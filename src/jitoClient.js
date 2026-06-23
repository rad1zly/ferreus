'use strict';

/**
 * Jito bundle submitter — Phase Pool-4.
 *
 * Submits signed transactions as Jito bundles for atomic, prioritized landing.
 * Jito bundles are guaranteed to land together (or not at all) at the front of
 * the block, with a tip paid to the validator.
 *
 * Use case: atomic arb (buy + sell in same bundle = no sandwich risk).
 *
 * Endpoints:
 * - Block engine: https://mainnet.block-engine.jito.wtf/api/v1
 * - sendBundle: POST /api/v1/bundles
 * - getInflightBundleStatuses: POST /api/v1/bundles/inflight
 *
 * Flow:
 * 1. Build tip transaction (system transfer of JITO_TIP_LAMPORTS to tip account)
 * 2. Build arb transaction (Jupiter swap or our custom arb)
 * 3. Sign both
 * 4. POST bundle to Jito
 * 5. Poll getInflightBundleStatuses for landing confirmation
 * 6. Return result
 *
 * v0: structure in place, real submission gated by config.LIVE_EXECUTE.
 * Pool-5 wires this to executor._executeLive().
 */

const axios = require('axios');
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const log = require('./logger');
const config = require('./config');

// Jito tip accounts (randomly chosen per bundle to avoid contention)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11iQiW1B8d4VDJz4Y8H9FoonG2',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hvA285Kj5Qgsj',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const JITO_BLOCK_ENGINE = config.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1';
const JITO_TIMEOUT_MS = 30000;  // 30s max wait for bundle landing
const JITO_POLL_INTERVAL_MS = 2000;

class JitoClient {
  constructor() {
    this._keypair = null;
    this.stats = {
      bundlesSubmitted: 0,
      bundlesLanded: 0,
      bundlesFailed: 0,
      totalTipLamports: 0,
    };
  }

  /**
   * Decode wallet private key. Supports both raw base58 and B64: prefix.
   */
  loadWallet() {
    if (this._keypair) return this._keypair;
    const key = config.WALLET_PRIVATE_KEY;
    if (!key) throw new Error('WALLET_PRIVATE_KEY not set');
    let secretBytes;
    if (key.startsWith('B64:')) {
      secretBytes = Buffer.from(key.slice(4), 'base64');
    } else {
      secretBytes = bs58.decode(key);
    }
    if (secretBytes.length !== 64) {
      throw new Error(`WALLET_PRIVATE_KEY wrong length: ${secretBytes.length} (expected 64)`);
    }
    this._keypair = Keypair.fromSecretKey(secretBytes);
    log.info(`[jito] wallet loaded: ${this._keypair.publicKey.toBase58().slice(0, 8)}…`);
    return this._keypair;
  }

  getWallet() {
    if (!this._keypair) this.loadWallet();
    return this._keypair;
  }

  /**
   * Build a Jito tip transaction. SystemProgram.transfer of JITO_TIP_LAMPORTS
   * to a random tip account, with recent blockhash.
   */
  async buildTipTx(connection) {
    const wallet = this.getWallet();
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipPubkey = new PublicKey(tipAccount);
    const { blockhash } = await connection.getRecentBlockhash();
    const tx = new Transaction({
      feePayer: wallet.publicKey,
      recentBlockhash: blockhash,
    });
    tx.add(SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipPubkey,
      lamports: config.JITO_TIP_LAMPORTS,
    }));
    return tx;
  }

  /**
   * Submit a signed transaction as a Jito bundle (with tip tx).
   * Returns { bundleId, status, landed } or null on error.
   *
   * @param {Connection} connection - Solana connection for blockhash
   * @param {Transaction} arbTx - the unsigned arb transaction
   * @param {Object} opts - { skipSign, prebuiltTipTx }
   */
  async submitBundle(connection, arbTx, opts = {}) {
    if (!this._keypair) this.loadWallet();

    try {
      // Build tip tx
      const tipTx = opts.prebuiltTipTx || await this.buildTipTx(connection);

      // Sign arb tx
      if (!opts.skipSign) {
        arbTx.feePayer = this._keypair.publicKey;
        arbTx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
        arbTx.sign(this._keypair);
      }

      // Bundle format: array of base58-encoded signed transactions
      const bundle = [
        bs58.encode(tipTx.serialize({ requireAllSignatures: false })),
        bs58.encode(arbTx.serialize({ requireAllSignatures: false })),
      ];

      // Submit
      const startTs = Date.now();
      const res = await axios.post(
        `${JITO_BLOCK_ENGINE}/bundles`,
        { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [bundle] },
        { timeout: 10000 }
      );
      if (res.data.error) {
        log.warn(`[jito] bundle submit error: ${JSON.stringify(res.data.error)}`);
        this.stats.bundlesFailed++;
        return null;
      }
      const bundleId = res.data.result;
      this.stats.bundlesSubmitted++;
      this.stats.totalTipLamports += config.JITO_TIP_LAMPORTS;
      log.info(`[jito] bundle submitted: ${bundleId} (tip=${config.JITO_TIP_LAMPORTS} lamports)`);

      // Poll for landing
      const result = await this._pollBundle(bundleId, startTs);
      if (result && result.landed) {
        this.stats.bundlesLanded++;
      } else {
        this.stats.bundlesFailed++;
      }
      return { bundleId, ...result };
    } catch (e) {
      this.stats.bundlesFailed++;
      log.warn(`[jito] submitBundle failed: ${e.message}`);
      return null;
    }
  }

  async _pollBundle(bundleId, startTs) {
    const deadline = startTs + JITO_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await axios.post(
          `${JITO_BLOCK_ENGINE}/bundles/inflight`,
          { jsonrpc: '2.0', id: 1, method: 'getInflightBundleStatuses', params: [[bundleId]] },
          { timeout: 5000 }
        );
        const status = res.data?.result?.value?.[0];
        if (status) {
          if (status.status === 'Landed' || status.status === 'landed') {
            log.info(`[jito] bundle LANDED: ${bundleId} (slot ${status.slot || '?'})`);
            return { landed: true, slot: status.slot, txSignature: status.transactions?.[0] };
          }
          if (status.status === 'Failed' || status.status === 'failed') {
            log.warn(`[jito] bundle FAILED: ${bundleId}`);
            return { landed: false, error: 'failed' };
          }
        }
      } catch (e) {
        // 404 = bundle not in inflight queue anymore (either landed or expired)
        if (e.response && e.response.status === 404) {
          log.info(`[jito] bundle ${bundleId} no longer in inflight (likely landed or expired)`);
          return { landed: null, unknown: true };
        }
      }
      await new Promise(r => setTimeout(r, JITO_POLL_INTERVAL_MS));
    }
    return { landed: false, error: 'timeout' };
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new JitoClient();
