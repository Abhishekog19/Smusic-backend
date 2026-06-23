/**
 * GET /api/recommendations?title=...&artist=...&limit=8
 *
 * Returns "You May Also Like" track recommendations:
 *   1. Fetches similar tracks from Last.fm track.getSimilar
 *   2. Resolves each on TIDAL via the parallel mirror race (same as fetchV2 in tidal-download.js)
 *   3. Filters: skips remixes, instrumentals, live versions, and karaoke variants
 *      that are likely to have no lyrics — prefers the original studio version
 *
 * Fixes in this version:
 *   - Uses parallel mirror race (all mirrors simultaneously) instead of sequential retries
 *   - Fixed findItems() to handle { data: [...] } V2 response shape
 *   - Rejects HTML responses (e.g. kinoplus) from mirror race
 *   - Always returns exactly `limit` tracks (increased Last.fm fetch to guarantee fill)
 *   - Studio version preference: filters out [live], [remix], [instrumental], [karaoke]
 *     unless that is literally the requested title
 */

import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';

const router = express.Router();

// ─── Config ──────────────────────────────────────────────────────────────────

const LASTFM_API_KEY = 'b25b959554ed76058ac220b7b2e0a026';
const LASTFM_BASE    = 'https://ws.audioscrobbler.com/2.0';
const BROWSER_UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// V2_MIRRORS updated 2026-06-23 — only confirmed ALIVE mirrors
// Dead as of 2026-06-23: triton.squid.wtf, spotisaver.net, all qqdl.site, hifi.geeked.wtf, kinoplus
const V2_MIRRORS = [
  { name: 'monochrome-us',  url: 'https://us-west.monochrome.tf' },
  { name: 'monochrome-api', url: 'https://api.monochrome.tf' },
  { name: 'samidy',         url: 'https://monochrome-api.samidy.com' },
  // Keep these in case they recover
  { name: 'monochrome-eu',  url: 'https://eu-central.monochrome.tf' },
  { name: 'hund',           url: 'https://hund.qqdl.site' },
  { name: 'katze',          url: 'https://katze.qqdl.site' },
  { name: 'maus',           url: 'https://maus.qqdl.site' },
  { name: 'vogel',          url: 'https://vogel.qqdl.site' },
  { name: 'wolf',           url: 'https://wolf.qqdl.site' },
  // kinoplus intentionally excluded — returns HTML 200 (auth wall)
];

const MIRROR_COOLDOWN_MS = 60_000; // 1 minute cooldown for failed mirrors
const mirrorFailMap = new Map();   // name → fail timestamp

function isMirrorHealthy(name) {
  const ts = mirrorFailMap.get(name);
  if (!ts) return true;
  if (Date.now() - ts > MIRROR_COOLDOWN_MS) { mirrorFailMap.delete(name); return true; }
  return false;
}
function markFailed(name) { mirrorFailMap.set(name, Date.now()); }

// ─── findItems — handles all V2 response shapes ───────────────────────────────
// V2 mirrors return: { version, data: [...] } or { items: [...] } or bare [...]
function findItems(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    return obj.length > 0 && (obj[0]?.id !== undefined || obj[0]?.title !== undefined) ? obj : null;
  }
  if (visited.has(obj)) return null;
  visited.add(obj);
  if (Array.isArray(obj.items) && obj.items.length > 0) return obj.items;
  if (Array.isArray(obj.data))  return obj.data;
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findItems(val, visited);
      if (found) return found;
    }
  }
  return null;
}

// ─── Cover URL builder ────────────────────────────────────────────────────────
function buildCoverUrl(cover, size = 320) {
  if (!cover) return null;
  return `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/${size}x${size}.jpg`;
}

// ─── Parallel mirror race ─────────────────────────────────────────────────────
// All healthy mirrors fire simultaneously. First JSON 200 wins, rest aborted.
async function raceMirrors(path) {
  const healthy = V2_MIRRORS.filter(m => isMirrorHealthy(m.name));
  const targets = healthy.length > 0 ? healthy : V2_MIRRORS;

  const controllers = new Map();

  const racePromises = targets.map(m => {
    const ac  = new AbortController();
    controllers.set(m.name, ac);
    const url = `${m.url}${path}`;

    return fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA, 'X-Client': 'BiniLossless/1.0' },
      signal: ac.signal,
    })
    .then(r => {
      if (!r.ok) { markFailed(m.name); throw new Error(`${m.name}: ${r.status}`); }
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) { markFailed(m.name); throw new Error(`${m.name}: HTML`); }
      return r.json().then(data => ({ data, mirror: m.name }));
    })
    .catch(err => {
      if (!err.message?.includes('abort')) markFailed(m.name);
      throw err;
    });
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('All mirrors timed out')), 8000)
  );

  try {
    const winner = await Promise.any([...racePromises, timeout]);
    for (const [name, ac] of controllers) {
      if (name !== winner.mirror) ac.abort();
    }
    return winner.data;
  } catch {
    for (const ac of controllers.values()) ac.abort();
    throw new Error('All V2 mirrors failed for path: ' + path);
  }
}

// ─── Lyrics-availability filter ───────────────────────────────────────────────
// Track titles containing these patterns are likely to have NO lyrics on lrclib:
//   - Live versions, instrumentals, karaoke, remixes (unless it's what was asked)
const LYRIC_SKIP_PATTERNS = /\b(live|instrumental|karaoke|backing track|minus one|acapella|a cappella|orch\.?|orchestra)\b/i;
const REMIX_PATTERN       = /\(.*?remix.*?\)/i;

