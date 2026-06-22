'use strict';

// Jito tip-floor calculator. Per @uyar121 thread, MEV bots dominate
// new-pool events — to compete we need Jito tips (the ANB example cited
// showed bribes up to 141 SOL). This module:
//   - Polls Jito public tip-floor API
//   - Recommends a tip for a given opportunity size
//   - Logs tip trends to DB (for back-testing later)
//
// Endpoint: https://bundles.jito.wtf/api/v1/bundles/tip_floor
//   (other jito.* hosts ENOTFOUND from this network; verified 2026-06-22)

const axios = require('axios');
const log = require('./logger');

const TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const CACHE_TTL_MS = 60 * 1000; // 60s — tip floor is fast-moving

class JitoTip {
  constructor() {
    this.cache = null;
    this.cacheTs = 0;
    this.stats = {
      calls: 0,
      lastSuccess: 0,
      lastError: null,
    };
  }

  /**
   * Get current tip floor. Returns { p50, p75, p95, p99 } in lamports
   * (NOT SOL) or null on error. Cached 60s.
   */
  async getTipFloor() {
    if (this.cache && Date.now() - this.cacheTs < CACHE_TTL_MS) {
      return this.cache;
    }
    this.stats.calls += 1;
    try {
      const res = await axios.get(TIP_FLOOR_URL, { timeout: 10000 });
      if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
        log.warn('[jito] tip floor: empty response');
        return this.cache;
      }
      // Use the most recent entry
      const latest = res.data[res.data.length - 1];
      const floor = {
        time: latest.time,
        p50_lamports: latest.landed_tips_50th_percentile || 0,
        p75_lamports: latest.landed_tips_75th_percentile || 0,
        p95_lamports: latest.landed_tips_95th_percentile || 0,
        p99_lamports: latest.landed_tips_99th_percentile || 0,
      };
      this.cache = floor;
      this.cacheTs = Date.now();
      this.stats.lastSuccess = Date.now();
      log.info(
        `[jito] tip floor: p50=${(floor.p50_lamports/1e9).toFixed(4)} SOL | ` +
        `p95=${(floor.p95_lamports/1e9).toFixed(4)} SOL | ` +
        `p99=${(floor.p99_lamports/1e9).toFixed(4)} SOL`
      );
      return floor;
    } catch (e) {
      this.stats.lastError = e.message;
      log.warn(`[jito] tip floor failed: ${e.message}`);
      return this.cache;
    }
  }

  /**
   * Recommend a tip (in lamports) for a given opportunity size in USD.
   * Strategy: scale by opportunity size — small opp = p50 tip, big opp = p99 tip.
   * Capped at 0.1 SOL (over that = MEV bot territory we can't win).
   *
   *   opportunityUsd < 100     → p50
   *   opportunityUsd 100-1000  → p75
   *   opportunityUsd 1000-10k  → p95
   *   opportunityUsd > 10k     → p99
   */
  async recommendTipLamports(opportunityUsd) {
    const floor = await this.getTipFloor();
    if (!floor) return null;
    const usd = opportunityUsd || 0;
    let chosen;
    if (usd < 100) chosen = floor.p50_lamports;
    else if (usd < 1000) chosen = floor.p75_lamports;
    else if (usd < 10000) chosen = floor.p95_lamports;
    else chosen = floor.p99_lamports;

    // Cap at 0.1 SOL (100M lamports) — beyond that, the game is rigged for whales
    const CAP = 100_000_000; // 0.1 SOL
    return {
      tipLamports: Math.min(chosen, CAP),
      tipSol: Math.min(chosen, CAP) / 1e9,
      floor: floor,
      scaled: chosen > CAP ? 'capped' : 'picked',
    };
  }

  getStats() {
    return { ...this.stats, cached: !!this.cache, cacheAgeMs: this.cacheTs ? Date.now() - this.cacheTs : 0 };
  }
}

module.exports = new JitoTip();