import express from 'express';
import { createHash } from 'crypto';
import { getRedisClient } from '../lib/redis.js';
import { isProxyTarget, isOriginAllowed } from '../lib/proxyConfig.js';
import dashParser from '../lib/dashParser.js';
import { getTidalHeaders } from '../lib/proxyUtils.js';
import { apiInstanceManager } from '../lib/apiInstances.js';
import RetryManager from '../lib/retryManager.js';

const router = express.Router();

const CACHE_NAMESPACE = 'api:proxy:v2:';
const DEFAULT_TTL = 300;
const SEARCH_TTL = 300;
const TRACK_TTL = 120;
const MAX_CACHE_BYTES = 200_000;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
]);

function getCacheTtl(url) {
  const path = url.pathname.toLowerCase();
  if (path.includes('/search')) return SEARCH_TTL;
  if (path.includes('/track') || path.includes('/song')) return TRACK_TTL;
  return DEFAULT_TTL;
}

function createCacheKey(url, acceptHeader = '', rangeHeader = '') {
  const material = `${url.toString()}|${acceptHeader}|${rangeHeader}`;
  return `${CACHE_NAMESPACE}${createHash('sha256').update(material).digest('hex')}`;
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

router.get('/', async (req, res) => {
  const origin = req.headers.origin || null;
  const targetUrl = req.query.url;

  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  if (!isProxyTarget(parsedUrl)) {
    return res.status(400).json({ error: 'Target host not allowed' });
  }

  const hasRange = !!req.headers.range;
  const hasAuth = !!req.headers.authorization;
  const hasCookie = !!req.headers.cookie;
  const shouldCache = !hasRange && !hasAuth && !hasCookie;

  const upstreamHeaders = {
    'user-agent': 'Antigravity/1.0',
    'accept-encoding': 'identity',
    'accept': req.headers.accept || 'application/json',
  };
  if (hasAuth) upstreamHeaders['authorization'] = req.headers.authorization;

  const redis = getRedisClient();
  const cacheKey = shouldCache ? createCacheKey(parsedUrl, req.headers.accept || '', '') : null;

  // Check cache
  if (cacheKey && redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const { status, headers, bodyBase64, timestamp } = JSON.parse(cached);
        const age = Math.round((Date.now() - timestamp) / 1000);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Age', `${age}s`);
        Object.entries(sanitizeHeaders(headers)).forEach(([k, v]) => res.setHeader(k, v));
        return res.status(status).json(JSON.parse(Buffer.from(bodyBase64, 'base64').toString()));
      }
    } catch { /* cache miss */ }
  }

  // Fetch upstream — use Promise.race for reliable timeout (AbortController
  // doesn't always abort established TCP connections in Node.js)
  const TIMEOUT_MS = 10_000;
  const timeoutError = () =>
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Upstream request timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
    );

  try {
    const controller = new AbortController();
    const fetchPromise = fetch(parsedUrl.toString(), {
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });

    let response;
    try {
      response = await Promise.race([fetchPromise, timeoutError()]);
    } catch (err) {
      controller.abort();
      throw err;
    }

    // Also timeout the body read
    let buffer;
    try {
      buffer = await Promise.race([response.arrayBuffer(), timeoutError()]);
    } catch (err) {
      throw new Error(`Body read timed out: ${err.message}`);
    }
    const bodyBytes = Buffer.from(buffer);
    const bodyText = bodyBytes.toString();

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return res.status(response.status).send(bodyText);
    }

    // Cache the response
    if (cacheKey && redis && response.status === 200 && bodyBytes.length <= MAX_CACHE_BYTES) {
      const ttl = getCacheTtl(parsedUrl);
      const cacheControl = response.headers.get?.('cache-control') || '';
      const skip = cacheControl.includes('no-store') || cacheControl.includes('private');
      if (!skip) {
        const entry = {
          status: response.status,
          headers: sanitizeHeaders(Object.fromEntries(response.headers.entries?.() || [])),
          bodyBase64: bodyBytes.toString('base64'),
          timestamp: Date.now(),
        };
        await redis.setex(cacheKey, ttl, JSON.stringify(entry)).catch(() => {});
      }
    }

    res.setHeader('X-Cache', 'MISS');
    return res.status(response.status).json(body);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: 'Proxy request failed', details: err.message });
  }
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

// ─── TIDAL Typed Routes (Phase 1-3) ──────────────────────────────────────────
// These named routes replace direct TIDAL API calls from the frontend.
// They handle both DASH XML manifests and direct-URL manifests, with
// automatic token injection and multi-instance retry/failover.

// Lazily initialised — mirrors load on first request
let _retryManager = null;
async function getRetryManager() {
  if (!_retryManager) {
    const instances = await apiInstanceManager.getInstances('api');
    _retryManager = new RetryManager(instances);
    console.log(`[proxy] RetryManager initialised with ${instances.length} mirrors`);
  }
  return _retryManager;
}

/** Safely get a valid token from the token manager (optional — no crash if missing) */
async function tryGetToken(req) {
  try {
    const tm = req.app.get('tokenManager');
    if (tm) return await tm.getValidToken();
  } catch (err) {
    console.warn('[proxy] Token manager error:', err.message);
  }
  return null;
}

