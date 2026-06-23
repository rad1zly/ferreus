'use strict';

/**
 * Vault balance reader — Phase Pool-2.5.
 *
 * CPMM doesn't store reserves in pool account (unlike CLMM/Whirlpool with
 * sqrtPriceX64). For CPMM we must read the token vault balances via
 * getMultipleAccountsInfo, then derive price as vault_b/vault_a.
 *
 * Strategy:
 * 1. Register CPMM pools to track via addPool()
 * 2. Background loop: every 10s, batch-fetch vault balances in chunks of 100
 * 3. Cache in memory: Map<vaultAddress, {amount, decimals, ts}>
 * 4. arbDetector reads from cache via getVaultBalance()
 *
 * Rate-limit aware: tracks consecutive 429s and backs off exponentially.
 * Public Solana RPC: 10 RPS burst, 40 RPM sustained.
 *
 * Token-2022 caveat: vault may be a Token-2022 account. The layout is
 * slightly different but the `amount` field is at the same offset (offset 64
 * after the 32-byte mint + 4-byte amount-padding alignment). For v0 we
 * read at offset 64 directly (works for SPL standard; Token-2022 may
 * require mint extension parsing — out of scope).
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const log = require('./logger');

const DEFAULT_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/';
const REFRESH_INTERVAL_MS = 10000;   // 10s — CPMM swaps are slow
const BATCH_SIZE = 100;              // max accounts per getMultipleAccountsInfo
const RATE_LIMIT_BACKOFF_MS = 5000;  // start with 5s after first 429
const RATE_LIMIT_MAX_BACKOFF_MS = 60000;

class VaultReader {
  constructor() {
    this.cache = new Map();   // vaultAddress -> { amount, decimals, ts, poolPubkey, mint }
    this.pools = new Map();   // poolPubkey -> { vaultA, vaultB, mintA, mintB, decimalsA, decimalsB, dex }
    this.connection = null;
    this._running = false;
    this._timer = null;
    this._consecRateLimit = 0;
    this._backoffMs = 0;
    this.stats = {
      poolsTracked: 0,
      vaultsTracked: 0,
      refreshes: 0,
      vaultsCached: 0,
      errors: 0,
      rateLimits: 0,
      lastRefreshTs: 0,
    };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.connection = new Connection(DEFAULT_RPC, 'confirmed');
    this._timer = setInterval(() => this._refreshOnce().catch(e => {
      this.stats.errors++;
      log.warn(`[vault-reader] refresh failed: ${e.message}`);
    }), REFRESH_INTERVAL_MS);
    log.info(`[vault-reader] started — refresh every ${REFRESH_INTERVAL_MS}ms, batch size ${BATCH_SIZE}`);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    log.info(`[vault-reader] stopped`);
  }

  /**
   * Register a CPMM pool to track. Idempotent (overwrites on re-call).
   * @param {Object} pool - { pubkey, dex, vaultA, vaultB, mintA, mintB, decimalsA, decimalsB }
   */
  addPool(pool) {
    if (!pool || !pool.pubkey || !pool.vaultA || !pool.vaultB) return;
    this.pools.set(pool.pubkey, pool);
    // Pre-register vaults in cache (so arbDetector doesn't drop the pool on first sight)
    if (!this.cache.has(pool.vaultA)) {
      this.cache.set(pool.vaultA, { amount: null, decimals: pool.decimalsA, ts: 0, poolPubkey: pool.pubkey, mint: pool.mintA });
    }
    if (!this.cache.has(pool.vaultB)) {
      this.cache.set(pool.vaultB, { amount: null, decimals: pool.decimalsB, ts: 0, poolPubkey: pool.pubkey, mint: pool.mintB });
    }
    this.stats.poolsTracked = this.pools.size;
    this.stats.vaultsTracked = this.cache.size;
  }

  /**
   * Compute TVL in USD for a CPMM pool using cached vault balances.
   * Returns USD value or null if data missing.
   * @param {string} pubkey
   * @param {Function} priceLookup - async (mint) => usd_price
   */
  async computeTvlUsd(pubkey, priceLookup) {
    const pool = this.pools.get(pubkey);
    if (!pool) return null;
    const va = this.cache.get(pool.vaultA);
    const vb = this.cache.get(pool.vaultB);
    if (!va || !vb || va.amount == null || vb.amount == null) return null;
    if (va.amount === 0n || vb.amount === 0n) return null;

    const decA = va.decimals ?? pool.decimalsA ?? 9;
    const decB = vb.decimals ?? pool.decimalsB ?? 6;
    const uiA = Number(va.amount) / Math.pow(10, decA);
    const uiB = Number(vb.amount) / Math.pow(10, decB);

    // Get prices (sync — uses in-memory priceOracle cache)
    const priceA = priceLookup(pool.mintA);
    const priceB = priceLookup(pool.mintB);
    if (!priceA || !priceB) return null;
    return uiA * priceA + uiB * priceB;
  }

  /**
   * Read cached vault balance. Returns {amount, decimals, ts} or null.
   * @param {string} vaultAddress
   * @param {number} maxAgeMs - default 30s
   */
  getVaultBalance(vaultAddress, maxAgeMs = 30000) {
    const entry = this.cache.get(vaultAddress);
    if (!entry) return null;
    if (entry.amount == null) return null;
    if (maxAgeMs && Date.now() - entry.ts > maxAgeMs) return null;
    return entry;
  }

  /**
   * Compute CPMM price from vault balances. Returns native price (tokenB/tokenA
   * in raw units) or null if either vault is missing.
   * @param {string} pubkey - pool pubkey
   */
  computePriceForPool(pubkey) {
    const pool = this.pools.get(pubkey);
    if (!pool) return null;
    const va = this.getVaultBalance(pool.vaultA, Infinity);  // any age
    const vb = this.getVaultBalance(pool.vaultB, Infinity);
    if (!va || !vb || va.amount == null || vb.amount == null) return null;
    if (va.amount === 0) return null;
    // priceNative = native_B / native_A (matches CLMM/Whirlpool convention)
    return Number(vb.amount) / Number(va.amount);
  }

  async _refreshOnce() {
    if (this._backoffMs > 0) {
      await new Promise(r => setTimeout(r, this._backoffMs));
      this._backoffMs = Math.max(0, this._backoffMs - REFRESH_INTERVAL_MS);
    }
    const vaultAddrs = [...this.cache.keys()];
    if (vaultAddrs.length === 0) return;

    // Batch fetch
    let fetched = 0;
    for (let i = 0; i < vaultAddrs.length; i += BATCH_SIZE) {
      const batch = vaultAddrs.slice(i, i + BATCH_SIZE);
      try {
        const pubkeys = batch.map(a => new PublicKey(a));
        const accounts = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
        this._consecRateLimit = 0;
        for (let j = 0; j < batch.length; j++) {
          const vaultAddr = batch[j];
          const acct = accounts[j];
          const cached = this.cache.get(vaultAddr);
          if (!cached) continue;
          if (!acct || !acct.data) {
            cached.amount = null;
            continue;
          }
          // Token account layout: 32 bytes mint, 8 bytes amount, ... (SPL standard)
          // Amount is at offset 64 as a little-endian u64
          try {
            if (acct.data.length >= 72) {
              const amountLow = acct.data.readBigUInt64LE(64);
              cached.amount = amountLow;
              cached.ts = Date.now();
              fetched++;
            }
          } catch (e) {
            // Token-2022 or other layout — leave as null
          }
        }
      } catch (e) {
        this.stats.errors++;
        if (e.message && (e.message.includes('429') || e.message.includes('Too Many'))) {
          this._consecRateLimit++;
          this.stats.rateLimits++;
          this._backoffMs = Math.min(
            RATE_LIMIT_BACKOFF_MS * Math.pow(2, this._consecRateLimit - 1),
            RATE_LIMIT_MAX_BACKOFF_MS
          );
          log.warn(`[vault-reader] rate-limited (consec=${this._consecRateLimit}), backing off ${this._backoffMs}ms`);
        } else {
          log.warn(`[vault-reader] batch fetch failed: ${e.message}`);
        }
      }
      // Small delay between batches to avoid burst
      if (i + BATCH_SIZE < vaultAddrs.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    this.stats.refreshes++;
    this.stats.vaultsCached = [...this.cache.values()].filter(v => v.amount != null).length;
    this.stats.lastRefreshTs = Date.now();
    if (this.stats.refreshes % 6 === 1) {
      log.info(
        `[vault-reader] refresh #${this.stats.refreshes}: ` +
        `pools=${this.stats.poolsTracked} vaults=${this.stats.vaultsTracked} ` +
        `cached=${this.stats.vaultsCached} (+${fetched} this round)`
      );
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new VaultReader();
