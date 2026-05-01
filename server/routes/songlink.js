import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';
import { getSpotifyTrack } from '../lib/spotifySession.js';

const router = express.Router();

const PRIMARY_SONGLINK = 'https://api.song.link/v1-alpha.1/links';
const BACKUP_SONGLINK  = 'https://tracks.monochrome.tf/api/links';
const BROWSER_CACHE_TTL = 2_592_000; // 30 days
const SHORT_CACHE_TTL   = 3_600;     // 1 hour (for oEmbed fallback)

/**
 * Fetch Spotify track metadata via the public oEmbed API.
 * No API key needed. Returns { title, artistName, thumbnailUrl } or null.
 *
 * oEmbed title format: "Track Name by Artist Name" (Spotify's format)
 */
async function getSpotifyOEmbed(spotifyUrl) {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const r = await fetch(oembedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return null;
  const data = await r.json();

  // oEmbed title is "Track Name" and author_name is the artist name
  const title = data.title || null;
  const artistName = data.author_name || null;
  // thumbnail_url is usually a low-res Spotify logo, not track art — skip it
  return title ? { title, artistName } : null;
}

/**
 * Primary approach: Build a Songlink-compatible response from the Spotify
 * track URL alone (no API call needed). Attempts to enrich with title/ISRC
 * via Spotify session, but works even when the API is rate-limited.
 */
async function convertViaSpotify(spotifyUrl) {
  const trackId = spotifyUrl.match(/track\/([a-zA-Z0-9]+)/)?.[1];
  if (!trackId) throw new Error('Not a Spotify track URL');

  let name = null, artists = [], isrc = null, albumArt = null;

  // Try Spotify session first (may fail if rate limited — that's OK)
  try {
    const track = await getSpotifyTrack(trackId);
    name = track.name;
    artists = track.artists;
    isrc = track.isrc;
    albumArt = track.albumArt;
  } catch (err) {
    console.warn('[songlink] Spotify session enrich skipped:', err.message);
  }

  // If Spotify session failed, try oEmbed for at least title + artist
  if (!name) {
    try {
      const oembed = await getSpotifyOEmbed(spotifyUrl);
      if (oembed?.title) {
        name = oembed.title;
        if (oembed.artistName) artists = [oembed.artistName];
        console.log('[songlink] oEmbed enriched:', name, 'by', artists[0]);
      }
    } catch (err) {
      console.warn('[songlink] oEmbed enrich skipped:', err.message);
    }
  }

  const enriched = !!name;

  // TIDAL search URL — use ISRC if available, otherwise search by title+artist
  const searchQuery = isrc
    ? `isrc:${isrc}`
    : name
      ? `${name} ${artists[0] || ''}`.trim()
      : trackId;

  const tidalSearchUrl = `https://listen.tidal.com/search?q=${encodeURIComponent(searchQuery)}`;

  return {
    entityUniqueId: `SPOTIFY_SONG::${trackId}`,
    userCountry: 'US',
    pageUrl: `https://song.link/s/${trackId}`,
    title: name || `Spotify Track ${trackId.slice(0, 8)}`,
    artistName: artists.join(', ') || '',
    thumbnailUrl: albumArt || null,
    linksByPlatform: {
      spotify: {
        url: spotifyUrl,
        nativeAppUriMobile: `spotify:track:${trackId}`,
        entityUniqueId: `SPOTIFY_SONG::${trackId}`,
      },
      tidal: {
        url: tidalSearchUrl,
        entityUniqueId: isrc ? `TIDAL_SONG::isrc:${isrc}` : `TIDAL_SEARCH::${trackId}`,
      },
    },
    entitiesByUniqueId: {
      [`SPOTIFY_SONG::${trackId}`]: {
        id: trackId, type: 'song',
        title: name || '', artistName: artists.join(', ') || '',
        thumbnailUrl: albumArt || null,
        apiProvider: 'spotify', platforms: ['spotify'],
        isrc,
      },
    },
    _source: 'spotify-direct',
    _isrc: isrc || null,
    _enriched: enriched,
    _searchQuery: searchQuery,  // pass to frontend for TIDAL search fallback
  };
}

/**
 * Fallback: try song.link APIs with client IP forwarding.
 */
function buildSonglinkUrl(params, useBackup = false) {
  const url = new URL(useBackup ? BACKUP_SONGLINK : PRIMARY_SONGLINK);
  url.searchParams.set('url', params.url);
  if (params.userCountry) url.searchParams.set('userCountry', params.userCountry);
  if (params.songIfSingle !== undefined) url.searchParams.set('songIfSingle', String(params.songIfSingle));
  return url.toString();
}

function getSonglinkHeaders(req) {
  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1';
  return {
    'User-Agent': 'Antigravity/1.0',
    Accept: 'application/json',
    'X-Forwarded-For': clientIp,
  };
}

async function fetchFromSonglink(primaryUrl, backupUrl, headers) {
  for (const [url, sourceName] of [[primaryUrl, 'primary'], [backupUrl, 'backup']]) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return { data: await r.json(), source: sourceName, status: r.status };
      if (r.status === 404) return { data: await r.json(), source: sourceName, status: 404 };
      console.warn(`[songlink] ${sourceName} returned ${r.status}`);
    } catch (err) {
      console.warn(`[songlink] ${sourceName} threw: ${err.message}`);
    }
  }
  throw Object.assign(new Error('All Songlink APIs failed (likely rate limited)'), { status: 429 });
}

