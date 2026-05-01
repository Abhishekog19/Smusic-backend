import express from 'express';
import crypto from 'crypto';
import { isOriginAllowed } from '../lib/proxyConfig.js';

const router = express.Router();

const BROWSER_VERSION = '131';

const COMMON_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION}.0.0.0 Safari/537.36`,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': `"Chromium";v="${BROWSER_VERSION}", "Not(A:Brand";v="24", "Google Chrome";v="${BROWSER_VERSION}"`,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const FALLBACK_SECRET = [
  44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102,
  43, 69, 49, 120, 118, 80, 64, 78,
];

function getLatestTotpSecret() {
  return { version: 61, secret: FALLBACK_SECRET };
}

function generateTotp(secret) {
  const transformed = secret.map((e, t) => e ^ ((t % 33) + 9));
  const joined = transformed.map((n) => n.toString()).join('');
  const hexStr = Buffer.from(joined, 'ascii').toString('hex');
  const base32Secret = Buffer.from(hexStr, 'hex').toString('base64').replace(/=/g, '');

  const timeStep = Math.floor(Date.now() / 1000 / 30);
  const timeHex = timeStep.toString(16).padStart(16, '0');
  const hmac = crypto.createHmac('sha1', Buffer.from(base32Secret, 'base64'));
  hmac.update(Buffer.from(timeHex, 'hex'));
  const digest = hmac.digest();
  const offset = digest[19] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return code.toString().padStart(6, '0');
}

function extractJsLinks(html) {
  const links = [];
  const re = /<script[^>]+src="([^"]+\.js)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) links.push(m[1]);
  return links;
}

async function getSessionData() {
  const response = await fetch('https://open.spotify.com', {
    headers: COMMON_HEADERS,
    redirect: 'follow',
  });

  const html = await response.text();

  if (!html.includes('Spotify')) {
    throw new Error('Spotify homepage returned unexpected content — possible bot detection');
  }

  const setCookie = response.headers.get('set-cookie') || '';
  const deviceId = setCookie.match(/sp_t=([^;]+)/)?.[1] || crypto.randomUUID().replace(/-/g, '');

  let clientVersion = '';
  const configMatch = html.match(/<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/);
  if (configMatch) {
    try {
      const decoded = Buffer.from(configMatch[1], 'base64').toString('utf-8');
      clientVersion = JSON.parse(decoded).clientVersion || '';
    } catch { /* ignore */ }
  }
  if (!clientVersion) {
    clientVersion = html.match(/"clientVersion":"([^"]+)"/)?.[1] || `1.2.${BROWSER_VERSION}.0.ge-xyz`;
  }

  const allJs = extractJsLinks(html);
  const jsPackRel = allJs.find((l) => l.includes('web-player') && l.endsWith('.js')) || '';
  const jsPack = jsPackRel.startsWith('http') ? jsPackRel : `https://open.spotify.com${jsPackRel}`;

  return { deviceId, clientVersion, jsPack };
}

async function getAccessToken(totp, totpVer) {
  const params = new URLSearchParams({
    reason: 'init',
    productType: 'web-player',
    totp,
    totpVer: totpVer.toString(),
    totpServer: totp,
  });
  const r = await fetch(`https://open.spotify.com/api/token?${params}`, {
    headers: { ...COMMON_HEADERS, Accept: 'application/json' },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`Spotify token failed: ${r.status} — ${text.slice(0, 100)}`);
  }

  const data = await r.json();
  if (!data.accessToken) throw new Error('No accessToken in Spotify token response');
  return { accessToken: data.accessToken, clientId: data.clientId };
}

async function getClientToken(clientVersion, clientId, deviceId) {
  const payload = {
    client_data: {
      client_version: clientVersion,
      client_id: clientId,
      js_sdk_data: { device_type: 'computer', os: 'windows', device_id: deviceId },
    },
  };
  const r = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  return data.granted_token.token;
}

