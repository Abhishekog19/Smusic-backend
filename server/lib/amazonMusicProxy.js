/**
 * amazonMusicProxy.js — Amazon Music Integration (Phase 2)
 *
 * Uses the community Amazon Music proxies from Monochrome:
 *   t2a.geeked.wtf  — Converter: search tracks → get Amazon ASIN
 *   amz.geeked.wtf  — API: ASIN + JWT → stream URL
 *
 * Auth flow (Cloudflare Turnstile):
 *   1. Browser renders Turnstile widget (site key: AMAZON_TURNSTILE_SITE_KEY)
 *   2. Browser POSTs cf_turnstile_response to /api/amazon/exchange-turnstile
 *   3. Backend forwards to amz.geeked.wtf/api/auth/turnstile → gets JWT
 *   4. JWT cached server-side for all Amazon requests (~4 minutes)
 *
 * Matching algorithm: fuzzy score (title 45 + artist 25 + album 15 + duration 15 = 100)
 * Only accepts matches scoring >= 62 with strong title AND artist signals.
 *
 * Endpoints used (from Monochrome js/api.js, js/storage.js):
 *   Converter: GET  {CONVERTER}/api/search/songs?query={title+artist}
 *   Auth:      POST {API}/api/auth/turnstile  { cf_turnstile_response }
 *   Stream:    GET  {API}/api/track/{asin}?quality={UHD|HD|SD_HIGH}
 *              Headers: X-Turnstile-JWT: {jwt}
 */

const CONVERTER_URL = 'https://t2a.geeked.wtf';
const API_URL       = 'https://amz.geeked.wtf';

// Quality mapping: TIDAL quality → Amazon Music quality tier
const QUALITY_MAP = {
  HI_RES_LOSSLESS: 'UHD',
  LOSSLESS:        'HD',
  HIGH:            'SD_HIGH',
  LOW:             'SD_LOW',
  NORMAL:          'SD_MEDIUM',
  AUTO:            'HD',
};

// ── JWT Cache ─────────────────────────────────────────────────────────────────
// Shared server-side JWT for all Amazon requests.
// Refreshed when expired or after 403 responses.

let _cachedJwt    = null;
let _jwtExpiry    = 0;
let _amazonRateLimitedUntil = 0;
const RATE_LIMIT_DURATION_MS = 30 * 60 * 1000; // 30 minutes (same as Monochrome)

export function getCachedJwt() {
  if (_cachedJwt && Date.now() < _jwtExpiry) return _cachedJwt;
  return null;
}

export function setCachedJwt(token, expiresIn = 300) {
  _cachedJwt = token;
  _jwtExpiry = Date.now() + Math.max((expiresIn - 60) * 1000, 60_000);
  console.log(`[amazon] JWT cached, valid for ${Math.round((expiresIn - 60))}s`);
}

export function clearCachedJwt() {
  _cachedJwt = null;
  _jwtExpiry = 0;
}

function isRateLimited() { return Date.now() < _amazonRateLimitedUntil; }
export function setRateLimited() {
  _amazonRateLimitedUntil = Date.now() + RATE_LIMIT_DURATION_MS;
  clearCachedJwt();
  console.warn('[amazon] Rate limited for 30 minutes — falling back to Qobuz/Deezer');
}

// Allow external callers to reset the rate-limit flag (e.g. via /api/amazon/clear-jwt)
export function clearRateLimit() {
  _amazonRateLimitedUntil = 0;
  console.log('[amazon] Rate-limit flag cleared');
}

// ── Fuzzy Matching (from Monochrome getAmazonAsin) ────────────────────────────

