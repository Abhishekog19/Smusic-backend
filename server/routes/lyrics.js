/**
 * GET /api/lyrics?title=...&artist=...&album=...&duration=...
 *
 * Fetches synchronized (or plain) lyrics via a multi-provider fallback chain:
 *   1. lrclib.net   → real LRC timestamps [MM:SS.ms]  (best, free, no key)
 *   2. lyrics.ovh   → plain text, evenly spread across duration (fallback)
 *
 * Query params:
 *   title    {string} required  — track title
 *   artist   {string} required  — artist name
 *   album    {string} optional  — album name (improves lrclib matching)
 *   duration {number} optional  — track duration in seconds (improves lrclib matching)
 */

import express from 'express';
import { isOriginAllowed } from '../lib/proxyConfig.js';

const router = express.Router();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const LRCLIB_UA  = 'Smusic/1.0 (https://github.com/smusic)';

/* ─── Provider 1: lrclib.net ───────────────────────────────────────────────── */
// Returns real synced LRC lyrics. Free, no auth. Database of ~7M songs.

async function fetchLrclib(title, artist, album, duration) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  if (album)    params.set('album_name', album);
  if (duration) params.set('duration',   String(Math.round(Number(duration))));

  const url = `https://lrclib.net/api/get?${params}`;
  const res  = await fetch(url, {
    headers: { 'Lrclib-Client': LRCLIB_UA, 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`);

  const data = await res.json();
  const lyrics = data.syncedLyrics || data.plainLyrics || null;
  if (!lyrics) return null;

  return {
    syncedLyrics: data.syncedLyrics || null,
    plainLyrics:  data.plainLyrics  || null,
    provider:     'lrclib',
    isSynced:     !!data.syncedLyrics,
  };
}

/* ─── Provider 2: lyrics.ovh ──────────────────────────────────────────────── */
// Returns plain text. Free, no auth. We spread lines evenly across duration.

function spreadLyricsAcrossDuration(plainText, durationSec) {
  const lines = plainText.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const totalMs    = (durationSec && durationSec > 0) ? durationSec * 1000 : lines.length * 3500;
  const intervalMs = totalMs / lines.length;

  const formatLrcTime = (ms) => {
    const totalSec = Math.floor(ms / 1000);
    const mm  = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const ss  = (totalSec % 60).toString().padStart(2, '0');
    const cs  = Math.floor((ms % 1000) / 10).toString().padStart(2, '0');
    return `${mm}:${ss}.${cs}`;
  };

  return lines.map((line, i) => `[${formatLrcTime(i * intervalMs)}] ${line}`).join('\n');
}

async function fetchLyricsOvh(title, artist, durationSec) {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const res  = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.lyrics) return null;

  const plain  = data.lyrics.trim();
  const synced = spreadLyricsAcrossDuration(plain, durationSec);

  return {
    syncedLyrics: synced,
    plainLyrics:  plain,
    provider:     'lyrics.ovh',
    isSynced:     false, // estimated, not true sync
  };
}

/* ─── Route handler ────────────────────────────────────────────────────────── */

router.get('/', async (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader(
    'Access-Control-Allow-Origin',
    isOriginAllowed(origin) ? (origin || '*') : ''
  );

  const { title, artist, album, duration } = req.query;

  if (!title || !artist) {
    return res.status(400).json({ error: 'Missing required params: title, artist' });
  }

  const errors = [];

  // ── Provider 1: lrclib (synced) ──────────────────────────────────────────
  try {
    const result = await fetchLrclib(title, artist, album, duration);
    if (result) {
      console.log(`[/api/lyrics] lrclib ✓ "${title}" – ${artist} (synced: ${result.isSynced})`);
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
      return res.json(result);
    }
    errors.push('lrclib: not found (404)');
  } catch (err) {
    console.warn(`[/api/lyrics] lrclib failed: ${err.message}`);
    errors.push(`lrclib: ${err.message}`);
  }

  // ── Provider 2: lyrics.ovh (plain → estimated sync) ──────────────────────
  try {
    const result = await fetchLyricsOvh(title, artist, parseFloat(duration) || 0);
    if (result) {
      console.log(`[/api/lyrics] lyrics.ovh ✓ "${title}" – ${artist} (plain spread)`);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.json(result);
    }
    errors.push('lyrics.ovh: not found');
  } catch (err) {
    console.warn(`[/api/lyrics] lyrics.ovh failed: ${err.message}`);
    errors.push(`lyrics.ovh: ${err.message}`);
  }

  // ── All providers exhausted ───────────────────────────────────────────────
  console.log(`[/api/lyrics] No lyrics found for "${title}" – ${artist}`);
  return res.status(404).json({
    error:   'Lyrics not found',
    title,
    artist,
    tried:   errors,
  });
});

router.options('/', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Access-Control-Allow-Origin', isOriginAllowed(origin) ? (origin || '*') : '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

export default router;