function extractMappings(jsCode) {
  const pattern = /\{\d+:"[^"]+"(?:,\d+:"[^"]+")*\}/g;
  const matches = jsCode.match(pattern);
  if (!matches || matches.length < 5) return [{}, {}];

  const parseMapping = (str) => {
    const result = {};
    const entries = str.slice(1, -1).split(/,(?=\d+:)/);
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      if (idx === -1) continue;
      result[entry.substring(0, idx).trim()] = entry.substring(idx + 1).trim().replace(/^"|"$/g, '');
    }
    return result;
  };

  return [parseMapping(matches[3]), parseMapping(matches[4])];
}

const FALLBACK_HASH = '19ff1c571c9e3e2e0a9f9e0e7b7cb8c5c3d45e3d8c4f5e6f7e8f9a0b1c2d3e4f';

async function getSha256Hash(jsPack) {
  if (!jsPack) return FALLBACK_HASH;
  try {
    const r = await fetch(jsPack, { headers: COMMON_HEADERS });
    let rawCode = await r.text();
    const [strMap, hashMap] = extractMappings(rawCode);

    const chunkFetches = Object.entries(strMap)
      .filter(([key]) => hashMap[key])
      .map(async ([key, str]) => {
        const hash = hashMap[key];
        const chunkUrl = `https://open.spotifycdn.com/cdn/build/web-player/${str}.${hash}.js`;
        try {
          const cr = await fetch(chunkUrl, { headers: COMMON_HEADERS });
          return await cr.text();
        } catch { return ''; }
      });

    const chunks = await Promise.all(chunkFetches);
    rawCode += chunks.join('');

    return rawCode.split('"fetchPlaylist","query","')[1]?.split('"')[0] || FALLBACK_HASH;
  } catch (err) {
    console.error('[spotify-playlist] getSha256Hash failed:', err.message);
    return FALLBACK_HASH;
  }
}

