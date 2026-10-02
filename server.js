const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

let ffmpegStaticPath = null;
try {
    ffmpegStaticPath = require("ffmpeg-static");
} catch (e) {
    // ffmpeg-static not available, fallback to system PATH
}

const app = express();

const allowedOrigins = [
    "http://127.0.0.1:5501",
    "http://localhost:5501",
    "https://link2video.site",
    "https://www.link2video.site"
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (
            allowedOrigins.includes(origin) ||
            /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
            return callback(null, true);
        }
        return callback(null, true);
    },
    credentials: true
}));

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// Platform detection
const isWin = process.platform === "win32";

const YTDLP_PATH = isWin
    ? path.join(__dirname, "yt-dlp.exe")
    : "yt-dlp";

const FFMPEG_PATH = ffmpegStaticPath || "ffmpeg";

// Platform-aware output directory (keep D:\ on Windows, temporary writable /tmp on Linux)
const OUTPUT_DIR = isWin
    ? "D:\\link2video-renders"
    : path.join("/tmp", "link2video-renders");

// =====================================================
// CREATE RENDER FOLDER
// =====================================================
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, {
        recursive: true
    });
}

const LOCAL_COOKIES = path.join(__dirname, "cookies.txt");

const COOKIES_PATH =
    process.env.YOUTUBE_COOKIES_PATH || LOCAL_COOKIES;

const WRITABLE_COOKIES = isWin
    ? path.join(OUTPUT_DIR, "youtube-cookies.txt")
    : path.join("/tmp", "youtube-cookies.txt");

function syncWritableCookies() {
    if (fs.existsSync(COOKIES_PATH)) {
        try {
            if (path.resolve(COOKIES_PATH) !== path.resolve(WRITABLE_COOKIES)) {
                fs.copyFileSync(COOKIES_PATH, WRITABLE_COOKIES);
            }
            return WRITABLE_COOKIES;
        } catch (err) {
            return COOKIES_PATH;
        }
    }
    return null;
}

if (fs.existsSync(COOKIES_PATH)) {
    syncWritableCookies();
    console.log(`Using YouTube cookies: ${COOKIES_PATH}`);
} else {
    console.log("YouTube cookie file not found");
}

const PYTHON_PATH = process.env.PYTHON_PATH || "python";
const YOUTUBE_SCRIPT_PATH = (() => {
    const localInDir = path.resolve(__dirname, "youtube_backend.py");
    if (fs.existsSync(localInDir)) return localInDir;
    const parentDir = path.resolve(__dirname, "..", "youtube_backend.py");
    if (fs.existsSync(parentDir)) return parentDir;
    return localInDir;
})();


// =====================================================
// STATIC RENDER DOWNLOAD
// =====================================================

app.use("/renders", express.static(OUTPUT_DIR, {
    setHeaders: (res, filePath) => {
        const basename = path.basename(filePath);
        res.setHeader("Content-Disposition", `attachment; filename="${basename}"`);
    }
}));

app.get("/renders/:filename", (req, res) => {

    const filename = path.basename(req.params.filename);

    const filePath = path.join(
        OUTPUT_DIR,
        filename
    );

    // Prevent path traversal
    const resolvedPath = path.resolve(filePath);
    const resolvedOutputDir = path.resolve(OUTPUT_DIR);
    if (!resolvedPath.startsWith(resolvedOutputDir)) {
        return res.status(403).send("Access denied.");
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found.");
    }

    res.download(
        filePath,
        filename
    );
});

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "Link2Video backend is running"
    });

});


// =====================================================
// HEALTH ENDPOINT
// =====================================================

app.get("/api/health", (req, res) => {

    res.json({
        success: true,
        service: "Link2Video Backend"
    });

});


// =====================================================
// FACEBOOK URL VALIDATION
// =====================================================

function isFacebookUrl(url) {

    try {

        const parsed = new URL(url);

        const host = parsed.hostname
            .toLowerCase()
            .replace(/^www\./, "");


        return (
            host === "facebook.com" ||
            host.endsWith(".facebook.com") ||
            host === "fb.watch" ||
            host.endsWith(".fb.watch") ||
            host === "fb.com"
        );

    } catch {

        return false;

    }

}

