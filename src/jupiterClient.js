'use strict';

const axios = require('axios');
const log = require('./logger');

// Per snipetrench pattern #12: only verified-working endpoints.
// - token.jup.ag/strict has no DNS from this network (ENOTFOUND)
// - api.jup.ag/swap/v1/quote works
// - api.jup.ag/swap/v1/swap works
// Falling back to Solana Labs official token list (6MB, no key) for token universe.
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json';
const JUPITER_QUOTE  = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP   = 'https://api.jup.ag/swap/v1/swap';

class JupiterClient {
  constructor() {
    this.tokenCache = null;
    this.tokenCacheTs = 0;
    this.cacheTtlMs = 3600000; // 1h
    this._lastQuoteTs = 0;
    this._quoteMinInterval = 300;  // 3.3 RPS — Jupiter public API limit
    this._consecRateLimit = 0;
    this._backoffMs = 0;
    this._lastNoRoute = false;   // last call was NO_ROUTES_FOUND (use for fallback)
    // Map our pool decoder dex names -> Jupiter's DEX labels
    // Source: https://api.jup.ag/swap/v1/program-id-to-label
    this.DEX_LABELS = {
      raydium_cpmm: 'Raydium CP',
      raydium_clmm: 'Raydium CLMM',
      orca_whirlpool: 'Whirlpool',
      meteora_dlmm: 'Meteora DLMM',
      meteora_damm_v2: 'Meteora DAMM v2',
      raydium: 'Raydium',
    };
    this.stats = {
      quotes: 0,
      success: 0,
      rateLimits: 0,
      retries: 0,
      noRoutes: 0,
      lastError: null,
    };
  }

