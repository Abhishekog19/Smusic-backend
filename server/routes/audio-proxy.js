import express from 'express';
import https from 'https';
import http from 'http';
import { isOriginAllowed } from '../lib/proxyConfig.js';

const router = express.Router();

// Allow any *.tidal.com subdomain
const TIDAL_DOMAIN_RE = /^([a-z0-9-]+\.)*tidal\.com$/i;

function isTidalUrl(urlString) {
  try {
    const u = new URL(urlString);
    return TIDAL_DOMAIN_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * GET /api/audio-proxy?url=<encoded-tidal-cdn-url>
 *
 * Proxies TIDAL CDN audio to the browser using Node.js native https module.
 * This bypasses the browser's CORS restriction on direct CDN fetches.
 *
 * Uses native http/https pipe — compatible with all Node.js versions.
 */
router.get('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Content-Type, Accept-Ranges'
  );

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  if (!isTidalUrl(targetUrl)) {
    console.warn(`[audio-proxy] Rejected URL (not TIDAL): ${targetUrl.substring(0, 80)}`);
    return res.status(400).json({ error: 'Only TIDAL audio URLs are allowed' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const requestHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'audio/flac, audio/mp4, audio/*, */*',
    'Accept-Encoding': 'identity', // No compression so bytes flow raw
    Connection: 'keep-alive',
  };

  // Forward Range header for seek support
  if (req.headers['range']) {
    requestHeaders['Range'] = req.headers['range'];
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;

  const proxyReq = proto.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: requestHeaders,
    },
    (upstream) => {
      const status = upstream.statusCode || 502;

      // Reject non-audio error responses
      if (status >= 400) {
        let body = '';
        upstream.on('data', (chunk) => (body += chunk.toString()));
        upstream.on('end', () => {
          console.error(`[audio-proxy] CDN error ${status} for ${targetUrl.substring(0, 80)}`);
          if (!res.headersSent) {
            res.status(status).json({
              error: `TIDAL CDN returned HTTP ${status}`,
              hint:
                status === 401 || status === 403
                  ? 'Stream token may have expired — reload the page and try again'
                  : undefined,
            });
          }
        });
        return;
      }

      // Forward status and safe headers
      res.status(status);

      const FORWARD = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'last-modified',
        'etag',
      ];
      for (const h of FORWARD) {
        const v = upstream.headers[h];
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'no-store, no-cache');

      const ct = upstream.headers['content-type'] || 'audio/flac';
      const cl = upstream.headers['content-length'] || '?';
      console.log(`[audio-proxy] ▶ ${status} ${ct} ${cl} bytes from ${parsedUrl.hostname}`);

      // Pipe upstream → response (native Node.js streams — no compatibility issues)
      upstream.pipe(res);

      upstream.on('end', () => {
        console.log(`[audio-proxy] ✓ Stream complete`);
      });

      // If client disconnects, stop pulling from CDN
      req.on('close', () => {
        upstream.destroy();
      });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('[audio-proxy] Request error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Failed to connect to TIDAL CDN',
        details: err.message,
      });
    }
  });

  proxyReq.end();
});

router.options('/', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

export default router;