/**
 * GET /api/proxy/track/:id
 * Resolves a TIDAL track to a playable stream URL.
 * Handles both direct-URL and DASH XML manifest formats.
 */
router.get('/track/:id', async (req, res) => {
  const { id: trackId } = req.params;
  const quality = req.query.quality || 'LOSSLESS';
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  if (!trackId) return res.status(400).json({ error: 'Track ID required' });

  console.log(`\n[proxy/track] ID: ${trackId}, Quality: ${quality}`);

  try {
    const rm    = await getRetryManager();
    const token = await tryGetToken(req);
    const endpoint = `/v1/tracks/${trackId}/streamUrl?quality=${quality}`;

    const response = await rm.executeWithRetry(endpoint, {
      headers: getTidalHeaders({ ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }),
    });

    const manifest = await response.json();

    // Format A: Direct URL (simple, most common)
    if (dashParser.isDirectUrlManifest(manifest)) {
      console.log('[proxy/track] ✅ Direct URL format');
      return res.json({
        type:       'direct',
        url:        manifest.urls[0],
        bitDepth:   manifest.bitDepth   ?? null,
        sampleRate: manifest.sampleRate ?? null,
        quality,
      });
    }

    // Format B: DASH XML manifest (base64-encoded)
    if (dashParser.isDashManifest(manifest)) {
      console.log('[proxy/track] ✅ DASH XML format — parsing...');
      try {
        const dashManifest  = await dashParser.parseManifest(manifest.manifest);
        const segmentUrls   = dashParser.generateSegmentUrls(dashManifest);
        console.log(`[proxy/track] Generated ${segmentUrls.length} segment URLs`);

        return res.json({
          type:         'dash',
          baseUrl:      dashManifest.baseUrl,
          initialization: dashManifest.initialization,
          media:        dashManifest.media,
          segmentUrls,
          mimeType:     dashManifest.mimeType,
          codecs:       dashManifest.codecs,
          quality,
        });
      } catch (dashErr) {
        console.error('[proxy/track] DASH parse failed:', dashErr.message);
        return res.status(502).json({ error: 'DASH manifest parse failed', details: dashErr.message });
      }
    }

    // Unknown format
    console.warn('[proxy/track] Unknown manifest format, keys:', Object.keys(manifest));
    return res.status(400).json({ error: 'Unknown manifest format', keys: Object.keys(manifest) });

  } catch (err) {
    console.error('[proxy/track] Error:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Track not found' });
    if (err.status === 401) return res.status(401).json({ error: 'Authentication failed' });
    return res.status(503).json({
      error:   'Failed to resolve track from all TIDAL mirrors',
      details: err.message,
    });
  }
});

/**
 * GET /api/proxy/search?q=…&limit=20
 * Search TIDAL via proxy mirrors.
 */
router.get('/search', async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  if (!query?.trim()) return res.status(400).json({ error: 'Search query required (param: q)' });

  console.log(`[proxy/search] Query: "${query}", Limit: ${limit}`);

  try {
    const rm    = await getRetryManager();
    const token = await tryGetToken(req);
    const endpoint = `/v1/search?query=${encodeURIComponent(query.trim())}&limit=${limit}&types=TRACKS`;

    const response = await rm.executeWithRetry(endpoint, {
      headers: getTidalHeaders({ ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }),
    });

    const results = await response.json();
    console.log(`[proxy/search] ✅ Results received`);
    return res.json(results);

  } catch (err) {
    console.error('[proxy/search] Error:', err.message);
    return res.status(503).json({ error: 'Search failed', details: err.message });
  }
});

/**
 * GET /api/proxy/album/:id
 * Get album info from TIDAL.
 */
router.get('/album/:id', async (req, res) => {
  const { id: albumId } = req.params;
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  console.log(`[proxy/album] ID: ${albumId}`);

  try {
    const rm    = await getRetryManager();
    const token = await tryGetToken(req);

    const response = await rm.executeWithRetry(`/v1/albums/${albumId}`, {
      headers: getTidalHeaders({ ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }),
    });

    const album = await response.json();
    console.log(`[proxy/album] ✅ Loaded`);
    return res.json(album);

  } catch (err) {
    console.error('[proxy/album] Error:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Album not found' });
    return res.status(503).json({ error: 'Album fetch failed', details: err.message });
  }
});

/**
 * GET /api/proxy/artist/:id
 * Get artist info from TIDAL.
 */
router.get('/artist/:id', async (req, res) => {
  const { id: artistId } = req.params;
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  try {
    const rm    = await getRetryManager();
    const token = await tryGetToken(req);

    const response = await rm.executeWithRetry(`/v1/artists/${artistId}`, {
      headers: getTidalHeaders({ ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }),
    });

    const artist = await response.json();
    return res.json(artist);

  } catch (err) {
    console.error('[proxy/artist] Error:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Artist not found' });
    return res.status(503).json({ error: 'Artist fetch failed', details: err.message });
  }
});

/**
 * GET /api/proxy/retry-status
 * Monitoring endpoint — shows per-mirror failure tracking.
 */
router.get('/retry-status', async (req, res) => {
  try {
    const rm = await getRetryManager();
    return res.json({
      instances: rm.getStatus(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

export default router;