// =====================================================
// FACEBOOK INFO API
// =====================================================

app.post("/api/facebook/info", (req, res) => {

    const { url } = req.body;


    if (!url) {

        return res.status(400).json({
            success: false,
            message: "Facebook video URL is required."
        });

    }


    if (!isFacebookUrl(url)) {

        return res.status(400).json({
            success: false,
            message: "Valid Facebook video URL required."
        });

    }


    const args = [

        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        url

    ];


    execFile(

        YTDLP_PATH,
        args,

        {
            windowsHide: true,
            maxBuffer: 50 * 1024 * 1024
        },

        (error, stdout, stderr) => {

            if (error) {

                console.error(
                    stderr || error.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Could not process this Facebook video."
                });

            }


            try {

                const data =
                    JSON.parse(stdout);


                const allFormats =
                    Array.isArray(data.formats)
                        ? data.formats
                        : [];


                // =================================================
                // AUDIO FORMATS
                // =================================================

                const audioCandidates =
                    allFormats

                        .filter((format) => {

                            return (

                                format.url &&

                                format.acodec &&
                                format.acodec !== "none" &&

                                (
                                    !format.vcodec ||
                                    format.vcodec === "none"
                                )

                            );

                        })

                        .sort((a, b) => {

                            return (
                                (b.abr || 0) -
                                (a.abr || 0)
                            );

                        });


                const bestAudio =
                    audioCandidates[0] || null;


                // =================================================
                // VIDEO FORMATS
                // =================================================

                const videoFormats =
                    allFormats

                        .filter((format) => {

                            return (

                                format.url &&

                                format.ext === "mp4" &&

                                format.vcodec &&
                                format.vcodec !== "none"

                            );

                        })

                        .map((format) => {


                            const hasAudio =

                                format.acodec &&
                                format.acodec !== "none";


                            // -------------------------------------
                            // CORRECT VIDEO QUALITY
                            // Vertical:
                            // 1080x1920 = 1080p
                            // 720x1280 = 720p
                            // 540x960  = 540p
                            // -------------------------------------

                            let resolution = null;


                            if (
                                format.width &&
                                format.height
                            ) {

                                resolution = Math.min(
                                    format.width,
                                    format.height
                                );

                            }

                            else {

                                resolution =
                                    format.height ||
                                    format.width ||
                                    null;

                            }


                            // -------------------------------------
                            // QUALITY LABEL
                            // -------------------------------------

                            let quality;


                            if (resolution) {

                                quality =
                                    `${resolution}p`;

                            }

                            else if (
                                format.format_note
                            ) {

                                quality =
                                    String(
                                        format.format_note
                                    ).toUpperCase();

                            }

                            else if (
                                format.format_id === "hd"
                            ) {

                                quality = "HD";

                            }

                            else if (
                                format.format_id === "sd"
                            ) {

                                quality = "SD";

                            }

                            else {

                                quality = "MP4";

                            }


                            return {

                                formatId:
                                    format.format_id ||
                                    null,

                                quality:
                                    quality,

                                resolution:
                                    resolution,

                                formatNote:
                                    format.format_note ||
                                    null,

                                width:
                                    format.width ||
                                    null,

                                height:
                                    format.height ||
                                    null,

                                fps:
                                    format.fps ||
                                    null,

                                ext:
                                    format.ext ||
                                    "mp4",

                                hasAudio:
                                    !!hasAudio,

                                needsRender:
                                    !hasAudio,

                                filesize:
                                    format.filesize ||
                                    format.filesize_approx ||
                                    null,

                                bitrate:
                                    format.tbr ||
                                    format.vbr ||
                                    null,

                                downloadUrl:
                                    format.url,

                                audioFormatId:
                                    bestAudio
                                        ? bestAudio.format_id
                                        : null

                            };

                        });


                // =================================================
                // REMOVE DUPLICATES
                // =================================================

                const uniqueMap =
                    new Map();


                for (
                    const format
                    of videoFormats
                ) {


                    // Resolution available

                    const key =
                        format.resolution
                            ? `resolution-${format.resolution}`
                            : `format-${format.formatId}`;


                    if (!uniqueMap.has(key)) {

                        uniqueMap.set(
                            key,
                            format
                        );

                        continue;

                    }


                    const current =
                        uniqueMap.get(key);


                    // ---------------------------------------------
                    // Same quality me direct audio+video
                    // available ho to usko prefer karo
                    // ---------------------------------------------

                    if (
                        !current.hasAudio &&
                        format.hasAudio
                    ) {

                        uniqueMap.set(
                            key,
                            format
                        );

                        continue;

                    }


                    // ---------------------------------------------
                    // Dono video-only hain to better bitrate
                    // ---------------------------------------------

                    if (
                        !current.hasAudio &&
                        !format.hasAudio
                    ) {

                        const currentBitrate =
                            current.bitrate || 0;

                        const newBitrate =
                            format.bitrate || 0;


                        if (
                            newBitrate >
                            currentBitrate
                        ) {

                            uniqueMap.set(
                                key,
                                format
                            );

                        }

                    }

                }


                const uniqueFormats =
                    Array.from(
                        uniqueMap.values()
                    );
                const allowedQualities = [2160, 1440, 1080, 720];

                const filteredFormats = uniqueFormats.filter((format) =>
                    allowedQualities.includes(format.resolution)
                );

                // =================================================
                // SORT QUALITY
                // =================================================

                uniqueFormats.sort(
                    (a, b) => {

                        return (
                            (b.resolution || 0) -
                            (a.resolution || 0)
                        );

                    }
                );


                // =================================================
                // AUDIO LIST
                // =================================================

                const audioFormats = [];


                if (bestAudio) {

                    audioFormats.push({

                        formatId:
                            bestAudio.format_id ||
                            null,

                        quality:
                            bestAudio.abr
                                ? `${Math.round(bestAudio.abr)} kbps`
                                : "Best Audio",

                        bitrate:
                            bestAudio.abr ||
                            null,

                        ext:
                            bestAudio.ext ||
                            "m4a",

                        downloadUrl:
                            bestAudio.url

                    });

                }


                // =================================================
                // RESPONSE
                // =================================================

                return res.json({

                    success: true,

                    video: {

                        title:
                            data.title ||
                            "Facebook Video",

                        thumbnail:
                            data.thumbnail ||
                            null,

                        duration:
                            data.duration ||
                            null,

                        uploader:
                            data.uploader ||
                            data.channel ||
                            null

                    },

                    formats:
                        filteredFormats,

                    audioFormats:
                        audioFormats

                });


            } catch (parseError) {

                console.error(
                    parseError
                );


                return res.status(500).json({

                    success: false,

                    message:
                        "Invalid video information received."

                });

            }

        }

    );

});


