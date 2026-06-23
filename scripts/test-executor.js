'use strict';
// Smoke test for vaultReader + executor (no RPC calls)

const vaultReader = require('../src/vaultReader');
const executor = require('../src/executor');
const jitoClient = require('../src/jitoClient');
const arbDetector = require('../src/arbDetector');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// In-memory test DB
const testDbPath = path.join(os.tmpdir(), `ferreus-exec-test-${Date.now()}.db`);
fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
const testDb = new Database(testDbPath);
testDb.pragma('journal_mode = WAL');
testDb.exec(`
  CREATE TABLE IF NOT EXISTS arb_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, pair_key TEXT NOT NULL,
    mint0 TEXT NOT NULL, mint1 TEXT NOT NULL, cheap_dex TEXT NOT NULL, cheap_price REAL,
    cheap_pool TEXT NOT NULL, cheap_tvl_usd REAL, expensive_dex TEXT NOT NULL,
    expensive_price REAL, expensive_pool TEXT NOT NULL, expensive_tvl_usd REAL,
    gap_bps REAL, executed INTEGER DEFAULT 0, trade_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, arb_id INTEGER,
    mode TEXT NOT NULL, status TEXT NOT NULL, mint_in TEXT NOT NULL, mint_out TEXT NOT NULL,
    amount_in_raw TEXT NOT NULL, amount_out_raw TEXT,
    amount_in_sol REAL, amount_out_sol REAL,
    amount_in_usd REAL, amount_out_usd REAL,
    gross_profit_sol REAL, gross_profit_usd REAL,
    net_profit_sol REAL, net_profit_usd REAL,
    jito_tip_lamports INTEGER, jito_tip_sol REAL,
    priority_fee_lamports INTEGER, gas_lamports INTEGER, gas_sol REAL,
    sol_usd_at_exec REAL, net_roi_pct REAL,
    tx_signature TEXT, error_msg TEXT, quote_json TEXT, raw_json TEXT
  );
`);
const stmts = {
  insertArbCandidate: testDb.prepare(`INSERT INTO arb_candidates (ts, pair_key, mint0, mint1, cheap_dex, cheap_price, cheap_pool, cheap_tvl_usd, expensive_dex, expensive_price, expensive_pool, expensive_tvl_usd, gap_bps) VALUES (@ts, @pair_key, @mint0, @mint1, @cheap_dex, @cheap_price, @cheap_pool, @cheap_tvl_usd, @expensive_dex, @expensive_price, @expensive_pool, @expensive_tvl_usd, @gap_bps)`),
  insertTradeLog: testDb.prepare(`INSERT INTO trade_log (ts, arb_id, mode, status, mint_in, mint_out, amount_in_raw, amount_out_raw, amount_in_sol, amount_out_sol, amount_in_usd, amount_out_usd, gross_profit_sol, gross_profit_usd, net_profit_sol, net_profit_usd, jito_tip_lamports, jito_tip_sol, priority_fee_lamports, gas_lamports, gas_sol, sol_usd_at_exec, net_roi_pct, tx_signature, error_msg, quote_json, raw_json) VALUES (@ts, @arb_id, @mode, @status, @mint_in, @mint_out, @amount_in_raw, @amount_out_raw, @amount_in_sol, @amount_out_sol, @amount_in_usd, @amount_out_usd, @gross_profit_sol, @gross_profit_usd, @net_profit_sol, @net_profit_usd, @jito_tip_lamports, @jito_tip_sol, @priority_fee_lamports, @gas_lamports, @gas_sol, @sol_usd_at_exec, @net_roi_pct, @tx_signature, @error_msg, @quote_json, @raw_json)`),
  markArbExecuted: testDb.prepare(`UPDATE arb_candidates SET executed=1, trade_id=@trade_id WHERE id=@arb_id`),
  recentArbCandidates: testDb.prepare(`SELECT * FROM arb_candidates ORDER BY ts DESC LIMIT ?`),
};
executor.attachDb({ db: testDb, stmts });

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log('--- Test 1: vaultReader addPool + computePriceForPool ---');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const fakeVaultA = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';  // fake SPL token program (placeholder)
const fakeVaultB = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DB';

vaultReader.addPool({
  pubkey: 'POOL_1',
  dex: 'raydium_cpmm',
  vaultA: fakeVaultA,
  vaultB: fakeVaultB,
  mintA: WSOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
});
const stats = vaultReader.getStats();
assert(stats.poolsTracked === 1, '1 pool tracked');
assert(stats.vaultsTracked === 2, '2 vaults tracked');

