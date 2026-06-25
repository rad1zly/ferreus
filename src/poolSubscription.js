'use strict';

/**
 * Pool subscription — WSS subscribe to 5 AMM programs, decode pool state,
 * persist to pool_state table. Phase Pool-1 of dead-pool MEV architecture.
 *
 * Strategy: catch-all `onProgramAccountChange` (simpler than boot discovery,
 * higher RPC volume but no upfront scan). For v0 with limited dead-pool
 * coverage this is fine. P5+ will switch to boot discovery + targeted subs.
 *
 * Public Solana RPC: ~10 RPS burst, 40 RPM sustained. With 5 programs at
 * ~10 events/sec/program = 50 events/sec peak. We throttle DB writes to
 * stay under control. WSS events are rate-limited at the RPC level.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const log = require('./logger');
const decoder = require('./poolDecoder');
const config = require('./config');
const arbDetector = require('./arbDetector');
const vaultReader = require('./vaultReader');
const weirdDetector = require('./weirdDetector');

const DEFAULT_WSS = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/';

// Per-program dataSize filter for onProgramAccountChange. Empirically derived
// from real on-chain pool accounts (see scripts/test-pool-decoder.js).
// Programs not in this map have no filter (receive all account updates).
const POOL_DATA_SIZE = {
  raydium_cpmm:    637,
  raydium_clmm:    1544,
  orca_whirlpool:  653,
  meteora_dlmm:    null,    // unknown — would need sample
  meteora_damm_v2: 1112,
};

class PoolSubscription {
  constructor() {
    this.connection = null;
    this.subscriptions = [];  // { programId, subscriptionId, programName }
    this.running = false;
    this.stats = {
      events: 0,
      decoded: 0,
      errors: 0,
      lastEventTs: 0,
      lastDecodedTs: 0,
      newPoolsDetected: 0,
      byProgram: {},   // { raydium_cpmm: 0, ... }
    };
    this._db = null;
    this._writeQueue = [];
    this._writeTimer = null;
    this._seenPubkeys = new Set();  // for new-pool detection
    this._newPoolListeners = [];    // callbacks for new pools
    this._decodeLog = new Map();    // poolKey -> ts (per-pool throttle)
  }

  attachDb(database) {
    this._db = database;
    arbDetector.attachDb(database);
  }

  /**
   * Register a callback for new pool detection.
   * Callback receives { pubkey, dex, mintA, mintB, priceNative, decimalsA, decimalsB, vaultA, vaultB, ts }
   */
  onNewPool(callback) {
    this._newPoolListeners.push(callback);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    log.info(`[pool-watch] connecting to ${DEFAULT_WSS.slice(0, 50)}...`);
    this.connection = new Connection(DEFAULT_WSS, 'confirmed');

    // Start vault reader for CPMM price data (Phase Pool-2.5)
    if (config.VAULT_READER_ENABLED) {
      vaultReader.start();
    }

    // Subscribe to each program (if enabled in config). Use legacy 4-arg signature.
    const programEnabled = {
      raydium_cpmm: config.POOL_WATCH_CPMM_ENABLED,
      raydium_clmm: config.POOL_WATCH_CLMM_ENABLED,
      orca_whirlpool: config.POOL_WATCH_WHIRLPOOL_ENABLED,
      meteora_dlmm: config.POOL_WATCH_DLMM_ENABLED,
      meteora_damm_v2: config.POOL_WATCH_DAMM_V2_ENABLED,
    };
    for (const [name, info] of Object.entries(decoder.PROGRAMS)) {
      if (!programEnabled[name]) {
        log.info(`[pool-watch] SKIPPED ${name} (POOL_WATCH_${name.toUpperCase()}_ENABLED=false)`);
        continue;
      }
      try {
        const programId = new PublicKey(info.id);
        const dataSize = POOL_DATA_SIZE[name];
        const filters = dataSize ? [{ dataSize }] : undefined;
        const subId = this.connection.onProgramAccountChange(
          programId,
          (keyedAccountInfo) => this._onAccountUpdate(name, info.id, keyedAccountInfo),
          'confirmed',
          filters
        );
        this.subscriptions.push({ programId: info.id, subscriptionId: subId, programName: name });
        this.stats.byProgram[name] = 0;
        log.info(`[pool-watch] subscribed to ${name} (${info.id})${dataSize ? ` [dataSize=${dataSize}]` : ' [no size filter]'}`);
      } catch (e) {
        log.error(`[pool-watch] failed to subscribe to ${name}: ${e.message}`);
      }
      // small delay between subs to avoid burst
      await new Promise(r => setTimeout(r, 200));
    }

    // Periodic batch write to DB (every 1s)
    this._writeTimer = setInterval(() => this._flushQueue(), 1000);

    log.info(`[pool-watch] started, ${this.subscriptions.length} subscriptions active`);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this._writeTimer) {
      clearInterval(this._writeTimer);
      this._writeTimer = null;
    }
    for (const sub of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(sub.subscriptionId);
      } catch (e) { /* ignore */ }
    }
    this.subscriptions = [];
    await this._flushQueue();  // final flush
    if (config.VAULT_READER_ENABLED) {
      vaultReader.stop();
    }
    log.info('[pool-watch] stopped');
  }

  _onAccountUpdate(programName, programId, keyedAccountInfo) {
    this.stats.events++;
    this.stats.lastEventTs = Date.now();
    this.stats.byProgram[programName] = (this.stats.byProgram[programName] || 0) + 1;

    // Backpressure: drop new events if queue full (CPU protection)
    if (this._writeQueue.length > config.POOL_MAX_INFLIGHT) {
      this.stats.dropped++;
      return;
    }

    const { accountId, accountInfo } = keyedAccountInfo;
    const poolKey = `${programName}:${accountId.toBase58()}`;

    // Per-pool decode throttle — skip if same pool within N ms
    const lastDecode = this._decodeLog.get(poolKey) || 0;
    const now = Date.now();
    if (now - lastDecode < config.POOL_DECODE_THROTTLE_MS) {
      return;
    }
    this._decodeLog.set(poolKey, now);
    // Periodically prune old entries to avoid Map growth
    if (this._decodeLog.size > 50000) {
      const cutoff = now - 60000;
      for (const [k, t] of this._decodeLog) if (t < cutoff) this._decodeLog.delete(k);
    }

    try {
      const data = accountInfo.data;
      const decoded = decoder.decodePoolAccount(programId, data);
      if (decoded._error) {
        this.stats.errors++;
        // Sample error logs (default 1 in 100)
        this._errSampleCount++;
        if (config.POOL_ERROR_LOG_SAMPLE > 0 && this._errSampleCount % config.POOL_ERROR_LOG_SAMPLE === 0) {
          log.debug(`[pool-watch] decode errors suppressed: ${this.stats.errors} total (${programName})`);
        }
        return;
      }
      if (!decoded.mintA || !decoded.mintB) {
        this.stats.errors++;
        return;  // partial decode
      }
      this.stats.decoded++;
      this.stats.lastDecodedTs = Date.now();

      // Register CPMM pool with vaultReader for price data
      if (decoded.dex === 'raydium_cpmm' && decoded.vaultA && decoded.vaultB) {
        vaultReader.addPool({
          pubkey: accountId.toBase58(),
          dex: decoded.dex,
          vaultA: decoded.vaultA,
          vaultB: decoded.vaultB,
          mintA: decoded.mintA,
          mintB: decoded.mintB,
          decimalsA: decoded.decimalsA,
          decimalsB: decoded.decimalsB,
        });
      }

      // Compute CPMM price from vault balances if available
      let priceForArb = decoded.priceNative;
      if (!priceForArb && decoded.dex === 'raydium_cpmm') {
        priceForArb = vaultReader.computePriceForPool(accountId.toBase58());
      }

      // New pool detection (Phase Weird-1): first time we see this pubkey
      const isNewPool = !this._seenPubkeys.has(accountId.toBase58());
      if (isNewPool) {
        this._seenPubkeys.add(accountId.toBase58());
        this.stats.newPoolsDetected++;
        // Fire callbacks (don't await — fire-and-forget)
        const newPoolInfo = {
          pubkey: accountId.toBase58(),
          dex: decoded.dex,
          mintA: decoded.mintA,
          mintB: decoded.mintB,
          decimalsA: decoded.decimalsA,
          decimalsB: decoded.decimalsB,
          priceNative: priceForArb,
          vaultA: decoded.vaultA,
          vaultB: decoded.vaultB,
          ts: Date.now(),
        };
        for (const cb of this._newPoolListeners) {
          try { cb(newPoolInfo); } catch (e) { /* swallow */ }
        }
      }

      // Queue DB write
      this._writeQueue.push({
        pubkey: accountId.toBase58(),
        dex: decoded.dex,
        mint_a: decoded.mintA,
        mint_b: decoded.mintB,
        vault_a: decoded.vaultA,
        vault_b: decoded.vaultB,
        decimals_a: decoded.decimalsA,
        decimals_b: decoded.decimalsB,
        reserve_a_native: null,  // requires vault balance read (Phase Pool-1.5)
        reserve_b_native: null,
        tvl_usd: null,
        price_native: priceForArb,
        price_usd: null,         // requires USD reference (Phase Pool-2)
        fee_bps: decoded.feeBps,
        lp_supply: decoded.lpSupply || null,
        sqrt_price_x64: decoded.sqrtPriceX64 || null,
        liquidity: decoded.liquidity || null,
        tick_current: decoded.tickCurrent ?? null,
        bin_step: decoded.binStep ?? null,
        ts: Date.now(),
      });

      // Cross-DEX gap check (Phase Pool-2) — fire-and-forget, uses in-memory index
      try {
        arbDetector.checkPool({
          pubkey: accountId.toBase58(),
          dex: decoded.dex,
          mintA: decoded.mintA,
          mintB: decoded.mintB,
          decimalsA: decoded.decimalsA,
          decimalsB: decoded.decimalsB,
          priceNative: priceForArb,
          vaultA: decoded.vaultA,
          vaultB: decoded.vaultB,
          ts: Date.now(),
        });
      } catch (e) {
        // Non-fatal — log once per 100 errors
        if (this._arbErrCount === undefined) this._arbErrCount = 0;
        if (this._arbErrCount++ % 100 === 0) {
          log.warn(`[pool-watch] arb check error: ${e.message}`);
        }
      }
    } catch (e) {
      this.stats.errors++;
      this._errSampleCount++;
      if (config.POOL_ERROR_LOG_SAMPLE > 0 && this._errSampleCount % config.POOL_ERROR_LOG_SAMPLE === 0) {
        log.warn(`[pool-watch] decode error: ${e.message} (suppressed, total=${this.stats.errors})`);
      }
    }
  }

  _flushQueue() {
    if (this._writeQueue.length === 0) return;
    if (!this._db) {
      log.warn('[pool-watch] no DB attached, queue dropped');
      this._writeQueue = [];
      return;
    }
    const batch = this._writeQueue.splice(0, this._writeQueue.length);
    try {
      const upsert = this._db.stmts.upsertPoolState;
      const tx = this._db.db.transaction((rows) => {
        for (const r of rows) upsert.run(r);
      });
      tx(batch);
      // Periodic stats log (configurable interval, default 60s)
      const now = Date.now();
      if (now - this.stats.lastStatsLogTs > config.POOL_STATS_INTERVAL_MS) {
        this.stats.lastStatsLogTs = now;
        log.info(
          `[pool-watch] events=${this.stats.events} decoded=${this.stats.decoded} ` +
          `errs=${this.stats.errors} skipped=${this.stats.skipped} dropped=${this.stats.dropped} ` +
          `q=${this._writeQueue.length} by=${JSON.stringify(this.stats.byProgram)}`
        );
      }
    } catch (e) {
      log.error(`[pool-watch] batch write failed: ${e.message}`);
      // Re-queue the batch (cap to avoid memory bloat)
      this._writeQueue.unshift(...batch.slice(0, 1000));
    }
  }

  getStats() {
    return {
      ...this.stats,
      subscriptions: this.subscriptions.length,
      queueDepth: this._writeQueue.length,
      seenPubkeys: this._seenPubkeys.size,
    };
  }
}

module.exports = new PoolSubscription();
