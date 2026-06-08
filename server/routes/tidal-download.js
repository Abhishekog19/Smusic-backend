import express from 'express';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import { getSpotifyTrack } from '../lib/spotifySession.js';
import { getLiveMirrors, FALLBACK_MIRRORS } from '../lib/mirrorDiscovery.js';

const router = express.Router();

// ─── V2 TIDAL Proxy Mirrors ──────────────────────────────────────────────────
// IMPORTANT: The static list below is kept ONLY as an emergency in-process fallback.
// ALL previously hardcoded mirrors (squid.wtf, spotisaver.net, qqdl.site etc.)
// are confirmed DEAD as of 2026-06-08 per Cloudflare Worker uptime checks.
// fetchV2() now calls getLiveMirrors() to get fresh mirror URLs at runtime.
const APP_VERSION = '1.0.0';
const FALLBACK_BASE = 'https://eu-central.monochrome.tf'; // was tidal.401658.xyz (dead)
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildHeaders(target) {
  const headers = { 'Accept': 'application/json', 'User-Agent': BROWSER_UA };
  const isCustom = !target.baseUrl.includes('tidal.com') && !target.baseUrl.includes('monochrome.tf');
  if (isCustom) headers['X-Client'] = `BiniLossless/${APP_VERSION}`;
  return headers;
}

/**
 * Fetch from V2 proxy with automatic retry across multiple mirrors.
 * Dynamically fetches the live mirror list from Cloudflare Workers (cached 15 min).
 * Tries up to `maxAttempts` different targets before giving up.
 */
