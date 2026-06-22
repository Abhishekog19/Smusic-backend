/**
 * deezerProxy.js — Deezer Community Proxy Integration
 *
 * Uses the community Deezer proxy instances to stream full tracks via ISRC.
 *
 * API format (from Monochrome source: js/api.js getDeezerStreamUrl):
 *   Stream:  GET /stream/?isrc={isrc}&format={format}
 *            The URL itself IS the streamable audio endpoint (direct HEAD probe first)
 *
 * Format map (from Monochrome getDeezerStreamFormat):
 *   HI_RES_LOSSLESS → FLAC
 *   LOSSLESS        → FLAC
 *   HIGH            → MP3_320
 *   LOW             → MP3_128
 *
 * Note: Monochrome does a HEAD request first to verify the URL is valid,
 * then passes the URL directly to the audio player (it streams the audio).
 * This proxy is a stream-through endpoint, not a JSON metadata endpoint.
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Community Deezer proxy instances (from Monochrome storage.js)
const DEEZER_INSTANCES = [
  'https://dzr.tabs-vs-spaces.wtf',
  // Add more instances here if the primary goes down
];

// Quality → Deezer format map (exact from Monochrome getDeezerStreamFormat)
const FORMAT_MAP = {
  HI_RES_LOSSLESS: 'FLAC',
  LOSSLESS:        'FLAC',
  DOLBY_ATMOS:     'FLAC',
  HIGH:            'MP3_320',
  LOW:             'MP3_128',
  NORMAL:          'MP3_128',
};

/**
 * Resolve a Deezer stream URL for a track using ISRC.
 * Returns the stream URL directly — the proxy serves audio at this URL.
 *
 * @param {string} isrc     - ISRC code (e.g. "USQX91300108")
 * @param {string} quality  - Quality tier: HI_RES_LOSSLESS | LOSSLESS | HIGH | LOW
 * @returns {Promise<{url: string, format: string, provider: 'deezer'}|null>}
 */
export async function resolveDeezerStream(isrc, quality = 'LOSSLESS') {
  if (!isrc) {
    console.warn('[deezer] No ISRC provided — skipping');
    return null;
  }

  const format = FORMAT_MAP[quality] || 'FLAC';

  for (const baseUrl of DEEZER_INSTANCES) {
    const streamUrl = `${baseUrl}/stream/?isrc=${encodeURIComponent(isrc)}&format=${encodeURIComponent(format)}`;

    try {
      console.log(`[deezer] Probing: ${streamUrl.substring(0, 80)}...`);

      // HEAD probe to verify URL is valid (mirrors Monochrome behaviour exactly)
      const probeRes = await fetch(streamUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(12_000),
      });

      // Accept 200, 206 (partial), 405 (method not allowed = proxy exists but HEAD unsupported)
      // Reject 404, 403, 5xx etc.
      const statusOk = probeRes.ok || probeRes.status === 405 || probeRes.status === 501;
      if (!statusOk) {
        console.warn(`[deezer] Probe ${probeRes.status} from ${baseUrl} for ISRC ${isrc}`);
        continue;
      }

      console.log(`[deezer] ✅ Stream available via ${baseUrl} (${format}, ISRC: ${isrc})`);
      return {
        url:      streamUrl,
        format:   format.toLowerCase().replace('_', '_'), // 'FLAC' or 'MP3_320'
        provider: 'deezer',
        rgInfo:   null, // Deezer proxy doesn't return replay gain info
      };

    } catch (err) {
      console.warn(`[deezer] Instance ${baseUrl} failed: ${err.message}`);
      // Try next instance
    }
  }

  console.warn(`[deezer] All instances failed for ISRC ${isrc}`);
  return null;
}

/**
 * Quick health check — tests if the primary Deezer proxy is reachable.
 * @returns {Promise<{ok: boolean, instance: string, latencyMs: number}>}
 */
export async function checkDeezerHealth() {
  const instance = DEEZER_INSTANCES[0];
  const start    = Date.now();
  // Use a well-known ISRC for testing (The Weeknd - Blinding Lights)
  const testUrl  = `${instance}/stream/?isrc=CAUM71900813&format=FLAC`;
  try {
    const res = await fetch(testUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8_000),
    });
    const ok = res.ok || res.status === 405 || res.status === 501;
    return { ok, instance, latencyMs: Date.now() - start, status: res.status };
  } catch (err) {
    return { ok: false, instance, latencyMs: Date.now() - start, error: err.message };
  }
}
