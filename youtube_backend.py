import sys
import os
import json
import re
import shutil
import tempfile
import yt_dlp

YOUTUBE_REGEX = re.compile(
    r'^(https?://)?(www\.|m\.)?(youtube\.com/(watch\?([^\s&]+&)*v=|shorts/)|youtu\.be/)[a-zA-Z0-9_-]+',
    re.IGNORECASE
)

TARGET_RESOLUTIONS = [2160, 1440, 1080, 720]


def is_valid_youtube_url(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    return bool(YOUTUBE_REGEX.search(url.strip()))


def find_ffmpeg(custom_path=None):
    if custom_path and os.path.exists(custom_path):
        return custom_path

    # Check node_modules/ffmpeg-static
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "backend", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
        os.path.join(script_dir, "backend", "node_modules", "ffmpeg-static", "ffmpeg"),
        os.path.join(script_dir, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
        os.path.join(script_dir, "node_modules", "ffmpeg-static", "ffmpeg")
    ]
    for c in candidates:
        if os.path.exists(c):
            return c

    # System PATH
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg

    return None


class QuietLogger:
    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def configure_cookies(ydl_opts: dict):
    source = os.environ.get("YOUTUBE_COOKIES_PATH")
    if not source:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        local_backend = os.path.join(script_dir, "backend", "cookies.txt")
        if os.path.exists(local_backend):
            source = local_backend
        else:
            local_same = os.path.join(script_dir, "cookies.txt")
            if os.path.exists(local_same):
                source = local_same

    if source and os.path.exists(source):
        writable_cookie = os.path.join(tempfile.gettempdir(), "youtube-cookies.txt")
        target_cookie = source
        try:
            if os.path.abspath(source) != os.path.abspath(writable_cookie):
                shutil.copyfile(source, writable_cookie)
            target_cookie = writable_cookie
        except Exception:
            target_cookie = source

        ydl_opts["cookiefile"] = target_cookie
        sys.stderr.write(f"Using YouTube cookies: {source}\n")
        sys.stderr.flush()
    else:
        sys.stderr.write("YouTube cookie file not found\n")
        sys.stderr.flush()


def get_video_info(url: str):
    if not is_valid_youtube_url(url):
        print(json.dumps({
            "success": False,
            "message": "Invalid YouTube URL. Supported formats: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/"
        }))
        sys.exit(1)

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "logger": QuietLogger(),
        "js_runtimes": {
            "node": {}
        },
    }

    configure_cookies(ydl_opts)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            print(json.dumps({
                "success": False,
                "message": "Failed to retrieve video metadata"
            }))
            sys.exit(1)

        # In case of playlist or multi-entry, pick the first entry
        if "entries" in info and info["entries"]:
            info = info["entries"][0]

        title = info.get("title") or "YouTube Video"
        thumbnail = info.get("thumbnail") or ""
        duration = info.get("duration") or 0

        # Scan formats to find available resolutions
        formats = info.get("formats", []) or []
        available_heights = set()

        for fmt in formats:
            height = fmt.get("height")
            vcodec = fmt.get("vcodec")
            # Must have video codec and valid height
            if vcodec != "none" and height:
                available_heights.add(height)

        qualities = []
        for res in TARGET_RESOLUTIONS:
            if res in available_heights:
                qualities.append({
                    "resolution": res,
                    "label": f"{res}p"
                })

        result = {
            "success": True,
            "video": {
                "title": title,
                "thumbnail": thumbnail,
                "duration": duration,
                "qualities": qualities
            }
        }
        print(json.dumps(result))
        sys.exit(0)

    except yt_dlp.utils.DownloadError as e:
        clean_err = str(e)
        if "ERROR:" in clean_err:
            clean_err = clean_err.split("ERROR:", 1)[1].strip()
        print(json.dumps({
            "success": False,
            "message": f"YouTube extraction error: {clean_err}"
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"An unexpected error occurred: {str(e)}"
        }))
        sys.exit(1)


