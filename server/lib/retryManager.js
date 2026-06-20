/**
 * retryManager.js — Multi-Instance Retry with Exponential Backoff
 *
 * Wraps fetch() calls to TIDAL proxy mirrors with:
 *   - Round-robin / weighted random instance selection
 *   - Exponential backoff on network errors
 *   - Rate-limit detection (429) → immediate instance switch
 *   - Auth failure tracking (401)
 *   - Per-instance failure counting for smart routing
 *
 * Used by proxy.js routes (/track/:id, /search, /album/:id).
 * Integrates with apiInstances.js which sources mirrors from mirrorDiscovery.js.
 */

export class RetryManager {
  /**
   * @param {Array<{name: string, baseUrl: string, weight?: number}>} instances
   */
  constructor(instances) {
    this.instances   = instances || [];
    this.failCounts  = new Map();  // baseUrl → failure count
    this.lastAttempt = new Map();  // baseUrl → Date.now()
  }

  /**
   * Execute a fetch request with automatic retry and instance failover.
   *
   * @param {string} endpoint     - API path, e.g. '/v1/tracks/123/streamUrl?quality=LOSSLESS'
   * @param {RequestInit} options - fetch options (headers, method, etc.)
   * @param {number} [maxAttempts] - defaults to instances.length * 2
   * @returns {Promise<Response>} The first successful Response
   */
  async executeWithRetry(endpoint, options = {}, maxAttempts = null) {
    if (this.instances.length === 0) {
      throw new Error('RetryManager: no instances configured');
    }

    maxAttempts = maxAttempts ?? this.instances.length * 2;

    // Random start for load balancing
    let idx = Math.floor(Math.random() * this.instances.length);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const instance = this.instances[idx % this.instances.length];
      const baseUrl  = instance.baseUrl ?? instance.url ?? instance;

      // Skip instances in exponential backoff window
      if (this._inBackoff(baseUrl)) {
        console.log(`[Retry] ⏳ ${baseUrl} in backoff — skipping`);
        idx++;
        continue;
      }

      const targetUrl = `${baseUrl.replace(/\/+$/, '')}${endpoint}`;

      try {
        console.log(`[Retry] Attempt ${attempt}/${maxAttempts} → ${baseUrl}`);

        const response = await fetch(targetUrl, {
          ...options,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          console.log(`[Retry] ✅ Success on attempt ${attempt} (${baseUrl})`);
          this._success(baseUrl);
          return response;
        }

        // 429 Rate Limited — try next instance immediately
        if (response.status === 429) {
          console.log(`[Retry] 429 Rate Limited on ${baseUrl} — trying next`);
          this._fail(baseUrl);
          lastError = new Error(`Rate limited on ${baseUrl}`);
          idx++;
          continue;
        }

        // 401 Unauthorized — likely token expired, not an instance issue
        if (response.status === 401) {
          console.log(`[Retry] 401 Unauthorized — token may be expired`);
          lastError = new Error(`Auth failed (401) on ${baseUrl}`);
          lastError.status = 401;
          idx++;
          continue;
        }

        // 403 Forbidden — mirror account may be banned
        if (response.status === 403) {
          console.log(`[Retry] 403 Forbidden on ${baseUrl} — mirror may be banned`);
          this._fail(baseUrl);
          lastError = new Error(`Forbidden (403) on ${baseUrl}`);
          lastError.status = 403;
          idx++;
          continue;
        }

        // 404 — content doesn't exist, stop trying
        if (response.status === 404) {
          const err = new Error(`Track not found (404)`);
          err.status = 404;
          throw err;
        }

        // Other errors
        console.log(`[Retry] HTTP ${response.status} on ${baseUrl}`);
        this._fail(baseUrl);
        lastError = new Error(`HTTP ${response.status} from ${baseUrl}`);
        lastError.status = response.status;
        idx++;
        continue;

      } catch (err) {
        if (err.status === 404) throw err; // Don't retry 404s

        console.log(`[Retry] ❌ Network error on ${baseUrl}: ${err.message}`);
        this._fail(baseUrl);
        lastError = err;
        idx++;

        // Exponential backoff — cap at 8 seconds
        const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 8_000);
        const jitter = Math.random() * backoffMs * 0.3;
        console.log(`[Retry] Waiting ${Math.round(backoffMs + jitter)}ms...`);
        await new Promise(r => setTimeout(r, backoffMs + jitter));
      }
    }

    console.error(`[Retry] ❌ All ${maxAttempts} attempts exhausted`);
    throw lastError || new Error('All API instances failed');
  }

  /** Mark a successful request — clears failure count */
  _success(baseUrl) {
    this.failCounts.delete(baseUrl);
    this.lastAttempt.set(baseUrl, Date.now());
  }

  /** Increment failure count */
  _fail(baseUrl) {
    this.failCounts.set(baseUrl, (this.failCounts.get(baseUrl) || 0) + 1);
    this.lastAttempt.set(baseUrl, Date.now());
  }

  /** Returns true if an instance should be skipped (still in backoff) */
  _inBackoff(baseUrl) {
    const failures = this.failCounts.get(baseUrl) || 0;
    if (failures === 0) return false;

    const lastTime   = this.lastAttempt.get(baseUrl) || 0;
    const backoffMs  = Math.min(500 * Math.pow(2, failures - 1), 30_000);
    return Date.now() < lastTime + backoffMs;
  }

  /**
   * Returns per-instance status object for the /retry-status monitoring endpoint.
   */
  getStatus() {
    const result = {};
    for (const inst of this.instances) {
      const url = inst.baseUrl ?? inst.url ?? inst;
      result[url] = {
        failures:    this.failCounts.get(url) || 0,
        inBackoff:   this._inBackoff(url),
        lastAttempt: new Date(this.lastAttempt.get(url) || 0).toISOString(),
      };
    }
    return result;
  }
}

export default RetryManager;