// =====================================================
// RENDER API
// =====================================================

app.post("/api/facebook/render", (req, res) => {

    const {
        url,
        videoFormatId,
        audioFormatId
    } = req.body;


    if (
        !url ||
        !videoFormatId
    ) {

        return res.status(400).json({

            success: false,

            message:
                "Video URL and video format are required."

        });

    }


    if (!isFacebookUrl(url)) {

        return res.status(400).json({

            success: false,

            message:
                "Valid Facebook URL required."

        });

    }


    const id =
        crypto.randomBytes(8)
            .toString("hex");


    const outputFile =
        path.join(

            OUTPUT_DIR,

            `facebook-${id}.mp4`

        );


    let formatSelector;


    if (audioFormatId) {

        formatSelector =
            `${videoFormatId}+${audioFormatId}`;

    }

    else {

        formatSelector =
            `${videoFormatId}+bestaudio`;

    }


    const args = [
        ...(FFMPEG_PATH ? ["--ffmpeg-location", FFMPEG_PATH] : []),
        "-f",
        formatSelector,

        "--merge-output-format",
        "mp4",

        "--no-playlist",

        "--paths",
        OUTPUT_DIR,
        "--paths",
        `temp:${OUTPUT_DIR}`,

        "-o",
        outputFile,

        url

    ];


    execFile(

        YTDLP_PATH,
        args,

        {
            cwd: OUTPUT_DIR,
            windowsHide: true,
            maxBuffer: 50 * 1024 * 1024
        },

        (error, stdout, stderr) => {

            if (error) {

                console.error(
                    stderr ||
                    error.message
                );


                return res.status(500).json({

                    success: false,

                    message:
                        "Render failed."

                });

            }


            if (
                !fs.existsSync(
                    outputFile
                )
            ) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Rendered file was not created."

                });

            }


            const downloadUrl =
                `/renders/${path.basename(outputFile)}`;


            return res.json({

                success: true,

                message:
                    "Render completed.",

                downloadUrl:
                    downloadUrl

            });

        }

    );

});

