import express from 'express';
import archiver from 'archiver';
import https from 'https';
import http from 'http';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import { getSpotifyTrack } from '../lib/spotifySession.js';
import { getLiveMirrors, FALLBACK_MIRRORS, invalidateMirrorCache } from '../lib/mirrorDiscovery.js';
import dashParser from '../lib/dashParser.js';
import { getTokenManager } from '../lib/tokenManager.js';

const router = express.Router();

// ─── V2 TIDAL Proxy Mirrors ──────────────────────────────────────────────────
// IMPORTANT: The static list below is kept ONLY as an emergency in-process fallback.
// ALL previously hardcoded mirrors (squid.wtf, spotisaver.net, qqdl.site etc.)
// are confirmed DEAD as of 2026-06-08 per Cloudflare Worker uptime checks.
// fetchV2() now calls getLiveMirrors() to get fresh mirror URLs at runtime.
const APP_VERSION = '1.0.0';
const FALLBACK_BASE = 'https://hifi.geeked.wtf'; // Top-priority mirror per Monochrome source
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── TIDAL Direct Relay (Monochrome strategy) ────────────────────────────────
// Multiple relay endpoints — tried in order until one succeeds.
// td.if-it-runs-ship-it.lol mirrors api.tidal.com for TIDAL API calls.
// tidal-proxy.monochrome.tf is Monochrome's own direct TIDAL proxy.
const TIDAL_RELAY_URLS = [
  'https://td.if-it-runs-ship-it.lol/api',       // Primary: runs-ship-it.lol relay
  'https://tidal-proxy.monochrome.tf/api',        // Monochrome's own reverse proxy (wrapTidalUrl target)
  'https://hifi.geeked.wtf',                      // Also try top mirror as relay (supports /v1/ paths)
];
const TIDAL_RELAY_BASE = TIDAL_RELAY_URLS[0]; // kept for backward compat
const TIDAL_AUTH_URL   = 'https://auth.tidal.com/v1/oauth2/token';

// Monochrome client creds (public, from functions/track/[id].js line 16-17)
const FALLBACK_CLIENT_ID     = 'txNoH4kkV41MfH25';
const FALLBACK_CLIENT_SECRET = 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';

// In-process token cache (relay always needs a fresh Bearer token)
let _relayToken = null;
let _relayTokenExpiry = 0;

