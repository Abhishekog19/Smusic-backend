
const PROD_ALLOWED = new Set([
  'api.tidal.com',
  'listen.tidal.com',
  'api.spotify.com',
  'open.spotify.com',
  'api-partner.spotify.com',
  'open.spotifycdn.com',
  'clienttoken.spotify.com',
  'musicbrainz.org',
  // TIDAL audio CDN domains — needed for proxied audio stream downloads
  'audio.tidal.com',
  'sp-pr.audio.tidal.com',
  'audio4.tidal.com',
  'chorus.tidal.com',
  'cf-hls-media.tidal.com',
  // Live V2 TIDAL proxy mirrors — confirmed working 2026-06-08 via uptime workers
  // NOTE: The isProxyTarget() endsWith check means 'monochrome.tf' covers ALL subdomains:
  //   eu-central.monochrome.tf, us-west.monochrome.tf, api.monochrome.tf,
  //   frankfurt-2.monochrome.tf, arran.monochrome.tf, etc.
  'monochrome.tf',
  'monochrome-api.samidy.com',
  // Legacy mirrors kept for safety (all confirmed dead, but harmless to keep)
  'triton.squid.wtf',
  'hifi-one.spotisaver.net',
  'hifi-two.spotisaver.net',
]);

// In dev, also allow loopback for proxy self-test
const ALLOWED_PROXY_HOSTS = process.env.NODE_ENV !== 'production'
  ? new Set([...PROD_ALLOWED, '127.0.0.1', 'localhost'])
  : PROD_ALLOWED;

export function isProxyTarget(url) {
  const hostname = url.hostname.toLowerCase();
  if (ALLOWED_PROXY_HOSTS.has(hostname)) return true;
  for (const allowed of ALLOWED_PROXY_HOSTS) {
    if (hostname.endsWith(`.${allowed}`) || hostname === allowed) return true;
  }
  return false;
}

export function getAllowedOrigins() {
  const configured = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== 'production') {
    return [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      ...configured,
    ];
  }
  return configured;
}

export function isOriginAllowed(origin) {
  if (!origin) return true;
  if (process.env.NODE_ENV !== 'production') return true;
  const allowed = getAllowedOrigins();
  // If no origins configured, allow all (open API — operator must restrict if needed)
  if (allowed.length === 0) return true;
  return allowed.some((a) => {
    if (a === '*' || a === origin) return true;
    if (a.startsWith('*.')) {
      const domain = a.slice(2);
      return origin.endsWith(`.${domain}`) || origin === domain;
    }
    return false;
  });
}
