require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");
const winston = require("winston");
require("winston-daily-rotate-file");

// Konfigurasi logger
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.DailyRotateFile({
            dirname: "logs",
            filename: "application-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            maxSize: "10m",
            maxFiles: "7d",
        }),
    ],
});

// Konstanta dan konfigurasi
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const TOKEN_PATH = "token.json";
const youtubeChannelID = process.env.YOUTUBE_CHANNEL_ID;

// Fungsi untuk otorisasi OAuth 2.0
async function authorize() {
    if (!fs.existsSync("credentials.json")) {
        logger.error("Error: credentials.json file is missing. Please ensure the file exists in the current directory.");
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync("credentials.json"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    try {
        if (fs.existsSync(TOKEN_PATH)) {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
            oAuth2Client.setCredentials(token);
            return oAuth2Client;
        }
    } catch (err) {
        logger.warn("Token file is missing or invalid. Proceeding to generate a new token.");
    }

    return await getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
    return new Promise((resolve, reject) => {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: "offline",
            scope: SCOPES,
        });

        console.log("Authorize this app by visiting this URL:", authUrl);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        rl.question("Enter the code from that page here: ", (code) => {
            rl.close();
            oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                    logger.error("Error retrieving access token:", err);
                    reject(err);
                    return;
                }
                oAuth2Client.setCredentials(token);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                logger.info("Token stored to", TOKEN_PATH);
                resolve(oAuth2Client);
            });
        });
    });
}

// Fungsi untuk memeriksa komentar
async function fetchComments(auth, VIDEO_ID) {
    const youtube = google.youtube({ version: "v3", auth });

    try {
        const response = await youtube.commentThreads.list({
            part: "snippet",
            videoId: VIDEO_ID,
            maxResults: 100,
        });

        const spamComments = [];
        const seenComments = new Set(); // Untuk mendeteksi duplikat

        response.data.items.forEach((item) => {
            const comment = item.snippet.topLevelComment.snippet;
            const commentText = comment.textDisplay.trim();
            const commentId = item.id;

            logger.info(`Checking comment: "${commentText}"`);

            // Jika komentar sudah pernah dilihat, tandai sebagai duplikat
            if (seenComments.has(commentText)) {
                logger.warn(`🚨 Duplicate comment detected: "${commentText}"`);
                spamComments.push(commentId);
            } else {
                seenComments.add(commentText); // Tambahkan ke daftar komentar yang sudah dilihat
                if (getJudolComment(commentText)) {
                    logger.warn(`🚨 Spam detected: "${commentText}"`);
                    spamComments.push(commentId);
                }
            }
        });

        return spamComments;
    } catch (error) {
        if (error.errors && error.errors[0].reason === "commentsDisabled") {
            logger.warn(`⚠️ Comments are disabled for video ID: ${VIDEO_ID}`);
        } else {
            logger.error("Error fetching comments:", error.message);
        }
        return [];
    }
}

// Fungsi untuk memeriksa apakah komentar adalah spam
function getJudolComment(text) {

    const cleanText = text.replace(/<[^>]+>/g, " ");

    const normalizedText = text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f\u034f\u1ab0-\u1aff\u1dc0-\u1dff]/g, "")
        .replace(/[^\p{Letter}\p{Number}\s()'"\-,.!?;:@#&\p{Emoji}]/gu, "")
        .replace(/\s+/g, " ")
        .trim();

    const textLength = [...cleanText].length;
    const normLength = [...normalizedText].length;
    const similarity = normLength / Math.max(textLength, 1);
    
    const hasFullEmoji = /\p{Emoji_Presentation}/gu.test(text);
    const hasStylized = /[\u{1D400}-\u{1D7FF}\u{1F100}-\u{1F1FF}]/u.test(cleanText);

    
    

    if (hasStylized || similarity < 0.75) {
        return true;
    }

    if (hasFullEmoji && normLength > 5) {
        return false;
    }

    const emojiCount = (cleanText.match(/\p{Emoji}/gu) || []).length;
    if (emojiCount >= 1 && text.length <= 15) {
        return false;
    }

    const emojiRegex = /\p{Extended_Pictographic}/gu;
    if (emojiRegex.test(text)) {
        return false;
    }

    const cjkRegex = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
    const arabicRegex = /[\u0600-\u06FF]/; // Arab
    const thaiRegex = /[\u0E00-\u0E7F]/; // Thai
    
    if (cjkRegex.test(text) || arabicRegex.test(text) || thaiRegex.test(text)) {
        return false;
    }

    const blockedWords = JSON.parse(fs.readFileSync("blockedword.json"));
    const lowerText = normalizedText.toLowerCase();
    
    return blockedWords.some(word => {
        const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        return new RegExp(`\\b${escapedWord}\\b`, "i").test(lowerText);
    });
}

// Fungsi untuk menghapus komentar
async function deleteComments(auth, commentIds) {
    const youtube = google.youtube({ version: "v3", auth });

    const totalCommentsToBeDeleted = commentIds.length;
    let totalDeletedComments = 0;

    do {
        const commentIdsChunk = commentIds.splice(0, 50);
        if (commentIdsChunk.length === 0) break;

        try {
            await youtube.comments.setModerationStatus({
                id: commentIdsChunk,
                moderationStatus: "rejected",
            });
            totalDeletedComments += commentIdsChunk.length;
            logger.info(
                `Progress: ${totalDeletedComments}/${totalCommentsToBeDeleted} (${commentIds.length} remaining)`
            );
        } catch (error) {
            logger.error(`Failed to delete these comment IDs: ${commentIdsChunk}:`, error.message);
        }
    } while (commentIds.length > 0);
}


async function youtubeContentList(auth) {
    const youtube = google.youtube({ version: "v3", auth });

    try {
        const response = await youtube.channels.list({
            part: "contentDetails",
            id: youtubeChannelID,
        });

        const channel = response.data.items[0];
        const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;

        const allVideos = [];
        let nextPageToken = "";

        do {
            const playlistResponse = await youtube.playlistItems.list({
                part: "snippet",
                playlistId: uploadsPlaylistId,
                maxResults: 50,
                pageToken: nextPageToken,
            });

            allVideos.push(...playlistResponse.data.items);
            nextPageToken = playlistResponse.data.nextPageToken;
        } while (nextPageToken);

        return allVideos;
    } catch (error) {
        logger.error("Error fetching videos:", error);
        return [];
    }
}


async function scanAndDeleteSpamComments() {
    try {
        const auth = await authorize();
        const contentList = await youtubeContentList(auth);

        for (const video of contentList) {
            const title = video.snippet.title;
            const videoId = video.snippet.resourceId.videoId;
            logger.info(`\n📹 Checking video: ${title} (ID: ${videoId})`);

            const spamComments = await fetchComments(auth, videoId);
            if (spamComments.length > 0) {
                logger.warn(`🚫 Found ${spamComments.length} spam comments. Deleting...`);
                await deleteComments(auth, spamComments);
                logger.info("✅ Spam comments deleted.");
            } else {
                logger.info("✅ No spam comments found.");
            }
        }
    } catch (error) {
        logger.error("Error running script:", error);
    }
}


const SCAN_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
logger.info("Starting automatic spam comment scanner...");
scanAndDeleteSpamComments();
setInterval(scanAndDeleteSpamComments, SCAN_INTERVAL);
