'use strict';

// CoinGecko trending tokens monitor. Per @uyar121 thread: high-volume
// trending tokens often have new DEX-DEX gaps (price discovery still in
// progress, before bots close them).
//
// Endpoint: /search/trending (free, no key). Returns top 15 trending
// coins globally, including Solana ecosystem tokens. Cached 5 min.

const axios = require('axios');
const log = require('./logger');

const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const SOLANA_PLATFORMS = new Set(['solana']); // CoinGecko platform id

class CoinGeckoTrending {
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
   * Fetch trending tokens. Returns array of:
   *   { id, symbol, name, marketCapRank, score, platforms }
   * Cached for CACHE_TTL_MS.
   */
  async getTrending() {
    if (this.cache && Date.now() - this.cacheTs < CACHE_TTL_MS) {
      return this.cache;
    }
    this.stats.calls += 1;
    try {
      const res = await axios.get(TRENDING_URL, { timeout: 10000 });
      if (!res.data || !Array.isArray(res.data.coins)) {
        log.warn('[coingecko] trending: unexpected shape');
        return this.cache || [];
      }
      const items = res.data.coins.map(c => {
        const it = c.item || {};
        return {
          id: it.id,
          symbol: it.symbol,
          name: it.name,
          marketCapRank: it.market_cap_rank,
          score: c.score || 0,
          platforms: it.platforms || {},
        };
      });
      this.cache = items;
      this.cacheTs = Date.now();
      this.stats.lastSuccess = Date.now();
      log.info(`[coingecko] trending refreshed: ${items.length} tokens`);
      return items;
    } catch (e) {
      this.stats.lastError = e.message;
      log.warn(`[coingecko] trending failed: ${e.message}`);
      return this.cache || [];
    }
  }

  /**
   * Filter trending list to tokens with a Solana contract address.
   */
  async getSolanaTrending() {
    const trending = await this.getTrending();
    return trending.filter(t => {
      const solMint = t.platforms?.solana;
      return solMint && solMint.length > 0;
    });
  }

  getStats() {
    return { ...this.stats, cached: !!this.cache, cacheAgeMs: this.cacheTs ? Date.now() - this.cacheTs : 0 };
  }
}

module.exports = new CoinGeckoTrending();