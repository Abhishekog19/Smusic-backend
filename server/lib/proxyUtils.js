/**
 * proxyUtils.js — TIDAL Proxy Helper Utilities
 *
 * - isTidalAudioUrl()  — detect TIDAL CDN audio stream URLs
 * - getAudioProxyUrl() — wrap them through the audio proxy
 * - wrapTidalApiUrl()  — rewrite api.tidal.com → Monochrome proxy
 * - getTidalHeaders()  — standard headers required by TIDAL API
 *
 * CRITICAL: TIDAL rejects browser User-Agents.
 * Using 'okhttp/5.3.2' (Android app UA) is required to get valid responses.
 */

const AUDIO_PROXY_BASE_URL = 'https://audio-proxy.binimum.org/proxy-audio/';
const TIDAL_API_PROXY     = 'tidal-proxy.monochrome.tf';
const TIDAL_OPENAPI_PROXY = 'tidal-proxy.monochrome.tf/openapi';

/**
 * Detect if a URL is a TIDAL audio stream that requires proxying.
 * Skips URLs already proxied, blob: and data: URIs, and TIDAL API endpoints.
 */
export function isTidalAudioUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith(AUDIO_PROXY_BASE_URL)) return false; // Already proxied
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('tidal.com')) return false;

    // Exclude TIDAL API/metadata endpoints — only audio CDNs
    if (['api.tidal.com', 'openapi.tidal.com', 'resources.tidal.com'].includes(host)) {
      return false;
    }

    return host.includes('audio') ||
      /\.(aac|flac|m4a|m4s|mp4|mpd|m3u8)(?:$|[?#])/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Wrap a TIDAL audio CDN URL through the audio proxy.
 */
export function getAudioProxyUrl(url) {
  return isTidalAudioUrl(url) ? `${AUDIO_PROXY_BASE_URL}${url}` : url;
}

/**
 * Rewrite api.tidal.com / openapi.tidal.com URLs to the Monochrome proxy.
 * Used for API calls that don't go through a community mirror.
 */
export function wrapTidalApiUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace('https://openapi.tidal.com', `https://${TIDAL_OPENAPI_PROXY}`)
    .replace('https://api.tidal.com',     `https://${TIDAL_API_PROXY}`)
    .replace('http://openapi.tidal.com',  `https://${TIDAL_OPENAPI_PROXY}`)
    .replace('http://api.tidal.com',      `https://${TIDAL_API_PROXY}`);
}

/**
 * Standard TIDAL API request headers.
 * The okhttp User-Agent is required — TIDAL rejects browser UAs.
 *
 * @param {Record<string, string>} additionalHeaders - Extra headers to merge in
 * @returns {Record<string, string>}
 */
export function getTidalHeaders(additionalHeaders = {}) {
  return {
    'User-Agent':       'okhttp/5.3.2',  // ⭐ Mobile app UA — CRITICAL
    'Accept':           'application/json',
    'Accept-Language':  'en-US,en;q=0.9',
    'Cache-Control':    'no-cache',
    ...additionalHeaders,
  };
}

export default { isTidalAudioUrl, getAudioProxyUrl, wrapTidalApiUrl, getTidalHeaders };