// =====================================================
// FACEBOOK MP3 API
// =====================================================

function handleFacebookMp3(req, res) {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
    let bitrate = 192;
    if (req.body && req.body.bitrate) {
        const parsed = parseInt(String(req.body.bitrate).replace(/\D/g, ""), 10);
        if ([128, 192, 256, 320].includes(parsed)) {
            bitrate = parsed;
        }
    }

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "Facebook video URL is required."
        });
    }

    if (!isFacebookUrl(url)) {
        return res.status(400).json({
            success: false,
            message: "Valid Facebook URL required."
        });
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const id = crypto.randomBytes(8).toString("hex");

    const outputFileName = `facebook-mp3-${id}.mp3`;
    const outputFile = path.join(
        OUTPUT_DIR,
        outputFileName
    );
    const outputTemplate = path.join(
        OUTPUT_DIR,
        `facebook-mp3-${id}.%(ext)s`
    );

    const args = [
        ...(FFMPEG_PATH ? ["--ffmpeg-location", FFMPEG_PATH] : []),
        "--no-playlist",
        "--no-warnings",
        "--paths",
        OUTPUT_DIR,
        "--paths",
        `temp:${OUTPUT_DIR}`,
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        `${bitrate}k`,
        "-o",
        outputTemplate,
        url
    ];

    execFile(
        YTDLP_PATH,
        args,
        {
            cwd: OUTPUT_DIR,
            windowsHide: true,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 90000
        },
        (error, stdout, stderr) => {

            if (error) {
                console.error("Facebook MP3 conversion error:", stderr || error.message);

                return res.status(500).json({
                    success: false,
                    message: "MP3 conversion failed."
                });
            }

            if (!fs.existsSync(outputFile)) {
                return res.status(500).json({
                    success: false,
                    message: "MP3 file was not created."
                });
            }

            const downloadUrl =
                `/renders/${outputFileName}`;

            return res.json({
                success: true,
                message: "MP3 ready.",
                downloadUrl: downloadUrl,
                filename: outputFileName,
                bitrate: `${bitrate} kbps`
            });
        }
    );
}

app.post("/api/facebook/mp3", handleFacebookMp3);
app.post("/api/facebook/mp3/render", handleFacebookMp3);
app.post("/api/facebook/mp3/info", (req, res, next) => {
    // Forward / reuse Facebook info logic
    req.url = "/api/facebook/info";
    app._router.handle(req, res, next);
});


// =====================================================
// YOUTUBE MP3 API
// =====================================================

const YOUTUBE_REGEX = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?([^\s&]+&)*v=|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]+/i;

function isYouTubeUrl(url) {
    if (!url || typeof url !== "string") return false;
    return YOUTUBE_REGEX.test(url.trim());
}

