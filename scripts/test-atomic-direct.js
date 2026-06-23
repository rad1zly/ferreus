'use strict';

/**
 * Test: atomic 2-DEX direct quote.
 * Picks a known arb candidate from DB, calls executor.execute(),
 * verifies Jupiter returns a quote with dexes=[specific] constraint.
 */

const Database = require('better-sqlite3');
const path = require('path');
const jupiter = require('../src/jupiterClient');
const executor = require('../src/executor');
const config = require('../src/config');
const priceOracle = require('../src/priceOracle');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

(async () => {
  // Init price oracle (we need SOL price for USD reporting)
  await priceOracle.getPriceUsd(WSOL_MINT).catch(e => {
    console.error('priceOracle.getPriceUsd failed:', e.message);
  });
  console.log('SOL USD:', priceOracle.cache.get(WSOL_MINT)?.priceUsd);

  // Init executor with DB
  const db = new Database(path.join(__dirname, '..', 'data', 'ferreus.db'), { readonly: true });
  executor.attachDb({
    stmts: {
      insertTradeLog: { run: () => ({ lastInsertRowid: null }) },
      markArbExecuted: { run: () => {} },
    },
  });

  // Pick 3 fresh arbs with various DEX pairs
  const arbs = db.prepare(`
    SELECT id, pair_key, mint0, mint1, cheap_dex, expensive_dex,
           cheap_tvl_usd, expensive_tvl_usd, gap_bps
    FROM arb_candidates
    WHERE gap_bps > 50 AND gap_bps < 5000
    ORDER BY ts DESC
    LIMIT 5
  `).all();
  console.log(`Found ${arbs.length} test arbs`);

  let success = 0;
  let fallback = 0;
  let failed = 0;
  let totalNetProfitSol = 0;

  for (const a of arbs) {
    console.log(`\n--- arb#${a.id} ${a.cheap_dex}→${a.expensive_dex} gap=${a.gap_bps}bps ---`);
    console.log(`  mint0=${a.mint0.slice(0, 12)}... mint1=${a.mint1.slice(0, 12)}...`);
    console.log(`  cheap_tvl=$${a.cheap_tvl_usd?.toFixed(0)} expensive_tvl=$${a.expensive_tvl_usd?.toFixed(0)}`);

    // Force direct first (no fallback) — bypass the round-trip fallback for the test
    const result = await executor.execute({
      id: a.id,
      pairKey: a.pair_key,
      mint0: a.mint0,
      mint1: a.mint1,
      cheapDex: a.cheap_dex,
      expensiveDex: a.expensive_dex,
      gapBps: a.gap_bps,
    }, { forceRoundTrip: false });

    if (result === null) {
      console.log(`  → SKIPPED (cooldown or other)`);
      failed++;
    } else if (result === 'fallback') {
      console.log(`  → FALLBACK (Jupiter couldn't find direct route)`);
      fallback++;
    } else {
      console.log(`  → TRADE #${result}`);
      success++;
    }
    // Stats from the executor
    const stats = executor.getStats();
    console.log(`  stats: simulated=${stats.directSimulated}, netProfit=${stats.totalNetProfitSol.toFixed(6)} SOL`);
  }

  console.log('\n=== TEST SUMMARY ===');
  console.log(`Total: ${arbs.length} | success: ${success} | fallback: ${fallback} | failed: ${failed}`);
  const finalStats = executor.getStats();
  console.log(`Direct simulated: ${finalStats.directSimulated}`);
  console.log(`Total gross profit: ${finalStats.totalGrossProfitSol.toFixed(6)} SOL ($${finalStats.totalGrossProfitUsd.toFixed(4)})`);
  console.log(`Total net profit:   ${finalStats.totalNetProfitSol.toFixed(6)} SOL ($${finalStats.totalNetProfitUsd.toFixed(4)})`);

  const jStats = jupiter.getStats();
  console.log(`\nJupiter stats:`, jStats);

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
