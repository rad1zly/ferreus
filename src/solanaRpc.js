'use strict';

// Per snipetrench pattern #12: only verified-working RPC endpoint.
// aggregator APIs (DexScreener/GeckoTerminal/Birdeye public/Raydium API) all returned
// HTTP 403 from this network on 2026-06-22. Solana public RPC works.
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com/';

const axios = require('axios');
const log = require('./logger');

class SolanaRpc {
  constructor(url) {
    this.url = url || process.env.SOLANA_RPC_URL || DEFAULT_RPC;
    this.client = axios.create({
      baseURL: this.url,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
    this._lastRequestTs = 0;
    this._minInterval = 250; // public RPC rate limit ~10 RPS; 4 RPS = safe headroom
  }

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this._lastRequestTs;
    if (elapsed < this._minInterval) {
      await new Promise(r => setTimeout(r, this._minInterval - elapsed));
    }
    this._lastRequestTs = Date.now();
  }

  async call(method, params) {
    await this._throttle();
    try {
      const res = await this.client.post('', {
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      });
      if (res.data.error) {
        throw new Error(`${res.data.error.code}: ${res.data.error.message}`);
      }
      return res.data.result;
    } catch (e) {
      log.warn(`[rpc] ${method} failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Get recent signatures for an address (program, wallet, pool, etc).
   * Returns array of {signature, blockTime, slot, err} or null on error.
   */
  async getSignaturesForAddress(address, opts = {}) {
    const params = [address, {
      limit: opts.limit || 5,
      ...(opts.before ? { before: opts.before } : {}),
      ...(opts.until ? { until: opts.until } : {}),
    }];
    return await this.call('getSignaturesForAddress', params);
  }

  /**
   * Get a parsed transaction by signature.
   * encoding: 'jsonParsed' gives readable inner instructions (slower, larger)
   *           'json' gives base64 (smaller, need manual decode)
   */
  async getTransaction(signature, encoding = 'jsonParsed') {
    return await this.call('getTransaction', [
      signature,
      { encoding, maxSupportedTransactionVersion: 0 },
    ]);
  }

  /**
   * Get current slot.
   */
  async getSlot() {
    return await this.call('getSlot', []);
  }
}

module.exports = new SolanaRpc();