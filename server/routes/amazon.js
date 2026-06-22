/**
 * amazon.js — Amazon Music Backend Routes (Phase 2)
 *
 * Routes:
 *   POST /api/amazon/exchange-turnstile  — Frontend sends Turnstile token → backend gets JWT
 *   GET  /api/amazon/status              — Check JWT / rate-limit status
 */

import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import {
  exchangeTurnstileToken,
  getAmazonStatus,
  clearCachedJwt,
  clearRateLimit,
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
// Returns { ok: true, expiresIn: number } — does NOT expose the raw JWT to the client.
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

    // 403/401 from amz.geeked.wtf = invalid token (dev test tokens won't work with prod)
    // This is expected in local dev — Amazon falls back to Qobuz silently
    const isTokenRejected = err.message?.includes('rejected') || err.message?.includes('HTTP 403') || err.message?.includes('HTTP 401');
    const isRateLimit     = err.message?.includes('rate-limited') || err.message?.includes('429');

    const statusCode = isRateLimit ? 429 : isTokenRejected ? 401 : 502;
    return res.status(statusCode).json({
      ok:    false,
      error: isTokenRejected
        ? 'Amazon Music auth: dev Turnstile token not accepted by production proxy (expected in local dev — Qobuz/Deezer used as fallback)'
        : isRateLimit
          ? 'Amazon Music is temporarily rate limited. Try again in 30 minutes.'
          : `Turnstile exchange failed: ${err.message}`,
      isDev: isTokenRejected,
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

// ── POST /api/amazon/clear-jwt ────────────────────────────────────────────────
// Forces a full Amazon state reset (JWT + rate-limit flag).
router.post('/clear-jwt', (_req, res) => {
  setCors(_req, res);
  clearCachedJwt();
  clearRateLimit();  // Also clears incorrectly-set rate-limit flags
  res.json({ ok: true, message: 'JWT and rate-limit cleared — Turnstile challenge required on next play' });
});

export default router;
