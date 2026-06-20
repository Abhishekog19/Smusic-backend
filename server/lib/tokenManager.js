/**
 * tokenManager.js — Server-side TIDAL OAuth2 Token Management
 *
 * Problem: Tokens obtained on the frontend expire after ~1 hour.
 * If a playback session exceeds the token lifetime, mid-song failure occurs.
 *
 * Solution: Manage tokens server-side. The backend proactively refreshes
 * the token before it expires so frontend-facing requests always succeed.
 *
 * Flow:
 *   1. On first request, get token via client_credentials grant
 *   2. Cache it in memory with expiry timestamp
 *   3. On subsequent requests, return cached token (if valid with 60s buffer)
 *   4. When expired, transparently refresh before returning
 */

export class TokenManager {
  /**
   * @param {string} clientId     - TIDAL_CLIENT_ID from environment
   * @param {string} clientSecret - TIDAL_CLIENT_SECRET from environment
   */
  constructor(clientId, clientSecret) {
    this.clientId     = clientId;
    this.clientSecret = clientSecret;

    this.accessToken  = null;
    this.refreshToken = null;
    this.tokenExpiry  = null;  // Unix ms timestamp

    console.log('[TokenManager] Initialized — client:', clientId?.substring(0, 8) + '...');
  }

  /**
   * Get a valid access token. Auto-refreshes when within 60 seconds of expiry.
   * @returns {Promise<string>} Valid Bearer token
   */
  async getValidToken() {
    const bufferMs = 60_000;
    if (this.accessToken && this.tokenExpiry > Date.now() + bufferMs) {
      const remainingSec = Math.round((this.tokenExpiry - Date.now()) / 1000);
      console.log(`[Token] Using cached token (expires in ${remainingSec}s)`);
      return this.accessToken;
    }

    console.log('[Token] Token expired or missing — refreshing...');
    return this.refreshAccessToken();
  }

  /**
   * Request a fresh token from TIDAL using client_credentials grant.
   * TIDAL tokens are valid for 86400 seconds (24 hours) with client credentials.
   */
  async refreshAccessToken() {
    try {
      const body = new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     this.clientId,
        client_secret: this.clientSecret,
      });

      const response = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'okhttp/5.3.2',  // ⭐ Mobile UA required
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          `Token request failed: ${response.status} — ${errData.error_description || response.statusText}`
        );
      }

      const data = await response.json();

      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000);
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
      }

      console.log(`[Token] ✅ New token acquired (expires in ${data.expires_in}s)`);
      return this.accessToken;

    } catch (err) {
      console.error('[Token] Refresh failed:', err.message);
      throw new Error(`Token refresh failed: ${err.message}`);
    }
  }

  /**
   * Returns a status object for the /api/health endpoint.
   */
  getTokenInfo() {
    if (!this.accessToken) return { status: 'no_token' };

    const expiresIn = this.tokenExpiry - Date.now();
    return {
      status:     expiresIn > 60_000 ? 'valid' : 'expired',
      expiresIn:  Math.round(expiresIn / 1000),
      tokenLength: this.accessToken.length,
    };
  }
}

// ── Singleton management ──────────────────────────────────────────────────────

let _instance = null;

/**
 * Initialize the global TokenManager. Call once at server startup.
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {TokenManager}
 */
export function initializeTokenManager(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new Error('TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET are required in .env');
  }
  _instance = new TokenManager(clientId, clientSecret);
  return _instance;
}

/**
 * Get the global TokenManager instance.
 * @returns {TokenManager}
 */
export function getTokenManager() {
  if (!_instance) {
    throw new Error('TokenManager not initialized — call initializeTokenManager() first');
  }
  return _instance;
}

export default { initializeTokenManager, getTokenManager, TokenManager };
