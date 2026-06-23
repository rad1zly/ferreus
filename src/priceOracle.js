'use strict';

// CoinGecko price oracle — fetches USD reference prices for Solana tokens.
// Caches per-mint for 5 minutes to avoid rate limits.
//
// v2.6: add bulk fetch (getPriceUsdBulk) + Jupiter price API fallback for
// tokens not on CoinGecko. Jupiter is the canonical Solana price source and
// has the most complete token coverage.

const axios = require('axios');
const log = require('./logger');

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const cache = new Map(); // mint -> {priceUsd, ts, source}
const CACHE_TTL_MS = 300000; // 5 min
const REQUEST_TIMEOUT = 10000;

// Map common Solana mints -> CoinGecko IDs (only the ones we care about)
const MINT_TO_COINGECKO = {
  'So11111111111111111111111111111111111111112': 'solana',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'tether',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnQT7KHGu3o1dW': 'bonk',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'jupiter-exchange-solana',
  'WIF': 'dogwifcoin', // placeholder
};

async function _throttledGet(url) {
  try {
    const res = await axios.get(url, { timeout: REQUEST_TIMEOUT });
    return res.data;
  } catch (e) {
    log.warn(`[oracle] coingecko request failed: ${e.message}`);
    return null;
  }
}

/**
 * Look up the CoinGecko ID for a Solana mint via /coins/list?include_platform=true.
 * Cached per mint.
 */
const mintToCgidCache = new Map();

async function getCoinGeckoId(mint) {
  if (mintToCgidCache.has(mint)) return mintToCgidCache.get(mint);
  if (MINT_TO_COINGECKO[mint]) {
    mintToCgidCache.set(mint, MINT_TO_COINGECKO[mint]);
    return MINT_TO_COINGECKO[mint];
  }
  // Fallback: query CoinGecko contract endpoint
  try {
    const url = `${COINGECKO_API}/coins/solana/contract/${mint}`;
    const data = await _throttledGet(url);
    if (data && data.id) {
      mintToCgidCache.set(mint, data.id);
      return data.id;
    }
  } catch (_) { /* not found */ }
  mintToCgidCache.set(mint, null);
  return null;
}

/**
 * Get USD price for a Solana mint. Returns number or null.
 * Try: cache → CoinGecko → Jupiter price API → null.
 */
async function getPriceUsd(mint) {
  if (!mint) return null;
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.priceUsd;
  }

  // 1. CoinGecko
  const cgId = await getCoinGeckoId(mint);
  if (cgId) {
    const data = await _throttledGet(`${COINGECKO_API}/simple/price?ids=${cgId}&vs_currencies=usd`);
    const price = data?.[cgId]?.usd;
    if (price) {
      cache.set(mint, { priceUsd: price, ts: Date.now(), source: 'coingecko' });
      return price;
    }
  }

  // 2. Jupiter price API fallback (works for any token Jupiter can route)
  try {
    const url = `${JUPITER_PRICE_API}?ids=${mint}&vsToken=USDC`;
    const data = await _throttledGet(url);
    const tokenData = data?.data?.[mint];
    if (tokenData && tokenData.price) {
      // Jupiter USDC price is "how many USDC per 1 token" — already USD-like
      const price = parseFloat(tokenData.price);
      if (isFinite(price) && price > 0) {
        cache.set(mint, { priceUsd: price, ts: Date.now(), source: 'jupiter' });
        return price;
      }
    }
  } catch (_) { /* fall through */ }

  // Cache the miss briefly to avoid hammering APIs
  cache.set(mint, { priceUsd: null, ts: Date.now(), source: null });
  return null;
}

/**
 * Bulk fetch USD prices for many mints. Returns Map<mint, priceUsd>.
 * Uses Jupiter price API (single batch call, up to ~50 mints per call).
 * For tokens Jupiter doesn't know, falls back to CoinGecko (one-at-a-time).
 */
async function getPriceUsdBulk(mints) {
  const result = new Map();
  const toFetch = [];
  const mintList = [...new Set(mints.filter(Boolean))];
  for (const mint of mintList) {
    const cached = cache.get(mint);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      if (cached.priceUsd != null) result.set(mint, cached.priceUsd);
    } else {
      toFetch.push(mint);
    }
  }
  if (toFetch.length === 0) return result;

  // Jupiter batch (fast, single HTTP call)
  try {
    const url = `${JUPITER_PRICE_API}?ids=${toFetch.join(',')}&vsToken=USDC`;
    const data = await _throttledGet(url);
    if (data && data.data) {
      for (const [mint, info] of Object.entries(data.data)) {
        if (info && info.price) {
          const price = parseFloat(info.price);
          if (isFinite(price) && price > 0) {
            result.set(mint, price);
            cache.set(mint, { priceUsd: price, ts: Date.now(), source: 'jupiter' });
          }
        }
      }
    }
  } catch (e) {
    log.warn(`[oracle] jupiter bulk fetch failed: ${e.message}`);
  }

  // Fallback for any not in Jupiter response — try CoinGecko one-by-one (slow)
  const stillMissing = toFetch.filter(m => !result.has(m));
  for (const mint of stillMissing.slice(0, 5)) {  // cap to avoid slow path spam
    const price = await getPriceUsd(mint);
    if (price != null) result.set(mint, price);
  }
  return result;
}

/**
 * Compute price ratio: how much of `quoteMint` does 1 `baseMint` cost in USD?
 * For arb: if pool price is X and ref price is Y, gap_bps = (X - Y) / Y * 10000
 *
 * If either is null, returns null.
 */
async function computeArbGap({ poolPrice, baseMint, quoteMint }) {
  if (poolPrice == null) return { gapBps: null, baseUsd: null, quoteUsd: null };
  const [baseUsd, quoteUsd] = await Promise.all([
    getPriceUsd(baseMint),
    getPriceUsd(quoteMint),
  ]);
  if (!baseUsd || !quoteUsd) return { gapBps: null, baseUsd, quoteUsd };

  // Reference price: how much USD does 1 base cost (in quote terms)?
  const refPrice = baseUsd / quoteUsd; // quote per base
  if (!refPrice) return { gapBps: null, baseUsd, quoteUsd };

  const gapBps = ((poolPrice - refPrice) / refPrice) * 10000;
  return { gapBps, baseUsd, quoteUsd, refPrice };
}

module.exports = {
  getPriceUsd,
  getPriceUsdBulk,
  computeArbGap,
  getCoinGeckoId,
  MINT_TO_COINGECKO,
  cache,  // exposed for executor/Jito tip calc
};