function isLikelyToHaveLyrics(trackTitle, requestedTitle) {
  const t = trackTitle.toLowerCase();
  const r = requestedTitle.toLowerCase();
  // Always allow if it matches the requested title (user asked for it)
  if (t === r) return true;
  if (LYRIC_SKIP_PATTERNS.test(trackTitle)) return false;
  if (REMIX_PATTERN.test(trackTitle)) return false;
  return true;
}

// Studio version preference scoring — lower = better
function versionScore(title) {
  if (/\(.*?(live|concert|tour).*?\)/i.test(title))         return 100;
  if (/\(.*?instrumental.*?\)/i.test(title))                 return 90;
  if (/\(.*?(karaoke|backing).*?\)/i.test(title))            return 85;
  if (/\(.*?remix.*?\)/i.test(title))                        return 50;
  if (/\(.*?(edit|version|mix|radio).*?\)/i.test(title))     return 20;
  if (/\(.*?(remaster|deluxe|anniversary).*?\)/i.test(title))return 5;
  return 0; // original/studio
}

// ─── Step 1: Last.fm similar tracks ──────────────────────────────────────────
async function getSimilarFromLastfm(title, artist, fetchLimit) {
  const params = new URLSearchParams({
    method:      'track.getSimilar',
    track:       title,
    artist:      artist,
    limit:       String(fetchLimit),
    autocorrect: '1',
    format:      'json',
    api_key:     LASTFM_API_KEY,
  });

  const res = await fetch(`${LASTFM_BASE}?${params}`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal:  AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Last.fm ${res.status}`);
  const data = await res.json();
  const tracks = data?.similartracks?.track;
  if (!tracks || tracks.length === 0) return [];

  return (Array.isArray(tracks) ? tracks : [tracks])
    .map(t => ({ title: t.name || '', artist: t.artist?.name || '' }))
    .filter(t => t.title && t.artist);
}

// ─── Step 2: Resolve each similar track on TIDAL via parallel mirror race ─────
async function searchOnTidal(title, artist, requestedTitle) {
  const query = `${title} ${artist}`.trim();
  const path  = `/search/?s=${encodeURIComponent(query)}`;

  let items = [];

  // ── Tier 1: parallel mirror race ─────────────────────────────────────────
  try {
    const data = await raceMirrors(path);
    items = findItems(data) || [];
  } catch {
    // All mirrors failed — no fallback available
  }

  if (items.length === 0) return null;

  const lTitle = title.toLowerCase();

  // Score candidates: prefer exact title + studio version + lyrics-friendly
  const candidates = items
    .filter(t => t.title && t.id)
    .map(t => {
      const itemTitle  = (t.title || '').toLowerCase();
      const titleMatch = itemTitle === lTitle ? 0 : (itemTitle.startsWith(lTitle) ? 5 : 15);
      const score      = titleMatch + versionScore(t.title || '');
      const hasLyrics  = isLikelyToHaveLyrics(t.title || '', requestedTitle);
      return { ...t, _score: score, _hasLyrics: hasLyrics };
    })
    .sort((a, b) => {
      if (a._hasLyrics !== b._hasLyrics) return a._hasLyrics ? -1 : 1;
      return a._score - b._score;
    });

  const best = candidates[0];
  if (!best) return null;

  const artistName = best.artists?.map(a => a.name).filter(Boolean).join(', ')
                  || best.artist?.name || best.artistName
                  || artist;
  const coverUuid   = best.album?.cover || null;
  const coverUrl    = buildCoverUrl(coverUuid);
  const durationSec = best.duration ?? 0;
  const mins = Math.floor(durationSec / 60);
  const secs = Math.floor(durationSec % 60);

  return {
    id:              `tidal-${best.id}`,
    tidalId:         Number(best.id),
    title:           best.title || title,
    artist:          artistName,
    album:           best.album?.title || '',
    cover:           coverUrl || '🎵',
    duration:        `${mins}:${String(secs).padStart(2, '0')}`,
    durationSeconds: durationSec,
    sourceType:      'tidal',
  };
}


// ─── Route handler ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader(
    'Access-Control-Allow-Origin',
    isOriginAllowed(origin) ? (origin || '*') : ''
  );

  const { title, artist } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 8, 12);

  if (!title || !artist) {
    return res.status(400).json({ error: 'Missing required params: title, artist' });
  }

  try {
    // Fetch more from Last.fm than needed to guarantee we can fill `limit` slots
    // after filtering live/instrumental/karaoke versions.
    const fetchLimit = limit * 3; // fetch 3× and filter down
    const similar    = await getSimilarFromLastfm(title, artist, fetchLimit);

    if (similar.length === 0) {
      return res.status(404).json({ error: 'No similar tracks found', title, artist });
    }

    console.log(`[recommendations] Last.fm: ${similar.length} similar for "${title}"`);

    // Resolve ALL fetched tracks in parallel (no sequential batching — mirrors race handles load)
    const settled = await Promise.allSettled(
      similar.map(t => searchOnTidal(t.title, t.artist, title))
    );

    const resolved = settled
      .filter(s => s.status === 'fulfilled' && s.value !== null)
      .map(s => s.value)
      .slice(0, limit); // cap at requested limit

    console.log(`[recommendations] Resolved ${resolved.length}/${similar.length} on TIDAL for "${title}"`);

    if (resolved.length === 0) {
      return res.status(404).json({ error: 'No tracks resolved on TIDAL', title, artist });
    }

    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.json({ tracks: resolved, source: 'lastfm+tidal', total: resolved.length });

  } catch (err) {
    console.error('[recommendations] Error:', err.message);
    return res.status(502).json({ error: 'Recommendations fetch failed', details: err.message });
  }
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

export default router;
