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

## Deploy on Railway

1. Push this `server/` folder to a GitHub repo
2. Create a new Railway project → Deploy from GitHub
3. Railway auto-detects `package.json` and runs `npm start`
4. Copy the generated URL and put it in Groove-app's `local.properties`

## Local Development

```bash
npm install
npm start
```
