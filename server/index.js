import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import express from 'express';
import cors from 'cors';

import { initializeTokenManager } from './lib/tokenManager.js';
import { apiInstanceManager } from './lib/apiInstances.js';

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

// ── Initialize token manager ─────────────────────────────────────────────────
// Uses env vars when set, otherwise falls back to Monochrome's own public
// client credentials (used in functions/track/[id].js). This yields a
// free-tier token valid for track resolution via td.if-it-runs-ship-it.lol,
// which bypasses ALL banned community mirrors.
const TIDAL_CLIENT_ID     = process.env.TIDAL_CLIENT_ID     || 'txNoH4kkV41MfH25';
const TIDAL_CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';
try {
  const tm = initializeTokenManager(TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET);
  app.set('tokenManager', tm);
  const src = process.env.TIDAL_CLIENT_ID ? 'env vars' : 'built-in fallback (Monochrome)';
  console.log(`✅ Token Manager initialized (credentials from ${src})`);
} catch (err) {
  console.warn('⚠️  Token Manager init failed:', err.message);
}

// ── Pre-warm mirror discovery (async, non-blocking) ────────────────────────
apiInstanceManager.loadInstances().then(mirrors => {
  console.log(`✅ Mirror discovery: ${mirrors.length} live mirrors loaded`);
}).catch(err => {
  console.warn('⚠️  Mirror discovery failed (will use fallbacks):', err.message);
});

// Middleware
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => callback(null, true), // Per-route CORS handled in routes
  credentials: true,
}));

// Health check
app.get('/api/health', (_req, res) => {
  const tm = _req.app.get('tokenManager');
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    port:      PORT,
    token:     tm ? tm.getTokenInfo() : { status: 'not_configured' },
  });
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