// ─── Route ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');

  let url = req.query.url || '';

  const params = {
    url,
    userCountry: req.query.userCountry || 'US',
    songIfSingle: req.query.songIfSingle === 'true',
  };

  if (!params.url) return res.status(400).json({ error: 'Missing required parameter: url' });

  // ── Resolve shortened URLs (spotify.link, etc.) ──
  if (params.url.includes('spotify.link/') || (params.url.includes('spotify') && !params.url.includes('open.spotify.com/'))) {
    try {
      const resolved = await fetch(params.url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      if (resolved.url && resolved.url !== params.url) {
        console.log(`[songlink] Resolved: ${params.url} → ${resolved.url}`);
        params.url = resolved.url;
      }
    } catch (resolveErr) {
      console.warn(`[songlink] URL resolve failed:`, resolveErr.message);
    }
  }

  const isSpotifyTrack = params.url.includes('open.spotify.com/track/');

  // ── Strategy 1: Spotify Direct + oEmbed fallback ──────────────────────────
  // Returns immediately only if we got at least title + artist (enriched).
  // If unenriched, we try song.link for a proper TIDAL ID first.
  let spotifyDirectData = null;
  if (isSpotifyTrack) {
    try {
      spotifyDirectData = await convertViaSpotify(params.url);
      if (spotifyDirectData._enriched) {
        res.setHeader('Cache-Control', `public, max-age=${BROWSER_CACHE_TTL}`);
        res.setHeader('X-Songlink-Source', 'spotify-direct');
        return res.json(spotifyDirectData);
      }
      console.warn('[songlink] Spotify+oEmbed both unenriched — trying song.link for TIDAL ID');
    } catch (err) {
      console.warn('[songlink] Spotify direct threw:', err.message, '— falling back to song.link');
    }
  }

  // ── Strategy 2: song.link APIs (real TIDAL ID) ────────────────────────────
  try {
    const headers = getSonglinkHeaders(req);
    const primary = buildSonglinkUrl(params, false);
    const backup  = buildSonglinkUrl(params, true);
    const { data, source, status } = await fetchFromSonglink(primary, backup, headers);

    // If song.link succeeded but has no TIDAL entry, merge with our Spotify+oEmbed data
    if (spotifyDirectData && (!data.linksByPlatform?.tidal)) {
      data.title = data.title || spotifyDirectData.title;
      data.artistName = data.artistName || spotifyDirectData.artistName;
      data.thumbnailUrl = data.thumbnailUrl || spotifyDirectData.thumbnailUrl;
      data._mergedFromSpotify = true;
    }

    res.setHeader('Cache-Control', `public, max-age=${BROWSER_CACHE_TTL}`);
    res.setHeader('X-Songlink-Source', source);
    return res.status(status).json(data);
  } catch (err) {
    console.warn('[songlink] song.link rate-limited or failed:', err.message);

    // ── Strategy 3: Return Spotify+oEmbed data with _searchQuery for TIDAL fallback ──
    // Even without a TIDAL ID, the client can use _searchQuery to search TIDAL.
    if (spotifyDirectData) {
      res.setHeader('Cache-Control', `public, max-age=${SHORT_CACHE_TTL}`);
      res.setHeader('X-Songlink-Source', 'spotify-only');
      return res.json(spotifyDirectData);
    }

    const code = err.status || 502;
    return res.status(code).json({
      error: code === 429
        ? 'Rate limited — please retry in a few seconds'
        : 'Failed to convert URL',
      details: err.message,
      retryAfter: code === 429 ? 5 : undefined,
    });
  }
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

export default router;