function handleYouTubeMp3Render(req, res) {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
    let bitrate = 192;
    if (req.body && req.body.bitrate) {
        const parsed = parseInt(String(req.body.bitrate).replace(/\D/g, ""), 10);
        if ([128, 192, 256, 320].includes(parsed)) {
            bitrate = parsed;
        }
    }

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "YouTube URL is required."
        });
    }

    if (!isYouTubeUrl(url)) {
        return res.status(400).json({
            success: false,
            message: "Valid YouTube URL required."
        });
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const id = crypto.randomBytes(8).toString("hex");
    const outputFileName = `youtube-mp3-${id}.mp3`;
    const outputFile = path.join(
        OUTPUT_DIR,
        outputFileName
    );
    const outputTemplate = path.join(
        OUTPUT_DIR,
        `youtube-mp3-${id}.%(ext)s`
    );

    const activeCookies = syncWritableCookies();
    if (activeCookies) {
        console.log(`Using YouTube cookies: ${COOKIES_PATH}`);
    } else {
        console.log("YouTube cookie file not found");
    }

    const args = [
        ...(FFMPEG_PATH ? ["--ffmpeg-location", FFMPEG_PATH] : []),
        ...(activeCookies ? ["--cookies", activeCookies] : []),
        "--js-runtimes",
        "node",
        "--no-playlist",
        "--no-warnings",
        "--paths",
        OUTPUT_DIR,
        "--paths",
        `temp:${OUTPUT_DIR}`,
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        `${bitrate}k`,
        "-o",
        outputTemplate,
        url
    ];

    execFile(
        YTDLP_PATH,
        args,
        {
            cwd: OUTPUT_DIR,
            env: {
                ...process.env,
                YOUTUBE_COOKIES_PATH: activeCookies || COOKIES_PATH
            },
            windowsHide: true,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 90000
        },
        (error, stdout, stderr) => {
            if (error) {
                console.error("YouTube MP3 conversion error:", stderr || error.message);
                return res.status(500).json({
                    success: false,
                    message: "YouTube MP3 conversion failed."
                });
            }

            if (!fs.existsSync(outputFile)) {
                return res.status(500).json({
                    success: false,
                    message: "MP3 file was not created."
                });
            }

            const downloadUrl = `/renders/${outputFileName}`;

            return res.json({
                success: true,
                message: "YouTube MP3 ready.",
                downloadUrl: downloadUrl,
                filename: outputFileName,
                bitrate: `${bitrate} kbps`
            });
        }
    );
}

app.post("/api/youtube/mp3/render", handleYouTubeMp3Render);
app.post("/api/youtube/mp3", handleYouTubeMp3Render);
app.post("/api/youtube/mp3/info", (req, res, next) => {
    req.url = "/api/youtube/info";
    app._router.handle(req, res, next);
});

// Periodic cleanup of older audio/video renders (older than 2 hours)
setInterval(() => {
    try {
        if (!fs.existsSync(OUTPUT_DIR)) return;
        const now = Date.now();
        const maxAge = 2 * 60 * 60 * 1000;
        fs.readdir(OUTPUT_DIR, (err, files) => {
            if (err || !files) return;
            files.forEach((file) => {
                const filePath = path.join(OUTPUT_DIR, file);
                fs.stat(filePath, (statErr, stats) => {
                    if (!statErr && stats && now - stats.mtimeMs > maxAge) {
                        fs.unlink(filePath, () => { });
                    }
                });
            });
        });
    } catch (e) { }
}, 30 * 60 * 1000).unref();


// =====================================================
// YOUTUBE INFO ROUTE
// =====================================================

app.post("/api/youtube/info", (req, res) => {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "YouTube URL is required."
        });
    }

    if (!fs.existsSync(YOUTUBE_SCRIPT_PATH)) {
        return res.status(500).json({
            success: false,
            message: "YouTube helper script not found on server."
        });
    }

    const activeCookies = syncWritableCookies();
    if (activeCookies) {
        console.log(`Using YouTube cookies: ${COOKIES_PATH}`);
    } else {
        console.log("YouTube cookie file not found");
    }

    const options = {
        cwd: OUTPUT_DIR,
        env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            YOUTUBE_COOKIES_PATH: activeCookies || COOKIES_PATH
        },
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    };

    execFile(PYTHON_PATH, ["-B", YOUTUBE_SCRIPT_PATH, "info", url], options, (error, stdout, stderr) => {
        const rawOutput = (stdout || "").trim();

        if (rawOutput) {
            try {
                const firstBrace = rawOutput.indexOf("{");
                const lastBrace = rawOutput.lastIndexOf("}");
                const jsonText = (firstBrace !== -1 && lastBrace !== -1)
                    ? rawOutput.substring(firstBrace, lastBrace + 1)
                    : rawOutput;
                const parsed = JSON.parse(jsonText);
                if (parsed.success) {
                    return res.status(200).json(parsed);
                } else {
                    return res.status(400).json(parsed);
                }
            } catch (jsonErr) {
                console.error("Invalid JSON from youtube_backend.py:", rawOutput);
                return res.status(500).json({
                    success: false,
                    message: "Invalid response received from YouTube processor."
                });
            }
        }

        if (error) {
            if (error.killed || error.signal === "SIGTERM") {
                return res.status(504).json({
                    success: false,
                    message: "YouTube request timed out."
                });
            }
            console.error("youtube_backend.py error:", error, stderr);
            return res.status(500).json({
                success: false,
                message: error.message || "Failed to execute YouTube processor."
            });
        }

        return res.status(500).json({
            success: false,
            message: "No output received from YouTube processor."
        });
    });
});