async function getRelayToken() {
  if (_relayToken && Date.now() < _relayTokenExpiry - 60_000) return _relayToken;

  // Try tokenManager singleton first (has the same creds anyway)
  try {
    const tm = getTokenManager();
    _relayToken = await tm.getValidToken();
    _relayTokenExpiry = tm.tokenExpiry || Date.now() + 3600_000;
    console.log('[relay] ✅ Token from TokenManager singleton');
    return _relayToken;
  } catch (_) { /* not initialized — get fresh */ }

  // Fallback: request directly with Monochrome's public creds
  const clientId     = FALLBACK_CLIENT_ID;
  const clientSecret = FALLBACK_CLIENT_SECRET;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TIDAL_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Relay token request failed: ${res.status}`);
  const data = await res.json();
  _relayToken = data.access_token;
  _relayTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('[relay] ✅ Fresh token acquired via Monochrome creds');
  return _relayToken;
}

/**
 * Resolve a TIDAL track stream via the direct relay (td.if-it-runs-ship-it.lol).
 * Mirrors exactly Monochrome's TidalAPI.fetchJson() + getStreamUrl() approach.
 * Returns { streamUrl, format, segmentUrls, isDash } or throws.
 *
 * Tries multiple relay URLs in sequence — if one returns 403/401, tries the next.
 */
async function resolveViaRelay(trackId, quality = 'LOSSLESS') {
  const qualityMap = { LOSSLESS: 'LOSSLESS', HIGH: 'HIGH', LOW: 'LOW', HI_RES_LOSSLESS: 'HI_RES_LOSSLESS' };
  const tidalQuality = qualityMap[quality] || 'LOSSLESS';

  let token = await getRelayToken();

  // CRITICAL: Use /playbackinfo (not /playbackinfopostpaywall)
  // /playbackinfopostpaywall requires a USER SESSION token (subStatus 6004 = no sessionId)
  // /playbackinfo works with client_credentials tokens (what we have)
  // Source: Monochrome functions/track/[id].js line 55
  const API_PATHS = [
    {
      path:    `/v1/tracks/${trackId}/playbackinfo`,
      params:  new URLSearchParams({ audioquality: tidalQuality, playbackmode: 'STREAM', assetpresentation: 'FULL', countryCode: 'US' }),
      label:   'playbackinfo',
    },
    // Fallback: try the postpaywall endpoint in case credentials were upgraded
    {
      path:    `/v1/tracks/${trackId}/playbackinfopostpaywall`,
      params:  new URLSearchParams({ audioquality: tidalQuality, playbackmode: 'STREAM', assetpresentation: 'FULL', countryCode: 'US', immersiveAudio: 'false' }),
      label:   'playbackinfopostpaywall',
    },
  ];

  let lastErr = null;

  // Try each (relay, apiPath) combination: playbackinfo first (works with client_credentials),
  // then playbackinfopostpaywall (requires user session — might work on some relays).
  for (const { path: apiPath, params: apiParams, label } of API_PATHS) {
    for (let attempt = 0; attempt < TIDAL_RELAY_URLS.length; attempt++) {
      const relayBase = TIDAL_RELAY_URLS[attempt];
      const relayUrl = `${relayBase}${apiPath}?${apiParams.toString()}`;
      console.log(`[relay] [${label}] Attempt ${attempt + 1}/${TIDAL_RELAY_URLS.length} GET ${relayUrl.substring(0, 100)}...`);

      try {
        const r = await fetch(relayUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent':    'okhttp/5.3.2',
            'Accept':        'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!r.ok) {
          const body = await r.text().catch(() => '');
          console.warn(`[relay] [${label}] ${r.status} from ${relayBase} for track ${trackId} quality ${tidalQuality}: ${body.substring(0, 200)}`);

          if (r.status === 401) {
            // Token expired mid-session — force refresh and retry this relay ONCE
            console.log('[relay] 401 received — refreshing token and retrying...');
            _relayToken = null; _relayTokenExpiry = 0;
            try {
              token = await getRelayToken();
              // Retry same relay with fresh token (don't advance attempt counter)
              const r2 = await fetch(relayUrl, {
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'okhttp/5.3.2', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(15_000),
              });
              if (r2.ok) {
                const data2 = await r2.json();
                return await _parseRelayResponse(data2, trackId, tidalQuality);
              }
              console.warn(`[relay] [${label}] Still ${r2.status} after token refresh on ${relayBase} — trying next`);
            } catch (retryErr) {
              console.warn(`[relay] Token refresh retry failed: ${retryErr.message}`);
            }
            // Always continue to next relay on 401
            const err401 = new Error(`Relay ${relayBase} [${label}] returned HTTP 401 for track ${trackId}`);
            err401.status = 401;
            lastErr = err401;
            continue;
          }

          const err = new Error(`Relay ${relayBase} [${label}] returned HTTP ${r.status} for track ${trackId}`);
          err.status = r.status;
          lastErr = err;
          // On 4xx/5xx, always try next relay (don't break — exhausting all is better than giving up early)
          continue;
        }

        const data = await r.json();
        console.log(`[relay] ✅ [${label}] Response from ${relayBase} — manifestMimeType: ${data.manifestMimeType}, hasUrls: ${!!data.urls}`);
        return await _parseRelayResponse(data, trackId, tidalQuality);

      } catch (fetchErr) {
        console.warn(`[relay] [${label}] Network error on ${relayBase}: ${fetchErr.message}`);
        lastErr = fetchErr;
        // Try next relay on network failure
        continue;
      }
    }
  }

  // All relay attempts exhausted
  const finalErr = lastErr || new Error(`All relay endpoints failed for track ${trackId}`);
  if (!finalErr.status) finalErr.status = 503;
  throw finalErr;
}

/**
 * Parse a TIDAL relay response into { streamUrl|segmentUrls, format, isDash }
 */
async function _parseRelayResponse(data, trackId, tidalQuality) {
  // ── Case 1: Direct URL manifest ────────────────────────────────────
  if (dashParser.isDirectUrlManifest(data)) {
    const streamUrl = data.urls[0];
    const fmt = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
    return { streamUrl, format: fmt, isDash: false };
  }

  // ── Case 2: DASH XML manifest ──────────────────────────────────────
  if (dashParser.isDashManifest(data)) {
    const manifest = await dashParser.parseManifest(data.manifest);
    const segmentUrls = dashParser.generateSegmentUrls(manifest);
    if (segmentUrls.length === 0) throw new Error('DASH manifest produced zero segment URLs');
    console.log(`[relay] DASH → ${segmentUrls.length} segments, codec: ${manifest.codecs}`);
    return {
      segmentUrls,
      format: 'dash',
      mimeType: manifest.mimeType || 'audio/mp4',
      isDash: true,
    };
  }

  // ── Case 3: Try extracting URL from legacy manifest string ─────────────
  if (data.manifest) {
    const decoded = Buffer.from(data.manifest.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const urlMatch = decoded.match(/https?:\/\/[\w\-.~:?#[\]@!$&'()*+,;=%/]+/g);
    if (urlMatch) {
      const streamUrl = urlMatch[0];
      return { streamUrl, format: 'm4a', isDash: false };
    }
  }

  // ── Case 4: legacy data.url or data.streamUrl ───────────────────────
  const fallbackUrl = data.url || data.streamUrl;
  if (fallbackUrl) return { streamUrl: fallbackUrl, format: 'm4a', isDash: false };

  throw new Error(`Relay response has no extractable stream URL for track ${trackId}`);
}

const MONOCHROME_TIDAL_PROXY = 'https://tidal-proxy.monochrome.tf';

function buildHeaders(target) {
  const headers = { 'Accept': 'application/json', 'User-Agent': BROWSER_UA };
  const isCustom = !target.baseUrl.includes('tidal.com') && !target.baseUrl.includes('monochrome.tf');
  if (isCustom) headers['X-Client'] = `BiniLossless/${APP_VERSION}`;
  return headers;
}

/**
 * Fetch from V2 proxy with automatic retry across multiple mirrors.
 * 
 * Attempt order (matches Monochrome's HiFiClient strategy):
 *   Step 0 (optional): tidal-proxy.monochrome.tf  — direct TIDAL relay if token present
 *   Step 1:            Live community mirrors (from uptime workers, priority-sorted)
 *   Step 2:            FALLBACK_BASE (hifi.geeked.wtf)
 */
async function fetchV2(path, maxAttempts = 10, bearerToken = null, opts = {}) {
  const { continueOn404 = false } = opts;
  // ─── Step 0: Try Monochrome's direct TIDAL reverse proxy first ──────────────
  // This bypasses all community mirrors and hits TIDAL directly via monochrome.tf.
  // Requires a Bearer token — when available (token manager initialized), this is
  // the most reliable path. Matches what Monochrome's HiFiClient.instance.query() does.
  if (bearerToken) {
    // Map community mirror paths (/track/?id=X) to standard TIDAL API paths (/v1/tracks/X)
    const tidalPath = path
      .replace(/^\/track\/\?id=(\d+)&quality=/, '/v1/tracks/$1/streamUrl?quality=')
      .replace(/^\/search\/\?s=/, '/v1/search?query=')
      .replace(/^\/search\/\?q=/, '/v1/search?query=');

    const proxyUrl = `${MONOCHROME_TIDAL_PROXY}${tidalPath.startsWith('/') ? '' : '/'}${tidalPath}`;
    try {
      const r = await fetch(proxyUrl, {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'User-Agent':    'okhttp/5.3.2',
          'Accept':        'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        console.log(`[tidal-v2] ✅ Direct proxy hit: ${MONOCHROME_TIDAL_PROXY}`);
        return { response: r, target: { name: 'monochrome-proxy', baseUrl: MONOCHROME_TIDAL_PROXY } };
      }
      console.log(`[tidal-v2] Direct proxy returned ${r.status} — falling through to mirrors`);
    } catch (proxyErr) {
      console.log(`[tidal-v2] Direct proxy unreachable: ${proxyErr.message} — falling through`);
    }
  }

  // ─── Step 1: Community mirrors (live list from uptime workers) ──────────────
  const liveMirrors = await getLiveMirrors().catch(() => FALLBACK_MIRRORS);
  const targets = liveMirrors.length > 0 ? liveMirrors : FALLBACK_MIRRORS;

  const tried = new Set();
  let lastError = null;

  for (let i = 0; i < Math.min(maxAttempts, targets.length * 2); i++) {
    // Weighted random selection — prioritySort already put hifi.geeked.wtf first,
    // but weighted random ensures load spreads when that mirror is down.
    const totalWeight = targets.reduce((sum, t) => sum + (t.weight || 10), 0);
    let r = Math.random() * totalWeight;
    let target = targets[0];
    for (const t of targets) {
      r -= (t.weight || 10);
      if (r <= 0) { target = t; break; }
    }

    if (tried.has(target.name) && tried.size < targets.length) {
      const fallback = targets.find(t => !tried.has(t.name));
      if (fallback) target = fallback;
    }

    tried.add(target.name);
    const url = `${target.baseUrl.replace(/\/+$/, '')}${path}`;
    try {
      const r = await fetch(url, { headers: buildHeaders(target), signal: AbortSignal.timeout(12000) });
      if (r.ok) return { response: r, target };
      console.warn(`[tidal-v2] ${target.name} returned ${r.status} for ${path}`);
      const errN = new Error(`${target.name}: HTTP ${r.status}`);
      errN.status = r.status;
      lastError = errN;
      // Continue to next mirror on:
      //  - 403 (banned), 404 (path not supported on this mirror, if allowed), 5xx (server error)
      // Stop on other 4xx that indicate a bad request (e.g. 400, 401, 429)
      const shouldContinue = r.status === 403 || r.status >= 500 || (continueOn404 && r.status === 404);
      if (!shouldContinue) break;
    } catch (err) {
      console.warn(`[tidal-v2] ${target.name} failed: ${err.message}`);
      lastError = err;
    }

    if (tried.size >= targets.length) break;
  }

  // ─── Step 2: Hard fallback (top-priority mirror, direct) ───────────────────
  try {
    const url = `${FALLBACK_BASE}${path}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { response: r, target: { name: 'fallback', baseUrl: FALLBACK_BASE } };
    const fbErr = new Error(`fallback: HTTP ${r.status}`);
    fbErr.status = r.status;
    if (!lastError) lastError = fbErr;
  } catch (err) {
    console.warn(`[tidal-v2] Fallback also failed: ${err.message}`);
  }

  throw lastError || new Error('All TIDAL proxy mirrors failed');
}

