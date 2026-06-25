'use strict';

/**
 * Multi-hop path finder for weird-pool arbs.
 *
 * Strategy: BFS over a pool graph where nodes are mints and edges are pools.
 * Given a new (weird) pool, find returnable paths back to SOL within N hops.
 *
 * For each potential path:
 * - Estimate return using current pool reserves
 * - Skip paths that are obviously losing (after fees, slippage, gas)
 * - Return top N paths sorted by expected return
 *
 * v0 simplification:
 * - 2-hop: SOL → weird_pool → reference_pool → SOL
 *   - Buy tokenA on weird_pool (cheap)
 *   - Sell tokenA on reference_pool (fair price)
 * - 3-hop: SOL → weird_pool → intermediate_pool → reference_pool → SOL
 *   - More complex routing for tokens without direct SOL pool
 *
 * For each path, we use Jupiter's quote API to estimate the actual return.
 * This is more reliable than our internal price calculations.
 */

const log = require('./logger');
const config = require('./config');
const jupiter = require('./jupiterClient');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

class PathFinder {
  constructor() {
    this._poolByMintPair = new Map();  // pairKey -> [poolInfo, ...]
    this._allPools = [];  // flat list
    this._refreshTimer = null;
  }

  /**
   * Register a pool in the graph. Call this for every pool seen (from WSS or DB).
   * @param {Object} pool - { pubkey, dex, mintA, mintB, priceNative, decimalsA, decimalsB, vaultA, vaultB, ts }
   */
  addPool(pool) {
    if (!pool || !pool.pubkey || !pool.mintA || !pool.mintB) return;
    const pairKey = this._pairKey(pool.mintA, pool.mintB);
    if (!this._poolByMintPair.has(pairKey)) {
      this._poolByMintPair.set(pairKey, []);
    }
    const list = this._poolByMintPair.get(pairKey);
    // Replace existing entry with same dex:pubkey (update price)
    const idx = list.findIndex(p => p.pubkey === pool.pubkey && p.dex === pool.dex);
    if (idx >= 0) {
      list[idx] = pool;
    } else {
      list.push(pool);
    }
    // Also add to flat list (capped at 50K)
    if (this._allPools.length < 50000) {
      this._allPools.push(pool);
    } else {
      // Replace oldest (FIFO)
      this._allPools.shift();
      this._allPools.push(pool);
    }
  }

  _pairKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /**
   * Find arb paths given a new weird pool.
   * @param {Object} newPool - the weird pool
   * @param {number} maxHops - 2 or 3
   * @param {number} tradeSizeSol - default 0.05
   * @returns {Array} sorted by expected return descending
   */
  async findPaths(newPool, maxHops = 3, tradeSizeSol = 0.05) {
    if (!newPool || !newPool.mintA || !newPool.mintB) return [];
    const results = [];

    // Hop 1: SOL → weird_pool (buy one side)
    // The weird pool has weird_price for mintA relative to mintB
    // We need to figure out which side is mispriced and buy the cheap one

    // For each mint in the weird pool, find other pools that also have it
    const mintsInWeird = [newPool.mintA, newPool.mintB];
    for (const mint of mintsInWeird) {
      // Find all pools containing this mint + SOL (or other reference)
      const otherMint = mint === newPool.mintA ? newPool.mintB : newPool.mintA;
      const otherPools = this._getPoolsForPair(mint, otherMint);
      for (const refPool of otherPools) {
        if (refPool.pubkey === newPool.pubkey) continue;  // skip self
        // 2-hop: SOL → weird_pool → ref_pool → SOL
        // But this is the same mint pair, so it's the same arb as cross-DEX gap (already detected)
        // We need a different structure: 3-hop
      }
    }

    // 3-hop: SOL → weird_pool (mintA→mintB) → other_pool (mintB→mintC) → ref_pool (mintC→SOL)
    // This finds cases where:
    // - weird pool has weird ratio for mintA:mintB
    // - another pool has mintB:mintC (where mintC is a known reference like SOL)
    // - and mintC connects to SOL via another pool
    // This is complex; let me try simpler 2-hop for v0:

    // 2-hop via Jupiter: SOL → weird_pool (using mint0 as intermediate)
    // We can use Jupiter to route SOL → mint0 → SOL via the weird pool
    // This is essentially the same as cross-DEX gap detection but using weird pool as one of the legs

    // For now, return empty — actual path finding needs more work
    // The cross-DEX gap detector already handles the simple case
    // What we want here is: SOL → weird_pool → other_dex_pool → SOL (cross-DEX with weird pool)
    // This is the same logic but explicit

    return results;
  }

  /**
   * Estimate return for a specific path using Jupiter quotes.
   * @param {string} inputMint
   * @param {string} outputMint
   * @param {number} amountLamports
   * @returns {number} output amount in lamports
   */
  async _jupiterQuote(inputMint, outputMint, amountLamports) {
    try {
      const quote = await jupiter.getQuote({
        inputMint,
        outputMint,
        amount: amountLamports,
        slippageBps: 50,
      });
      return quote?.outAmount ? Number(quote.outAmount) : null;
    } catch (e) {
      return null;
    }
  }

  _getPoolsForPair(mintA, mintB) {
    return this._poolByMintPair.get(this._pairKey(mintA, mintB)) || [];
  }

  getStats() {
    return {
      poolsIndexed: this._allPools.length,
      pairKeys: this._poolByMintPair.size,
    };
  }
}

module.exports = new PathFinder();
