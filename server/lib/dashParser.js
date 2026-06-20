/**
 * dashParser.js — DASH Manifest Parser (Node.js / ESM)
 *
 * TIDAL returns streaming manifests in two formats:
 *   1. Direct URLs:  { "urls": ["https://..."] }               ✅ Already works
 *   2. DASH XML:     { "manifest": "PG1wZD4...",
 *                      "manifestMimeType": "application/dash+xml" }  ← This file handles it
 *
 * Parsing steps:
 *   1. Base64-decode the manifest string → XML text
 *   2. Parse XML with xml2js (Node-compatible)
 *   3. Find the audio AdaptationSet + best-quality Representation
 *   4. Extract SegmentTemplate → generate segment URLs
 *   5. Return structured object used by proxy.js
 */

import { parseStringPromise } from 'xml2js';

export class DashParser {
  /**
   * Parse a Base64-encoded DASH XML manifest from TIDAL.
   * @param {string} base64Manifest - Raw Base64 string from TIDAL API response
   * @returns {Promise<Object>} Parsed manifest with baseUrl, segments[], etc.
   */
  async parseManifest(base64Manifest) {
    try {
      // ── Step 1: Base64 decode ──────────────────────────────────────────────
      // Normalise URL-safe Base64 (replace - with + and _ with /)
      let b64 = base64Manifest.trim().replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4;
      if (pad === 2) b64 += '==';
      if (pad === 3) b64 += '=';
      const xmlString = Buffer.from(b64, 'base64').toString('utf-8');

      // ── Step 2: Parse XML ──────────────────────────────────────────────────
      const xmlObj = await parseStringPromise(xmlString, {
        explicitArray: true,
        mergeAttrs: false,
        attrkey: '$',
        charkey: '_',
      });

      const mpd = xmlObj?.MPD;
      if (!mpd) throw new Error('Invalid DASH manifest: no MPD root element');

      const periods = mpd.Period;
      if (!periods || periods.length === 0) throw new Error('No Period element in DASH manifest');
      const period = periods[0];

      // ── Step 3: Find audio AdaptationSet ──────────────────────────────────
      const adaptationSets = period.AdaptationSet || [];
      let audioSet = adaptationSets.find(as =>
        as.$?.mimeType?.startsWith('audio')
      );
      if (!audioSet && adaptationSets.length > 0) {
        audioSet = adaptationSets[0]; // Fallback to first
      }
      if (!audioSet) throw new Error('No AdaptationSet found in DASH manifest');

      // ── Step 4: Best quality Representation ───────────────────────────────
      const reps = (audioSet.Representation || []).sort((a, b) => {
        return parseInt(b.$?.bandwidth || '0', 10) - parseInt(a.$?.bandwidth || '0', 10);
      });
      if (reps.length === 0) throw new Error('No Representation in AdaptationSet');
      const rep = reps[0];

      // ── Step 5: SegmentTemplate ────────────────────────────────────────────
      const segTemplate =
        (rep.SegmentTemplate || [])[0] ||
        (audioSet.SegmentTemplate || [])[0];
      if (!segTemplate) throw new Error('No SegmentTemplate in DASH manifest');

      const initialization = segTemplate.$?.initialization || null;   // e.g. "init.mp4"
      const media = segTemplate.$?.media || null;                     // e.g. "segment-$Number$.m4s"
      const startNumber = parseInt(segTemplate.$?.startNumber || '1', 10);

      // ── Step 6: BaseURL ────────────────────────────────────────────────────
      const baseUrlEl =
        (rep.BaseURL || [])[0] ||
        (audioSet.BaseURL || [])[0] ||
        (period.BaseURL || [])[0] ||
        (mpd.BaseURL || [])[0];
      const baseUrl = (typeof baseUrlEl === 'string' ? baseUrlEl : baseUrlEl?._ || '').trim();

      // ── Step 7: Segments from SegmentTimeline ─────────────────────────────
      const segments = [];
      const timeline = (segTemplate.SegmentTimeline || [])[0];
      if (timeline) {
        const sElements = timeline.S || [];
        let currentTime = 0;
        let currentNumber = startNumber;

        for (const s of sElements) {
          const attrs = s.$;
          if (attrs?.t) currentTime = parseInt(attrs.t, 10);
          const d = parseInt(attrs?.d || '0', 10);
          const r = parseInt(attrs?.r || '0', 10);

          segments.push({ number: currentNumber, time: currentTime });
          currentTime += d;
          currentNumber++;

          for (let i = 0; i < r; i++) {
            segments.push({ number: currentNumber, time: currentTime });
            currentTime += d;
            currentNumber++;
          }
        }
      }

      return {
        type: 'dash',
        baseUrl,
        initialization,
        media,
        segments,
        startNumber,
        mimeType: audioSet.$?.mimeType || 'audio/mp4',
        codecs: rep.$?.codecs || 'unknown',
      };

    } catch (err) {
      console.error('[DashParser] Parse error:', err.message);
      throw new Error(`Failed to parse DASH manifest: ${err.message}`);
    }
  }

  /**
   * Generate full segment URLs from a parsed manifest object.
   * @param {Object} manifest - Result of parseManifest()
   * @returns {string[]} Array of segment URLs (init + media segments)
   */
  generateSegmentUrls(manifest) {
    const urls = [];

    // Initialization segment (MP4 box header)
    if (manifest.initialization) {
      urls.push(`${manifest.baseUrl}${manifest.initialization}`);
    }

    // Media segments — replace $Number$ with actual segment number
    for (const seg of manifest.segments) {
      if (!manifest.media) continue;
      const segUrl = manifest.media.replace('$Number$', String(seg.number));
      urls.push(`${manifest.baseUrl}${segUrl}`);
    }

    return urls;
  }

  /**
   * Detect DASH XML manifest format from a TIDAL API response.
   */
  isDashManifest(response) {
    return response?.manifest &&
      response?.manifestMimeType === 'application/dash+xml';
  }

  /**
   * Detect direct URL manifest format from a TIDAL API response.
   */
  isDirectUrlManifest(response) {
    return Array.isArray(response?.urls) && response.urls.length > 0;
  }
}

export default new DashParser();