/**
 * Recursively find items array in a nested search response.
 * Handles shapes: { items: [...] }, { data: [...] }, { data: { items: [...] } }, bare [...]
 */
function findItems(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && (obj[0]?.id !== undefined || obj[0]?.title !== undefined)) return obj;
    return null;
  }
  if (visited.has(obj)) return null;
  visited.add(obj);
  if (Array.isArray(obj.items) && obj.items.length > 0) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findItems(val, visited);
      if (found) return found;
    }
  }
  return null;
}

async function searchTidal({ title, artist, isrc }) {
  const query = isrc || `${title} ${artist}`.trim();
  const path = `/search/?s=${encodeURIComponent(query)}`;
  const { response, target } = await fetchV2(path);
  const data = await response.json();
  const items = findItems(data) || [];
  if (items.length === 0) {
    if (isrc) return searchTidal({ title, artist, isrc: null });
    throw new Error(`No TIDAL results for: "${query}"`);
  }
  const best = items.find(t => t.title?.toLowerCase() === title?.toLowerCase()) || items[0];
  if (!best.artist && Array.isArray(best.artists) && best.artists.length > 0) {
    best.artist = best.artists[0];
  }
  console.log(`[tidal-v2] Search hit via ${target.name}: "${best.title}" (ID: ${best.id})`);
  return best;
}

