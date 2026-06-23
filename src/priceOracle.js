'use strict';

// CoinGecko price oracle — fetches USD reference prices for Solana tokens.
// Caches per-mint for 5 minutes to avoid rate limits.

const axios = require('axios');
const log = require('./logger');

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const cache = new Map(); // mint -> {priceUsd, ts}
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
 */
async function getPriceUsd(mint) {
  if (!mint) return null;
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.priceUsd;
  }
  const cgId = await getCoinGeckoId(mint);
  if (!cgId) {
    log.info(`[oracle] no coingecko mapping for ${mint.slice(0, 8)}...`);
    cache.set(mint, { priceUsd: null, ts: Date.now() });
    return null;
  }
  const data = await _throttledGet(`${COINGECKO_API}/simple/price?ids=${cgId}&vs_currencies=usd`);
  const price = data?.[cgId]?.usd;
  cache.set(mint, { priceUsd: price ?? null, ts: Date.now() });
  return price;
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
  computeArbGap,
  getCoinGeckoId,
  MINT_TO_COINGECKO,
};
