/**
 * qobuzProxy.js — Qobuz Community Proxy Integration
 *
 * Uses the community Qobuz proxy at qobuz.kennyy.com.br to stream full,
 * lossless tracks. Works by searching by title+artist, then matching ISRC.
 *
 * TESTED API format (live, 2026-06-22):
 *   Search:  GET /api/get-music?q={title+artist}&offset=0
 *            → { data: { tracks: [{id, isrc, title, performer, audio_info}...],
 *                        albums: [...], artists: [...], ... } }
 *   Stream:  GET /api/download-music?track_id={id}&quality={format_id}
 *            → { success: true, data: { url: "https://streaming-qobuz..." } }
 *
 * Quality format_id map:
 *   HI_RES_LOSSLESS → 27  (24-bit FLAC hi-res)
 *   LOSSLESS        → 6   (16-bit FLAC)
 *   HIGH/LOW/NORMAL → 5   (MP3 320kbps)
 */

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Community Qobuz proxy instances — tried in order
const QOBUZ_INSTANCES = [
  'https://qobuz.kennyy.com.br',
];

// Quality → Qobuz format_id mapping
const QUALITY_MAP = {
  HI_RES_LOSSLESS: '27',
  LOSSLESS:        '6',
  HIGH:            '5',
  LOW:             '5',
  NORMAL:          '5',
};

/**
 * Resolve a full-length stream URL for a track.
 * Searches by title+artist, matches the track with the given ISRC.
 *
 * @param {string} isrc     - ISRC for exact matching (e.g. "CAUM71900813")
 * @param {string} quality  - Quality tier: HI_RES_LOSSLESS | LOSSLESS | HIGH | LOW
 * @param {object} [meta]   - Optional: { title, artist } for search query (improves matching)
 * @returns {Promise<{url, format, quality, provider: 'qobuz', rgInfo}|null>}
 */
export async function resolveQobuzStream(isrc, quality = 'LOSSLESS', meta = {}) {
  if (!isrc) {
    console.warn('[qobuz] No ISRC provided — skipping');
    return null;
  }

  const formatId = QUALITY_MAP[quality] || '6';
  const format   = formatId === '27' ? 'flac_24bit' : formatId === '6' ? 'flac' : 'mp3_320';

  // Build search query: use "title artist" if available, else ISRC as fallback text
  const searchQuery = (meta?.title && meta?.artist)
    ? `${meta.title} ${meta.artist}`.trim()
    : (meta?.title || isrc);

  for (const baseUrl of QOBUZ_INSTANCES) {
    try {
      // ── Step 1: Search by title+artist ────────────────────────────────────
      const searchUrl = `${baseUrl}/api/get-music?q=${encodeURIComponent(searchQuery)}&offset=0`;
      console.log(`[qobuz] Searching: "${searchQuery}" on ${baseUrl}`);

      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!searchRes.ok) {
        console.warn(`[qobuz] Search HTTP ${searchRes.status} from ${baseUrl}`);
        continue;
      }

      const searchJson = await searchRes.json();

      // API returns { data: { tracks: [...], albums: [...], ... } }
      // OR          { tracks: [...] } (direct)
      const rawData = searchJson?.data || searchJson;
      let tracks = [];

      if (Array.isArray(rawData?.tracks)) {
        tracks = rawData.tracks;
      } else if (Array.isArray(rawData?.tracks?.items)) {
        tracks = rawData.tracks.items;  // Monochrome-style fallback shape
      }

      if (tracks.length === 0) {
        console.warn(`[qobuz] No tracks in search results for "${searchQuery}"`);
        continue;
      }

      // Find best match: prefer exact ISRC match, then fall back to first result
      const match = tracks.find(t => t.isrc?.toUpperCase() === isrc.toUpperCase()) || tracks[0];

      if (!match?.id) {
        console.warn(`[qobuz] No valid track ID in results for ISRC ${isrc}`);
        continue;
      }

      const qobuzTrackId = match.id;
      const matchedIsrc  = match.isrc || 'unknown';
      const isExactMatch = matchedIsrc.toUpperCase() === isrc.toUpperCase();
      console.log(`[qobuz] Match: "${match.title}" (id: ${qobuzTrackId}, ISRC: ${matchedIsrc}, exact: ${isExactMatch})`);

      // ── Step 2: Get stream URL ─────────────────────────────────────────────
      const streamUrl = `${baseUrl}/api/download-music?track_id=${qobuzTrackId}&quality=${formatId}`;
      console.log(`[qobuz] Fetching stream URL...`);

      const streamRes = await fetch(streamUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });

      if (!streamRes.ok) {
        console.warn(`[qobuz] Stream request HTTP ${streamRes.status} from ${baseUrl}`);
        continue;
      }

      const streamJson = await streamRes.json();

      if (!streamJson?.success || !streamJson?.data?.url) {
        console.warn(`[qobuz] Bad stream response:`, JSON.stringify(streamJson).substring(0, 150));
        continue;
      }

      // ── Step 3: Replay gain info ───────────────────────────────────────────
      let rgInfo = null;
      if (match.audio_info) {
        rgInfo = {
          trackReplayGain:    match.audio_info.replaygain_track_gain ?? 0,
          trackPeakAmplitude: match.audio_info.replaygain_track_peak ?? 1,
          albumReplayGain:    match.audio_info.replaygain_album_gain ?? 0,
          albumPeakAmplitude: match.audio_info.replaygain_album_peak ?? 1,
        };
      }

      console.log(`[qobuz] ✅ Stream resolved (${format}, ISRC match: ${isExactMatch})`);
      return {
        url:      streamJson.data.url,
        format,
        quality,
        provider: 'qobuz',
        rgInfo,
        isExactMatch,
      };

    } catch (err) {
      console.warn(`[qobuz] Instance ${baseUrl} error: ${err.message}`);
    }
  }

  console.warn(`[qobuz] All instances failed for ISRC ${isrc}`);
  return null;
}

/**
 * Quick health check — tests if the primary Qobuz proxy is reachable.
 */
export async function checkQobuzHealth() {
  const instance = QOBUZ_INSTANCES[0];
  const start    = Date.now();
  try {
    const res = await fetch(`${instance}/api/get-music?q=test&offset=0`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8_000),
    });
    return { ok: res.ok, instance, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, instance, latencyMs: Date.now() - start, error: err.message };
  }
}