// =====================================================
// YOUTUBE ASYNC RENDER & DOWNLOAD SYSTEM
// =====================================================

const youtubeJobs = new Map();

// Periodic cleanup of jobs older than 1 hour
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of youtubeJobs.entries()) {
        if (job.createdAt < oneHourAgo) {
            youtubeJobs.delete(id);
        }
    }
}, 15 * 60 * 1000).unref();

app.post("/api/youtube/render", (req, res) => {
    const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
    const rawResolution = req.body && req.body.resolution;
    const resolution = parseInt(rawResolution, 10);

    if (!url) {
        return res.status(400).json({
            success: false,
            message: "YouTube URL is required."
        });
    }

    const allowedResolutions = [2160, 1440, 1080, 720];
    if (!allowedResolutions.includes(resolution)) {
        return res.status(400).json({
            success: false,
            message: `Invalid resolution: ${rawResolution}. Allowed: ${allowedResolutions.join(", ")}`
        });
    }

    if (!fs.existsSync(YOUTUBE_SCRIPT_PATH)) {
        return res.status(500).json({
            success: false,
            message: "YouTube helper script not found on server."
        });
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const jobId = "yt_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
    const outputFileName = `youtube_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`;
    const outputFilePath = path.join(OUTPUT_DIR, outputFileName);

    const job = {
        jobId,
        url,
        resolution,
        status: "processing",
        progress: 0,
        filePath: outputFilePath,
        fileName: outputFileName,
        error: null,
        createdAt: Date.now()
    };

    youtubeJobs.set(jobId, job);

    // Return immediate response so browser does not hang
    res.status(200).json({
        success: true,
        jobId: jobId,
        status: "processing"
    });

    const activeCookies = syncWritableCookies();
    if (activeCookies) {
        console.log(`Using YouTube cookies: ${COOKIES_PATH}`);
    } else {
        console.log("YouTube cookie file not found");
    }

    // Execute Python CLI helper asynchronously
    const args = [
        "-B",
        YOUTUBE_SCRIPT_PATH,
        "render",
        url,
        String(resolution),
        outputFilePath,
        FFMPEG_PATH
    ];

    const pyProcess = spawn(PYTHON_PATH, args, {
        cwd: OUTPUT_DIR,
        env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            YOUTUBE_COOKIES_PATH: activeCookies || COOKIES_PATH
        },
        windowsHide: true
    });

    let stdoutData = "";
    let stderrData = "";

    pyProcess.stdout.on("data", (data) => {
        stdoutData += data.toString();
    });

    pyProcess.stderr.on("data", (data) => {
        const text = data.toString();
        stderrData += text;
        const lines = text.split("\n");
        for (const line of lines) {
            const match = line.trim().match(/^PROGRESS:(\d+)$/);
            if (match) {
                const pct = parseInt(match[1], 10);
                if (!isNaN(pct)) {
                    job.progress = Math.max(job.progress, Math.min(100, pct));
                }
            }
        }
    });

    pyProcess.on("error", (err) => {
        console.error("YouTube render process error:", err);
        job.status = "failed";
        job.error = err.message || "Failed to start render helper.";
    });

    pyProcess.on("close", (code) => {
        if (code === 0) {
            try {
                const firstBrace = stdoutData.indexOf("{");
                const lastBrace = stdoutData.lastIndexOf("}");
                const jsonText = (firstBrace !== -1 && lastBrace !== -1)
                    ? stdoutData.substring(firstBrace, lastBrace + 1)
                    : stdoutData.trim();
                const parsed = JSON.parse(jsonText);
                if (parsed.success) {
                    job.status = "completed";
                    job.progress = 100;
                    if (parsed.filePath) job.filePath = parsed.filePath;
                    if (parsed.fileName) job.fileName = parsed.fileName;
                } else {
                    job.status = "failed";
                    job.error = parsed.message || "Rendering failed.";
                }
            } catch (e) {
                if (fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 0) {
                    job.status = "completed";
                    job.progress = 100;
                } else {
                    job.status = "failed";
                    job.error = "Invalid processor response.";
                }
            }
        } else {
            job.status = "failed";
            try {
                const firstBrace = stdoutData.indexOf("{");
                const lastBrace = stdoutData.lastIndexOf("}");
                const jsonText = (firstBrace !== -1 && lastBrace !== -1)
                    ? stdoutData.substring(firstBrace, lastBrace + 1)
                    : stdoutData.trim();
                const parsed = JSON.parse(jsonText);
                job.error = parsed.message || "Rendering failed.";
            } catch (e) {
                job.error = stderrData.trim() || "Video rendering failed.";
            }
        }
    });
});

