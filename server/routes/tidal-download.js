import express from 'express';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import { getSpotifyTrack } from '../lib/spotifySession.js';

const router = express.Router();

// ─── TIDAL API config ─────────────────────────────────────────────────────────
// Public TIDAL API (no auth required for stream URL resolution via search)
const TIDAL_API_BASE = 'https://listen.tidal.com';
const TIDAL_SEARCH_API = 'https://api.tidal.com/v1';
const TIDAL_TOKEN = 'zU4XHVVkc2tDPo4t'; // Public TIDAL web token (no login needed)
const TIDAL_COUNTRY = 'US';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Search TIDAL for a track by ISRC or title+artist.
 * Returns the best matched TIDAL track object, or null.
 */
async function searchTidal({ title, artist, isrc }) {
  const headers = {
    'X-Tidal-Token': TIDAL_TOKEN,
    'Accept': 'application/json',
    'User-Agent': BROWSER_UA,
  };

  // ISRC lookup (most accurate)
  if (isrc) {
    try {
      const url = `${TIDAL_SEARCH_API}/tracks?isrc=${encodeURIComponent(isrc)}&countryCode=${TIDAL_COUNTRY}&limit=5`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        const items = data?.items || [];
        if (items.length > 0) {
          console.log(`[tidal-download] ISRC hit: "${items[0].title}" (ID: ${items[0].id})`);
          return items[0];
        }
      }
    } catch (err) {
      console.warn('[tidal-download] ISRC search failed:', err.message);
    }
  }

  // Title+artist search fallback
  const query = `${title} ${artist}`.trim();
  const url = `${TIDAL_SEARCH_API}/search/tracks?query=${encodeURIComponent(query)}&countryCode=${TIDAL_COUNTRY}&limit=10`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`TIDAL search failed: ${r.status}`);
  const data = await r.json();
  const items = data?.items || [];
  if (items.length === 0) throw new Error(`No TIDAL results for: "${query}"`);

  // Best match: prefer exact title match
  const best = items.find(t =>
    t.title?.toLowerCase() === title?.toLowerCase()
  ) || items[0];

  console.log(`[tidal-download] Text search hit: "${best.title}" by ${best.artists?.map(a => a.name).join(', ')} (ID: ${best.id})`);
  return best;
}

/**
 * Get a TIDAL stream URL for a track ID.
 * Returns { streamUrl, format, quality } or throws.
 */
