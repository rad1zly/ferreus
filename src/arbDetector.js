'use strict';

/**
 * Cross-DEX arb detector — Phase Pool-2 of dead-pool MEV architecture.
 *
 * Strategy: maintain in-memory index of all observed pools, grouped by canonical
 * (mintSmall, mintBig) pair. For each pair with ≥2 pools on different DEXes,
 * compute price gap in bps. If gap > MIN_GAP_BPS, log arb candidate.
 *
 * v0 limitations:
 * - CPMM excluded (no priceNative from decoder — reserves in vaults, not pool account)
 * - Whirlpool/CLMM only (price from sqrtPriceX64 on-chain, no extra RPC)
 * - Decimals lookup: hardcoded common mints (SOL, USDC, USDT, wSOL, BTC, ETH)
 *   + extension via setDecimals() from external sources (mint info API)
 * - Stale pruning: pools older than 5 min removed from index
 * - Cooldown: same pair not re-logged within ARB_COOLDOWN_MS
 *
 * Upgrade paths (P5+):
 * - CPMM with vault balance reads (1 extra RPC, with caching)
 * - Cross-program arb (CPMM↔CLMM, Whirlpool↔DLMM)
 * - Jupiter execution hook (replace console log with quote + simulate + send)
 */

const log = require('./logger');
const config = require('./config');

// Common Solana mints — used for decimals lookup
const KNOWN_MINTS = {
  'So11111111111111111111111111111111111111112': { symbol: 'wSOL', decimals: 9 },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
  '7vfCXYUXx6q3c7hS3jMzR9cEuz8qMdQ4G1N1QwHpump': { symbol: 'BONK', decimals: 5 },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK_old', decimals: 5 },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', decimals: 6 },
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': { symbol: 'JTO', decimals: 9 },
  'mb1eu7TzEc71KxDSiysfNv3L5rsDymrqS9pwT1zhTLG': { symbol: 'ORCA', decimals: 6 },
  'rndrizKT3MK1iimSxRdW2FLifSc2ZrLSG2r2q4WEKu8': { symbol: 'RENDER', decimals: 8 },
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH', decimals: 6 },
  'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq5': { symbol: 'KIN', decimals: 5 },
};

class ArbDetector {
  constructor() {
    this._db = null;
    this.pairIndex = new Map();  // pairKey -> Map<poolKey, PoolEntry>
    this.lastNotified = new Map(); // pairKey -> ts
    this.decimals = { ...KNOWN_MINTS };
    this.stats = {
      poolsReceived: 0,
      poolsSkippedNoPrice: 0,
      poolsSkippedNoDecimals: 0,
      pairsTracked: 0,
      poolsTracked: 0,
      gapsDetected: 0,
      gapsLogged: 0,
      gapsByDexPair: {},  // e.g. "raydium_clmm:orca_whirlpool" -> count
    };
    this._pruneTimer = null;
  }

  attachDb(database) {
    this._db = database;
    log.info(`[arb-detect] attached to DB`);
  }

  setDecimals(mint, decimals, symbol = null) {
    if (this.decimals[mint] && this.decimals[mint].decimals === decimals) return;
    this.decimals[mint] = { symbol: symbol || this.decimals[mint]?.symbol || '?', decimals };
  }

  /**
   * Bulk-load decimals from an external source (e.g. Jupiter token list).
   * @param {Array<{address, decimals, symbol}>} tokens
   */
  setDecimalsBulk(tokens) {
    if (!Array.isArray(tokens)) return;
    for (const t of tokens) {
      if (t && t.address && typeof t.decimals === 'number') {
        this.decimals[t.address] = { symbol: t.symbol || '?', decimals: t.decimals };
      }
    }
    log.info(`[arb-detect] loaded decimals for ${Object.keys(this.decimals).length} mints`);
  }

  start() {
    if (this._pruneTimer) return;
    // Periodic stale-prune: remove pools we haven't heard from in 5 min
    this._pruneTimer = setInterval(() => this._pruneStale(), 60000);
    log.info(`[arb-detect] started — min gap: ${config.ARB_MIN_GAP_BPS}bps, cooldown: ${config.ARB_COOLDOWN_MS}ms`);
  }

