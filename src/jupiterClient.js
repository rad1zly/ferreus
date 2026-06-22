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
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps = 50 }) {
    try {
      const res = await axios.get(JUPITER_QUOTE, {
        params: { inputMint, outputMint, amount, slippageBps },
        timeout: 10000,
      });
      if (!res.data || res.data.error) {
        return null;
      }
      return res.data;
    } catch (e) {
      log.warn(`[jupiter] quote failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = new JupiterClient();
