/**
 * isrcResolver.js — Fetch ISRC and track metadata from TIDAL community mirrors
 *
 * ISRC (International Standard Recording Code) is the key to unlocking
 * Qobuz, Deezer, and Amazon Music playback. This module fetches it from
 * TIDAL's metadata endpoint via community proxy mirrors.
 *
 * Mirrors are ONLY used for metadata (search, track info, album art) —
 * NOT for audio streaming. Audio comes from Qobuz/Deezer/Amazon.
 *
 * API path: GET {mirror}/info/?id={tidalTrackId}
 * Returns:  { data: { id, title, isrc, duration, artists, album, ... } }
 */

import { getLiveMirrors, FALLBACK_MIRRORS } from './mirrorDiscovery.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// In-memory ISRC cache to avoid redundant mirror calls
const isrcCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch track metadata (including ISRC) from TIDAL community mirrors.
 * Only the mirrors are used — no TIDAL auth needed, mirrors return full metadata.
 *
 * @param {string|number} trackId  - TIDAL track ID
 * @returns {Promise<{isrc: string, title: string, artist: string, album: string, duration: number, albumCoverId: string|null}>}
 */
export async function resolveTrackMetadata(trackId) {
  const id = String(trackId);

  // Check cache
  const cached = isrcCache.get(id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[isrcResolver] Cache hit for track ${id} (ISRC: ${cached.data.isrc})`);
    return cached.data;
  }

  // Get live mirrors (metadata-only; these are NOT used for streaming)
  const mirrors = await getLiveMirrors().catch(() => FALLBACK_MIRRORS);

  let lastError = null;

  for (const mirror of mirrors) {
    const baseUrl = mirror.baseUrl || mirror.url || '';
    if (!baseUrl) continue;

    const infoUrl = `${baseUrl}/info/?id=${id}`;
    try {
      const res = await fetch(infoUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[isrcResolver] ${res.status} from ${baseUrl} for track ${id}`);
        lastError = new Error(`Mirror ${baseUrl}: HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();

      // Mirrors can return { data: {...} } or the object directly
      const raw = json?.data || json;
      const items = Array.isArray(raw) ? raw : [raw];
      const track = items.find(i => i?.id == id || i?.item?.id == id);
      const t = track?.item || track;

      if (!t || !t.isrc) {
        console.warn(`[isrcResolver] No ISRC in response from ${baseUrl} for track ${id}`);
        lastError = new Error(`No ISRC in mirror response`);
        continue;
      }

      // Build normalized metadata object
      const artistName = Array.isArray(t.artists) && t.artists.length > 0
        ? t.artists.map(a => a?.name).filter(Boolean).join(', ')
        : t.artist?.name || '';

      const metadata = {
        isrc:         t.isrc,
        tidalId:      id,
        title:        t.title || '',
        artist:       artistName,
        album:        t.album?.title || '',
        duration:     t.duration || 0,
        albumCoverId: t.album?.cover || null,
        audioQuality: t.audioQuality || 'LOSSLESS',
      };

      // Cache the result
      isrcCache.set(id, { data: metadata, timestamp: Date.now() });

      console.log(`[isrcResolver] ✅ Resolved track ${id}: ISRC=${metadata.isrc}, title="${metadata.title}"`);
      return metadata;

    } catch (err) {
      console.warn(`[isrcResolver] Mirror ${baseUrl} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error(`Could not resolve ISRC for track ${id} from any mirror`);
}

/**
 * Convenience: just returns the ISRC string (or null if not found).
 * @param {string|number} trackId
 * @returns {Promise<string|null>}
 */
export async function getISRC(trackId) {
  try {
    const meta = await resolveTrackMetadata(trackId);
    return meta.isrc || null;
  } catch {
    return null;
  }
}

/**
 * Search for a track by title+artist on community mirrors.
 * Returns the first result's metadata including ISRC.
 *
 * @param {string} query - Search string (e.g. "Blinding Lights The Weeknd")
 * @returns {Promise<object|null>}
 */
export async function searchTrackMetadata(query) {
  const mirrors = await getLiveMirrors().catch(() => FALLBACK_MIRRORS);

  for (const mirror of mirrors) {
    const baseUrl = mirror.baseUrl || mirror.url || '';
    if (!baseUrl) continue;

    const searchUrl = `${baseUrl}/search/?s=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) continue;

      const json = await res.json();
      const items = findItems(json) || [];
      if (items.length === 0) continue;

      const track = items[0];
      if (!track?.id) continue;

      const artistName = Array.isArray(track.artists) && track.artists.length > 0
        ? track.artists.map(a => a?.name).filter(Boolean).join(', ')
        : track.artist?.name || '';

      return {
        isrc:         track.isrc || null,
        tidalId:      String(track.id),
        title:        track.title || '',
        artist:       artistName,
        album:        track.album?.title || '',
        duration:     track.duration || 0,
        albumCoverId: track.album?.cover || null,
        audioQuality: track.audioQuality || 'LOSSLESS',
      };

    } catch {
      // Try next mirror
    }
  }

  return null;
}

// ── Internal helper ────────────────────────────────────────────────────────────

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