async function fetchPlaylist(accessToken, clientToken, clientVersion, playlistId, sha256Hash, offset = 0, limit = 343) {
  const payload = {
    operationName: 'fetchPlaylist',
    variables: { uri: `spotify:playlist:${playlistId}`, offset, limit, enableWatchFeedEntrypoint: false },
    extensions: { persistedQuery: { version: 1, sha256Hash } },
  };
  const r = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
    method: 'POST',
    headers: {
      'User-Agent': COMMON_HEADERS['User-Agent'],
      Authorization: `Bearer ${accessToken}`,
      'Client-Token': clientToken,
      'Spotify-App-Version': clientVersion,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function getAllItems(accessToken, clientToken, clientVersion, playlistId, sha256Hash) {
  const items = [];
  let offset = 0;
  const limit = 343;

  while (true) {
    const data = await fetchPlaylist(accessToken, clientToken, clientVersion, playlistId, sha256Hash, offset, limit);
    const content = data?.data?.playlistV2?.content || data?.data?.playlist?.content;
    if (!content?.items?.length) break;
    items.push(...content.items);
    if (content.totalCount <= offset + limit) break;
    offset += limit;
  }

  return items;
}

/**
 * Extract rich track metadata from a Spotify internal GraphQL playlist item.
 * Handles multiple nesting shapes across API versions.
 * KEY: extracts ISRC for exact cross-platform matching instead of text search.
 */
function extractTrackMeta(item) {
  // Probe multiple possible nesting shapes
  const track =
    item?.itemV2?.data?.item?.data || // newest shape (double-nested)
    item?.itemV2?.data ||             // common shape
    item?.item?.data ||               // older shape
    item?.data ||
    item;

  if (!track) return null;

  const uri =
    track.uri ||
    item?.itemV2?.data?.uri ||
    item?.item?.data?.uri ||
    item?.uri;

  if (!uri || !uri.includes('spotify:track:')) return null;
  const spotifyId = uri.split(':')[2];

  const title = track.name || track.trackMetadata?.trackName || '';

  const artistItems = track.artists?.items || track.trackMetadata?.artists || [];
  const artist = artistItems
    .map(a => a?.profile?.name || a?.name || '')
    .filter(Boolean)
    .join(', ') || '';

  const album = track.albumOfTrack?.name || track.album?.name || '';

  const sources = track.albumOfTrack?.coverArt?.sources || track.album?.images || [];
  const albumArt = sources
    .filter(s => s?.url)
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';

  // ISRC — used for exact TIDAL matching
  const isrc =
    track.externalId?.id ||
    track.externalIds?.isrc ||
    (Array.isArray(track.externalIds)
      ? track.externalIds.find(e => e?.type === 'isrc')?.id
      : null) ||
    '';

  const durationMs = track.trackDuration?.totalMilliseconds || track.duration_ms || 0;

  return { spotifyId, spotifyUrl: `https://open.spotify.com/track/${spotifyId}`, title, artist, album, albumArt, isrc, durationMs };
}

router.post('/', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');

  let { playlistUrl } = req.body || {};
  if (!playlistUrl) return res.status(400).json({ error: 'Missing playlistUrl' });

  try {
    // ── Resolve shortened URLs (spotify.link, etc.) ──
    if (playlistUrl.includes('spotify.link/') || !playlistUrl.includes('open.spotify.com/')) {
      try {
        const resolved = await fetch(playlistUrl, {
          method: 'HEAD',
          redirect: 'follow',
          headers: { 'User-Agent': COMMON_HEADERS['User-Agent'] },
          signal: AbortSignal.timeout(8000),
        });
        if (resolved.url && resolved.url !== playlistUrl) {
          console.log(`[spotify-playlist] Resolved: ${playlistUrl} → ${resolved.url}`);
          playlistUrl = resolved.url;
        }
      } catch (resolveErr) {
        console.warn(`[spotify-playlist] URL resolve failed (trying original):`, resolveErr.message);
      }
    }

    // ── Extract playlist ID (handles ?si=, &utm_source=, etc.) ──
    const playlistIdMatch = playlistUrl.match(/playlist\/([a-zA-Z0-9]+)/);
    const playlistId = playlistIdMatch ? playlistIdMatch[1] : '';
    if (!playlistId) return res.status(400).json({ error: 'Invalid Spotify playlist URL. Make sure you\'re pasting a playlist link.' });

    console.log(`[spotify-playlist] Fetching playlist: ${playlistId}`);

    const { deviceId, clientVersion, jsPack } = await getSessionData();
    const { secret, version } = getLatestTotpSecret();
    const totp = generateTotp(secret);
    const { accessToken, clientId } = await getAccessToken(totp, version);
    const clientToken = await getClientToken(clientVersion, clientId, deviceId);
    const sha256Hash = await getSha256Hash(jsPack);

    // First page gives us the playlist name; getAllItems fetches all pages
    const firstPage = await fetchPlaylist(accessToken, clientToken, clientVersion, playlistId, sha256Hash, 0, 343);
    const meta = firstPage?.data?.playlistV2 || firstPage?.data?.playlist || {};
    const playlistName = meta?.name || meta?.data?.name || 'Spotify Playlist';

    const rawItems = await getAllItems(accessToken, clientToken, clientVersion, playlistId, sha256Hash);
    const tracks = rawItems.map(extractTrackMeta).filter(Boolean);
    const isrcCount = tracks.filter(t => t.isrc).length;

    console.log(`[spotify-playlist] "${playlistName}": ${tracks.length} tracks, ${isrcCount}/${tracks.length} with ISRC`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.json({ tracks, songLinks: tracks.map(t => t.spotifyUrl), totalTracks: tracks.length, playlistName });
  } catch (err) {
    console.error('[spotify-playlist] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch playlist', details: err.message });
  }
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

export default router;