function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')           // strip combining accents only
    .toLowerCase()
    .replace(/\b(explicit|clean|remastered?|deluxe|bonus track|radio edit|album version|single version)\b/g, ' ')
    .replace(/[()[\]{}'"]/g, ' ')
    .replace(/\u0026/g, ' and ')
    // Keep non-latin scripts (Hindi/Devanagari \u0900-\u097F, Korean, Japanese, Arabic, etc.)
    // Only strip punctuation that isn't part of a word in any script
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ASCII-only fallback for transliterated latin matching
function normalizeAscii(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '') // strip all non-ASCII
    .toLowerCase()
    .replace(/\b(explicit|clean|remastered?|deluxe|bonus track|radio edit|album version|single version)\b/g, ' ')
    .replace(/[()[\]{}'"]/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function textScore(expected, actual, maxPoints) {
  const eNorm = normalize(expected);
  const aNorm = normalize(actual);
  const eAscii = normalizeAscii(expected);
  const aAscii = normalizeAscii(actual);

  // Helper: token overlap score between two normalized strings
  function _score(left, right) {
    if (!left || !right) return 0;
    if (left === right) return maxPoints;
    if (right.includes(left) || left.includes(right)) return maxPoints * 0.80;
    const leftTokens  = left.split(' ').filter(Boolean);
    const rightTokens = new Set(right.split(' ').filter(Boolean));
    if (!leftTokens.length || !rightTokens.size) return 0;
    let overlap = 0;
    for (const t of leftTokens) if (rightTokens.has(t)) overlap++;
    return maxPoints * (overlap / Math.max(leftTokens.length, rightTokens.size));
  }

  // Take the best score between: full unicode match and ASCII-only match
  // This handles: Devanagari titles (full unicode wins) AND transliterated titles (ascii wins)
  return Math.max(_score(eNorm, aNorm), _score(eAscii, aAscii));
}

function durationScore(expectedSec, actualSec) {
  const a = Number(expectedSec), b = Number(actualSec);
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return 0;
  const diff = Math.abs(a - b);
  if (diff <= 2)  return 15;
  if (diff <= 5)  return 12;
  if (diff <= 10) return  8;
  if (diff <= 20) return  4;
  return 0;
}

// ASIN cache: normalizedQuery → { asin, timestamp }
// null asin = confirmed no match (avoids repeated failed searches)
const _asinCache = new Map();
const ASIN_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function searchAmazonAsin(title, artist, album = '', durationSec = 0) {
  const cacheKey = normalize(`${title} ${artist}`).substring(0, 80);
  const cached = _asinCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ASIN_CACHE_TTL) {
    if (cached.asin === null) {
      console.log(`[amazon] ASIN cache: no match for "${title}"`);
      return null;
    }
    console.log(`[amazon] ASIN cache hit: ${cached.asin} for "${title}"`);
    return cached.asin;
  }

  if (!title) throw new Error('Amazon ASIN search requires title');

  // Try two queries: (1) title+artist, (2) title only (better for non-latin artists)
  const queries = [
    `${title} ${artist}`.trim(),
    title.trim(),
  ].filter((q, i, arr) => q && arr.indexOf(q) === i); // dedupe

  let bestAsin = null;
  let bestScore = 0;
  let bestCandidate = null;

  for (const query of queries) {
    const params = new URLSearchParams({ query });
    const url    = `${CONVERTER_URL}/api/search/songs?${params}`;
    console.log(`[amazon] Searching ASIN: "${query}"`);

    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'Accept': 'application/json' },
      });
    } catch (fetchErr) {
      console.warn(`[amazon] Search fetch failed: ${fetchErr.message}`);
      continue;
    }

    if (res.status === 403) { setRateLimited(); throw Object.assign(new Error('Amazon converter 403 — rate limited'), { status: 403 }); }
    if (!res.ok) { console.warn(`[amazon] Search HTTP ${res.status} for query "${query}"`); continue; }

    const data = await res.json();
    const candidates = Array.isArray(data?.data) ? data.data : [];
    if (candidates.length === 0) { console.warn(`[amazon] 0 results for "${query}"`); continue; }

    const ranked = candidates
      .filter(c => c?.id)
      .map(c => {
        const titleSc  = textScore(title,         c.title || '',        45);
        const artistSc = textScore(artist || '',  c.artist?.name || '', 25);
        const albumSc  = textScore(album || '',   c.album?.name || '',  15);
        const durSc    = durationScore(durationSec, c.duration || 0);
        const total    = titleSc + artistSc + albumSc + durSc;
        return { c, total, titleSc, artistSc };
      })
      .sort((a, b) => b.total - a.total);

    if (!ranked.length) continue;
    const top = ranked[0];
    if (top.total > bestScore) {
      bestScore = top.total;
      bestAsin = top.c.id;
      bestCandidate = top;
    }
  }

  if (!bestAsin || !bestCandidate) {
    console.warn(`[amazon] No candidates found for "${title}"`);
    _asinCache.set(cacheKey, { asin: null, timestamp: Date.now() });
    return null;
  }

  const { c, total, titleSc, artistSc } = bestCandidate;

  // Threshold: 55 overall + strong title (35+). Slightly relaxed for international songs
  // where artist name in Amazon may be transliterated differently (e.g. "A.R. Rahman" vs "AR Rahman")
  const strongTitle = titleSc >= 30;
  const minTotal = artist ? 55 : 40; // artist-less search = title-only, lower bar

  if (total < minTotal || !strongTitle) {
    console.warn(`[amazon] No confident match — score ${total.toFixed(1)}/100 (title:${titleSc.toFixed(0)}, artist:${artistSc.toFixed(0)})`);
    console.warn(`[amazon] Best candidate: "${c.title}" by "${c.artist?.name || '?'}"`);
    _asinCache.set(cacheKey, { asin: null, timestamp: Date.now() });
    return null;
  }

  _asinCache.set(cacheKey, { asin: bestAsin, timestamp: Date.now() });
  console.log(`[amazon] ✅ ASIN: ${bestAsin} for "${c.title}" by "${c.artist?.name || '?'}" (score: ${total.toFixed(1)})`);
  return bestAsin;
}

