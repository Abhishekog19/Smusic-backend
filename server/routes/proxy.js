import express from 'express';
import { createHash } from 'crypto';
import { getRedisClient } from '../lib/redis.js';
import { isProxyTarget, isOriginAllowed } from '../lib/proxyConfig.js';

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

export default router;
