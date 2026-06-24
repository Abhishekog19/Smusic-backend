  /**
 * amazon.js — Amazon Music Backend Routes
 *
 * Routes:
 *   POST /api/amazon/exchange-turnstile  — Exchanges CF Turnstile token → JWT (cached server-side)
 *   GET  /api/amazon/status              — Check JWT / rate-limit status
 *   GET  /api/amazon/jwt                 — Returns the raw JWT so frontend can call amz.geeked.wtf directly
 *   GET  /api/amazon/asin               — Server-side ASIN lookup (t2a.geeked.wtf works from server)
 *   POST /api/amazon/clear-jwt           — Reset JWT + rate-limit state
 *
 * Architecture note:
 *   The Turnstile JWT exchange and ASIN lookup work fine from Node.js (server-side).
 *   However, the stream URL fetch (amz.geeked.wtf/api/track) must be done from the
 *   BROWSER because Cloudflare bot detection blocks server-side Node.js requests.
 *   This matches the Monochrome architecture exactly — it calls amz.geeked.wtf directly
 *   from the browser frontend.
 */

import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import {
  exchangeTurnstileToken,
  getAmazonStatus,
  clearCachedJwt,
  clearRateLimit,
  getCachedJwt,
  searchAmazonAsin,
  setRateLimited,
} from '../lib/amazonMusicProxy.js';

const router = express.Router();

// ── CORS helper ──────────────────────────────────────────────────────────────
function setCors(req, res) {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── OPTIONS preflight ─────────────────────────────────────────────────────────
router.options('{*path}', (req, res) => {
  setCors(req, res);
  res.status(204).end();
});

// ── POST /api/amazon/exchange-turnstile ───────────────────────────────────────
// Frontend sends { token: "cf_turnstile_response..." } after Turnstile challenge.
// Backend forwards to amz.geeked.wtf → gets JWT → caches it server-side.
router.post('/exchange-turnstile', async (req, res) => {
  setCors(req, res);

  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return res.status(400).json({ error: 'Missing or invalid Turnstile token' });
  }

  try {
    await exchangeTurnstileToken(token.trim());
    const status = getAmazonStatus();
    console.log(`[amazon-route] ✅ Turnstile JWT cached (expires in ${status.jwtExpiresIn}s)`);
    return res.json({
      ok:        true,
      expiresIn: status.jwtExpiresIn,
    });
  } catch (err) {
    console.error('[amazon-route] Turnstile exchange failed:', err.message);

    const isTokenRejected = err.message?.includes('rejected') || err.message?.includes('HTTP 403') || err.message?.includes('HTTP 401');
    const isRateLimit     = err.message?.includes('rate-limited') || err.message?.includes('429');

    const statusCode = isRateLimit ? 429 : isTokenRejected ? 401 : 502;
    return res.status(statusCode).json({
      ok:    false,
      error: isRateLimit
        ? 'Amazon Music is temporarily rate limited. Try again in 30 minutes.'
        : `Turnstile exchange failed: ${err.message}`,
    });
  }
});

