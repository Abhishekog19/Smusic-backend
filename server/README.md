# Smusic Backend Server

Express.js API server that powers the Smusic and Groove apps.

## Routes

| Route | Description |
|-------|-------------|
| `GET /api/health` | Health check |
| `GET /api/proxy` | TIDAL / Spotify JSON proxy |
| `GET /api/audio-proxy` | TIDAL CDN audio stream proxy |
| `GET /api/songlink` | Spotify → TIDAL URL converter |
| `POST /api/spotify-playlist` | Spotify playlist track extractor |
| `GET /api/resolve-url` | Shortened URL resolver |
| `GET /api/tidal-download/resolve` | Resolve TIDAL stream URL |
| `GET /api/tidal-download/stream` | Proxy TIDAL audio stream |
| `POST /api/tidal-download/zip` | Batch download ZIP |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Set to `production` on Railway |
| `ALLOWED_ORIGINS` | No | Comma-separated allowed CORS origins |
| `REDIS_URL` | No | Redis URL for caching (optional) |

## Deploy on Render

1. Push the `Smusic-backend/` folder (repo root) to GitHub
2. Go to [render.com](https://render.com) → **New** → **Blueprint**
3. Connect your GitHub repo — Render will detect `render.yaml` automatically
4. Click **Apply** — Render builds and deploys the service
5. Copy the generated `https://<service>.onrender.com` URL and update it in Groove-app

### Manual setup (without Blueprint)

1. Go to **New** → **Web Service** → connect your repo
2. Set **Root Directory** to `server`
3. **Build Command**: `npm install`
4. **Start Command**: `node index.js`
5. Add env var: `NODE_ENV` = `production`
6. **Health Check Path**: `/api/health`

> **Note**: Render free tier spins down after 15 min of inactivity (cold start ~30s).
> Upgrade to a paid plan or use [UptimeRobot](https://uptimerobot.com) to ping `/api/health` every 10 min to keep it warm.

## Local Development

```bash
npm install
npm start
```
