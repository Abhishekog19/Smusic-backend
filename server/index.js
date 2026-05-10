import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import express from 'express';
import cors from 'cors';

import proxyRoute from './routes/proxy.js';
import audioProxyRoute from './routes/audio-proxy.js';
import songlinkRoute from './routes/songlink.js';
import spotifyPlaylistRoute from './routes/spotify-playlist.js';
import resolveUrlRoute from './routes/resolve-url.js';
import tidalDownloadRoute from './routes/tidal-download.js';
import lyricsRoute from './routes/lyrics.js';
import recommendationsRoute from './routes/recommendations.js';

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => callback(null, true), // Per-route CORS handled in routes
  credentials: true,
}));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), port: PORT });
});

// API Routes
app.use('/api/proxy', proxyRoute);
app.use('/api/audio-proxy', audioProxyRoute);
app.use('/api/songlink', songlinkRoute);
app.use('/api/spotify-playlist', spotifyPlaylistRoute);
app.use('/api/resolve-url', resolveUrlRoute);
app.use('/api/tidal-download', tidalDownloadRoute);
app.use('/api/lyrics', lyricsRoute);
app.use('/api/recommendations', recommendationsRoute);

// 404 handler
app.use('/api/{*path}', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Antigravity API server running on http://localhost:${PORT}`);
  console.log(`   /api/proxy              → TIDAL/Spotify JSON proxy + caching`);
  console.log(`   /api/audio-proxy        → TIDAL CDN audio stream proxy (binary)`);
  console.log(`   /api/songlink           → Spotify → TIDAL URL conversion`);
  console.log(`   /api/spotify-playlist   → Playlist track extractor`);
  console.log(`   /api/resolve-url        → Shortened URL resolver (mobile)`);
  console.log(`   /api/tidal-download     → TIDAL stream resolve + ZIP download`);
  console.log(`   /api/lyrics             → Synced lyrics (lrclib → lyrics.ovh fallback)`);
  console.log(`   /api/recommendations    → Similar tracks (Last.fm → TIDAL resolve)`);
  console.log(`   /api/health             → Health check\n`);
});

export default app;
