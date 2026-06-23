/**
 * mirrorDiscovery.js — Dynamic TIDAL API Mirror Discovery (Backend/Node.js)
 *
 * Fetches live mirrors from the same uptime endpoint Monochrome uses.
 * Priority order (matches Monochrome storage.js):
 *   1. hifi.geeked.wtf (highest reliability per Monochrome source)
 *   2. Official Monochrome CDN (eu-central, us-west, api.monochrome.tf, samidy)
 *   3. qqdl.site community instances (shuffled)
 */

const UPTIME_WORKERS = [
  // Monochrome's own uptime tracker (primary source — same one Monochrome uses)
  'https://tidal-uptime.geeked.wtf',
  // Smusic Cloudflare worker mirrors as backup
  'https://tidal-uptime.jiffy-puffs-1j.workers.dev/',
  'https://tidal-uptime.props-76styles.workers.dev/',
];

// Full mirror list — updated 2026-06-23 based on live health check results:
//   DEAD: hifi.geeked.wtf (DNS), eu-central.monochrome.tf (503), all qqdl.site (timeout), kinoplus (DNS)
//   ALIVE: us-west.monochrome.tf, api.monochrome.tf, monochrome-api.samidy.com
export const FALLBACK_MIRRORS = [
  // Priority 1: Confirmed ALIVE as of 2026-06-23
  { name: 'monochrome-us',  baseUrl: 'https://us-west.monochrome.tf',       weight: 20 },
  { name: 'monochrome-api', baseUrl: 'https://api.monochrome.tf',           weight: 18 },
  { name: 'samidy',         baseUrl: 'https://monochrome-api.samidy.com',   weight: 16 },
  // Priority 2: May come back online — lower weight so alive mirrors are preferred
  { name: 'monochrome-eu',  baseUrl: 'https://eu-central.monochrome.tf',    weight: 5  },
  { name: 'hifi-geeked',    baseUrl: 'https://hifi.geeked.wtf',             weight: 3  },
  // Priority 3: qqdl.site — all timed out 2026-06-23 but kept in case they recover
  { name: 'maus-qqdl',     baseUrl: 'https://maus.qqdl.site',              weight: 2  },
  { name: 'vogel-qqdl',    baseUrl: 'https://vogel.qqdl.site',             weight: 2  },
  { name: 'katze-qqdl',    baseUrl: 'https://katze.qqdl.site',             weight: 2  },
  { name: 'hund-qqdl',     baseUrl: 'https://hund.qqdl.site',              weight: 2  },
  { name: 'wolf-qqdl',     baseUrl: 'https://wolf.qqdl.site',              weight: 2  },
];

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let cachedMirrors = null;
let lastFetchTime = 0;
let fetchInFlight = null;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Priority-sort mirrors exactly as Monochrome does:
 * hifi.geeked.wtf → official monochrome.tf/samidy → qqdl.site (shuffled)
 */
function prioritySort(mirrors) {
  const top    = [];  // hifi.geeked.wtf
  const middle = [];  // official CDN nodes
  const bottom = [];  // qqdl community

  for (const m of mirrors) {
    const url = m.baseUrl || m.url || '';
    if (url.includes('hifi.geeked.wtf'))  top.push(m);
    else if (url.includes('.qqdl.site'))  bottom.push({ ...m, weight: 6 });
    else                                  middle.push(m);
  }

  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
  return [...top, ...shuffle(middle), ...shuffle(bottom)];
}

async function fetchFromWorker(workerUrl) {
  try {
    const res = await fetch(workerUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json', 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) return null;

    const data = await res.json();

    // Monochrome uptime workers return { api: [...], streaming: [...] }
    const apiList       = Array.isArray(data?.api)       ? data.api       : [];
    const streamingList = Array.isArray(data?.streaming) ? data.streaming : [];
    const combined = [...apiList, ...streamingList];

    if (combined.length === 0) return null;

    const mirrors = combined.map((entry, i) => ({
      name:    entry.name || `worker-mirror-${i}`,
      baseUrl: (entry.url || entry.baseUrl || '').replace(/\/$/, ''),
      weight:  entry.weight || 10,
    }));

    return prioritySort(mirrors);
  } catch (err) {
    console.warn(`[mirrorDiscovery] Worker ${workerUrl} failed: ${err.message}`);
    return null;
  }
}

async function _fetchLiveMirrors() {
  // Shuffle workers to avoid always hammering the same one first
  const workers = [...UPTIME_WORKERS].sort(() => Math.random() - 0.5);

  for (const worker of workers) {
    const mirrors = await fetchFromWorker(worker);
    if (mirrors && mirrors.length > 0) {
      console.log(`[mirrorDiscovery] Fetched ${mirrors.length} live mirrors from ${worker}`);
      return mirrors;
    }
  }

  console.warn('[mirrorDiscovery] All uptime workers unreachable — using full fallback list');
  return prioritySort([...FALLBACK_MIRRORS]);
}

/**
 * Returns the current live mirror list.
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
    return cachedMirrors || prioritySort([...FALLBACK_MIRRORS]);
  });

  return fetchInFlight;
}

/**
 * Force-invalidate the mirror cache (e.g. after repeated failures).
 */
export function invalidateMirrorCache() {
  cachedMirrors = null;
  lastFetchTime = 0;
  fetchInFlight = null;
}
