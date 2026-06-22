'use strict';

/**
 * Ferreus smoke test — validates config + DB + each API client + detectors.
 * Run with: npm run smoke
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

const config = require('../src/config');
const log = require('../src/logger');
const jupiter = require('../src/jupiterClient');
const dexscreener = require('../src/dexScreener');
const db = require('../src/db');
const safety = require('../src/safety');
const Detector = require('../src/detector');
const rpc = require('../src/solanaRpc');
const newPoolMonitor = require('../src/newPoolMonitor');
const pumpfunMonitor = require('../src/pumpfunMonitor');
const coingecko = require('../src/coingecko');
const jitoTip = require('../src/jitoTip');

async function run() {
  log.info('=== Ferreus smoke test (v0.2.0) ===\n');
  let pass = 0, fail = 0;
  function check(name, ok, detail) {
    if (ok) { log.info(`✓ ${name}${detail ? ' — ' + detail : ''}`); pass++; }
    else    { log.error(`✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
  }

  // 1. config
  check('config loaded', !!config.DB_PATH);
  check('DRY_RUN default true', config.DRY_RUN === true);
  check('MIN_GAP_BPS sensible', config.MIN_GAP_BPS >= 10);
  check('MIN_TVL_USD sensible', config.MIN_TVL_USD >= 1000);

  // 2. db
  let database;
  try {
    database = db.init();
    const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    check('db schema created', tables.includes('arb_log') && tables.includes('new_pools') && tables.includes('settings'),
      tables.join(','));
  } catch (e) {
    check('db schema created', false, e.message);
    log.error(e);
    return done(pass, fail);
  }

  // 3. jupiter token list
  try {
    const tokens = await jupiter.getTokenList();
    check('jupiter token list (>=100 tokens)', tokens.length >= 100, `${tokens.length} tokens`);
  } catch (e) {
    check('jupiter token list', false, e.message);
  }

  // 4. dexscreener — SOL mint should have several Solana pairs
  try {
    const solMint = 'So11111111111111111111111111111111111111112';
    const pairs = await dexscreener.getTokenPairs(solMint);
    const solanaPairs = pairs.filter(p => p.chainId === 'solana');
    check('dexscreener SOL pairs (>=2 Solana DEXes)', solanaPairs.length >= 2, `${solanaPairs.length} pairs`);

    if (solanaPairs.length >= 2) {
      const byDex = dexscreener.groupByDex(solanaPairs, solMint);
      check('groupByDex returns multiple DEXes', byDex.length >= 2, byDex.map(d => d.dexId).join(','));
    }
  } catch (e) {
    check('dexscreener', false, e.message);
  }

  // 5. detector end-to-end (single tick on a known multi-DEX token)
  try {
    const detector = new Detector(database);
    await detector.refreshTokenList();
    check('detector refreshTokenList', detector.tokens.length > 0, `${detector.tokens.length} tokens`);

    let found = 0;
    for (let i = 0; i < 10; i++) {
      found += await detector.tick();
    }
    check('detector tick runs (10 iterations)', true, `${found} opportunities in 10 batches`);
  } catch (e) {
    check('detector tick', false, e.message);
  }

  // 6. Solana RPC: getSignaturesForAddress on Raydium CPMM
  try {
    const sigs = await rpc.getSignaturesForAddress('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', { limit: 3 });
    check('solana RPC getSignaturesForAddress', sigs && sigs.length > 0, `${sigs ? sigs.length : 0} sigs from Raydium CPMM`);
  } catch (e) {
    check('solana RPC', false, e.message);
  }

  // 7. new-pool monitor: single tick, count detected events
  try {
    safety.resume(); // make sure not paused from prior run
    newPoolMonitor.attachDb(database);
    const before = database.stmts.countNewPools.get().c;
    await newPoolMonitor.tick();
    const after = database.stmts.countNewPools.get().c;
    const stats = newPoolMonitor.getStats();
    check('new-pool monitor tick', true,
      `${after - before} new events this tick, ${stats.sigsSeen} sigs seen total, ${stats.errors} errors`);
  } catch (e) {
    check('new-pool monitor', false, e.message);
  }

  // 8. pumpfun monitor: single tick
  try {
    pumpfunMonitor.attachDb(database);
    const stats = pumpfunMonitor.getStats();
    await pumpfunMonitor.tick();
    const stats2 = pumpfunMonitor.getStats();
    check('pumpfun monitor tick', true,
      `${stats2.sigsSeen - stats.sigsSeen} sigs this tick, ${stats2.migrationEvents - stats.migrationEvents} migrations`);
  } catch (e) {
    check('pumpfun monitor', false, e.message);
  }

  // 9. safety gates
  check('safety guardDetect allowed', safety.guardDetect().allowed === true);
  check('safety guardTrade dryRun', safety.guardTrade().dryRun === true);
  safety.pause('smoke-test');
  check('safety pause works', safety.isPaused() === true);
  safety.resume();
  check('safety resume works', safety.isPaused() === false);

  // 10. CoinGecko trending
  try {
    const trending = await coingecko.getTrending();
    check('coingecko trending (>=5 tokens)', trending.length >= 5, `${trending.length} trending tokens`);
    const sol = await coingecko.getSolanaTrending();
    check('coingecko Solana trending filter', true, `${sol.length} Solana tokens (out of ${trending.length} total)`);
  } catch (e) {
    check('coingecko', false, e.message);
  }

  // 11. Jito tip floor
  try {
    const floor = await jitoTip.getTipFloor();
    check('jito tip floor', !!floor, floor ? `p50=${(floor.p50_lamports/1e9).toFixed(4)} SOL` : 'no data');
    // Test recommender
    const rec = await jitoTip.recommendTipLamports(500);
    check('jito recommendTipLamports', !!rec && typeof rec.tipLamports === 'number',
      rec ? `${(rec.tipLamports/1e9).toFixed(6)} SOL for $500 opp` : 'no rec');
  } catch (e) {
    check('jito', false, e.message);
  }

  return done(pass, fail);
}

function done(pass, fail) {
  log.info(`\n=== Result: ${pass} pass, ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
  log.error(`smoke test crash: ${e.message}`);
  console.error(e);
  process.exit(1);
});