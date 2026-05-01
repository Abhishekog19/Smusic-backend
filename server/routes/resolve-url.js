import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';

const router = express.Router();

/**
 * GET /api/resolve-url?url=<shortened-url>
 *
 * Resolves shortened URLs (e.g. https://spotify.link/AbCdEfGh) by following
 * HTTP redirects without downloading the page body. Returns the final URL.
 *
 * This is needed because mobile Spotify share links use shortened URLs that
 * browsers/fetch can follow, but the frontend can't due to CORS restrictions.
 */
router.get('/', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');

  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'Missing required parameter: url' });
  }

  try {
    // Use HEAD request first (faster, no body), fall back to GET if HEAD doesn't work
    let resolvedUrl = url;

    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetch(url, {
          method,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(8000),
        });

        // The final URL after following all redirects
        resolvedUrl = response.url || url;

        // Clean tracking params from the resolved URL
        try {
          const parsed = new URL(resolvedUrl);
          const trackingParams = ['si', 'nd', 'dl_branch', 'context', '_branch_match_id',
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
            'feature', 'app_destination', '_branch_referrer'];
          for (const param of trackingParams) {
            parsed.searchParams.delete(param);
          }
          resolvedUrl = parsed.toString();
        } catch { /* keep as-is if URL parsing fails */ }

        console.log(`[resolve-url] ${url} → ${resolvedUrl}`);
        break; // Success, no need to try GET
      } catch (err) {
        if (method === 'HEAD') {
          console.warn(`[resolve-url] HEAD failed, trying GET:`, err.message);
          continue;
        }
        throw err;
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
    return res.json({ resolvedUrl, originalUrl: url });
  } catch (err) {
    console.error('[resolve-url] Failed:', err.message);
    return res.status(502).json({
      error: 'Failed to resolve URL',
      details: err.message,
      resolvedUrl: url, // Return original as fallback
    });
  }
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

export default router;
