# Render Free Deployment Guide - Link2Video Backend

This guide outlines how to deploy the Link2Video backend to [Render](https://render.com) using their Free tier Linux Web Service.

---

## 1. Web Service Configuration

When creating a new Web Service on Render, connect your Git repository and set the following parameters:

| Setting | Value |
|---|---|
| **Service Type** | Web Service |
| **Name** | `link2video-backend` (or your choice) |
| **Region** | Closest to your users (e.g. Frankfurt, Oregon, Singapore) |
| **Branch** | `main` |
| **Root Directory** | `backend` *(if repository has both frontend and backend)* |
| **Runtime** | `Node` |
| **Build Command** | `bash render-build.sh` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

> **Note on Root Directory**:
> If you deploy the entire repository as root, set the **Root Directory** to `backend`. If you push only the `backend/` folder to a standalone repository, leave the Root Directory blank.

---

## 2. Environment Variables

| Variable | Required? | Description |
|---|---|---|
| `PORT` | **Automatic** | Render automatically sets and injects `PORT` for your service. The backend binds to `0.0.0.0:${PORT}`. |
| `NODE_ENV` | Optional | Can be set to `production`. |

---

## 3. How the Build Script Works (`render-build.sh`)

1. **Python yt-dlp**: Installs/updates the latest `yt-dlp` executable into Linux PATH via `pip`.
2. **Node.js Dependencies**: Runs `npm install` to install:
   - `express`
   - `cors`
   - `ffmpeg-static` (downloads platform-native static FFmpeg binary for Linux)

---

## 4. Cookies & Authentication

- **Do NOT commit `cookies.txt` to GitHub or public repositories.**
- `cookies.txt` is listed in `.gitignore` to prevent accidental credential leakage.
- The backend checks `fs.existsSync(COOKIES_PATH)` dynamically:
  - If `cookies.txt` is missing, the backend continues to function normally and does NOT crash.
  - If cookies are required for age-restricted or member-only videos in the future, provide them securely (e.g., via a Render Secret File or secure environment variable) rather than committing them to source control.

---

## 5. Storage & Output Directory

- Render Free instances have an ephemeral file system.
- On Linux/Render, generated files are stored in `/tmp/link2video-renders`.
- Temporary files are created dynamically and served via `/renders/:filename`.

---

## 6. Health & Verification

Once deployed, you can verify your service status using the health check endpoint:

```
GET https://your-service-name.onrender.com/api/health
```

Expected Response:
```json
{
  "success": true,
  "service": "Link2Video Backend"
}
```