function decodeManifest(manifest) {
  if (!manifest || typeof manifest !== 'string') return '';
  let normalized = manifest.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  if (pad === 3) normalized += '=';
  try { return Buffer.from(normalized, 'base64').toString('utf-8'); } catch { return manifest; }
}

function extractFromManifest(manifest) {
  const decoded = decodeManifest(manifest);

  // Guard: detect segmented DASH (SegmentTemplate) — cannot extract a single URL from these.
  // Returning null signals the caller to skip this manifest format.
  if (/<SegmentTemplate/i.test(decoded)) {
    console.warn('[tidal-v2] Segmented DASH manifest detected — cannot extract single stream URL');
    return null;
  }

  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed.urls) && parsed.urls.length > 0) return parsed.urls[0];
  } catch { /* not JSON */ }
  const baseUrlMatch = decoded.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
  if (baseUrlMatch?.[1]) {
    const url = baseUrlMatch[1].trim();
    if (url.startsWith('http')) return url;
  }
  const urlRegex = /https?:\/\/[\w\-.~:?#[\]@!$&'()*+,;=%/]+/g;
  let match;
  while ((match = urlRegex.exec(decoded)) !== null) {
    const url = match[0];
    if (url.includes('$Number$')) continue;
    if (/\/\d+\.mp4/.test(url)) continue;
    if (url.includes('.flac') || url.includes('.mp4') || url.includes('.m4a') ||
      url.includes('token=') || url.includes('/audio/')) {
      return url;
    }
  }
  return null;
}

function extractStreamUrl(data) {
  const container = data?.data ?? data;
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (entry?.manifest) return extractFromManifest(entry.manifest);
      if (entry?.url) return entry.url;
      if (entry?.urls?.[0]) return entry.urls[0];
    }
    return null;
  }
  if (container?.url) return container.url;
  if (container?.urls?.[0]) return container.urls[0];
  if (container?.manifest) return extractFromManifest(container.manifest);
  return null;
}

/**
 * Try community mirrors using the standard TIDAL v1 API path.
 * Some mirrors (hifi.geeked.wtf, monochrome.tf) support /v1/tracks/{id}/playbackinfopostpaywall
 * which returns DASH manifest directly, unlike the mirror-specific /track/?id= path.
 */
