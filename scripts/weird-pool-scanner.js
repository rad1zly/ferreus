'use strict';

/**
 * Weird Pool Scanner — verify strategy by finding current mispriced pools.
 *
 * Two parts:
 * 1. Static scan: read pool_state, find pools whose price is >5x off from
 *    median price of same pair (cross-DEX outliers).
 * 2. Live scan: subscribe to Solana logsSubscribe for pool-creation events,
 *    decode newly-created pools, check for mispricing.
 *
 * "Mispricing" criteria:
 * - Same pair, different DEXes: pool price > 5x off from median → likely broken
 * - Single pool, no reference: pool price > 100x off from Jupiter reference → likely broken
 * - New pool with imbalanced reserves: ratio between mints > 1000:1 → likely opportunity
 */

const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const db_arbDecoder = require('../src/poolDecoder');

const DB_PATH = '/mnt/c/Users/Prism/Ferreus/data/ferreus.db';
const WSS_URL = process.env.SOLANA_WSS_URL || 'https://api.mainnet-beta.solana.com/';
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';

const db = new Database(DB_PATH, { readonly: true });
const log = (...a) => console.log(...a);

async function staticScan() {
  log('\n=== STATIC SCAN: existing pool_state outliers ===');

  // Get all pools with valid prices and decimals
  const pools = db.prepare(`
    SELECT pubkey, dex, mint_a, mint_b, decimals_a, decimals_b, price_native, sqrt_price_x64
    FROM pool_state
    WHERE price_native IS NOT NULL AND price_native > 0
      AND decimals_a IS NOT NULL AND decimals_b IS NOT NULL
      AND ts > ?
  `).all(Date.now() - 30 * 60 * 1000);  // last 30 min

  log(`Total recent pools with price: ${pools.length}`);

  // Group by pair (mint_a, mint_b normalized — sort mints)
  const byPair = new Map();
  for (const p of pools) {
    const [mint0, mint1] = [p.mint_a, p.mint_b].sort();
    const key = `${mint0}:${mint1}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(p);
  }

  log(`Unique pairs: ${byPair.size}`);

  // For each pair with ≥2 pools, find outliers
  let outliers = [];
  for (const [pairKey, plist] of byPair) {
    if (plist.length < 2) continue;
    // Convert each pool's price to "display priceSmallPerBig" (consistent direction)
    const normalized = plist.map(p => {
      const [aIsSmall, mintSmall] = p.mint_a < p.mint_b ? [true, p.mint_a] : [false, p.mint_b];
      const decSmall = aIsSmall ? p.decimals_a : p.decimals_b;
      const decBig = aIsSmall ? p.decimals_b : p.decimals_a;
      let price;
      if (aIsSmall) {
        price = p.price_native * Math.pow(10, decSmall - decBig);
      } else {
        price = (1 / p.price_native) * Math.pow(10, decBig - decSmall);
      }
      return { ...p, priceDisplay: price };
    });

    const prices = normalized.map(p => p.priceDisplay).filter(p => isFinite(p) && p > 0);
    if (prices.length < 2) continue;
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];

    for (const p of normalized) {
      if (!isFinite(p.priceDisplay) || p.priceDisplay <= 0) continue;
      const ratio = p.priceDisplay / median;
      if (ratio > 5 || ratio < 0.2) {
        outliers.push({ ...p, median, ratio });
      }
    }
  }

  outliers.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));

  log(`\nFound ${outliers.length} outlier pools (>5x off from pair median):`);
  for (const o of outliers.slice(0, 20)) {
    log(`  ${o.dex} ${o.mint_a.slice(0,8)}/${o.mint_b.slice(0,8)}`);
    log(`    price=${o.priceDisplay.toExponential(3)} | median=${o.median.toExponential(3)} | ratio=${o.ratio.toFixed(1)}x`);
    log(`    pubkey=${o.pubkey}`);
  }

  return outliers;
}

async function jupiterPriceScan(outliers) {
  log('\n=== JUPITER REFERENCE SCAN ===');
  if (outliers.length === 0) return;

  // Collect unique mints from top outliers
  const mints = new Set();
  for (const o of outliers.slice(0, 30)) {
    mints.add(o.mint_a);
    mints.add(o.mint_b);
  }

  log(`Fetching Jupiter prices for ${mints.size} mints...`);
  let priceMap = new Map();
  try {
    const res = await axios.get(`${JUPITER_PRICE_API}?ids=${[...mints].join(',')}&vsToken=USDC`, { timeout: 15000 });
    if (res.data && res.data.data) {
      for (const [mint, info] of Object.entries(res.data.data)) {
        if (info && info.price) priceMap.set(mint, parseFloat(info.price));
      }
    }
    log(`Got Jupiter prices for ${priceMap.size} mints`);
  } catch (e) {
    log(`Jupiter price fetch failed: ${e.message}`);
  }

  // For each outlier pool, compute "expected price" from Jupiter and compare
  log('\n--- Outliers vs Jupiter reference ---');
  for (const o of outliers.slice(0, 10)) {
    const priceA = priceMap.get(o.mint_a);
    const priceB = priceMap.get(o.mint_b);
    if (!priceA || !priceB) continue;
    const expectedPrice = priceA / priceB;  // big per small
    if (!isFinite(expectedPrice) || expectedPrice <= 0) continue;
    const ratio = o.priceDisplay / expectedPrice;
    log(`  ${o.dex} ${o.mint_a.slice(0,8)}/${o.mint_b.slice(0,8)}`);
    log(`    pool=${o.priceDisplay.toExponential(3)}  jupiter=${expectedPrice.toExponential(3)}  ratio=${ratio.toFixed(2)}x`);
    if (ratio > 10 || ratio < 0.1) {
      log(`    *** ARB OPPORTUNITY: ${ratio > 1 ? 'pool HIGH' : 'pool LOW'} (${ratio.toFixed(1)}x off)`);
    }
  }
}

async function liveScan() {
  log('\n=== LIVE SCAN: subscribe to pool-creation (60s) ===');
  const connection = new Connection(WSS_URL, 'confirmed');

  // Programs to monitor for new pool creations
  const KNOWN_AMMS = [
    ...Object.entries(db_arbDecoder.PROGRAMS).map(([name, info]) => ({
      name, programId: info.id,
    })),
    // Add pump.fun related (bonding curve + graduated Raydium pools)
    { name: 'pumpfun_bonding', programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' },
    // Pump.fun AMM (graduated tokens trade here)
    { name: 'pumpfun_amm', programId: 'pAMMBay6oceH9fJKBRhGP5D4bD4sWpmSwMn52FMfXEA' },
  ];

  log(`Monitoring ${KNOWN_AMMS.length} AMM programs for new pool creation...`);

  // Track new pools found
  const newPools = [];

  function isValidPool(decoded) {
    if (decoded._error) return false;
    if (!decoded.mintA || !decoded.mintB) return false;
    // Skip System Program pubkeys (decoder garbage)
    const SYS = '11111111111111111111111111111111';
    if (decoded.mintA === SYS || decoded.mintB === SYS) return false;
    // Skip tokens that look like base58 garbage (e.g. "1111111n" = single character variations)
    if (/^1+$/.test(decoded.mintA.slice(0, 10))) return false;
    if (/^1+$/.test(decoded.mintB.slice(0, 10))) return false;
    // Skip degenerate prices
    if (decoded.priceNative !== null && decoded.priceNative !== undefined) {
      if (decoded.priceNative <= 0 || decoded.priceNative > 1e10 || decoded.priceNative < 1e-10) return false;
    }
    return true;
  }

  // Subscribe to each AMM
  const subs = [];
  for (const { name, programId } of KNOWN_AMMS) {
    try {
      const subId = connection.onProgramAccountChange(
        new PublicKey(programId),
        (info) => {
          try {
            const decoded = db_arbDecoder.decodePoolAccount(programId, info.accountInfo.data);
            if (!isValidPool(decoded)) return;
            // Valid new pool found!
            newPools.push({
              program: name,
              pubkey: info.accountId.toBase58(),
              mintA: decoded.mintA,
              mintB: decoded.mintB,
              decimalsA: decoded.decimalsA,
              decimalsB: decoded.decimalsB,
              priceNative: decoded.priceNative,
              ts: Date.now(),
            });
            log(`[NEW POOL] ${name}: ${decoded.mintA.slice(0,8)}/${decoded.mintB.slice(0,8)} price=${decoded.priceNative}`);
          } catch (e) { /* skip */ }
        },
        'confirmed',
      );
      subs.push({ name, programId, subId });
    } catch (e) {
      log(`Failed to subscribe to ${name}: ${e.message}`);
    }
  }

  log(`Subscribed to ${subs.length} programs. Waiting 60s for new pools...`);

  await new Promise(r => setTimeout(r, 60000));

  // Cleanup
  for (const { subId } of subs) {
    try { await connection.removeAccountChangeListener(subId); } catch (_) {}
  }

  log(`\n=== Live scan done. Found ${newPools.length} valid new pools ===`);
  for (const p of newPools) {
    log(`  ${p.program}: ${p.mintA.slice(0,8)}/${p.mintB.slice(0,8)} price=${p.priceNative} ts=${new Date(p.ts).toISOString()}`);
  }

  return newPools;
}

(async () => {
  try {
    const outliers = await staticScan();
    await jupiterPriceScan(outliers);
    await liveScan();
    log('\n=== DONE ===');
    process.exit(0);
  } catch (e) {
    log('Error:', e.message);
    console.error(e);
    process.exit(1);
  }
})();