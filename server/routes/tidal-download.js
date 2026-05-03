import express from 'express';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import { getSpotifyTrack } from '../lib/spotifySession.js';

const router = express.Router();

// ─── V2 TIDAL Proxy Mirrors ──────────────────────────────────────────────────
// These mirrors handle TIDAL auth internally — no token needed from our side.
const APP_VERSION = '1.0.0';

const V2_TARGETS = [
  { name: 'squid-api',    baseUrl: 'https://triton.squid.wtf',         weight: 20 },
  { name: 'spotisaver-1', baseUrl: 'https://hifi-one.spotisaver.net',  weight: 20 },
  { name: 'spotisaver-2', baseUrl: 'https://hifi-two.spotisaver.net',  weight: 20 },
  { name: 'kinoplus',     baseUrl: 'https://tidal.kinoplus.online',    weight: 15 },
  { name: 'hund',         baseUrl: 'https://hund.qqdl.site',           weight: 15 },
  { name: 'katze',        baseUrl: 'https://katze.qqdl.site',          weight: 15 },
  { name: 'maus',         baseUrl: 'https://maus.qqdl.site',           weight: 15 },
  { name: 'vogel',        baseUrl: 'https://vogel.qqdl.site',          weight: 15 },
  { name: 'wolf',         baseUrl: 'https://wolf.qqdl.site',           weight: 15 },
  { name: 'monochrome',   baseUrl: 'https://arran.monochrome.tf',      weight: 10 },
];

// Quality levels to try in order — most mirrors don't support LOSSLESS without auth
// so we fall back through progressively lower qualities until one works.
const QUALITY_FALLBACK_CHAIN = ['LOSSLESS', 'HI_RES_LOSSLESS', 'HIGH', 'LOW', 'AAC_320'];

const FALLBACK_BASE = 'https://tidal.401658.xyz';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Weighted random selection of a V2 proxy target.
 */
function selectTarget() {
  const totalWeight = V2_TARGETS.reduce((sum, t) => sum + t.weight, 0);
  let r = Math.random() * totalWeight;
  for (const target of V2_TARGETS) {
    r -= target.weight;
    if (r <= 0) return target;
  }
  return V2_TARGETS[0];
}

/**
 * Build headers for a V2 proxy request.
 * Custom proxies (non-tidal.com, non-monochrome) need X-Client header.
 */
function buildHeaders(target) {
  const headers = {
    'Accept': 'application/json',
    'User-Agent': BROWSER_UA,
  };
  const isCustom = !target.baseUrl.includes('tidal.com') &&
                   !target.baseUrl.includes('monochrome.tf');
  if (isCustom) {
    headers['X-Client'] = `BiniLossless/${APP_VERSION}`;
  }
  return headers;
}

/**
 * Fetch from V2 proxy with automatic retry across multiple mirrors.
 * Tries up to `maxAttempts` different targets before giving up.
 * Uses a longer timeout (20s) since some mirrors are slow.
 */