async function fetchV2(path, maxAttempts = 10) {
  // Get live mirrors (cached for 15 min, auto-refreshed by mirrorDiscovery)
  const liveMirrors = await getLiveMirrors().catch(() => FALLBACK_MIRRORS);
  const targets = liveMirrors.length > 0 ? liveMirrors : FALLBACK_MIRRORS;

  const tried = new Set();
  let lastError = null;

  for (let i = 0; i < Math.min(maxAttempts, targets.length * 2); i++) {
    // Weighted random selection from live mirrors
    const totalWeight = targets.reduce((sum, t) => sum + (t.weight || 15), 0);
    let r = Math.random() * totalWeight;
    let target = targets[0];
    for (const t of targets) {
      r -= (t.weight || 15);
      if (r <= 0) { target = t; break; }
    }

    if (tried.has(target.name) && tried.size < targets.length) {
      // Already tried this one, find an untried mirror
      const fallback = targets.find(t => !tried.has(t.name));
      if (fallback) target = fallback;
    }

    tried.add(target.name);
    const url = `${target.baseUrl.replace(/\/+$/, '')}${path}`;
    try {
      const r = await fetch(url, { headers: buildHeaders(target), signal: AbortSignal.timeout(12000) });
      if (r.ok) return { response: r, target };
      console.warn(`[tidal-v2] ${target.name} returned ${r.status} for ${path}`);
      lastError = new Error(`${target.name}: HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[tidal-v2] ${target.name} failed: ${err.message}`);
      lastError = err;
    }

    // All unique mirrors tried — stop early
    if (tried.size >= targets.length) break;
  }

  // Last resort: try fallback base
  try {
    const url = `${FALLBACK_BASE}${path}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { response: r, target: { name: 'fallback', baseUrl: FALLBACK_BASE } };
  } catch (err) {
    console.warn(`[tidal-v2] Fallback also failed: ${err.message}`);
  }

  throw lastError || new Error('All TIDAL proxy mirrors failed');
}

/**
 * Recursively find items array in a nested search response.
 * Handles shapes: { items: [...] }, { data: [...] }, { data: { items: [...] } }, bare [...]
 */
function findItems(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && (obj[0]?.id !== undefined || obj[0]?.title !== undefined)) return obj;
    return null;
  }
  if (visited.has(obj)) return null;
  visited.add(obj);
  if (Array.isArray(obj.items) && obj.items.length > 0) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findItems(val, visited);
      if (found) return found;
    }
  }
  return null;
}

async function searchTidal({ title, artist, isrc }) {
  const query = isrc || `${title} ${artist}`.trim();
  const path = `/search/?s=${encodeURIComponent(query)}`;
  const { response, target } = await fetchV2(path);
  const data = await response.json();
  const items = findItems(data) || [];
  if (items.length === 0) {
    if (isrc) return searchTidal({ title, artist, isrc: null });
    throw new Error(`No TIDAL results for: "${query}"`);
  }
  const best = items.find(t => t.title?.toLowerCase() === title?.toLowerCase()) || items[0];
  if (!best.artist && Array.isArray(best.artists) && best.artists.length > 0) {
    best.artist = best.artists[0];
  }
  console.log(`[tidal-v2] Search hit via ${target.name}: "${best.title}" (ID: ${best.id})`);
  return best;
}

function decodeManifest(manifest) {
  if (!manifest || typeof manifest !== 'string') return '';
  let normalized = manifest.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  if (pad === 3) normalized += '=';
  try { return Buffer.from(normalized, 'base64').toString('utf-8'); } catch { return manifest; }
}

function extractFromManifest(manifest) {
  const decoded = decodeManifest(manifest);

  // Guard: detect segmented DASH (SegmentTemplate) — cannot extract a single URL from these.
  // Returning null signals the caller to skip this manifest format.
  if (/<SegmentTemplate/i.test(decoded)) {
    console.warn('[tidal-v2] Segmented DASH manifest detected — cannot extract single stream URL');
    return null;
  }

  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed.urls) && parsed.urls.length > 0) return parsed.urls[0];
  } catch { /* not JSON */ }
  const baseUrlMatch = decoded.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
  if (baseUrlMatch?.[1]) {
    const url = baseUrlMatch[1].trim();
    if (url.startsWith('http')) return url;
  }
  const urlRegex = /https?:\/\/[\w\-.~:?#[\]@!$&'()*+,;=%/]+/g;
  let match;
  while ((match = urlRegex.exec(decoded)) !== null) {
    const url = match[0];
    if (url.includes('$Number$')) continue;
    if (/\/\d+\.mp4/.test(url)) continue;
    if (url.includes('.flac') || url.includes('.mp4') || url.includes('.m4a') ||
      url.includes('token=') || url.includes('/audio/')) {
      return url;
    }
  }
  return null;
}

function extractStreamUrl(data) {
  const container = data?.data ?? data;
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (entry?.manifest) return extractFromManifest(entry.manifest);
      if (entry?.url) return entry.url;
      if (entry?.urls?.[0]) return entry.urls[0];
    }
    return null;
  }
  if (container?.url) return container.url;
  if (container?.urls?.[0]) return container.urls[0];
  if (container?.manifest) return extractFromManifest(container.manifest);
  return null;
}

async function getTidalStreamUrl(trackId, quality = 'LOSSLESS') {
  const qualityMap = { LOSSLESS: 'LOSSLESS', HI_RES: 'HI_RES_LOSSLESS', HI_RES_LOSSLESS: 'HI_RES_LOSSLESS', HIGH: 'HIGH', LOW: 'LOW' };
  const tidalQuality = qualityMap[quality] || 'LOSSLESS';
  const path = `/track/?id=${trackId}&quality=${tidalQuality}`;
  const { response, target } = await fetchV2(path);
  const data = await response.json();
  const streamUrl = extractStreamUrl(data);
  if (!streamUrl) throw new Error(`No stream URL found in ${target.name} response for track ${trackId}`);
  const format = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
  console.log(`[tidal-v2] Stream URL via ${target.name}: ${streamUrl.substring(0, 80)}...`);
  return { streamUrl, format, quality: tidalQuality };
}

/**
 * Quality fallback chain: tries from the requested quality downward.
 * HI_RES_LOSSLESS → LOSSLESS → HIGH → LOW
 */
async function getTidalStreamUrlWithFallback(trackId, preferredQuality = 'LOSSLESS') {
  const allQualities = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
  const startIndex = allQualities.indexOf(preferredQuality);
  // Start from the requested quality (or LOSSLESS if not found)
  const chain = allQualities.slice(startIndex >= 0 ? startIndex : 1);

  let lastError;
  for (const q of chain) {
    try {
      const result = await getTidalStreamUrl(trackId, q);
      if (result.streamUrl) {
        if (q !== preferredQuality) {
          console.log(`[tidal-v2] Quality fallback: ${preferredQuality} → ${q} for track ${trackId}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`[tidal-v2] Quality ${q} failed for track ${trackId}: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error(`No playable quality available for track ${trackId}`);
}

// ─── GET /api/tidal-download/search ──────────────────────────────────────────
router.get('/search', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing required query param: q' });

  try {
    const path = `/search/?s=${encodeURIComponent(q.trim())}`;
    const { response, target } = await fetchV2(path);
    const data = await response.json();
    const items = findItems(data) || [];
    const searchLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const results = items.slice(0, searchLimit).map(track => {
      const artistName = track.artists?.map(a => a.name).filter(Boolean).join(', ')
        || track.artist?.name || '';
      const albumTitle = track.album?.title || '';
      const albumCover = track.album?.cover
        ? `https://resources.tidal.com/images/${track.album.cover.replace(/-/g, '/')}/640x640.jpg`
        : null;
      const durationMs = (track.duration || 0) * 1000;
      return {
        id: track.id,
        title: track.title || '',
        artist: artistName,
        album: albumTitle,
        albumArt: albumCover,
        albumCoverId: track.album?.cover || null,
        audioQuality: track.audioQuality || 'LOSSLESS',
        durationMs,
        isrc: track.isrc || null,
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
router.get('/resolve', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { title, artist, isrc, quality = 'LOSSLESS', tidalId } = req.query;

  // tidalId shortcut: when the frontend already knows the track ID from a prior search,
  // skip searchTidal() entirely — saves ~2-3 seconds and one mirror round-trip.
  const resolveId = tidalId ? String(tidalId).trim() : null;
  if (!resolveId && (!title || !artist)) {
    return res.status(400).json({ error: 'Missing required params: tidalId or (title + artist)' });
  }

  try {
    let trackId = resolveId;
    let trackMeta = { title, artist };

    if (!trackId) {
      // No ID provided — fall back to search
      const track = await searchTidal({ title, artist, isrc });
      trackId = track.id;
      trackMeta = {
        title: track.title || title,
        artist: track.artists?.map(a => a.name).join(', ') || artist,
        album: track.album?.title || '',
        durationMs: (track.duration || 0) * 1000,
      };
    }

    // Use quality fallback chain: HI_RES_LOSSLESS → LOSSLESS → HIGH → LOW
    const { streamUrl, format, quality: resolvedQuality } = await getTidalStreamUrlWithFallback(trackId, quality);

    console.log(`[tidal-download/resolve] ✓ ID:${trackId} (${resolvedQuality}) → ${streamUrl.substring(0, 80)}...`);
    return res.json({
      streamUrl,
      tidalTrackId: trackId,
      title: trackMeta.title || title || '',
      artist: trackMeta.artist || artist || '',
      album: trackMeta.album || '',
      durationMs: trackMeta.durationMs || 0,
      format,
      quality: resolvedQuality,
    });
  } catch (err) {
    console.error('[tidal-download/resolve] Failed:', err.message);
    // 403 from all mirrors = TIDAL has banned public mirror accounts (known issue per hifi-api README).
    // Give a clear message instead of a cryptic proxy error.
    const isMirrorBan = err.message?.includes('403') || err.message?.includes('Forbidden');
    const userMessage = isMirrorBan
      ? 'TIDAL streaming temporarily unavailable — provider accounts are being blocked. Try again later.'
      : 'Failed to resolve TIDAL stream';
    return res.status(502).json({ error: userMessage, details: err.message });
  }
});

// ─── GET /api/tidal-download/stream ──────────────────────────────────────────
// CRITICAL: ExoPlayer sends "Range: bytes=X-Y" for seeking — must be forwarded.
router.get('/stream', (req, res) => {
  const { url: streamUrl } = req.query;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url param' });

  let parsedUrl;
  try { parsedUrl = new URL(streamUrl); } catch { return res.status(400).json({ error: 'Invalid stream URL' }); }

  const upstreamHeaders = {
    'User-Agent': BROWSER_UA,
    'Accept': 'audio/flac, audio/mp4, audio/*, */*',
    'Accept-Encoding': 'identity',
  };
  if (req.headers['range']) {
    upstreamHeaders['Range'] = req.headers['range'];
    console.log(`[tidal/stream] Forwarding Range: ${req.headers['range']}`);
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = proto.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: upstreamHeaders,
    },
    (upstream) => {
      const status = upstream.statusCode || 502;
      if (status >= 400) {
        let body = '';
        upstream.on('data', c => (body += c.toString()));
        upstream.on('end', () => {
          if (!res.headersSent) res.status(status).json({ error: `TIDAL CDN returned ${status}`, hint: status === 401 ? 'Stream URL expired — resolve again' : undefined });
        });
        return;
      }
      res.status(status);
      const ct = upstream.headers['content-type'] || 'audio/flac';
      const cl = upstream.headers['content-length'];
      const cr = upstream.headers['content-range'];
      const ar = upstream.headers['accept-ranges'];
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Accept-Ranges', ar || 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
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
router.post('/zip', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { tracks, playlistName = 'Groove Playlist', quality = 'LOSSLESS' } = req.body || {};
  if (!Array.isArray(tracks) || tracks.length === 0) return res.status(400).json({ error: 'Missing tracks array' });
  if (tracks.length > 50) return res.status(400).json({ error: 'Max 50 tracks per ZIP request' });

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
      const r = await fetch(streamUrl, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'audio/*,*/*', 'Accept-Encoding': 'identity' } });
      if (!r.ok) throw new Error(`CDN returned ${r.status}`);
      const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim();
      const safeArtist = artist.replace(/[/\\:*?"<>|]/g, '_').trim();
      const filename = `${safeArtist} - ${safeTitle}.${format}`;
      const audioBuffer = Buffer.from(await r.arrayBuffer());
      archive.append(audioBuffer, { name: filename });
      succeeded++;
      console.log(`[tidal-download/zip] ✓ Added: ${filename}`);
    } catch (err) {
      console.error(`[tidal-download/zip] ✗ Failed: "${title}" — ${err.message}`);
      errors.push(`❌ ${title} — ${err.message}`);
    }
  }

  if (errors.length > 0) archive.append(errors.join('\n'), { name: '_ERRORS.txt' });
  await archive.finalize();
  console.log(`[tidal-download/zip] Done: ${succeeded}/${tracks.length} tracks`);
});

// ─── GET /api/tidal-download/cover ────────────────────────────────────────────
router.get('/cover', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { id, q, size = '640' } = req.query;
  if (!id && !q) return res.status(400).json({ error: 'Missing required param: id or q' });

  try {
    const safeSizes = ['80', '160', '320', '640', '1280'];
    const sz = safeSizes.includes(size) ? size : '640';

    if (id) {
      const { title: titleQ, artist: artistQ } = req.query;
      const searchQuery = titleQ ? `${titleQ} ${artistQ || ''}`.trim() : null;
      if (searchQuery) {
        const path = `/search/?s=${encodeURIComponent(searchQuery)}`;
        const { response } = await fetchV2(path);
        const data = await response.json();
        const items = findItems(data) || [];
        const track = items.find(t => String(t.id) === String(id)) ?? items[0] ?? null;
        const coverUuid = track?.album?.cover ?? null;
        if (!coverUuid) return res.status(404).json({ error: 'No cover found for this track' });
        const coverUrl = `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg`;
        const videoCoverUuid = track?.album?.videoCover ?? null;
        const videoCoverUrl = videoCoverUuid ? `https://resources.tidal.com/videos/${videoCoverUuid.replace(/-/g, '/')}/${sz}x${sz}.mp4` : null;
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.json({ coverUrl, videoCoverUrl, coverUuid, videoCoverUuid });
      }
    }

    const path = `/search/?s=${encodeURIComponent(q.trim())}`;
    const { response } = await fetchV2(path);
    const data = await response.json();
    const items = findItems(data) || [];
    if (items.length === 0) return res.status(404).json({ error: 'No results found for query' });
    const best = items[0];
    const coverUuid = best?.album?.cover ?? null;
    if (!coverUuid) return res.status(404).json({ error: 'No cover found in search results' });
    const coverUrl = `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg`;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json({ coverUrl, coverUuid });
  } catch (err) {
    console.error('[tidal-download/cover]', err.message);
    return res.status(502).json({ error: 'Cover fetch failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/song ─────────────────────────────────────────────
router.get('/song', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, quality = 'LOSSLESS' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing required param: q' });

  try {
    const path = `/song/?q=${encodeURIComponent(q.trim())}&quality=${quality}`;
    const { response, target } = await fetchV2(path);
    if (!response.ok) return res.status(response.status).json({ error: `Proxy returned ${response.status}` });
    const data = await response.json();
    console.log(`[tidal-download/song] "${q}" via ${target.name}`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(data);
  } catch (err) {
    console.error('[tidal-download/song]', err.message);
    return res.status(502).json({ error: 'Song fetch failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/track-metadata ───────────────────────────────────
router.get('/track-metadata', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { id, size = '640' } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing required param: id' });

  const safeSizes = ['320', '640', '1280'];
  const sz = safeSizes.includes(size) ? size : '640';

  try {
    const { title: titleQ, artist: artistQ } = req.query;
    const searchQuery = titleQ ? `${titleQ} ${artistQ || ''}`.trim() : String(id);
    const searchPath = `/search/?s=${encodeURIComponent(searchQuery)}`;
    const { response, target } = await fetchV2(searchPath);
    if (!response.ok) return res.status(response.status).json({ error: `Proxy returned ${response.status}` });
    const data = await response.json();
    const items = findItems(data) || [];
    const track = items.find(t => String(t.id) === String(id))
      ?? items.find(t => t.title?.toLowerCase() === titleQ?.toLowerCase())
      ?? items[0] ?? null;
    if (!track) return res.status(404).json({ error: `Track ${id} not found in proxy search results` });

    const album = track.album ?? {};
    const artist = track.artist ?? track.artists?.[0] ?? {};
    const coverUuid = album.cover ?? null;
    const videoCoverUuid = album.videoCover ?? null;
    const artistPicUuid = artist.picture ?? null;
    const coverUrl = coverUuid ? `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg` : null;
    const videoCoverUrl = videoCoverUuid ? `https://resources.tidal.com/videos/${videoCoverUuid.replace(/-/g, '/')}/${sz}x${sz}.mp4` : null;
    const artistPicUrl = artistPicUuid ? `https://resources.tidal.com/images/${artistPicUuid.replace(/-/g, '/')}/750x750.jpg` : null;
    const durationSec = track.duration ?? 0;
    const mins = Math.floor(durationSec / 60);
    const secs = Math.floor(durationSec % 60);

    const result = { tidalId: Number(id), title: track.title ?? '', artist: artist.name ?? '', album: album.title ?? '', coverUrl, videoCoverUrl, artistPicUrl, duration: `${mins}:${String(secs).padStart(2, '0')}`, durationSeconds: durationSec };
    console.log(`[tidal-download/track-metadata] ID ${id} via ${target.name} — cover: ${!!coverUrl}, video: ${!!videoCoverUrl}`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(result);
  } catch (err) {
    console.error('[tidal-download/track-metadata]', err.message);
    return res.status(502).json({ error: 'Track metadata fetch failed', details: err.message });
  }
});

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
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