app.get("/api/youtube/render/:jobId/status", (req, res) => {
    const { jobId } = req.params;
    const job = youtubeJobs.get(jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            status: "failed",
            message: "Job not found."
        });
    }

    if (job.status === "completed") {
        return res.json({
            success: true,
            status: "completed",
            progress: 100,
            downloadUrl: `/api/youtube/download/${jobId}`
        });
    }

    if (job.status === "failed") {
        return res.json({
            success: false,
            status: "failed",
            message: job.error || "Video processing failed."
        });
    }

    return res.json({
        success: true,
        status: "processing",
        progress: job.progress || 0
    });
});

app.get("/api/youtube/download/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = youtubeJobs.get(jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            message: "Download job not found."
        });
    }

    if (job.status !== "completed" || !job.filePath) {
        return res.status(400).json({
            success: false,
            message: "File is not ready for download."
        });
    }

    const resolvedPath = path.resolve(job.filePath);
    const resolvedOutputDir = path.resolve(OUTPUT_DIR);
    if (!resolvedPath.startsWith(resolvedOutputDir)) {
        return res.status(403).json({
            success: false,
            message: "Access denied."
        });
    }

    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({
            success: false,
            message: "Rendered file not found."
        });
    }

    const downloadName = job.fileName || path.basename(resolvedPath);
    return res.download(resolvedPath, downloadName, (err) => {
        if (err && !res.headersSent) {
            console.error("YouTube download error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to download file."
            });
        }
    });
});


// =====================================================
// API 404 & ERROR HANDLING (ALWAYS RETURN JSON)
// =====================================================

app.use("/api", (req, res) => {
    return res.status(404).json({
        success: false,
        message: `API endpoint not found: ${req.method} ${req.originalUrl}`
    });
});

app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) {
        return next(err);
    }
    return res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal server error."
    });
});

// =====================================================
// START SERVER
// =====================================================

const server = app.listen(PORT, "0.0.0.0", () => {

    console.log("");

    console.log(
        "===================================="
    );

    console.log(
        " Link2Video Backend Running"
    );

    console.log(
        "===================================="
    );

    console.log(
        `Server: http://0.0.0.0:${PORT}`
    );

    console.log(
        `Health: http://localhost:${PORT}/api/health`
    );

    console.log(
        `Info:   http://localhost:${PORT}/api/facebook/info`
    );

    console.log(
        `Render: http://localhost:${PORT}/api/facebook/render`
    );

    console.log(
        `YouTube:http://localhost:${PORT}/api/youtube/info`
    );

    console.log(
        "===================================="
    );

    console.log("");

});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error("");
        console.error("====================================");
        console.error(` ERROR: Port ${PORT} is already in use!`);
        console.error(` Another process is already running on port ${PORT}.`);
        console.error(" Please terminate the existing process or close the other terminal.");
        console.error("====================================");
        console.error("");
    } else {
        console.error("Server error:", error);
    }
});