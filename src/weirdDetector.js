'use strict';

/**
 * Weird pool detector — finds new pools with mispriced reserves.
 *
 * Strategy:
 * 1. Track first-time pubkeys from WSS pool updates (those are new pools)
 * 2. For each new pool, fetch account, decode mints + reserves
 * 3. Compute effective price from reserves
 * 4. Look up reference price for known mints (SOL, USDC, USDT, BONK, JUP, etc.)
 * 5. If pool price vs ref price ratio < 0.3 or > 3.0, flag as WEIRD
 * 6. For weird pools, find arb path via 2-3 hop BFS over pool graph
 * 7. Log to weird_pools + arb_paths tables
 *
 * Why not repeat Jupiter round-trip from Pool-3:
 * - Jupiter's smart router doesn't capture weird-pool opportunities
 *   (Jupiter picks its own path, not necessarily the mispriced one)
 * - The "weird" pool IS the opportunity — round-trip through Jupiter misses it
 * - For weird-pool arb, we need: SOL → weird_pool → reference_pool → SOL
 *
 * Trade size: 0.05 SOL ($3.5 at SOL=$70). Small because:
 * - First-mover edge is short
 * - Illiquid pools have limited depth
 * - We want to leave room for LPs to not get rekt
 *
 * v0 limitations:
 * - Only monitors our 5 known AMM programs (no "Unknown AMM" detection)
 * - 2-3 hop BFS only (no 4-5 hop)
 * - No Telegram notifier (logs + DB only)
 * - No live execution (DRY_RUN only for now)
 */

const log = require('./logger');
const config = require('./config');
const priceOracle = require('./priceOracle');
const jupiter = require('./jupiterClient');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Common mints with known USD reference prices
const KNOWN_PRICED_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// Weirdness threshold: pool price vs reference price
// If ratio is outside [1/MIN_RATIO, MAX_RATIO], it's weird
const MIN_RATIO = 0.3;   // pool price < 30% of ref = very cheap
const MAX_RATIO = 3.0;   // pool price > 3x of ref = very expensive