async function resolveViaMirrorsDirect(trackId, tidalQuality) {
  // Paths to try on community mirrors, in preference order
  const apiPaths = [
    // Standard TIDAL API path with Bearer token (preferred — returns DASH manifest)
    // Use /playbackinfo NOT /playbackinfopostpaywall (client_credentials tokens work with /playbackinfo)
    {
      path: `/v1/tracks/${trackId}/playbackinfo?audioquality=${tidalQuality}&playbackmode=STREAM&assetpresentation=FULL&countryCode=US`,
      needsAuth: true,
    },
    // Legacy community mirror path (returns wrapped stream URL)
    {
      path: `/track/?id=${trackId}&quality=${tidalQuality}`,
      needsAuth: false,
    },
  ];

  let lastErr = null;
  for (const { path, needsAuth } of apiPaths) {
    try {
      let bearerToken = null;
      if (needsAuth) {
        try { bearerToken = await getRelayToken(); } catch (_) { /* skip auth path if no token */ continue; }
      }
      const { response, target } = await fetchV2(path, 10, bearerToken, { continueOn404: needsAuth });
      const data = await response.json();
      console.log(`[tidal-v2] Mirror direct response from ${target.name} (path: ${path.substring(0, 60)})`);

      // Try DASH manifest first
      if (dashParser.isDashManifest(data)) {
        const manifest = await dashParser.parseManifest(data.manifest);
        const segmentUrls = dashParser.generateSegmentUrls(manifest);
        if (segmentUrls.length > 0) {
          console.log(`[tidal-v2] ✅ DASH from mirror direct: ${segmentUrls.length} segments`);
          return { segmentUrls, format: 'dash', mimeType: manifest.mimeType || 'audio/mp4', isDash: true };
        }
      }

      // Try direct URL
      if (dashParser.isDirectUrlManifest(data)) {
        const streamUrl = data.urls[0];
        const fmt = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
        console.log(`[tidal-v2] ✅ Direct URL from mirror direct: ${streamUrl.substring(0, 60)}`);
        return { streamUrl, format: fmt, isDash: false };
      }

      // Try legacy extractStreamUrl as last resort
      const streamUrl = extractStreamUrl(data);
      if (streamUrl) {
        const fmt = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
        console.log(`[tidal-v2] ✅ Legacy extracted URL from mirror: ${streamUrl.substring(0, 60)}`);
        return { streamUrl, format: fmt, isDash: false };
      }
    } catch (err) {
      console.warn(`[tidal-v2] Mirror direct path failed (${path.substring(0, 60)}): ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Mirror direct resolution failed for track ${trackId}`);
}

async function getTidalStreamUrl(trackId, quality = 'LOSSLESS') {
  const qualityMap = { LOSSLESS: 'LOSSLESS', HI_RES: 'HI_RES_LOSSLESS', HI_RES_LOSSLESS: 'HI_RES_LOSSLESS', HIGH: 'HIGH', LOW: 'LOW' };
  const tidalQuality = qualityMap[quality] || 'LOSSLESS';

  // ── Step 1: Try the direct relay (Monochrome strategy) ────────────────────
  try {
    const result = await resolveViaRelay(trackId, tidalQuality);
    console.log(`[tidal-v2] ✅ Stream via relay for track ${trackId} (${tidalQuality})`);
    return { ...result, quality: tidalQuality };
  } catch (relayErr) {
    console.warn(`[tidal-v2] All relays failed (${relayErr.message}) — trying mirror direct paths`);
  }

  // ── Step 2: Try community mirrors with v1 API path + legacy path ─────────
  try {
    const result = await resolveViaMirrorsDirect(trackId, tidalQuality);
    return { ...result, quality: tidalQuality };
  } catch (mirrorDirectErr) {
    console.warn(`[tidal-v2] Mirror direct failed (${mirrorDirectErr.message}) — trying legacy community path`);
  }

  // ── Step 3: Fall back to legacy community mirror path ────────────────────
  const path = `/track/?id=${trackId}&quality=${tidalQuality}`;
  const { response, target } = await fetchV2(path);
  const data = await response.json();
  const streamUrl = extractStreamUrl(data);
  if (!streamUrl) throw new Error(`No stream URL found in ${target.name} response for track ${trackId}`);
  const format = tidalQuality.includes('LOSSLESS') ? 'flac' : 'm4a';
  console.log(`[tidal-v2] Stream URL via ${target.name}: ${streamUrl.substring(0, 80)}...`);
  return { streamUrl, format, quality: tidalQuality };
}

/**
 * Quality fallback chain: tries from the requested quality downward.
 * LOSSLESS → HIGH → LOW  (HI_RES is skipped by default; account bans invalidate mirror cache)
 *
 * When ALL mirrors return 403 (TIDAL account banned on every mirror), the mirror cache
 * is invalidated so fresh mirrors are fetched on the next request.
 */
async function getTidalStreamUrlWithFallback(trackId, preferredQuality = 'LOSSLESS') {
  // Build chain starting from preferred quality
  const allQualities = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
  let startIndex = allQualities.indexOf(preferredQuality);
  // Default start at LOSSLESS (index 1) so we don't waste time on HI_RES_LOSSLESS
  if (startIndex < 0) startIndex = 1;
  const chain = allQualities.slice(startIndex);

  let lastError;
  let consecutiveBans = 0;

  for (const q of chain) {
    try {
      const result = await getTidalStreamUrl(trackId, q);
      // Accept both direct URL results and DASH results
      if (result.streamUrl || result.isDash) {
        if (q !== preferredQuality) {
          console.log(`[tidal-v2] Quality fallback: ${preferredQuality} → ${q} for track ${trackId}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`[tidal-v2] Quality ${q} failed for track ${trackId}: ${err.message}`);
      lastError = err;
      // Count 403 bans across quality attempts
      if (err.status === 403 || err.message?.includes('HTTP 403')) {
        consecutiveBans++;
      }
      // Always continue to next quality — don't give up early
    }
  }

  // If all qualities resulted in 403 bans, the mirror accounts are all banned.
  // Invalidate the cache so fresh mirrors are fetched on next attempt.
  if (consecutiveBans >= chain.length) {
    console.warn(`[tidal-v2] All mirrors returned 403 for track ${trackId} — invalidating mirror cache for fresh discovery`);
    invalidateMirrorCache();
  }

  throw lastError || new Error(`No playable quality available for track ${trackId}`);
}

// ─── GET /api/tidal-download/search ──────────────────────────────────────────
router.get('/search', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, limit = 20 } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing required query param: q' });

  try {
    const path = `/search/?s=${encodeURIComponent(q.trim())}`;
    const { response, target } = await fetchV2(path);
    const data = await response.json();
    const items = findItems(data) || [];
    const searchLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const results = items.slice(0, searchLimit).map(track => {
      const artistName = track.artists?.map(a => a.name).filter(Boolean).join(', ')
        || track.artist?.name || '';
      const albumTitle = track.album?.title || '';
      const albumCover = track.album?.cover
        ? `https://resources.tidal.com/images/${track.album.cover.replace(/-/g, '/')}/640x640.jpg`
        : null;
      const durationMs = (track.duration || 0) * 1000;
      return {
        id: track.id,
        title: track.title || '',
        artist: artistName,
        album: albumTitle,
        albumArt: albumCover,
        albumCoverId: track.album?.cover || null,
        audioQuality: track.audioQuality || 'LOSSLESS',
        durationMs,
        isrc: track.isrc || null,
      };
    });
    console.log(`[tidal-v2/search] "${q}" via ${target.name} → ${results.length} results`);
    return res.json({ results });
  } catch (err) {
    console.error('[tidal-v2/search] Failed:', err.message);
    return res.status(502).json({ error: 'TIDAL search failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/resolve ─────────────────────────────────────────
router.get('/resolve', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { title, artist, isrc, quality = 'LOSSLESS', tidalId } = req.query;

  // tidalId shortcut: when the frontend already knows the track ID from a prior search,
  // skip searchTidal() entirely — saves ~2-3 seconds and one mirror round-trip.
  const resolveId = tidalId ? String(tidalId).trim() : null;
  if (!resolveId && (!title || !artist)) {
    return res.status(400).json({ error: 'Missing required params: tidalId or (title + artist)' });
  }

  try {
    let trackId = resolveId;
    let trackMeta = { title, artist };

    if (!trackId) {
      // No ID provided — fall back to search
      const track = await searchTidal({ title, artist, isrc });
      trackId = track.id;
      trackMeta = {
        title: track.title || title,
        artist: track.artists?.map(a => a.name).join(', ') || artist,
        album: track.album?.title || '',
        durationMs: (track.duration || 0) * 1000,
      };
    }

    // Use quality fallback chain: HI_RES_LOSSLESS → LOSSLESS → HIGH → LOW
    const result = await getTidalStreamUrlWithFallback(trackId, quality);
    const { format, quality: resolvedQuality, isDash, streamUrl, segmentUrls, mimeType } = result;

    if (isDash) {
      console.log(`[tidal-download/resolve] ✓ ID:${trackId} (${resolvedQuality}) → DASH, ${segmentUrls.length} segments`);
      return res.json({
        tidalTrackId: trackId,
        title: trackMeta.title || title || '',
        artist: trackMeta.artist || artist || '',
        album: trackMeta.album || '',
        durationMs: trackMeta.durationMs || 0,
        format: 'dash',
        mimeType: mimeType || 'audio/mp4',
        quality: resolvedQuality,
        segmentUrls,
      });
    }

    console.log(`[tidal-download/resolve] ✓ ID:${trackId} (${resolvedQuality}) → ${streamUrl.substring(0, 80)}...`);
    return res.json({
      streamUrl,
      tidalTrackId: trackId,
      title: trackMeta.title || title || '',
      artist: trackMeta.artist || artist || '',
      album: trackMeta.album || '',
      durationMs: trackMeta.durationMs || 0,
      format,
      quality: resolvedQuality,
    });
  } catch (err) {
    console.error('[tidal-download/resolve] Failed:', err.message);
    // 403 from all mirrors = TIDAL has banned the proxy mirror accounts.
    // Return a distinct error code so the frontend can show a targeted message.
    const isMirrorBan = err.status === 403 || err.message?.includes('HTTP 403') || err.message?.includes('Forbidden');
    const isAllDown = err.message?.includes('All TIDAL proxy mirrors failed') || err.status === 503;
    const userMessage = isMirrorBan
      ? 'TIDAL mirror accounts are currently blocked — stream quality temporarily unavailable. Try downloading at a lower quality.'
      : isAllDown
        ? 'All TIDAL proxy mirrors are currently unreachable. Please try again in a few minutes.'
        : 'Failed to resolve TIDAL stream.';
    const statusCode = isMirrorBan ? 403 : 502;
    return res.status(statusCode).json({ error: userMessage, details: err.message, isMirrorBan, isAllDown });
  }
});

// ─── GET /api/tidal-download/stream ──────────────────────────────────────────
// CRITICAL: ExoPlayer sends "Range: bytes=X-Y" for seeking — must be forwarded.
router.get('/stream', (req, res) => {
  const { url: streamUrl } = req.query;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url param' });

  let parsedUrl;
  try { parsedUrl = new URL(streamUrl); } catch { return res.status(400).json({ error: 'Invalid stream URL' }); }

  const upstreamHeaders = {
    'User-Agent': BROWSER_UA,
    'Accept': 'audio/flac, audio/mp4, audio/*, */*',
    'Accept-Encoding': 'identity',
  };
  if (req.headers['range']) {
    upstreamHeaders['Range'] = req.headers['range'];
    console.log(`[tidal/stream] Forwarding Range: ${req.headers['range']}`);
  }

  const proto = parsedUrl.protocol === 'https:' ? https : http;
  const proxyReq = proto.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: upstreamHeaders,
    },
    (upstream) => {
      const status = upstream.statusCode || 502;
      if (status >= 400) {
        let body = '';
        upstream.on('data', c => (body += c.toString()));
        upstream.on('end', () => {
          if (!res.headersSent) res.status(status).json({ error: `TIDAL CDN returned ${status}`, hint: status === 401 ? 'Stream URL expired — resolve again' : undefined });
        });
        return;
      }
      res.status(status);
      const ct = upstream.headers['content-type'] || 'audio/flac';
      const cl = upstream.headers['content-length'];
      const cr = upstream.headers['content-range'];
      const ar = upstream.headers['accept-ranges'];
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Accept-Ranges', ar || 'bytes');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
      upstream.pipe(res);
      req.on('close', () => upstream.destroy());
    }
  );
  proxyReq.on('error', (err) => {
    console.error('[tidal-download/stream] Request error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'CDN connection failed', details: err.message });
  });
  proxyReq.end();
});

// ─── POST /api/tidal-download/zip ────────────────────────────────────────────
router.post('/zip', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { tracks, playlistName = 'Groove Playlist', quality = 'LOSSLESS' } = req.body || {};
  if (!Array.isArray(tracks) || tracks.length === 0) return res.status(400).json({ error: 'Missing tracks array' });
  if (tracks.length > 50) return res.status(400).json({ error: 'Max 50 tracks per ZIP request' });

  console.log(`[tidal-download/zip] Starting ZIP: "${playlistName}" — ${tracks.length} tracks`);
  const safeName = playlistName.replace(/[/\\:*?"<>|]/g, '_').trim();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  let succeeded = 0;
  const errors = [];

  for (const track of tracks) {
    const { title, artist, isrc } = track;
    try {
      const tidalTrack = await searchTidal({ title, artist, isrc });
      const { streamUrl, format } = await getTidalStreamUrl(tidalTrack.id, quality);
      const r = await fetch(streamUrl, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'audio/*,*/*', 'Accept-Encoding': 'identity' } });
      if (!r.ok) throw new Error(`CDN returned ${r.status}`);
      const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').trim();
      const safeArtist = artist.replace(/[/\\:*?"<>|]/g, '_').trim();
      const filename = `${safeArtist} - ${safeTitle}.${format}`;
      const audioBuffer = Buffer.from(await r.arrayBuffer());
      archive.append(audioBuffer, { name: filename });
      succeeded++;
      console.log(`[tidal-download/zip] ✓ Added: ${filename}`);
    } catch (err) {
      console.error(`[tidal-download/zip] ✗ Failed: "${title}" — ${err.message}`);
      errors.push(`❌ ${title} — ${err.message}`);
    }
  }

  if (errors.length > 0) archive.append(errors.join('\n'), { name: '_ERRORS.txt' });
  await archive.finalize();
  console.log(`[tidal-download/zip] Done: ${succeeded}/${tracks.length} tracks`);
});

// ─── GET /api/tidal-download/cover ────────────────────────────────────────────
router.get('/cover', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { id, q, size = '640' } = req.query;
  if (!id && !q) return res.status(400).json({ error: 'Missing required param: id or q' });

  try {
    const safeSizes = ['80', '160', '320', '640', '1280'];
    const sz = safeSizes.includes(size) ? size : '640';

    if (id) {
      const { title: titleQ, artist: artistQ } = req.query;
      const searchQuery = titleQ ? `${titleQ} ${artistQ || ''}`.trim() : null;
      if (searchQuery) {
        const path = `/search/?s=${encodeURIComponent(searchQuery)}`;
        const { response } = await fetchV2(path);
        const data = await response.json();
        const items = findItems(data) || [];
        const track = items.find(t => String(t.id) === String(id)) ?? items[0] ?? null;
        const coverUuid = track?.album?.cover ?? null;
        if (!coverUuid) return res.status(404).json({ error: 'No cover found for this track' });
        const coverUrl = `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg`;
        const videoCoverUuid = track?.album?.videoCover ?? null;
        const videoCoverUrl = videoCoverUuid ? `https://resources.tidal.com/videos/${videoCoverUuid.replace(/-/g, '/')}/${sz}x${sz}.mp4` : null;
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.json({ coverUrl, videoCoverUrl, coverUuid, videoCoverUuid });
      }
    }

    const path = `/search/?s=${encodeURIComponent(q.trim())}`;
    const { response } = await fetchV2(path);
    const data = await response.json();
    const items = findItems(data) || [];
    if (items.length === 0) return res.status(404).json({ error: 'No results found for query' });
    const best = items[0];
    const coverUuid = best?.album?.cover ?? null;
    if (!coverUuid) return res.status(404).json({ error: 'No cover found in search results' });
    const coverUrl = `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg`;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json({ coverUrl, coverUuid });
  } catch (err) {
    console.error('[tidal-download/cover]', err.message);
    return res.status(502).json({ error: 'Cover fetch failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/song ─────────────────────────────────────────────
router.get('/song', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { q, quality = 'LOSSLESS' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Missing required param: q' });

  try {
    const path = `/song/?q=${encodeURIComponent(q.trim())}&quality=${quality}`;
    const { response, target } = await fetchV2(path);
    if (!response.ok) return res.status(response.status).json({ error: `Proxy returned ${response.status}` });
    const data = await response.json();
    console.log(`[tidal-download/song] "${q}" via ${target.name}`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(data);
  } catch (err) {
    console.error('[tidal-download/song]', err.message);
    return res.status(502).json({ error: 'Song fetch failed', details: err.message });
  }
});

// ─── GET /api/tidal-download/track-metadata ───────────────────────────────────
router.get('/track-metadata', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');

  const { id, size = '640' } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing required param: id' });

  const safeSizes = ['320', '640', '1280'];
  const sz = safeSizes.includes(size) ? size : '640';

  try {
    const { title: titleQ, artist: artistQ } = req.query;
    const searchQuery = titleQ ? `${titleQ} ${artistQ || ''}`.trim() : String(id);
    const searchPath = `/search/?s=${encodeURIComponent(searchQuery)}`;
    const { response, target } = await fetchV2(searchPath);
    if (!response.ok) return res.status(response.status).json({ error: `Proxy returned ${response.status}` });
    const data = await response.json();
    const items = findItems(data) || [];
    const track = items.find(t => String(t.id) === String(id))
      ?? items.find(t => t.title?.toLowerCase() === titleQ?.toLowerCase())
      ?? items[0] ?? null;
    if (!track) return res.status(404).json({ error: `Track ${id} not found in proxy search results` });

    const album = track.album ?? {};
    const artist = track.artist ?? track.artists?.[0] ?? {};
    const coverUuid = album.cover ?? null;
    const videoCoverUuid = album.videoCover ?? null;
    const artistPicUuid = artist.picture ?? null;
    const coverUrl = coverUuid ? `https://resources.tidal.com/images/${coverUuid.replace(/-/g, '/')}/${sz}x${sz}.jpg` : null;
    const videoCoverUrl = videoCoverUuid ? `https://resources.tidal.com/videos/${videoCoverUuid.replace(/-/g, '/')}/${sz}x${sz}.mp4` : null;
    const artistPicUrl = artistPicUuid ? `https://resources.tidal.com/images/${artistPicUuid.replace(/-/g, '/')}/750x750.jpg` : null;
    const durationSec = track.duration ?? 0;
    const mins = Math.floor(durationSec / 60);
    const secs = Math.floor(durationSec % 60);

    const result = { tidalId: Number(id), title: track.title ?? '', artist: artist.name ?? '', album: album.title ?? '', coverUrl, videoCoverUrl, artistPicUrl, duration: `${mins}:${String(secs).padStart(2, '0')}`, durationSeconds: durationSec };
    console.log(`[tidal-download/track-metadata] ID ${id} via ${target.name} — cover: ${!!coverUrl}, video: ${!!videoCoverUrl}`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(result);
  } catch (err) {
    console.error('[tidal-download/track-metadata]', err.message);
    return res.status(502).json({ error: 'Track metadata fetch failed', details: err.message });
  }
});

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────────
router.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || null;
    res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Groove-Api-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  next();
});

export default router;