async function fetchV2(path, maxAttempts = 5) {
  const tried = new Set();
  let lastError = null;

  // Shuffle a fresh copy of targets so each request gets a different order
  const shuffled = [...V2_TARGETS].sort(() => Math.random() - 0.5);

  for (let i = 0; i < Math.min(maxAttempts, shuffled.length); i++) {
    const target = shuffled[i];
    tried.add(target.name);
    const url = `${target.baseUrl.replace(/\/+$/, '')}${path}`;
    try {
      const r = await fetch(url, {
        headers: buildHeaders(target),
        signal: AbortSignal.timeout(20000),  // 20s — some mirrors are slow
      });
      if (r.ok) return { response: r, target };
      console.warn(`[tidal-v2] ${target.name} returned ${r.status} for ${path}`);
      lastError = new Error(`${target.name}: HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[tidal-v2] ${target.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  // Last resort: try fallback base
  try {
    const url = `${FALLBACK_BASE}${path}`;
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return { response: r, target: { name: 'fallback', baseUrl: FALLBACK_BASE } };
    console.warn(`[tidal-v2] Fallback returned ${r.status} for ${path}`);
  } catch (err) {
    console.warn(`[tidal-v2] Fallback also failed: ${err.message}`);
  }

  throw lastError || new Error('All TIDAL proxy mirrors failed');
}

/**
 * Recursively find items array in a nested search response.
 * V2 proxies may nest results differently than the official API.
 */
function findItems(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return null;
  if (visited.has(obj)) return null;
  visited.add(obj);

  if (Array.isArray(obj.items)) return obj.items;

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findItems(val, visited);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Search TIDAL for a track by ISRC or title+artist via V2 proxies.
 * Uses /search/?s=... endpoint (same as web app's LosslessAPI.searchTracks).
 */
async function searchTidal({ title, artist, isrc }) {
  // Build query: prefer ISRC, fall back to title+artist
  const query = isrc || `${title} ${artist}`.trim();
  const path = `/search/?s=${encodeURIComponent(query)}`;

  const { response, target } = await fetchV2(path);
  const data = await response.json();

  // V2 proxies return data in various shapes — find the items array
  const items = findItems(data) || [];
  if (items.length === 0) {
    // If ISRC search returned nothing, retry with title+artist
    if (isrc) {
      return searchTidal({ title, artist, isrc: null });
    }
    throw new Error(`No TIDAL results for: "${query}"`);
  }

  // Best match: prefer exact title match
  const best = items.find(t =>
    t.title?.toLowerCase() === title?.toLowerCase()
  ) || items[0];

  // Normalize artist field
  if (!best.artist && Array.isArray(best.artists) && best.artists.length > 0) {
    best.artist = best.artists[0];
  }

  console.log(`[tidal-v2] Search hit via ${target.name}: "${best.title}" (ID: ${best.id})`);
  return best;
}

/**
 * Decode a base64 manifest string (handles URL-safe base64).
 */
function decodeManifest(manifest) {
  if (!manifest || typeof manifest !== 'string') return '';
  let normalized = manifest.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  if (pad === 3) normalized += '=';
  try {
    return Buffer.from(normalized, 'base64').toString('utf-8');
  } catch {
    return manifest;
  }
}

/**
 * Extract a stream URL from a V2 track response.
 * V2 proxies return the track + stream info in various formats.
 * Handles: direct URL, urls array, manifest (JSON or MPD/XML), nested data.
 */
function extractStreamUrl(data) {
  // V2 container format: { version: "2.x", data: { ... } } or just { ... }
  const container = data?.data ?? data;

  // If it's an array (older format or multi-entry), find any entry with a URL/manifest
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (entry?.manifest) {
        const u = extractFromManifest(entry.manifest);
        if (u) return u;
      }
      if (entry?.url && entry.url.startsWith('http')) return entry.url;
      if (Array.isArray(entry?.urls) && entry.urls[0]?.startsWith('http')) return entry.urls[0];
    }
    return null;
  }

  // Direct URL fields (flat response)
  if (container?.url && typeof container.url === 'string' && container.url.startsWith('http'))
    return container.url;
  if (Array.isArray(container?.urls) && container.urls[0]?.startsWith('http'))
    return container.urls[0];

  // Manifest-based (base64-encoded JSON or MPD XML)
  if (container?.manifest) {
    const u = extractFromManifest(container.manifest);
    if (u) return u;
  }

  // Some mirrors nest under trackPlaybackInfo / streamInfo / track
  for (const key of ['trackPlaybackInfo', 'streamInfo', 'track', 'playbackInfo']) {
    if (container?.[key]) {
      const nested = extractStreamUrl(container[key]);
      if (nested) return nested;
    }
  }

  return null;
}

function extractFromManifest(manifest) {
  const decoded = decodeManifest(manifest);
  if (!decoded) return null;

  // Try JSON format: { urls: ["https://..."] } or { url: "https://..." }
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed.urls) && parsed.urls.length > 0 && parsed.urls[0]?.startsWith('http'))
      return parsed.urls[0];
    if (typeof parsed.url === 'string' && parsed.url.startsWith('http'))
      return parsed.url;
    // Some mirrors: { mimeType, codecs, urls: [...] }
    if (parsed.mimeType && Array.isArray(parsed.urls) && parsed.urls[0])
      return parsed.urls[0];
  } catch { /* not JSON — try XML */ }

  // Try MPD/XML: extract <BaseURL>
  const baseUrlMatch = decoded.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
  if (baseUrlMatch?.[1]) {
    const url = baseUrlMatch[1].trim();
    if (url.startsWith('http')) return url;
  }

  // MPD initialization segment URL
  const initMatch = decoded.match(/initialization="([^"]+)"/i);
  if (initMatch?.[1] && initMatch[1].startsWith('http')) {
    return initMatch[1].split('$')[0]; // strip template suffix
  }

  // Regex fallback: find any URL that looks like a full audio file
  const urlRegex = /https?:\/\/[\w\-.~:?#[\]@!$&'()*+,;=%/]+/g;
  let match;
  while ((match = urlRegex.exec(decoded)) !== null) {
    const url = match[0].replace(/[)"']+$/, ''); // strip trailing punctuation
    if (url.includes('$Number$')) continue;  // template, not direct
    if (/\/\d+\.mp4$/.test(url)) continue;  // segment chunk, not full file
    if (url.includes('.flac') || url.includes('.mp4') || url.includes('.m4a') ||
        url.includes('.aac') || url.includes('token=') || url.includes('/audio/') ||
        url.includes('tidal.com/')) {
      return url;
    }
  }

  return null;
}

/**
 * Get a TIDAL stream URL for a track ID via V2 proxies.
 * Tries multiple quality levels in sequence — most mirrors don't support LOSSLESS
 * without auth, so we fall back to HIGH/LOW until we get a working stream URL.
 *
 * @param {number|string} trackId - TIDAL track ID
 * @param {string} preferredQuality - Preferred quality ('LOSSLESS', 'HIGH', 'LOW')
 * @returns {{ streamUrl: string, format: string, quality: string }}
 */
async function getTidalStreamUrl(trackId, preferredQuality = 'LOSSLESS') {
  // Build quality fallback chain starting from preferred quality
  const startIdx = QUALITY_FALLBACK_CHAIN.indexOf(preferredQuality);
  const qualitiesToTry = startIdx >= 0
    ? QUALITY_FALLBACK_CHAIN.slice(startIdx)
    : QUALITY_FALLBACK_CHAIN;

  let lastError = null;

  for (const tidalQuality of qualitiesToTry) {
    // Try two URL formats that different mirrors accept:
    // Format A: /track/?id=<id>&quality=<quality>  (most mirrors)
    // Format B: /track/<id>?quality=<quality>       (some mirrors use path segment)
    const pathsToTry = [
      `/track/?id=${trackId}&quality=${tidalQuality}`,
      `/track/${trackId}?quality=${tidalQuality}`,
    ];

    for (const path of pathsToTry) {
      try {
        const { response, target } = await fetchV2(path, 3);
        const data = await response.json();

        // Log response shape to help debug future issues
        const topKeys = Object.keys(data || {}).join(', ');
        console.log(`[tidal-v2] ${target.name} (${tidalQuality}) response keys: [${topKeys}]`);

        const streamUrl = extractStreamUrl(data);
        if (streamUrl) {
          const isLossless = tidalQuality === 'LOSSLESS' || tidalQuality === 'HI_RES_LOSSLESS';
          const format = isLossless ? 'flac' : 'm4a';
          console.log(`[tidal-v2] ✓ Stream URL via ${target.name} @ ${tidalQuality}: ${streamUrl.substring(0, 80)}...`);
          return { streamUrl, format, quality: tidalQuality };
        }

        console.warn(`[tidal-v2] ${target.name} returned no extractable URL for track ${trackId} @ ${tidalQuality}`);
        console.warn(`[tidal-v2] Raw data sample: ${JSON.stringify(data).substring(0, 300)}`);
      } catch (err) {
        console.warn(`[tidal-v2] ${tidalQuality}/${path} failed: ${err.message}`);
        lastError = err;
      }
    }
  }

  throw lastError || new Error(`No working stream URL found for track ${trackId} after trying all qualities`);
}

// ─── GET /api/tidal-download/search ──────────────────────────────────────────
// Free-text search across TIDAL via V2 proxy mirrors.
// Used by Groove Android app's search screen.
// Returns results matching the TidalSearchTrack DTO shape the app expects.
router.get('/search', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing required query param: q' });
  }

  try {
    // Use V2 proxy search endpoint: /search/?s=...
    const path = `/search/?s=${encodeURIComponent(q.trim())}`;
    const { response, target } = await fetchV2(path);
    const data = await response.json();

    // V2 proxies return data in various nested shapes — find the items array
    const items = findItems(data) || [];

    // Map to the shape the Groove Android app's TidalSearchTrack DTO expects
    const searchLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const results = items.slice(0, searchLimit).map(track => {
      // Normalize artists — V2 proxies use `artists` array, may or may not have `artist`
      const artistName = track.artists?.map(a => a.name).filter(Boolean).join(', ')
                      || track.artist?.name
                      || '';
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

    console.log(`[tidal-v2/search] "${q}" via ${target.name} → ${results.length} results`);
    return res.json({ results });
  } catch (err) {
    console.error('[tidal-v2/search] Failed:', err.message);
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
