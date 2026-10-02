#!/usr/bin/env bash
set -e

echo "=== Link2Video Render Build Starting ==="

# Install / update yt-dlp using python pip
if command -v python3 &>/dev/null; then
    python3 -m pip install --upgrade "yt-dlp[default]"
elif command -v pip &>/dev/null; then
    pip install --upgrade "yt-dlp[default]"
else
    pip3 install --upgrade "yt-dlp[default]" || true
fi

# Install Node dependencies (including ffmpeg-static)
npm install

echo "=== Link2Video Render Build Completed Successfully ==="
