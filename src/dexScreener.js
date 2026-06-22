'use strict';

const axios = require('axios');
const log = require('./logger');

const BASE = 'https://api.dexscreener.com/latest/dex';

class DexScreener {
  /**
   * Get all pairs for a Solana token mint across all DEXes.
   * Returns raw array (already filtered to chainId='solana').
   * Fail-open: returns [] on error (per pattern #6).
   */
  async getTokenPairs(tokenMint) {
    try {
      const res = await axios.get(`${BASE}/tokens/${tokenMint}`, { timeout: 10000 });
      const pairs = res.data?.pairs || [];
      return pairs.filter(p => p.chainId === 'solana');
    } catch (e) {
      log.warn(`[dexscreener] getTokenPairs ${tokenMint.slice(0, 8)}: ${e.message}`);
      return [];
    }
  }

  /**
   * Group pairs by DEX, returning the most-liquid pool per DEX
   * (most representative price for that DEX).
   * Returns [{ dexId, price, liquidity, pairAddress, volume24h }, ...]
   */
  groupByDex(pairs) {
    const byDex = new Map();
    for (const p of pairs) {
      const dexId = p.dexId;
      const liq = p.liquidity?.usd || 0;
      const price = parseFloat(p.priceUsd) || 0;
      if (!price || !dexId) continue;
      // Skip dust pools (would give misleading price)
      if (liq < 1000) continue;
      const existing = byDex.get(dexId);
      if (!existing || (existing.liquidity || 0) < liq) {
        byDex.set(dexId, {
          dexId,
          price,
          liquidity: liq,
          pairAddress: p.pairAddress,
          volume24h: p.volume?.h24 || 0,
        });
      }
    }
    return Array.from(byDex.values());
  }
}

module.exports = new DexScreener();