class WeirdDetector {
  constructor() {
    this._db = null;
    this._pathFinder = null;  // set by index.js
    this._seenPubkeys = new Set();
    this.stats = {
      newPoolsSeen: 0,
      weirdPoolsFound: 0,
      pathsFound: 0,
      alerted: 0,
      byDex: {},
    };
    this._alerts = [];  // recent alerts (for stats)
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Called when a new pool is detected (first time we see this pubkey).
   * @param {Object} pool - { pubkey, dex, mintA, mintB, priceNative, decimalsA, decimalsB, vaultA, vaultB, ts }
   */
  async onNewPool(pool) {
    if (!pool || !pool.pubkey) return;
    if (this._seenPubkeys.has(pool.pubkey)) return;
    this._seenPubkeys.add(pool.pubkey);
    this.stats.newPoolsSeen++;
    this.stats.byDex[pool.dex] = (this.stats.byDex[pool.dex] || 0) + 1;

    try {
      // Skip pools without price data
      if (pool.priceNative == null || pool.priceNative <= 0) {
        // For CPMM, we need to wait for vault reader to populate
        // Schedule retry in 5s
        setTimeout(() => this._retryPool(pool), 5000);
        return;
      }

      // Skip pools where both mints are unknown
      if (!pool.mintA || !pool.mintB) return;
      const aKnown = KNOWN_PRICED_MINTS.has(pool.mintA);
      const bKnown = KNOWN_PRICED_MINTS.has(pool.mintB);
      if (!aKnown && !bKnown) return;  // both unknown, can't price-check

      // Compute display price
      const decA = pool.decimalsA ?? 9;
      const decB = pool.decimalsB ?? 6;
      const priceDisplay = pool.priceNative * Math.pow(10, decA - decB);

      // Get reference prices
      const [priceA, priceB] = await Promise.all([
        priceOracle.getPriceUsd(pool.mintA),
        priceOracle.getPriceUsd(pool.mintB),
      ]);

      // Compute "fair" price from USD references
      // pool price = how many tokenB per tokenA (display)
      // ref price = (priceA / priceB) = how many tokenB per tokenA (by USD value)
      if (!priceA || !priceB || priceB === 0) return;
      const refPrice = priceA / priceB;
      if (!isFinite(refPrice) || refPrice <= 0) return;

      const ratio = priceDisplay / refPrice;
      const ratioInverse = 1 / ratio;

      // Flag if ratio is outside normal range
      // ratio < MIN_RATIO = pool is "too cheap" for tokenA (or "too expensive" for tokenB)
      // ratio > MAX_RATIO = pool is "too expensive" for tokenA
      if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
        const direction = ratio < MIN_RATIO ? 'cheap' : 'expensive';
        const ratioPct = (ratio < 1 ? ratio : ratioInverse) * 100;
        const weirdness = ratio < 1 ? (1 - ratio) * 100 : (ratio - 1) * 100;

        this.stats.weirdPoolsFound++;

        const record = {
          ts: Date.now(),
          pubkey: pool.pubkey,
          dex: pool.dex,
          mint_a: pool.mintA,
          mint_b: pool.mintB,
          price_display: priceDisplay,
          ref_price: refPrice,
          ratio: ratio,
          direction: direction,
          weirdness_pct: weirdness,
        };

        // DB insert
        if (this._db) {
          try {
            this._db.stmts.insertWeirdPool.run(record);
          } catch (e) {
            log.warn(`[weird] DB insert failed: ${e.message}`);
          }
        }

        log.info(
          `🚨 WEIRD POOL ${direction.toUpperCase()} ${pool.dex} | ` +
          `ratio=${ratio.toFixed(3)} (${weirdness.toFixed(1)}% off) ` +
          `| pool=${pool.pubkey.slice(0, 8)}… ` +
          `| ${pool.mintA.slice(0, 6)}…/${pool.mintB.slice(0, 6)}…`
        );

        // Find arb path
        if (this._pathFinder) {
          try {
            const paths = await this._pathFinder.findPaths(pool, 3);
            for (const path of paths.slice(0, 3)) {
              this.stats.pathsFound++;
              this._logPath(pool, path);
            }
          } catch (e) {
            log.warn(`[weird] path finder error: ${e.message}`);
          }
        }
      }
    } catch (e) {
      log.warn(`[weird] onNewPool error: ${e.message}`);
    }
  }

  _retryPool(pool) {
    if (this._seenPubkeys.has(pool.pubkey + '_retried')) return;
    this._seenPubkeys.add(pool.pubkey + '_retried');
    if (pool.priceNative == null || pool.priceNative <= 0) {
      // Still no price — skip
      return;
    }
    this.onNewPool(pool);
  }

  _logPath(pool, path) {
    // Log to DB
    if (this._db) {
      try {
        this._db.stmts.insertArbPath.run({
          ts: Date.now(),
          weird_pool_id: null,  // could link via timestamp/pubkey
          source_pool: pool.pubkey,
          path_json: JSON.stringify(path),
          expected_return_x: path.expectedReturnX || null,
          trade_size_sol: path.tradeSizeSol || null,
        });
      } catch (e) {
        log.warn(`[weird] arb_path DB insert failed: ${e.message}`);
      }
    }
    log.info(
      `🛣️  PATH ${path.hops} hops | est return ${path.expectedReturnX?.toFixed(2)}x ` +
      `| ${path.steps?.map(s => s.dex || s.label).join(' → ')}`
    );
  }

  setPathFinder(pathFinder) {
    this._pathFinder = pathFinder;
  }

  getStats() {
    return { ...this.stats, alerts: this._alerts.length };
  }
}

module.exports = new WeirdDetector();