async function getTidalStreamUrl(trackId, quality = 'LOSSLESS') {
  const qualityMap = {
    LOSSLESS: 'LOSSLESS',
    HI_RES: 'HI_RES_LOSSLESS',
    HIGH: 'HIGH',
    LOW: 'LOW',
  };
  const tidalQuality = qualityMap[quality] || 'LOSSLESS';

  const url = `${TIDAL_SEARCH_API}/tracks/${trackId}/streamUrl?soundQuality=${tidalQuality}&countryCode=${TIDAL_COUNTRY}`;
  const r = await fetch(url, {
    headers: {
      'X-Tidal-Token': TIDAL_TOKEN,
      'Accept': 'application/json',
      'User-Agent': BROWSER_UA,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (r.status === 401) {
    throw new Error('TIDAL stream requires login (track may be premium-only)');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`TIDAL stream URL failed: ${r.status} — ${text.slice(0, 100)}`);
  }

  const data = await r.json();
  const streamUrl = data?.url || data?.urls?.[0];
  if (!streamUrl) throw new Error('No stream URL in TIDAL response');

  const format = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
  return { streamUrl, format, quality: tidalQuality };
}

// ─── GET /api/tidal-download/search ──────────────────────────────────────────
// Free-text search across TIDAL. Used by Groove Android app's search screen.
// Returns results matching the TidalSearchTrack DTO shape the app expects.
router.get('/search', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    const searchLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const url = `${TIDAL_SEARCH_API}/search/tracks?query=${encodeURIComponent(q.trim())}&countryCode=${TIDAL_COUNTRY}&limit=${searchLimit}`;
    const r = await fetch(url, {
      headers: {
        'X-Tidal-Token': TIDAL_TOKEN,
        'Accept': 'application/json',
        'User-Agent': BROWSER_UA,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => r.statusText);
      throw new Error(`TIDAL search returned ${r.status}: ${text.slice(0, 200)}`);
    }

    const data = await r.json();
    const items = data?.items || [];

    // Map to the shape the Groove Android app's TidalSearchTrack DTO expects
    const results = items.map(track => {
      const artistName = track.artists?.map(a => a.name).filter(Boolean).join(', ') || '';
      const albumTitle = track.album?.title || '';
      const albumCover = track.album?.cover
        ? `https://resources.tidal.com/images/${track.album.cover.replace(/-/g, '/')}/640x640.jpg`
        : null;
      const durationMs = (track.duration || 0) * 1000;
      const isrc = track.isrc || null;

      return {
        id: track.id,
        title: track.title || '',
        artist: artistName,
        album: albumTitle,
        albumArt: albumCover,
        durationMs,
        isrc,
      };
    });

    console.log(`[tidal-download/search] "${q}" → ${results.length} results`);
    return res.json({ results });
  } catch (err) {
    console.error('[tidal-download/search] Failed:', err.message);
    return res.status(502).json({ error: 'TIDAL search failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/resolve ─────────────────────────────────────────
// Resolves a Spotify track (by title/artist/ISRC) to a TIDAL direct stream URL.
// Android DownloadWorker polls this before downloading.
router.get('/resolve', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { title, artist, isrc, quality = 'LOSSLESS' } = req.query;
  if (!title || !artist) {
    return res.status(400).json({ error: 'Missing required params: title, artist' });
  }

  try {
    const track = await searchTidal({ title, artist, isrc });
    const { streamUrl, format, quality: resolvedQuality } = await getTidalStreamUrl(track.id, quality);

    const artistName = track.artists?.map(a => a.name).join(', ') || artist;
    const albumTitle = track.album?.title || '';
    const durationMs = (track.duration || 0) * 1000;

    console.log(`[tidal-download/resolve] ✓ "${track.title}" → ${streamUrl.substring(0, 80)}...`);

    return res.json({
      streamUrl,
      tidalTrackId: track.id,
      title: track.title || title,
      artist: artistName,
      album: albumTitle,
      durationMs,
      format,
      quality: resolvedQuality,
    });
  } catch (err) {
    console.error('[tidal-download/resolve] Failed:', err.message);
    return res.status(502).json({
      error: 'Failed to resolve TIDAL stream',
      details: err.message,
    });
  }
});

// ─── GET /api/tidal-download/stream ──────────────────────────────────────────
// Proxies TIDAL CDN audio to the Android device via native Node.js https pipe.
router.get('/stream', (req, res) => {
  const { url: streamUrl } = req.query;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url param' });

  let parsedUrl;
  try {
    parsedUrl = new URL(streamUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid stream URL' });
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = proto.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'audio/flac, audio/mp4, audio/*, */*',
        'Accept-Encoding': 'identity',
      },
    },
    (upstream) => {
      const status = upstream.statusCode || 502;
      if (status >= 400) {
        let body = '';
        upstream.on('data', c => (body += c.toString()));
        upstream.on('end', () => {
          if (!res.headersSent) {
            res.status(status).json({ error: `TIDAL CDN returned ${status}`, hint: status === 401 ? 'Token expired' : undefined });
          }
        });
        return;
      }
      res.status(status);
      const ct = upstream.headers['content-type'] || 'audio/flac';
      const cl = upstream.headers['content-length'];
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Cache-Control', 'no-store');
      upstream.pipe(res);
      req.on('close', () => upstream.destroy());
    }
  );
  proxyReq.on('error', (err) => {
    console.error('[tidal-download/stream] Request error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'CDN connection failed', details: err.message });
  });
  proxyReq.end();
});

// ─── POST /api/tidal-download/zip ────────────────────────────────────────────
// Accepts a list of tracks, downloads them all, and returns a ZIP file.
// Used by the "Download as ZIP" feature in the Android app.
router.post('/zip', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { tracks, playlistName = 'Groove Playlist', quality = 'LOSSLESS' } = req.body || {};
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'Missing tracks array' });
  }
  if (tracks.length > 50) {
    return res.status(400).json({ error: 'Max 50 tracks per ZIP request' });
  }

  console.log(`[tidal-download/zip] Starting ZIP: "${playlistName}" — ${tracks.length} tracks`);

  const safeName = playlistName.replace(/[/\\:*?"<>|]/g, '_').trim();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  let succeeded = 0;
  const errors = [];

  for (const track of tracks) {
    const { title, artist, isrc } = track;
    try {
      const tidalTrack = await searchTidal({ title, artist, isrc });
      const { streamUrl, format } = await getTidalStreamUrl(tidalTrack.id, quality);

      const r = await fetch(streamUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'audio/*,*/*', 'Accept-Encoding': 'identity' },
      });
      if (!r.ok) throw new Error(`CDN returned ${r.status}`);

      const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim();
      const safeArtist = artist.replace(/[/\\:*?"<>|]/g, '_').trim();
      const filename = `${safeArtist} - ${safeTitle}.${format}`;

      // Buffer the audio then append to ZIP (compatible with all Node.js versions)
      const audioBuffer = Buffer.from(await r.arrayBuffer());
      archive.append(audioBuffer, { name: filename });
      succeeded++;
      console.log(`[tidal-download/zip] ✓ Added: ${filename}`);
    } catch (err) {
      console.error(`[tidal-download/zip] ✗ Failed: "${title}" — ${err.message}`);
      errors.push(`❌ ${title} — ${err.message}`);
    }
  }

  if (errors.length > 0) {
    archive.append(errors.join('\n'), { name: '_ERRORS.txt' });
  }

  await archive.finalize();
  console.log(`[tidal-download/zip] Done: ${succeeded}/${tracks.length} tracks`);
});

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
// Use router.use() instead of router.options('*') — path-to-regexp v8 (Node 24)
// rejects all wildcard patterns in named route methods.
router.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || null;
    res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Groove-Api-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

export default router;
