'use strict';

/**
 * Weird pool detector — Phase "Weird".
 *
 * The real arb opportunities are not in well-known CLMM/Whirlpool pairs
 * (those are competed for by every MEV bot). They're in:
 * - Newly-created pools with mispriced initial reserves
 * - Illiquid pools on exotic AMMs (pump.fun graduated, Raydium legacy, etc)
 * - Multi-hop routes through several illiquid pools where the chain
 *   of mispricings compounds into a huge return
 *
 * This module:
 * 1. Tracks first-time-seen pool pubkeys (= new pools)
 * 2. Heuristically decodes ANY pool to extract (mint0, mint1, price)
 * 3. Compares to Jupiter price API reference — if ratio > WEIRD_GAP_RATIO,
 *    flag as WEIRD and insert into weird_pools table
 * 4. Builds a pool graph: token → pools that hold it (for multi-hop)
 * 5. Periodically runs multi-hop path finder (BFS, top paths logged)
 *
 * v0 design: opportunistic. We see a new pool, decode what we can, log
 * to DB. If we can compute a price, compare to reference. The user
 * gets alerts and decides whether to execute.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const log = require('./logger');
const config = require('./config');
const decoder = require('./poolDecoder');
const vaultReader = require('./vaultReader');
const priceOracle = require('./priceOracle');
const db = require('./db');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class WeirdPoolDetector {
  constructor() {
    this._db = null;
    // Pubkeys we've seen (persisted to DB via pool_state.ts for restart-survival)
    this.seenPools = new Set();
    // Pool graph: mint -> Set<poolPubkey>
    this.tokenToPools = new Map();
    // Pool data: pubkey -> { dex, mintA, mintB, priceNative, decimalsA, decimalsB, ts }
    this.poolData = new Map();
    // Stats
    this.stats = {
      newPoolsDetected: 0,
      weirdPoolsFlagged: 0,
      pathsFound: 0,
      pathsByHops: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    };
    this._pruneTimer = null;
    this._pathTimer = null;
    this._loaded = false;
  }

  attachDb(database) {
    this._db = database;
  }

  async start() {
    if (!this._db) {
      log.error('[weird] no DB attached');
      return;
    }
    // Pre-load seen pools (last 24h) to avoid re-flagging old pools on restart
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = this._db.db.prepare(`
      SELECT pubkey FROM pool_state WHERE ts > ?
    `).all(cutoff);
    for (const r of rows) this.seenPools.add(r.pubkey);
    log.info(`[weird] loaded ${rows.length} seen pools from DB (last 24h)`);
    this._loaded = true;

    // Prune stale pools every 5 min
    this._pruneTimer = setInterval(() => this._pruneStale(), 5 * 60 * 1000);

    // Run multi-hop finder every 60s
    this._pathTimer = setInterval(() => this._findPaths().catch(e => {
      log.warn(`[weird] path finder error: ${e.message}`);
    }), 60 * 1000);

    // Run initial path finder after 30s (let some pools accumulate)
    setTimeout(() => this._findPaths().catch(e => {
      log.warn(`[weird] initial path finder error: ${e.message}`);
    }), 30 * 1000);

    log.info(`[weird] started — gap threshold ${config.WEIRD_GAP_RATIO}x`);
  }

  stop() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    if (this._pathTimer) clearInterval(this._pathTimer);
    this._pruneTimer = null;
    this._pathTimer = null;
    log.info('[weird] stopped');
  }

  /**
   * Process a decoded pool from poolSubscription. Called for every WSS update.
   * @param {Object} pool - { pubkey, dex, mintA, mintB, decimalsA, decimalsB, priceNative, ts }
   */
  async onPool(pool) {
    if (!pool || !pool.pubkey) return;

    const isNew = !this.seenPools.has(pool.pubkey);
    if (isNew) {
      this.seenPools.add(pool.pubkey);
      this.stats.newPoolsDetected++;
      await this._onNewPool(pool);
    }

    // Update graph (always, even for known pools — prices change)
    if (pool.mintA && pool.mintB) {
      this.poolData.set(pool.pubkey, pool);
      this._addToGraph(pool.mintA, pool.pubkey);
      this._addToGraph(pool.mintB, pool.pubkey);
    }
  }

  async _onNewPool(pool) {
    if (!pool.mintA || !pool.mintB) return;
    log.info(
      `[weird] NEW pool: ${pool.dex} ` +
      `${pool.mintA.slice(0, 6)}…/${pool.mintB.slice(0, 6)}… ` +
      `(${pool.pubkey.slice(0, 8)}…)`
    );

    // Mispricing check vs Jupiter price
    if (pool.priceNative != null && pool.priceNative > 0 && pool.decimalsA != null && pool.decimalsB != null) {
      try {
        await this._checkMispricing(pool);
      } catch (e) {
        log.warn(`[weird] misprice check failed: ${e.message}`);
      }
    }
  }

  async _checkMispricing(pool) {
    // Compute pool price in display units (mintB per mintA)
    const aIsSmall = pool.mintA < pool.mintB;
    let priceDisplay;
    if (aIsSmall) {
      priceDisplay = pool.priceNative * Math.pow(10, pool.decimalsA - pool.decimalsB);
    } else {
      priceDisplay = (1 / pool.priceNative) * Math.pow(10, pool.decimalsB - pool.decimalsA);
    }
    if (!isFinite(priceDisplay) || priceDisplay <= 0) return;

    // Get reference USD prices
    const [priceA, priceB] = await Promise.all([
      priceOracle.getPriceUsd(pool.mintA),
      priceOracle.getPriceUsd(pool.mintB),
    ]);

    // Compute "fair" display price (B per A in USD-equivalent)
    let refPriceDisplay = null;
    if (priceA != null && priceB != null && priceB > 0) {
      // 1 mintA = priceA USD, 1 mintB = priceB USD
      // 1 mintA in mintB = priceA / priceB mintB
      refPriceDisplay = priceA / priceB;
    } else if (priceA != null && Math.abs(priceA - 1) < 0.01) {
      // mintA is ~USDC stable, mintB price unknown
      // Pool price already in mintB per USDC ≈ USD value of mintB
      refPriceDisplay = priceDisplay;  // assume pool is fairly priced
      // Skip — no real reference
      return;
    }

    if (!refPriceDisplay || refPriceDisplay <= 0) return;

    const ratio = priceDisplay / refPriceDisplay;
    if (ratio >= 1/config.WEIRD_GAP_RATIO && ratio <= config.WEIRD_GAP_RATIO) {
      return;  // within reasonable range
    }

    // WEIRD pool detected!
    this.stats.weirdPoolsFlagged++;
    const direction = ratio > 1 ? 'expensive' : 'cheap';
    const weirdnessPct = ((ratio > 1 ? ratio : 1/ratio) - 1) * 100;

    try {
      this._db.stmts.insertWeirdPool.run({
        ts: Date.now(),
        pubkey: pool.pubkey,
        dex: pool.dex,
        mint_a: pool.mintA,
        mint_b: pool.mintB,
        price_display: priceDisplay,
        ref_price: refPriceDisplay,
        ratio: ratio,
        direction: direction,
        weirdness_pct: weirdnessPct,
      });
    } catch (e) {
      log.warn(`[weird] insertWeirdPool failed: ${e.message}`);
    }

    log.warn(
      `🔮 WEIRD POOL ${direction.toUpperCase()} ${weirdnessPct.toFixed(1)}%: ` +
      `${pool.dex} ${pool.mintA.slice(0, 6)}…/${pool.mintB.slice(0, 6)}… ` +
      `pool=${priceDisplay.toExponential(2)} ref=${refPriceDisplay.toExponential(2)} ` +
      `(${pool.pubkey.slice(0, 8)}…)`
    );
  }

  _addToGraph(mint, poolPubkey) {
    if (!this.tokenToPools.has(mint)) {
      this.tokenToPools.set(mint, new Set());
    }
    this.tokenToPools.get(mint).add(poolPubkey);
  }

  _pruneStale() {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;  // 30 min
    let pruned = 0;
    for (const [pubkey, pool] of this.poolData) {
      if (now - (pool.ts || 0) > MAX_AGE) {
        this.poolData.delete(pubkey);
        if (pool.mintA && this.tokenToPools.has(pool.mintA)) this.tokenToPools.get(pool.mintA).delete(pubkey);
        if (pool.mintB && this.tokenToPools.has(pool.mintB)) this.tokenToPools.get(pool.mintB).delete(pubkey);
        pruned++;
      }
    }
    if (pruned > 0) log.debug(`[weird] pruned ${pruned} stale pools`);
  }

  /**
   * Multi-hop path finder: BFS from WSOL → WSOL, max 5 hops.
   * Edge weights: pool's exchange rate. Path with highest compounded return wins.
   */
  async _findPaths() {
    if (this.poolData.size < 10) return;
    const wsolPools = this.tokenToPools.get(WSOL_MINT);
    log.info(`[weird] path finder tick — ${this.poolData.size} pools, ${this.tokenToPools.size} tokens, WSOL pools in graph: ${wsolPools?.size || 0}`);
    if (!wsolPools || wsolPools.size === 0) return;

    const MAX_HOPS = 5;
    const MIN_RETURN = 1.005;  // 0.5% min — we just want to surface ANY round-trippable path
    const MAX_PATHS = 50;

    const startToken = WSOL_MINT;
    const paths = [];

    // Priority queue (simple: sort and shift)
    const queue = [{ tokens: [startToken], return: 1.0, hops: 0 }];
    const visited = new Map();  // key -> best return

    while (queue.length > 0) {
      queue.sort((a, b) => b.return - a.return);
      const node = queue.shift();

      const currentToken = node.tokens[node.tokens.length - 1];
      if (currentToken === startToken && node.hops > 0) {
        if (node.return >= MIN_RETURN) {
          paths.push({
            tokens: node.tokens,
            return: node.return,
            hops: node.hops,
          });
        }
        continue;  // don't extend further from startToken (would be redundant)
      }
      if (node.hops >= MAX_HOPS) continue;

      const pools = this.tokenToPools.get(currentToken);
      if (!pools) continue;
      if (this._bfsSteps === undefined) this._bfsSteps = 0;
      this._bfsSteps++;
      if (this._bfsSteps % 500 === 0) {
        log.info(`[weird] BFS step ${this._bfsSteps}, queue=${queue.length}, paths=${paths.length}`);
      }

      for (const poolPubkey of pools) {
        const pool = this.poolData.get(poolPubkey);
        if (!pool || !pool.mintA || !pool.mintB) continue;

        const otherToken = pool.mintA === currentToken ? pool.mintB : pool.mintA;
        // Allow returning to startToken (closing the cycle); block other revisits
        if (!otherToken) continue;
        if (otherToken !== startToken && node.tokens.includes(otherToken)) continue;

        const rate = this._getExchangeRate(pool, currentToken, otherToken);
        if (this._rateDebug === undefined) this._rateDebug = { total: 0, valid: 0, null: 0, sample: null };
        this._rateDebug.total++;
        if (rate && rate > 0) this._rateDebug.valid++; else this._rateDebug.null++;
        if (!rate || rate <= 0) continue;

        const newReturn = node.return * rate;
        const key = node.tokens.concat([otherToken]).join(':');
        const prev = visited.get(key) || 0;
        if (newReturn <= prev * 1.01) continue;
        visited.set(key, newReturn);

        queue.push({
          tokens: node.tokens.concat([otherToken]),
          return: newReturn,
          hops: node.hops + 1,
        });
      }
    }

    paths.sort((a, b) => b.return - a.return);
    const topPaths = paths.slice(0, MAX_PATHS);
    const maxReturn = paths[0]?.return || 0;
    log.info(`[weird] path finder done — rates valid=${this._rateDebug?.valid}/${this._rateDebug?.total} (null=${this._rateDebug?.null}), paths=${paths.length}, max_return=${maxReturn.toFixed(4)}x`);
    if (topPaths.length === 0) return;

    this.stats.pathsFound += topPaths.length;
    topPaths.forEach(p => {
      this.stats.pathsByHops[p.hops] = (this.stats.pathsByHops[p.hops] || 0) + 1;
    });

    for (const p of topPaths) {
      const pathStr = p.tokens.map(t => t.slice(0, 6) + '…').join(' → ');
      log.info(
        `🛣️  Path ${p.hops}-hop return=${p.return.toFixed(3)}x: ${pathStr}`
      );
      try {
        this._db.stmts.insertArbPath.run({
          ts: Date.now(),
          weird_pool_id: null,  // could link to source if known
          source_pool: this._findSourcePool(p.tokens),
          path_json: JSON.stringify(p.tokens),
          expected_return_x: p.return,
          trade_size_sol: 0.01,  // default size
        });
      } catch (e) {
        log.warn(`[weird] insertArbPath failed: ${e.message}`);
      }
    }
  }

  _findSourcePool(tokens) {
    // Find the first pool that contains the start (WSOL) and the next token
    const startPools = this.tokenToPools.get(tokens[0]);
    if (!startPools) return null;
    for (const pubkey of startPools) {
      const pool = this.poolData.get(pubkey);
      if (pool && (pool.mintA === tokens[1] || pool.mintB === tokens[1])) {
        return pubkey;
      }
    }
    return null;
  }

  /**
   * Compute exchange rate: how many `otherToken` per `currentToken`.
   * Returns a multiplier (e.g., 1.05 = +5%).
   */
  _getExchangeRate(pool, currentToken, otherToken) {
    if (pool.priceNative == null || pool.priceNative <= 0) return null;
    if (pool.decimalsA == null || pool.decimalsB == null) return null;

    const aIsCurrent = pool.mintA === currentToken;
    const decA = pool.decimalsA, decB = pool.decimalsB;

    let displayPrice;
    if (aIsCurrent) {
      // 1 native_A = priceNative native_B
      // 1 display_A = priceNative * 10^(decA - decB) display_B
      displayPrice = pool.priceNative * Math.pow(10, decA - decB);
    } else {
      // currentToken is B, otherToken is A
      // 1 display_B = (1 / priceNative) * 10^(decB - decA) display_A
      displayPrice = (1 / pool.priceNative) * Math.pow(10, decB - decA);
    }
    return displayPrice;
  }

  /**
   * Heuristic decoder for unknown AMMs. Tries to extract (mint0, mint1)
   * from raw pool account data without IDL.
   * Strategy: try common offsets after discriminator; pick first 2 valid pubkeys
   * that aren't System/TokeProgram/AssociatedToken.
   */
  heuristicDecode(programId, data) {
    if (!data || data.length < 8 + 32 + 32) return null;

    const PK = PublicKey;
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

    const buf = data.subarray(8);  // skip discriminator
    const candidateOffsets = [0, 32, 64, 96, 128, 160, 192, 224, 256];
    const candidates = [];

    for (const offset of candidateOffsets) {
      if (offset + 32 > buf.length) break;
      try {
        const pub = new PK(buf.subarray(offset, offset + 32)).toBase58();
        if (pub === SYSTEM_PROGRAM || pub === TOKEN_PROGRAM || pub === ASSOCIATED_TOKEN) continue;
        if (candidates.find(c => c.pubkey === pub)) continue;
        candidates.push({ pubkey: pub, offset });
        if (candidates.length >= 2) break;
      } catch (_) {}
    }

    if (candidates.length < 2) return null;
    const mints = candidates.map(c => c.pubkey).sort();
    return { mint0: mints[0], mint1: mints[1], programId, heuristic: true };
  }

  getStats() {
    return {
      ...this.stats,
      poolsTracked: this.poolData.size,
      uniqueTokens: this.tokenToPools.size,
      seenPools: this.seenPools.size,
    };
  }
}

module.exports = new WeirdPoolDetector();