  async _throttleQuote() {
    const now = Date.now();
    // Dynamic backoff: 2x after each 429, capped at 30s
    const dynamicMin = Math.min(this._quoteMinInterval * Math.pow(2, this._consecRateLimit), 30000);
    const wait = Math.max(dynamicMin - (now - this._lastQuoteTs), 0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastQuoteTs = Date.now();
  }

  _noteSuccess() {
    this._consecRateLimit = 0;
    this._backoffMs = 0;
  }

  _noteRateLimit() {
    this._consecRateLimit++;
    this._backoffMs = Math.min(this._quoteMinInterval * Math.pow(2, this._consecRateLimit), 30000);
    this.stats.rateLimits++;
  }

  /**
   * Map our decoder dex name (e.g. 'orca_whirlpool') to Jupiter's label
   * (e.g. 'Whirlpool'). Returns null if unknown.
   */
  jupLabel(ourDexName) {
    return this.DEX_LABELS[ourDexName] || null;
  }

  /**
   * Get the full Solana token list. Cached for 1h. Returns array of:
   * { address, name, symbol, decimals, logoURI, ... }
   * (Solana Labs list shape — chainId 101 = mainnet.)
   * Fail-open: returns previous cache or [] on error (per pattern #6).
   */
  async getTokenList() {
    if (this.tokenCache && Date.now() - this.tokenCacheTs < this.cacheTtlMs) {
      return this.tokenCache;
    }
    try {
      const res = await axios.get(TOKEN_LIST_URL, { timeout: 30000 });
      if (!res.data || !Array.isArray(res.data.tokens)) {
        log.warn('[jupiter] token list: unexpected shape, returning cache');
        return this.tokenCache || [];
      }
      this.tokenCache = res.data.tokens;
      this.tokenCacheTs = Date.now();
      log.info(`[jupiter] token list refreshed: ${res.data.tokens.length} tokens (chainId=101/mainnet)`);
      return res.data.tokens;
    } catch (e) {
      log.error(`[jupiter] token list failed: ${e.message}`);
      return this.tokenCache || [];
    }
  }

  /**
   * Get a quote. Returns Jupiter quote object or null on error.
   * amount is in raw token units (e.g. lamports for SOL).
   * Retries up to 3 times on 429 with exponential backoff.
   *
   * @param {Object} q
   * @param {string} q.inputMint
   * @param {string} q.outputMint
   * @param {number} q.amount
   * @param {number} [q.slippageBps=50]
   * @param {string[]} [q.dexes] - restrict to specific Jupiter DEXes (atomic 2-DEX arb)
   * @param {boolean} [q.onlyDirectRoutes=false] - only direct pools, no multi-hop
   * @param {string} [q.swapMode='ExactIn']
   * @param {Object} [opts]
   * @param {number} [opts.maxRetries=3]
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps = 50, dexes, onlyDirectRoutes, swapMode = 'ExactIn' }, opts = {}) {
    const maxRetries = opts.maxRetries ?? 3;
    this.stats.quotes++;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this._throttleQuote();
      const params = { inputMint, outputMint, amount, slippageBps, swapMode };
      if (dexes && dexes.length > 0) params.dexes = dexes.join(',');
      if (onlyDirectRoutes) params.onlyDirectRoutes = 'true';
      try {
        const res = await axios.get(JUPITER_QUOTE, { params, timeout: 10000 });
        if (!res.data) {
          this._noteSuccess();
          this._lastNoRoute = false;
          return null;
        }
        // Jupiter returns 400 with errorCode=NO_ROUTES_FOUND when no route
        // exists for the given dexes constraint. Distinguish from real errors.
        if (res.data.error) {
          if (res.data.errorCode === 'NO_ROUTES_FOUND' ||
              /no.*route/i.test(res.data.error || '')) {
            this._noteSuccess();
            this._lastNoRoute = true;
            this.stats.noRoutes++;
            return null;
          }
          this._lastNoRoute = false;
          this.stats.lastError = res.data.error;
          return null;
        }
        this._noteSuccess();
        this._lastNoRoute = false;
        this.stats.success++;
        return res.data;
      } catch (e) {
        const is429 = e.response && e.response.status === 429;
        const is400 = e.response && e.response.status === 400;
        const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
        // 400 with NO_ROUTES_FOUND in body → not an error, just no route
        if (is400 && e.response?.data?.errorCode === 'NO_ROUTES_FOUND') {
          this._noteSuccess();
          this._lastNoRoute = true;
          this.stats.noRoutes++;
          return null;
        }
        if ((is429 || isTimeout) && attempt < maxRetries) {
          this._noteRateLimit();
          this.stats.retries++;
          const backoff = is429
            ? this._backoffMs
            : Math.min(1000 * Math.pow(2, attempt), 10000);
          log.warn(`[jupiter] ${is429 ? '429' : 'timeout'} on attempt ${attempt+1}/${maxRetries+1}, backing off ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        this._lastNoRoute = false;
        this.stats.lastError = e.message;
        log.warn(`[jupiter] quote failed: ${e.message}`);
        return null;
      }
    }
    return null;
  }

  /** Last call returned NO_ROUTES_FOUND (caller should fall back to broader route). */
  wasLastCallNoRoute() {
    return this._lastNoRoute;
  }

  /**
   * Build a swap transaction from a quote response.
   * Returns { swapTransaction: <base64 string>, lastValidBlockHeight } or null.
   * The returned transaction is signed by Jupiter's fee payer only; we must
   * sign with the user wallet before submitting.
   */
  async getSwapTransaction({ quoteResponse, userPublicKey, wrapAndUnwrapSol = true, prioritizationFeeLamports, dynamicComputeUnitLimit = true }) {
    if (!quoteResponse || !userPublicKey) return null;
    this.stats.quotes++;  // reuse counter (it's a Jupiter API call)
    await this._throttleQuote();
    const body = { quoteResponse, userPublicKey, wrapAndUnwrapSol, dynamicComputeUnitLimit };
    if (prioritizationFeeLamports != null) body.prioritizationFeeLamports = prioritizationFeeLamports;
    try {
      const res = await axios.post(JUPITER_SWAP, body, { timeout: 15000 });
      if (!res.data || res.data.error) {
        this.stats.lastError = JSON.stringify(res.data?.error || 'no data');
        log.warn(`[jupiter] swap tx error: ${this.stats.lastError}`);
        return null;
      }
      this._noteSuccess();
      return res.data;
    } catch (e) {
      this.stats.lastError = e.message;
      log.warn(`[jupiter] swap tx failed: ${e.message}`);
      return null;
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new JupiterClient();
