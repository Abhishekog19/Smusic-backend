/**
 * Shared Spotify web-player session utilities.
 * Used by both spotify-playlist and songlink routes.
 */
import crypto from 'crypto';

const BROWSER_VERSION = '131';
export const COMMON_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION}.0.0.0 Safari/537.36`,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Ch-Ua': `"Chromium";v="${BROWSER_VERSION}", "Not(A:Brand";v="24", "Google Chrome";v="${BROWSER_VERSION}"`,
};

const FALLBACK_SECRET = [
  44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102,
  43, 69, 49, 120, 118, 80, 64, 78,
];

export function generateTotp(secret = FALLBACK_SECRET) {
  const transformed = secret.map((e, t) => e ^ ((t % 33) + 9));
  const joined = transformed.map(n => n.toString()).join('');
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

// Simple in-memory session cache
let _session = null;
let _sessionExpiry = 0;

async function ensureSession() {
  if (_session && Date.now() < _sessionExpiry) return _session;

  // 1. Get web-player access token via TOTP
  const totp = generateTotp();
  const params = new URLSearchParams({
    reason: 'init', productType: 'web-player',
    totp, totpVer: '61', totpServer: totp,
  });

  const tokenRes = await fetch(`https://open.spotify.com/api/token?${params}`, {
    headers: { ...COMMON_HEADERS, Accept: 'application/json' },
  });
  if (!tokenRes.ok) throw new Error(`Spotify web-player token failed: ${tokenRes.status}`);
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.accessToken;
  const clientId = tokenData.clientId;

  // 2. Get client-token (needed for partner API requests)
  const deviceId = crypto.randomUUID().replace(/-/g, '');
  const clientPayload = {
    client_data: {
      client_version: `1.2.${BROWSER_VERSION}.0.ge-xyz`,
      client_id: clientId,
      js_sdk_data: { device_type: 'computer', os: 'windows', device_id: deviceId },
    },
  };

  const ctRes = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(clientPayload),
  });

  let clientToken = '';
  if (ctRes.ok) {
    const ctData = await ctRes.json();
    clientToken = ctData.granted_token?.token || '';
  }

  _session = { accessToken, clientId, clientToken, deviceId };
  _sessionExpiry = Date.now() + 40 * 60 * 1000; // Cache 40 min
  return _session;
}

export async function getWebPlayerToken() {
  const { accessToken } = await ensureSession();
  return accessToken;
}

/**
 * Fetch a single track's metadata using the Spotify partner API.
 * Uses full session (access token + client token).
 */
export async function getSpotifyTrack(trackId) {
  const { accessToken, clientToken } = await ensureSession();

  // Spotify v1 API with web-player token + client token
  const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'client-token': clientToken,
      'app-platform': 'WebPlayer',
      Accept: 'application/json',
    },
  });

  if (r.status === 429) {
    // Rate limited — clear cached session so next call gets fresh token
    _session = null;
    _sessionExpiry = 0;
    throw Object.assign(new Error('Spotify track API rate limited'), { status: 429 });
  }

  if (!r.ok) {
    throw new Error(`Spotify track API failed: ${r.status}`);
  }

  const track = await r.json();
  const isrc = track.external_ids?.isrc || null;

  return {
    id: trackId,
    name: track.name || '',
    artists: (track.artists || []).map(a => a.name),
    isrc,
    albumArt: track.album?.images?.[0]?.url || null,
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
  };
}
