/**
 * apiInstances.js — Thin wrapper over mirrorDiscovery.js
 *
 * The plan calls for an ApiInstanceManager class but mirrorDiscovery.js already
 * implements the same functionality (fetches live mirrors from Cloudflare Workers,
 * 15-min cache, fallback list).
 *
 * This file re-exports mirrorDiscovery's interface in the shape that proxy.js and
 * retryManager.js expect, so no logic is duplicated.
 */

import { getLiveMirrors, invalidateMirrorCache, FALLBACK_MIRRORS } from './mirrorDiscovery.js';

export class ApiInstanceManager {
  constructor() {
    this._mirrors = null;
    this._loaded = false;
  }

  /**
   * Load/refresh the live mirror list.
   * Call once on startup; results are cached 15 min in mirrorDiscovery.
   */
  async loadInstances(forceRefresh = false) {
    if (forceRefresh) invalidateMirrorCache();
    this._mirrors = await getLiveMirrors();
    this._loaded = true;
    return this._mirrors;
  }

  /**
   * Returns the current mirror list (loads on first call if needed).
   * @param {string} _type - ignored ('api' | 'streaming') — mirrorDiscovery returns combined list
   */
  async getInstances(_type = 'api') {
    if (!this._mirrors) {
      await this.loadInstances();
    }
    return this._mirrors;
  }

  /**
   * Synchronous version — returns whatever is cached.
   * Throws if not yet loaded.
   */
  getInstancesSync(_type = 'api') {
    if (!this._mirrors) {
      return FALLBACK_MIRRORS; // Safe fallback before first load
    }
    return this._mirrors;
  }

  /**
   * Pick a random mirror for load balancing.
   */
  async getRandomInstance(_type = 'api') {
    const instances = await this.getInstances();
    return instances[Math.floor(Math.random() * instances.length)];
  }
}

export const apiInstanceManager = new ApiInstanceManager();
export default apiInstanceManager;
