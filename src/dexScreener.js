'use strict';

const axios = require('axios');
const log = require('./logger');

// DexScreener reference docs: https://docs.dexscreener.com/api/reference
// Rate limit: 300 req/min on /latest/dex/* (and /token-pairs/v1/*, /tokens/v1/*).
// Public API: returns 403 from this network (per snipetrench pattern #12).
// Detected from session 2026-06-22: works intermittently (timeout on some calls).
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
   * Group pairs by DEX, returning the most-liquid pool per DEX.
   * CRITICAL (per DexScreener docs): `priceUsd` is the price of `baseToken` in USD,
   * not the queried token. So if we query USDC mint, a USDC/SOL pair has
   * priceUsd=USDC-price, but a SOL/USDC pair has priceUsd=SOL-price.
   * To compare prices consistently, we MUST filter to pairs where the target
   * token is the baseToken — otherwise we'll compare USDC-price to SOL-price.
   *
   * Returns [{ dexId, price, liquidity, pairAddress, volume24h, baseAddr, quoteAddr }, ...]
   * Only includes pairs where baseToken.address === targetMint.
   */
  groupByDex(pairs, targetMint) {
    if (!targetMint) {
      // Backward-compat: if no target provided, fall back to old behavior.
      // (Will produce buggy gaps if pairs have different baseTokens.)
      log.warn('[dexscreener] groupByDex called without targetMint, results may be wrong');
    }
    const target = targetMint?.toLowerCase();
    const byDex = new Map();
    for (const p of pairs) {
      const dexId = p.dexId;
      const liq = p.liquidity?.usd || 0;
      const price = parseFloat(p.priceUsd);
      if (!dexId) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      // Skip dust pools (would give misleading price)
      if (liq < 1000) continue;

      // CRITICAL filter: only consider pairs where target is the baseToken.
      // This ensures priceUsd is interpreted consistently across all pairs.
      if (target && p.baseToken?.address?.toLowerCase() !== target) continue;

      const existing = byDex.get(dexId);
      if (!existing || (existing.liquidity || 0) < liq) {
        byDex.set(dexId, {
          dexId,
          price,
          liquidity: liq,
          pairAddress: p.pairAddress,
          volume24h: p.volume?.h24 || 0,
          baseAddr: p.baseToken?.address,
          quoteAddr: p.quoteToken?.address,
        });
      }
    }
    return Array.from(byDex.values());
  }
}

module.exports = new DexScreener();