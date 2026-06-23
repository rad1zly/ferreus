'use strict';

const axios = require('axios');
const log = require('./logger');

// Per snipetrench pattern #12: only verified-working endpoints.
// - token.jup.ag/strict has no DNS from this network (ENOTFOUND)
// - api.jup.ag/swap/v1/quote works
// Falling back to Solana Labs official token list (6MB, no key) for token universe.
const TOKEN_LIST_URL = 'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json';
const JUPITER_QUOTE  = 'https://api.jup.ag/swap/v1/quote';

class JupiterClient {
  constructor() {
    this.tokenCache = null;
    this.tokenCacheTs = 0;
    this.cacheTtlMs = 3600000; // 1h
    this._lastQuoteTs = 0;
    this._quoteMinInterval = 1000;  // 1 RPS — conservative for public API
    this._consecRateLimit = 0;
    this._backoffMs = 0;
    this.stats = {
      quotes: 0,
      success: 0,
      rateLimits: 0,
      retries: 0,
      lastError: null,
    };
  }

  async _throttleQuote() {
    const now = Date.now();
    const elapsed = now - this._lastQuoteTs;
    // Dynamic backoff: 2x after each 429, capped at 30s
    const dynamicMin = Math.min(this._quoteMinInterval * Math.pow(2, this._consecRateLimit), 30000);
    const wait = Math.max(dynamicMin - elapsed, 0);
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
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps = 50 }, opts = {}) {
    const maxRetries = opts.maxRetries ?? 3;
    this.stats.quotes++;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this._throttleQuote();
      try {
        const res = await axios.get(JUPITER_QUOTE, {
          params: { inputMint, outputMint, amount, slippageBps },
          timeout: 10000,
        });
        if (!res.data || res.data.error) {
          this._noteSuccess();  // got a response, just no route
          return null;
        }
        this._noteSuccess();
        this.stats.success++;
        return res.data;
      } catch (e) {
        const is429 = e.response && e.response.status === 429;
        const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
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
        this.stats.lastError = e.message;
        log.warn(`[jupiter] quote failed: ${e.message}`);
        return null;
      }
    }
    return null;
  }
}

module.exports = new JupiterClient();