  stop() {
    if (this._pruneTimer) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = null;
    }
    log.info(`[arb-detect] stopped`);
  }

  /**
   * Process a decoded pool. Call this from poolSubscription after every successful decode.
   * @param {Object} pool - { pubkey, dex, mintA, mintB, decimalsA, decimalsB, priceNative, ts }
   */
  checkPool(pool) {
    this.stats.poolsReceived++;
    if (!pool || pool.priceNative == null || pool.priceNative <= 0) {
      this.stats.poolsSkippedNoPrice++;
      return;
    }
    // Skip garbage decodes (Meteora DAMM v2 offset issues produce System Program pubkeys)
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    if (!pool.mintA || !pool.mintB ||
        pool.mintA === SYSTEM_PROGRAM || pool.mintB === SYSTEM_PROGRAM) {
      this.stats.poolsSkippedNoPrice++;
      return;
    }
    // Resolve decimals — use pool's, or fall back to known registry, or default 6
    const decA = pool.decimalsA ?? this.decimals[pool.mintA]?.decimals;
    const decB = pool.decimalsB ?? this.decimals[pool.mintB]?.decimals;
    if (decA == null || decB == null) {
      this.stats.poolsSkippedNoDecimals++;
      return;
    }

    // Normalize to canonical pair: (mintSmall, mintBig)
    const aIsSmall = pool.mintA < pool.mintB;
    const mintSmall = aIsSmall ? pool.mintA : pool.mintB;
    const mintBig = aIsSmall ? pool.mintB : pool.mintA;
    const decSmall = aIsSmall ? decA : decB;
    const decBig = aIsSmall ? decB : decA;
    // priceSmallPerBig (display units): if mintA is small, price is pool.priceNative
    // adjusted by 10^(decA - decB). If mintA is big, we invert: 1/price * 10^(decB - decA)
    let priceSmallPerBig;
    if (aIsSmall) {
      priceSmallPerBig = pool.priceNative * Math.pow(10, decA - decB);
    } else {
      priceSmallPerBig = (1 / pool.priceNative) * Math.pow(10, decB - decA);
    }
    if (!isFinite(priceSmallPerBig) || priceSmallPerBig <= 0) {
      this.stats.poolsSkippedNoPrice++;
      return;
    }

    const pairKey = `${mintSmall}:${mintBig}`;
    if (!this.pairIndex.has(pairKey)) {
      this.pairIndex.set(pairKey, new Map());
    }
    const poolKey = `${pool.dex}:${pool.pubkey}`;
    this.pairIndex.get(pairKey).set(poolKey, {
      dex: pool.dex,
      pubkey: pool.pubkey,
      price: priceSmallPerBig,
      ts: pool.ts || Date.now(),
    });

    // Check for gaps if we have ≥2 pools on different DEXes
    const pools = [...this.pairIndex.get(pairKey).values()];
    const dexes = new Set(pools.map(p => p.dex));
    if (dexes.size < 2) return;

    let cheapest = pools[0], expensive = pools[0];
    for (const p of pools) {
      if (p.price < cheapest.price) cheapest = p;
      if (p.price > expensive.price) expensive = p;
    }
    if (cheapest.dex === expensive.dex) return;
    if (cheapest.price <= 0) return;

    const gapBps = ((expensive.price - cheapest.price) / cheapest.price) * 10000;
    this.stats.gapsDetected++;
    if (gapBps < config.ARB_MIN_GAP_BPS) return;

    // Cooldown per pair
    const lastTs = this.lastNotified.get(pairKey) || 0;
    if (Date.now() - lastTs < config.ARB_COOLDOWN_MS) return;
    this.lastNotified.set(pairKey, Date.now());

    this._logCandidate({
      ts: Date.now(),
      pairKey,
      mintSmall,
      mintBig,
      cheapDex: cheapest.dex,
      cheapPrice: cheapest.price,
      cheapPool: cheapest.pubkey,
      expensiveDex: expensive.dex,
      expensivePrice: expensive.price,
      expensivePool: expensive.pubkey,
      gapBps,
    });
  }

  _logCandidate(c) {
    this.stats.gapsLogged++;
    const dexPair = [c.cheapDex, c.expensiveDex].sort().join(':');
    this.stats.gapsByDexPair[dexPair] = (this.stats.gapsByDexPair[dexPair] || 0) + 1;

    // DB insert
    if (this._db) {
      try {
        this._db.stmts.insertArbCandidate.run({
          ts: c.ts,
          pair_key: c.pairKey,
          mint0: c.mintSmall,
          mint1: c.mintBig,
          cheap_dex: c.cheapDex,
          cheap_price: c.cheapPrice,
          cheap_pool: c.cheapPool,
          expensive_dex: c.expensiveDex,
          expensive_price: c.expensivePrice,
          expensive_pool: c.expensivePool,
          gap_bps: c.gapBps,
        });
      } catch (e) {
        log.warn(`[arb-detect] DB insert failed: ${e.message}`);
      }
    }

    // Console log — human-readable
    const symSmall = this.decimals[c.mintSmall]?.symbol || c.mintSmall.slice(0, 4) + '…';
    const symBig = this.decimals[c.mintBig]?.symbol || c.mintBig.slice(0, 4) + '…';
    log.info(
      `🎯 ARB ${symSmall}/${symBig} | ` +
      `buy ${c.cheapDex} @ ${c.cheapPrice.toExponential(3)} ` +
     `sell ${c.expensiveDex} @ ${c.expensivePrice.toExponential(3)} ` +
      `| gap=${c.gapBps.toFixed(1)}bps ` +
      `| ${c.cheapPool.slice(0, 6)}…→${c.expensivePool.slice(0, 6)}…`
    );
  }

  _pruneStale() {
    const now = Date.now();
    const MAX_AGE_MS = 5 * 60 * 1000; // 5 min
    let removed = 0;
    for (const [pairKey, pools] of this.pairIndex) {
      for (const [poolKey, entry] of pools) {
        if (now - entry.ts > MAX_AGE_MS) {
          pools.delete(poolKey);
          removed++;
        }
      }
      if (pools.size === 0) this.pairIndex.delete(pairKey);
    }
    if (removed > 0) log.debug(`[arb-detect] pruned ${removed} stale pool entries`);
  }

  getStats() {
    return {
      ...this.stats,
      pairsTracked: this.pairIndex.size,
      poolsTracked: [...this.pairIndex.values()].reduce((s, m) => s + m.size, 0),
    };
  }
}

module.exports = new ArbDetector();
