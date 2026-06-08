/**
 * mirrorDiscovery.js — Dynamic TIDAL API Mirror Discovery (Backend/Node.js)
 *
 * Server-side equivalent of the frontend mirrorDiscovery.js.
 * Uses native fetch (requires Node 18+ — confirmed via package.json engines field).
 * ESM module — use import/export syntax.
 *
 * Fetches live mirrors from Cloudflare Worker uptime endpoints every 15 minutes.
 * The workers return { api: [...], streaming: [], down: [...] } — we use `api`
 * since `streaming` is currently empty.
 */

const UPTIME_WORKERS = [
  'https://tidal-uptime.jiffy-puffs-1j.workers.dev/',
  'https://tidal-uptime.props-76styles.workers.dev/',
];

// Hardcoded fallback — monochrome.tf endpoints confirmed working 2026-06-08
const FALLBACK_MIRRORS = [
  { name: 'monochrome-eu', baseUrl: 'https://eu-central.monochrome.tf', weight: 15 },
  { name: 'monochrome-us', baseUrl: 'https://us-west.monochrome.tf', weight: 15 },
  { name: 'monochrome-api', baseUrl: 'https://api.monochrome.tf', weight: 10 },
  { name: 'samidy', baseUrl: 'https://monochrome-api.samidy.com', weight: 10 },
];

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let cachedMirrors = null;
let lastFetchTime = 0;
let fetchInFlight = null;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchFromWorker(workerUrl) {
  try {
    const res = await fetch(workerUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json', 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) return null;

    const data = await res.json();

    // Use `api` array (has 4 live mirrors). `streaming` is currently empty.
    const apiList = Array.isArray(data?.api) ? data.api : [];
    const streamingList = Array.isArray(data?.streaming) ? data.streaming : [];
    const combined = [...apiList, ...streamingList];

    if (combined.length === 0) return null;

    return combined.map((entry, i) => ({
      name: `worker-mirror-${i}`,
      baseUrl: entry.url.replace(/\/$/, ''),
      weight: 15,
    }));
  } catch (err) {
    console.warn(`[mirrorDiscovery] Worker ${workerUrl} failed: ${err.message}`);
    return null;
  }
}

async function _fetchLiveMirrors() {
  const workers = [...UPTIME_WORKERS].sort(() => Math.random() - 0.5);

  for (const worker of workers) {
    const mirrors = await fetchFromWorker(worker);
    if (mirrors && mirrors.length > 0) {
      console.log(`[mirrorDiscovery] Fetched ${mirrors.length} live mirrors from ${worker}`);
      return mirrors;
    }
  }

  console.warn('[mirrorDiscovery] Both workers unreachable — using fallback mirrors');
  return FALLBACK_MIRRORS;
}

/**
 * Returns the current live mirror list for use in fetchV2().
 * Call this at the top of fetchV2() to replace the static V2_TARGETS array.
 *
 * @returns {Promise<Array<{name: string, baseUrl: string, weight: number}>>}
 */
export async function getLiveMirrors() {
  const now = Date.now();

  if (cachedMirrors && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedMirrors;
  }

  if (fetchInFlight) {
    return fetchInFlight;
  }

  fetchInFlight = _fetchLiveMirrors().then(mirrors => {
    cachedMirrors = mirrors;
    lastFetchTime = Date.now();
    fetchInFlight = null;
    return mirrors;
  }).catch(err => {
    fetchInFlight = null;
    console.error('[mirrorDiscovery] Fetch error:', err.message);
    return cachedMirrors || FALLBACK_MIRRORS;
  });

  return fetchInFlight;
}

/**
 * Force-invalidate cache (e.g. after repeated mirror failures).
 */
export function invalidateMirrorCache() {
  cachedMirrors = null;
  lastFetchTime = 0;
  fetchInFlight = null;
}

export { FALLBACK_MIRRORS };