// ── GET /api/amazon/status ────────────────────────────────────────────────────
// Returns current JWT/rate-limit status so the frontend knows when to show
// the Turnstile widget again.
router.get('/status', (_req, res) => {
  setCors(_req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json(getAmazonStatus());
});

// ── GET /api/amazon/jwt ───────────────────────────────────────────────────────
// audioPlayer.js calls this to retrieve the cached JWT so it can call
// amz.geeked.wtf/api/track/{asin} directly from the browser (Cloudflare
// bot-protection passes browser requests, blocks Node.js server requests).
// Returns { jwt, apiBase } if a valid JWT is cached, or 401 if not.
router.get('/jwt', (req, res) => {
  setCors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  const jwt = getCachedJwt();
  if (!jwt) {
    return res.status(404).json({ ok: false, error: 'No valid JWT — Turnstile challenge required' });
  }

  const status = getAmazonStatus();
  return res.json({
    ok:        true,
    jwt,
    expiresIn: status.jwtExpiresIn,
    apiBase:   'https://amz.geeked.wtf',
  });
});

// ── GET /api/amazon/asin ──────────────────────────────────────────────────────
// Server-side ASIN lookup via t2a.geeked.wtf (works fine from Node.js).
// Frontend calls this to get the ASIN, then calls amz.geeked.wtf/api/track directly.
// Query params: title, artist, album (optional), duration (optional, seconds)
router.get('/asin', async (req, res) => {
  setCors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  const { title, artist, album = '', duration } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'Missing required param: title' });
  }

  try {
    const asin = await searchAmazonAsin(
      title.trim(),
      (artist || '').trim(),
      (album || '').trim(),
      duration ? Number(duration) : 0
    );

    if (!asin) {
      console.log(`[amazon-asin] No match for "${title}" — not on Amazon Music`);
      return res.status(404).json({ ok: false, error: 'No Amazon Music match found for this track' });
    }

    console.log(`[amazon-asin] ✅ ASIN ${asin} for "${title}"`);
    return res.json({ ok: true, asin });
  } catch (err) {
    console.error(`[amazon-asin] Error: ${err.message}`);
    if (err.status === 403) {
      return res.status(429).json({ ok: false, error: 'Amazon Music rate limited' });
    }
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── POST /api/amazon/report-rate-limit ───────────────────────────────────────
// Frontend calls this when it gets a 403 from amz.geeked.wtf/api/track.
// This syncs the rate-limit state to the server so future resolves skip Amazon.
router.post('/report-rate-limit', (req, res) => {
  setCors(req, res);
  setRateLimited();
  console.warn('[amazon-route] Client reported 403 rate limit from amz.geeked.wtf');
  res.json({ ok: true });
});

// ── GET /api/amazon/stream ────────────────────────────────────────────────────
// Proxies the track stream request through the SERVER using the cached JWT.
// This fixes the 401 IP-mismatch: JWT is issued to server IP during exchange,
// so the track request must also come from the server — not the browser.
// Query params: asin, quality (HD|SD_HIGH|UHD)
router.get('/stream', async (req, res) => {
  setCors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  const { asin, quality = 'HD' } = req.query;
  if (!asin) return res.status(400).json({ error: 'asin required' });

  const jwt = getCachedJwt();
  if (!jwt) {
    return res.status(401).json({ error: 'No valid JWT — Turnstile challenge required' });
  }

  try {
    const url = `https://amz.geeked.wtf/api/track/${encodeURIComponent(asin)}?quality=${quality}`;
    console.log(`[amazon-stream] Fetching ${asin} (${quality}) via server JWT...`);

    const trackRes = await fetch(url, {
      headers: {
        'X-Turnstile-JWT': jwt,
        'Accept':          'application/json',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (trackRes.status === 401 || trackRes.status === 428) {
      clearCachedJwt();
      return res.status(401).json({ error: 'JWT expired or invalid — Turnstile re-challenge required' });
    }
    if (trackRes.status === 403) {
      setRateLimited();
      return res.status(429).json({ error: 'Amazon Music rate limited' });
    }
    if (!trackRes.ok) {
      const text = await trackRes.text().catch(() => '');
      console.warn(`[amazon-stream] amz.geeked.wtf HTTP ${trackRes.status}:`, text.substring(0, 100));
      return res.status(trackRes.status).json({ error: `Amazon API returned ${trackRes.status}` });
    }

    const data = await trackRes.json();
    if (!data?.stream_url) {
      console.warn('[amazon-stream] No stream_url in response:', JSON.stringify(data).substring(0, 150));
      return res.status(404).json({ error: 'No stream URL in Amazon response' });
    }

    console.log(`[amazon-stream] ✅ ${asin} (${data.quality_selected || quality})`);
    return res.json({
      ok:           true,
      stream_url:   data.stream_url,
      quality:      data.quality_selected || quality,
      decryption_key: data.decryption_key || null,
    });

  } catch (err) {
    console.error(`[amazon-stream] Error: ${err.message}`);
    return res.status(502).json({ error: `Amazon stream proxy failed: ${err.message}` });
  }
});

// ── POST /api/amazon/notify-jwt ──────────────────────────────────────────────
// Browser calls this after successfully exchanging Turnstile token directly with
// amz.geeked.wtf (browser-side, to avoid IP-mismatch 401 on track requests).
// We just record that a JWT is active for the /status endpoint \u2014 we don't store
// the actual JWT since the browser holds it in sessionStorage.
let _browserJwtExpiry = 0;
router.post('/notify-jwt', (req, res) => {
  setCors(req, res);
  const { expiresIn = 3600 } = req.body || {};
  _browserJwtExpiry = Date.now() + (Number(expiresIn) - 60) * 1000;
  console.log(`[amazon-route] Browser JWT active (${expiresIn}s)`);
  res.json({ ok: true });
});

// Patch getAmazonStatus to include browser JWT info
const _origGetStatus = getAmazonStatus;

// ── POST /api/amazon/clear-jwt ────────────────────────────────────────────────
router.post('/clear-jwt', (_req, res) => {
  setCors(_req, res);
  clearCachedJwt();
  clearRateLimit();
  res.json({ ok: true, message: 'JWT and rate-limit cleared' });
});

export default router;
