'use strict';

/**
 * Jupiter Aggregator client.
 *
 * v0.8.2: added 2-DEX direct quote via `dexes` param + `onlyDirectRoutes=true`.
 * This bypasses Jupiter's smart router and forces a direct pool swap on the
 * specific DEX we detected, capturing the actual AMM gap.
 *
 * For our arb flow:
 * - q1: WSOL → USDC, restricted to expensive_dex (sell SOL high)
 * - q2: USDC → WSOL, restricted to cheap_dex (buy SOL cheap)
 * - If q2.outAmount > q1.inAmount: profit in SOL
 *
 * v0.8.2 also: retry on 429 with exponential backoff (3 attempts).
 */

const axios = require('axios');
const log = require('./logger');

// Jupiter public API. `quote-api.jup.ag` is blocked from some networks
// (DNS returns no A record). `public.jupiterapi.com` is an unofficial
// mirror that works from more networks. Falls back to original if mirror fails.
const JUPITER_QUOTE_PRIMARY = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_QUOTE_MIRROR = 'https://public.jupiterapi.com/quote';
const JUPITER_TOKENS_PRIMARY = 'https://token.jup.ag/strict';
const JUPITER_TOKENS_MIRROR = 'https://public.jupiterapi.com/tokens/strict';

// Map our internal DEX names → Jupiter's `dexes` param values.
// Both endpoints use these labels.
const DEX_TO_JUPITER = {
  'raydium_clmm':     'Raydium',
  'raydium_cpmm':     'Raydium',  // Jupiter's Raydium includes CPMM
  'orca_whirlpool':   'Whirlpool',  // Jupiter uses 'Whirlpool' for Orca Whirlpools
  'meteora_dlmm':     'Meteora',
  'meteora_damm_v2':  'Meteora',
};

class JupiterClient {
  constructor() {
    this.tokenCache = null;
    this.tokenCacheTs = 0;
    this.cacheTtlMs = 3600000; // 1h
    this._lastQuoteTs = 0;
    this._quoteMinInterval = 250;  // 4 RPS — Jupiter public API limit
  }

  async _throttleQuote() {
    const now = Date.now();
    const wait = this._quoteMinInterval - (now - this._lastQuoteTs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastQuoteTs = Date.now();
  }

  /**
   * Get a swap quote.
   * @param {Object} opts
   * @param {string} opts.inputMint
   * @param {string} opts.outputMint
   * @param {number} opts.amount - in raw token units (lamports for SOL)
   * @param {number} opts.slippageBps
   * @param {string} [opts.restrictToDex] - internal DEX name (e.g. 'raydium_clmm')
   *   If set, quote is restricted to that DEX via Jupiter's `dexes` param
   *   with `onlyDirectRoutes=true`. Captures the specific AMM gap.
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps = 50, restrictToDex = null }) {
    await this._throttleQuote();
    const params = { inputMint, outputMint, amount, slippageBps };
    if (restrictToDex) {
      const jupDex = DEX_TO_JUPITER[restrictToDex];
      if (jupDex) {
        params.dexes = jupDex;
        params.onlyDirectRoutes = true;  // skip multi-hop router
      }
    }

    // Try primary endpoint first, fall back to mirror on ENOTFOUND/network errors
    const endpoints = [JUPITER_QUOTE_PRIMARY, JUPITER_QUOTE_MIRROR];
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const url of endpoints) {
        try {
          const res = await axios.get(url, {
            params,
            timeout: 10000,
          });
          if (!res.data || res.data.error) {
            if (attempt < 3) {
              await this._sleep(500 * attempt);
              continue;
            }
            return null;
          }
          return res.data;
        } catch (e) {
          const is429 = e.response?.status === 429;
          const isNet = ['ENOTFOUND', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT'].includes(e.code);
          const isLast = attempt === 3;
          if (isNet && url === endpoints[0]) {
            // Try next endpoint
            continue;
          }
          if ((is429 || isNet) && !isLast) {
            const backoff = 500 * Math.pow(2, attempt - 1);
            log.warn(`[jupiter] ${is429 ? '429' : e.code} on attempt ${attempt}, backing off ${backoff}ms`);
            await this._sleep(backoff);
            break;  // try next attempt
          }
          log.warn(`[jupiter] quote failed (attempt ${attempt}, ${url}): ${e.message}`);
          if (isLast) return null;
        }
      }
    }
    return null;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Get the full token list (cached for 1h).
   */
  async getTokenList() {
    const now = Date.now();
    if (this.tokenCache && now - this.tokenCacheTs < this.cacheTtlMs) {
      return this.tokenCache;
    }
    for (const url of [JUPITER_TOKENS_PRIMARY, JUPITER_TOKENS_MIRROR]) {
      try {
        const res = await axios.get(url, { timeout: 10000 });
        this.tokenCache = res.data;
        this.tokenCacheTs = now;
        return this.tokenCache;
      } catch (e) {
        // Try next
      }
    }
    log.warn(`[jupiter] token list fetch failed on all endpoints`);
    return this.tokenCache || [];
  }
}

module.exports = new JupiterClient();
module.exports.DEX_TO_JUPITER = DEX_TO_JUPITER;