// ── Main Resolution ───────────────────────────────────────────────────────────

/**
 * Resolve an Amazon Music stream URL for a track.
 *
 * @param {object} trackMeta   — { title, artist, album, duration } from TIDAL metadata
 * @param {string} quality     — Quality tier (LOSSLESS, HIGH, etc.)
 * @returns {Promise<{url, format, quality, provider: 'amazon'}|null>}
 */
export async function resolveAmazonStream(trackMeta, quality = 'LOSSLESS') {
  if (isRateLimited()) {
    console.warn('[amazon] Skipping — rate limited');
    return null;
  }

  const jwt = getCachedJwt();
  if (!jwt) {
    console.warn('[amazon] No valid JWT — Turnstile not yet completed by client');
    return null;
  }

  const { title, artist, album, duration } = trackMeta;

  let asin;
  try {
    asin = await searchAmazonAsin(title, artist, album, duration);
    if (!asin) {
      console.warn(`[amazon] No ASIN found — "${title}" not available on Amazon Music (catalog miss)`);
      return null;
    }
  } catch (asinErr) {
    console.warn(`[amazon] ASIN search error: ${asinErr.message}`);
    return null;
  }

  // Quality cascade: try preferred first, then fall down
  const QUALITY_CASCADE = {
    HI_RES_LOSSLESS: ['UHD', 'HD'],
    LOSSLESS:        ['HD', 'SD_HIGH'],
    HIGH:            ['SD_HIGH', 'HD'],
    LOW:             ['SD_HIGH'],
  };
  const qualitiesToTry = QUALITY_CASCADE[quality] || ['HD'];

  for (const amazonQuality of qualitiesToTry) {
    try {
      const params = new URLSearchParams({ quality: amazonQuality });
      const url    = `${API_URL}/api/track/${asin}?${params}`;
      console.log(`[amazon] Fetching stream for ASIN ${asin} (${amazonQuality})...`);

      const res = await fetch(url, {
        headers: { 'X-Turnstile-JWT': jwt, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 403) { setRateLimited(); return null; }
      if (res.status === 401 || res.status === 428) {
        clearCachedJwt();
        console.warn(`[amazon] JWT rejected (${res.status}) — need fresh Turnstile`);
        return null;
      }
      if (res.status === 404) {
        console.warn(`[amazon] ASIN ${asin} not streamable at ${amazonQuality} — trying next quality`);
        continue;
      }
      if (!res.ok) {
        console.warn(`[amazon] API HTTP ${res.status} for ASIN ${asin} quality ${amazonQuality}`);
        continue;
      }

      const data = await res.json();
      // Log the full response shape (keys only) for debugging
      console.log(`[amazon] API response keys: ${Object.keys(data || {}).join(', ')}`);

      if (!data?.stream_url) {
        console.warn(`[amazon] No stream_url in response — ${JSON.stringify(data).substring(0, 120)}`);
        continue;
      }

      // Amazon returns CENC-encrypted MP4 streams.
      // The decryption_key field contains the AES-128 key needed to play it.
      // If decryption_key is absent, the track is unencrypted and plays directly.
      const decryptionKey = data.decryption_key || null;
      const hasEncryption = !!decryptionKey;
      const fmt = (data.quality_selected || '').toLowerCase().startsWith('uhd') ? 'flac' : 'mp4';

      console.log(`[amazon] ✅ Stream acquired: ${data.quality_selected || amazonQuality} (${fmt}) encrypted=${hasEncryption} for "${title}"`);

      return {
        url:            data.stream_url,
        format:         fmt,
        quality:        data.quality_selected || amazonQuality,
        provider:       'amazon',
        isDash:         false,
        decryptionKey,                                // null if unencrypted
        asin,
        replayGain:     data.replay_gain || null,
        availableQualities: data.available_qualities || null,
      };

    } catch (err) {
      console.warn(`[amazon] Stream fetch failed at ${amazonQuality}: ${err.message}`);
      if (isRateLimited()) return null;
    }
  }

  console.warn(`[amazon] All quality tiers exhausted for ASIN ${asin} ("${title}")`);
  return null;
}

// ── Turnstile Token Exchange ─────────────────────────────────────────────────

/**
 * Exchange a Cloudflare Turnstile response token for an Amazon Music JWT.
 * Called by the backend route after receiving the token from the frontend.
 *
 * NOTE on 403: When amz.geeked.wtf returns 403 on this endpoint, it means
 * the Turnstile token was INVALID (e.g. dev test token rejected by prod server).
 * This is NOT a rate-limit — do NOT set the rate-limit flag here.
 * Rate-limiting only applies to track API calls (resolveAmazonStream).
 *
 * @param {string} cfTurnstileResponse — Token from Turnstile widget in browser
 * @returns {Promise<string>} — JWT access_token (also cached server-side)
 */
export async function exchangeTurnstileToken(cfTurnstileResponse) {
  const res = await fetch(`${API_URL}/api/auth/turnstile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cf_turnstile_response: cfTurnstileResponse }),
    signal: AbortSignal.timeout(12_000),
  });

  // 403 here = invalid Turnstile token (test token rejected by production server)
  // This is NOT a rate-limit condition — just auth failure
  if (res.status === 403 || res.status === 401) {
    const text = await res.text().catch(() => '');
    throw new Error(`Turnstile token rejected by Amazon proxy (HTTP ${res.status}) — dev test tokens are not accepted by production servers. This is expected in local development.`);
  }

  // 429 = actual rate limit from the Turnstile auth endpoint
  if (res.status === 429) {
    setRateLimited();
    throw new Error('Amazon Music Turnstile auth is rate-limited — try again in 30 minutes');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Turnstile exchange failed HTTP ${res.status}: ${text.substring(0, 100)}`);
  }

  const data = await res.json();
  if (!data?.access_token) throw new Error('No access_token in Turnstile auth response');

  setCachedJwt(data.access_token, data.expires_in || 300);
  return data.access_token;
}

/**
 * Check Amazon Music proxy health and JWT status.
 */
export function getAmazonStatus() {
  return {
    hasJwt:       !!getCachedJwt(),
    isRateLimited: isRateLimited(),
    rateLimitedUntil: _amazonRateLimitedUntil || null,
    jwtExpiresIn: _cachedJwt && _jwtExpiry > Date.now()
      ? Math.round((_jwtExpiry - Date.now()) / 1000)
      : 0,
  };
}