console.log('\n--- Test 2: vaultReader.computePriceForPool returns null without RPC ---');
const price = vaultReader.computePriceForPool('POOL_1');
assert(price === null, 'no price without RPC fetches (vaults unpopulated)');

console.log('\n--- Test 3: vaultReader.getVaultBalance returns null for unpopulated ---');
const vb = vaultReader.getVaultBalance(fakeVaultA);
assert(vb === null, 'unpopulated vault returns null');

console.log('\n--- Test 4: vaultReader.setVaultBalance (test helper) ---');
// Manually inject vault data to test the price calculation
vaultReader.cache.set(fakeVaultA, { amount: 1000000000n, decimals: 9, ts: Date.now(), poolPubkey: 'POOL_1', mint: WSOL });  // 1 SOL
vaultReader.cache.set(fakeVaultB, { amount: 70000000n, decimals: 6, ts: Date.now(), poolPubkey: 'POOL_1', mint: USDC });  // 70 USDC
const price2 = vaultReader.computePriceForPool('POOL_1');
// priceNative = native_B / native_A = 70M / 1B = 0.07
// (decimal-adjusted display price would be 0.07 * 10^(9-6) = 70)
assert(Math.abs(price2 - 0.07) < 1e-9, `priceNative = 0.07 (raw), got ${price2}`);

console.log('\n--- Test 5: vaultReader start/stop (no RPC, no error) ---');
vaultReader.start();
setTimeout(() => {
  vaultReader.stop();
  assert(true, 'start/stop cycle without error');

  console.log('\n--- Test 6: jitoClient wallet load fails without key ---');
  delete require.cache[require.resolve('../src/config')];
  // Reset config
  const cfg = require('../src/config');
  cfg.WALLET_PRIVATE_KEY = null;
  let threw = false;
  try { jitoClient.loadWallet(); } catch (e) { threw = true; }
  assert(threw, 'loadWallet throws when no key set');

  console.log('\n--- Test 7: jitoClient wallet load with bad key ---');
  cfg.WALLET_PRIVATE_KEY = 'invalid_base58_!@#$';
  let threw2 = false;
  try { jitoClient.loadWallet(); } catch (e) { threw2 = true; }
  assert(threw2, 'loadWallet throws on bad key');

  console.log('\n--- Test 8: executor.execute with stub arb (no real Jupiter call) ---');
  // This actually calls Jupiter — we expect it to return without crashing.
  // We don't assert on result (network-dependent) but check no crash.
  const fakeArb = {
    id: 1, pairKey: `${USDC}:${WSOL}`,
    mint0: USDC, mint1: WSOL,
    cheapDex: 'orca_whirlpool', cheapPrice: 0.014, cheapPool: 'POOL_A', cheapTvlUsd: 50000,
    expensiveDex: 'raydium_clmm', expensivePrice: 0.0145, expensivePool: 'POOL_B', expensiveTvlUsd: 75000,
    gapBps: 35.7,
  };
  (async () => {
    try {
      const tradeId = await executor.execute(fakeArb);
      // If Jupiter call succeeded, tradeId will be set. If failed, null.
      // Either way, no crash.
      assert(true, `executor.execute completed (tradeId=${tradeId})`);
    } catch (e) {
      fail++; console.log(`  ✗ executor.execute crashed: ${e.message}`);
    }

    console.log('\n--- Test 9: arbDetector with vault price (CPMM via vault) ---');
    arbDetector.attachDb({ db: testDb, stmts });
    arbDetector.start();
    arbDetector.checkPool({
      pubkey: 'POOL_1', dex: 'raydium_cpmm',
      mintA: WSOL, mintB: USDC, decimalsA: 9, decimalsB: 6,
      priceNative: 70,  // 1 SOL = 70 USDC
      vaultA: fakeVaultA, vaultB: fakeVaultB,
      ts: Date.now(),
    });
    const adStats = arbDetector.getStats();
    assert(adStats.poolsReceived === 1, 'arbDetector accepted CPMM pool with priceNative=70');
    arbDetector.stop();

    console.log(`\n=== ${pass} pass, ${fail} fail ===`);
    testDb.close();
    try { fs.unlinkSync(testDbPath); } catch (_) {}
    try { fs.unlinkSync(testDbPath + '-wal'); } catch (_) {}
    try { fs.unlinkSync(testDbPath + '-shm'); } catch (_) {}
    process.exit(fail > 0 ? 1 : 0);
  })();
}, 200);