def render_video(url: str, resolution_str: str, output_path: str, custom_ffmpeg: str = None):
    if not is_valid_youtube_url(url):
        print(json.dumps({
            "success": False,
            "message": "Invalid YouTube URL. Supported formats: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/"
        }))
        sys.exit(1)

    try:
        res = int(resolution_str)
        if res not in TARGET_RESOLUTIONS:
            raise ValueError()
    except Exception:
        print(json.dumps({
            "success": False,
            "message": f"Invalid resolution: {resolution_str}. Allowed: {TARGET_RESOLUTIONS}"
        }))
        sys.exit(1)

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    ffmpeg_bin = find_ffmpeg(custom_ffmpeg)

    # Format selector prioritizing exact height, mp4/h264, and best audio
    format_selector = (
        f"bestvideo[height={res}][vcodec^=avc1]+bestaudio[ext=m4a]/"
        f"bestvideo[height={res}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height={res}]+bestaudio/"
        f"best[height={res}][ext=mp4]/"
        f"best[height={res}]/"
        f"bestvideo[height<={res}][vcodec^=avc1]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={res}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={res}]+bestaudio/"
        f"best[height<={res}][ext=mp4]/"
        f"best[height<={res}]"
    )

    last_reported_progress = 0

    def progress_hook(d):
        nonlocal last_reported_progress
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            if total > 0:
                raw_pct = downloaded / total
                info_dict = d.get("info_dict") or {}
                vcodec = info_dict.get("vcodec")
                if vcodec == "none":
                    # Audio stream: map 75% -> 90%
                    pct = int(75 + raw_pct * 15)
                else:
                    # Video stream: map 5% -> 75%
                    pct = int(5 + raw_pct * 70)

                pct = max(1, min(90, pct))
                if pct > last_reported_progress:
                    last_reported_progress = pct
                    sys.stderr.write(f"PROGRESS:{pct}\n")
                    sys.stderr.flush()
        elif status == "finished":
            if last_reported_progress < 90:
                last_reported_progress = 90
                sys.stderr.write("PROGRESS:90\n")
                sys.stderr.flush()

    def postprocessor_hook(d):
        nonlocal last_reported_progress
        if d.get("status") == "started":
            sys.stderr.write("PROGRESS:92\n")
            sys.stderr.flush()
        elif d.get("status") == "finished":
            sys.stderr.write("PROGRESS:98\n")
            sys.stderr.flush()

    ydl_opts = {
        "format": format_selector,
        "outtmpl": output_path,
        "merge_output_format": "mp4",
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "retries": 10,
        "fragment_retries": 10,
        "socket_timeout": 30,
        "file_access_retries": 5,
        "logger": QuietLogger(),
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "noplaylist": True,
        "paths": {"home": out_dir, "temp": out_dir},
        "js_runtimes": {
            "node": {}
        },
    }

    if ffmpeg_bin:
        ydl_opts["ffmpeg_location"] = ffmpeg_bin

    configure_cookies(ydl_opts)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        final_path = output_path
        if not os.path.exists(final_path):
            base, _ = os.path.splitext(output_path)
            candidates = [output_path, f"{output_path}.mp4", f"{base}.mp4", f"{base}.mkv", f"{base}.webm"]
            for c in candidates:
                if os.path.exists(c):
                    final_path = c
                    break

        if not os.path.exists(final_path) or os.path.getsize(final_path) == 0:
            print(json.dumps({
                "success": False,
                "message": "Output video file was not generated or is empty."
            }))
            sys.exit(1)

        sys.stderr.write("PROGRESS:100\n")
        sys.stderr.flush()

        file_name = os.path.basename(final_path)
        print(json.dumps({
            "success": True,
            "filePath": final_path,
            "fileName": file_name
        }))
        sys.exit(0)

    except yt_dlp.utils.DownloadError as e:
        clean_err = str(e)
        if "ERROR:" in clean_err:
            clean_err = clean_err.split("ERROR:", 1)[1].strip()
        print(json.dumps({
            "success": False,
            "message": f"YouTube download error: {clean_err}"
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"An unexpected error occurred during rendering: {str(e)}"
        }))
        sys.exit(1)


def download_mp3(url: str, output_path: str, bitrate: int = 192, custom_ffmpeg: str = None):
    if not is_valid_youtube_url(url):
        print(json.dumps({
            "success": False,
            "message": "Invalid YouTube URL. Supported formats: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/"
        }))
        sys.exit(1)

    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    ffmpeg_bin = find_ffmpeg(custom_ffmpeg)

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_path,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": str(bitrate),
        }],
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "paths": {"home": out_dir, "temp": out_dir},
        "logger": QuietLogger(),
        "js_runtimes": {
            "node": {}
        },
    }

    if ffmpeg_bin:
        ydl_opts["ffmpeg_location"] = ffmpeg_bin

    configure_cookies(ydl_opts)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        final_path = output_path
        if not os.path.exists(final_path):
            base, _ = os.path.splitext(output_path)
            candidate = f"{base}.mp3"
            if os.path.exists(candidate):
                final_path = candidate

        if not os.path.exists(final_path) or os.path.getsize(final_path) == 0:
            print(json.dumps({
                "success": False,
                "message": "Output MP3 file was not generated or is empty."
            }))
            sys.exit(1)

        print(json.dumps({
            "success": True,
            "filePath": final_path,
            "fileName": os.path.basename(final_path)
        }))
        sys.exit(0)
    except yt_dlp.utils.DownloadError as e:
        clean_err = str(e)
        if "ERROR:" in clean_err:
            clean_err = clean_err.split("ERROR:", 1)[1].strip()
        print(json.dumps({
            "success": False,
            "message": f"YouTube MP3 error: {clean_err}"
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"An unexpected error occurred during MP3 conversion: {str(e)}"
        }))
        sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "message": "Usage: python youtube_backend.py info <URL> OR python youtube_backend.py render <URL> <RESOLUTION> <OUTPUT_PATH> [FFMPEG_PATH]"
        }))
        sys.exit(1)

    action = sys.argv[1].lower()
    url = sys.argv[2].strip()

    if action == "info":
        get_video_info(url)
    elif action == "render":
        if len(sys.argv) < 5:
            print(json.dumps({
                "success": False,
                "message": "Usage: python youtube_backend.py render <URL> <RESOLUTION> <OUTPUT_PATH> [FFMPEG_PATH]"
            }))
            sys.exit(1)
        resolution_str = sys.argv[3].strip()
        output_path = sys.argv[4].strip()
        custom_ffmpeg = sys.argv[5].strip() if len(sys.argv) > 5 else None
        render_video(url, resolution_str, output_path, custom_ffmpeg)
    elif action == "mp3":
        output_path = sys.argv[3].strip() if len(sys.argv) > 3 else "output.mp3"
        bitrate = int(sys.argv[4].strip()) if len(sys.argv) > 4 and sys.argv[4].isdigit() else 192
        custom_ffmpeg = sys.argv[5].strip() if len(sys.argv) > 5 else None
        download_mp3(url, output_path, bitrate, custom_ffmpeg)
    else:
        print(json.dumps({
            "success": False,
            "message": f"Unknown action: {action}. Expected 'info', 'render', or 'mp3'"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()

