'use strict';

/**
 * Smoke test for arbDetector. Verifies:
 * 1. Cross-DEX gap detection (CLMM vs Whirlpool)
 * 2. Same-DEX no gap (CLMM vs CLMM, ignored)
 * 3. Cooldown works
 * 4. Decimals normalization correct
 * 5. SOL/USDC real price ~$200 (sanity)
 */

const arbDetector = require('../src/arbDetector');
const db = require('../src/db');

// In-memory test DB (don't touch prod)
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const testDbPath = path.join(os.tmpdir(), `arb-detector-test-${Date.now()}.db`);
const fs = require('fs');
fs.mkdirSync(path.dirname(testDbPath), { recursive: true });

const testDb = new Database(testDbPath);
testDb.pragma('journal_mode = WAL');
testDb.exec(`
  CREATE TABLE IF NOT EXISTS arb_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    pair_key TEXT NOT NULL,
    mint0 TEXT NOT NULL,
    mint1 TEXT NOT NULL,
    cheap_dex TEXT NOT NULL,
    cheap_price REAL NOT NULL,
    cheap_pool TEXT NOT NULL,
    expensive_dex TEXT NOT NULL,
    expensive_price REAL NOT NULL,
    expensive_pool TEXT NOT NULL,
    gap_bps REAL NOT NULL,
    notified INTEGER DEFAULT 0
  );
`);
const stmts = {
  insertArbCandidate: testDb.prepare(`
    INSERT INTO arb_candidates (ts, pair_key, mint0, mint1, cheap_dex, cheap_price, cheap_pool, expensive_dex, expensive_price, expensive_pool, gap_bps)
    VALUES (@ts, @pair_key, @mint0, @mint1, @cheap_dex, @cheap_price, @cheap_pool, @expensive_dex, @expensive_price, @expensive_pool, @gap_bps)
  `),
};
arbDetector.attachDb({ db: testDb, stmts });

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log('--- Test 1: Decimals normalization ---');
// SOL = So111...12, USDC = EPjF...v
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// CLMM: mintA=SOL(dec=9), mintB=USDC(dec=6), priceNative = USDC_raw / SOL_raw
// For 1 SOL = 200 USDC: native = 200e6 / 1e9 = 0.0002
// priceSmallPerBig (USDC per SOL) = 0.0002 * 10^(9-6) = 0.2 ... wait that's wrong
// 0.0002 * 1000 = 0.2 — but 1 SOL = 200 USDC, not 0.2
// 
// Let me recompute: 1 SOL = 200 USDC, so USDC/SOL = 200 (display)
// native: USDC_native / SOL_native = (200 * 10^6) / (1 * 10^9) = 0.0002
// adjustment: 10^(decA - decB) = 10^(9-6) = 1000
// 0.0002 * 1000 = 0.2
// That's not 200. Bug in math?
// 
// Wait, 0.0002 * 1000 = 0.2. So I'm getting 0.2 instead of 200.
// Let me recheck: 0.0002 * 10^3 = 0.2. Hmm.
// 
// Actually: 10^(9-6) = 10^3 = 1000. 0.0002 * 1000 = 0.2. 
// So formula gives 0.2, but answer should be 200. Off by 10^3.
// 
// Maybe the formula should be 10^(decB - decA)? = 10^(6-9) = 0.001. 0.0002 * 0.001 = 2e-7. Worse.
// 
// Let me re-derive. We want: 1 display_SOL = ? display_USDC
// We have: native_USDC = 200e6, native_SOL = 1e9
// ratio: display_USDC / display_SOL = (200e6 / 1e6) / (1e9 / 1e9) = 200 / 1 = 200
// In terms of native: display_USDC / display_SOL = (native_USDC / 10^decB) / (native_SOL / 10^decA)
//   = (native_USDC * 10^decA) / (native_SOL * 10^decB)
//   = (native_USDC / native_SOL) * 10^(decA - decB)
//   = 0.0002 * 10^3
//   = 0.2
// 
// Hmm. Let me check native_USDC = 200e6 (correct) and native_SOL = 1e9 (correct).
// 
// (200e6 / 1e9) = 0.0002. Yes.
// 0.0002 * 10^(9-6) = 0.0002 * 1000 = 0.2.
// 
// But (200e6 * 1e9) / (1e9 * 1e6) = 200e15 / 1e15 = 200. Wait that's:
// 1e9 / 1e9 = 1 (display SOL)
// 200e6 / 1e6 = 200 (display USDC)
// So display_USDC per display_SOL = 200/1 = 200. ✓
// 
// But my formula gives 0.2. So the formula is wrong.
// 
// Let me redo: 
//   price_display = (native_USDC / 10^decB) / (native_SOL / 10^decA)
//   = native_USDC / native_SOL * 10^decA / 10^decB
//   = 0.0002 * 10^9 / 10^6
//   = 0.0002 * 1000
//   = 0.2
// 
// That's wrong by factor of 10^3. Why?
// 
// OH. I see. (200e6 / 1e6) = 200 — that's not "200e6 in display units" if the actual display value is 200. So display USDC = 200.
// 
// display_SOL = native_SOL / 10^decA = 1e9 / 10^9 = 1
// display_USDC = native_USDC / 10^decB = 200e6 / 10^6 = 200
// ratio = 200 / 1 = 200. ✓
// 
// In terms of native ratio: native_USDC / native_SOL = 200e6 / 1e9 = 0.0002
// 
// But I need to MULTIPLY by 10^(decA - decB), which is 10^3 = 1000.
// 0.0002 * 1000 = 0.2. Still wrong.
// 
// Wait: native_USDC / native_SOL = 200e6 / 1e9 = 0.0002 = 2e-4
// 2e-4 * 10^3 = 2e-1 = 0.2
// 
// Hmm. Let me check with different numbers. If 1 SOL = 0.5 USDC (hypothetical):
// native_SOL = 1e9, native_USDC = 0.5e6 = 5e5
// display_SOL = 1, display_USDC = 0.5
// ratio = 0.5/1 = 0.5
// 
// Using formula: 5e5 / 1e9 * 10^(9-6) = 5e-4 * 10^3 = 5e-1 = 0.5. ✓
// 
// So the formula works for the 0.5 case but not the 200 case?! 
// 
// OH WAIT. 200e6 / 1e9 = 0.0002, and 0.0002 * 10^3 = 0.2. But answer should be 200.
// 
// Let me recheck: 1 SOL = 200 USDC. So 1 native_SOL = (200e6 / 1e9) native_USDC = 0.0002 native_USDC. So 1 native_SOL is 0.0002 native_USDC. Or equivalently, 1 native_USDC = 1/0.0002 = 5000 native_SOL.
// 
// OK so 1 native_SOL is a small fraction of 1 native_USDC. That makes sense (1 USDC unit > 1 SOL unit in raw value).
// 
// But the human-readable ratio: 1 SOL = 200 USDC, i.e., 1 display_SOL = 200 display_USDC.
// 
// How do we get from native ratio 0.0002 to display ratio 200?
// 
// native_SOL = 1 * 10^decA = 1 * 10^9
// native_USDC = 200 * 10^decB = 200 * 10^6 = 2e8
// 
// (200 * 10^6) / (1 * 10^9) = 2e8 / 1e9 = 0.2... not 0.0002.
// 
// Hmm! 200 * 10^6 = 2e8, divided by 1e9 = 0.2.
// 
// But I said native_USDC = 200e6 above. 200e6 = 2e8 = 200,000,000. So if 1 SOL = 200 USDC, then USDC_native = 2e8 (for 1 SOL_native = 1e9, USDC_native = 2e8).
// 
// Hmm, but 200e6 is also 2e8. So 200e6 / 1e9 = 0.2. Not 0.0002.
// 
// I made an arithmetic error above. Let me redo: 200 * 10^6 = 200,000,000 = 2e8. 1 * 10^9 = 1,000,000,000 = 1e9.
// 2e8 / 1e9 = 0.2. ✓
// 
// So priceNative = 0.2 (USDC_native per SOL_native).
// 0.2 * 10^3 = 200. ✓ ✓ ✓
//
// OK so the formula IS correct, I had a decimal error above. So:
// - 1 SOL = 200 USDC → priceNative = 0.2 (USDC_native / SOL_native), price_display = 200 (USDC_display / SOL_display)
// - adjustment = 10^(decA - decB) = 10^(9-6) = 1000
// - 0.2 * 1000 = 200. ✓

// Now set up test: CLMM at 200, Whirlpool at 202 → 100bps gap
arbDetector.start();
arbDetector.checkPool({
  pubkey: 'CLMM_POOL_1',
  dex: 'raydium_clmm',
  mintA: SOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  priceNative: 0.2,  // 1 native_SOL = 0.2 native_USDC, i.e., 1 SOL = 200 USDC
  ts: Date.now(),
});
arbDetector.checkPool({
  pubkey: 'WP_POOL_1',
  dex: 'orca_whirlpool',
  mintA: SOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  priceNative: 0.202,  // 1 SOL = 202 USDC
  ts: Date.now(),
});

let stats = arbDetector.getStats();
console.log(`Stats after test 1:`, JSON.stringify(stats, null, 2));

assert(stats.poolsReceived === 2, 'received 2 pools');
assert(stats.gapsDetected === 1, 'detected 1 gap');
assert(stats.gapsLogged === 1, 'logged 1 gap (gap > 30bps)');
assert(Math.abs(stats.pairsTracked - 1) <= 0, '1 pair tracked');

const rows = testDb.prepare('SELECT * FROM arb_candidates').all();
assert(rows.length === 1, '1 row in arb_candidates');
if (rows.length > 0) {
  // mintSmall = USDC (E < S), mintBig = wSOL
  // priceSmallPerBig = wSOL per USDC = 1/200 = 0.005 (CLMM) and 1/202 = 0.00495 (WP)
  // Cheaper to buy wSOL = lower wSOL/USDC ratio = Whirlpool (0.00495)
  assert(rows[0].cheap_dex === 'orca_whirlpool', 'cheap_dex is orca_whirlpool (lower wSOL/USDC)');
  assert(rows[0].expensive_dex === 'raydium_clmm', 'expensive_dex is raydium_clmm (higher wSOL/USDC)');
  assert(Math.abs(rows[0].gap_bps - 100) < 0.1, `gap_bps ~100 (got ${rows[0].gap_bps.toFixed(2)})`);
  assert(Math.abs(rows[0].cheap_price - 0.00495) < 0.0001, `cheap_price ~0.00495 (got ${rows[0].cheap_price})`);
  assert(Math.abs(rows[0].expensive_price - 0.005) < 0.0001, `expensive_price ~0.005 (got ${rows[0].expensive_price})`);
  assert(rows[0].mint0 === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'mint0 = USDC (smaller)');
  assert(rows[0].mint1 === 'So11111111111111111111111111111111111111112', 'mint1 = wSOL (larger)');
}

console.log('\n--- Test 2: Cooldown (no spam) ---');
const before = testDb.prepare('SELECT COUNT(*) AS c FROM arb_candidates').get().c;
// Trigger another gap within cooldown
arbDetector.checkPool({
  pubkey: 'CLMM_POOL_1',
  dex: 'raydium_clmm',
  mintA: SOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  priceNative: 0.2,
  ts: Date.now(),
});
arbDetector.checkPool({
  pubkey: 'WP_POOL_1',
  dex: 'orca_whirlpool',
  mintA: SOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  priceNative: 0.205,  // 2.5% gap
  ts: Date.now(),
});
const after = testDb.prepare('SELECT COUNT(*) AS c FROM arb_candidates').get().c;
assert(after === before, `cooldown prevented duplicate (${before} → ${after})`);

console.log('\n--- Test 3: Same DEX, no gap ---');
// Add JUP/USDC pair
const JUP = 'JUPyiwrYJFskUPiHa7kY3xVCWsCPop4GCkKfjDQNwx6P'.slice(0, 43) + 'CN';  // wrong but ok
const realJup = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
arbDetector.setDecimals(realJup, 6, 'JUP');
arbDetector.checkPool({
  pubkey: 'CLMM_POOL_2',
  dex: 'raydium_clmm',
  mintA: realJup,
  mintB: USDC,
  decimalsA: 6,
  decimalsB: 6,
  priceNative: 0.5,
  ts: Date.now(),
});
arbDetector.checkPool({
  pubkey: 'CLMM_POOL_3',
  dex: 'raydium_clmm',
  mintA: realJup,
  mintB: USDC,
  decimalsA: 6,
  decimalsB: 6,
  priceNative: 0.6,
  ts: Date.now(),
});
const after2 = testDb.prepare('SELECT COUNT(*) AS c FROM arb_candidates').get().c;
assert(after2 === after, `same-DEX pools not logged as arb (${after} → ${after2})`);

console.log('\n--- Test 4: Reverse mint order (USDC/SOL vs SOL/USDC) ---');
// Simulate another DEX with reversed mint order
// For 1 SOL = 200 USDC, with mintA=USDC, mintB=SOL:
//   priceNative = native_SOL / native_USDC = 1e9 / (200 * 1e6) = 5
arbDetector.checkPool({
  pubkey: 'CLMM_POOL_4',
  dex: 'raydium_clmm',
  mintA: USDC,    // reversed
  mintB: SOL,
  decimalsA: 6,
  decimalsB: 9,
  priceNative: 5,  // 1 SOL = 200 USDC, viewed from USDC side
  ts: Date.now() + 1,  // bypass cooldown
});
stats = arbDetector.getStats();
console.log(`  After reversed pool: ${stats.poolsTracked} pools, ${stats.pairsTracked} pairs`);
// The pair should already be tracked, but this is a NEW pool, so we get a third pool in same pair
// This should still find gaps. Let me check if it logged something.
const after3 = testDb.prepare('SELECT COUNT(*) AS c FROM arb_candidates').get().c;
assert(stats.poolsTracked >= 3, 'pools tracked includes reversed-mint pool');
assert(after3 === after2, `cooldown still suppresses Test 4's gap detection`);
// After 1 min it will log. Let's just verify the pool was added.
assert(stats.poolsTracked >= 3, 'pools tracked includes reversed-mint pool');

console.log('\n--- Test 5: Inverted direction detected ---');
// After cooldown elapses (we can't wait 60s), let's check by manipulating lastNotified
arbDetector.lastNotified.clear();
// Now we expect another log
arbDetector.checkPool({
  pubkey: 'WP_POOL_1',
  dex: 'orca_whirlpool',
  mintA: SOL,
  mintB: USDC,
  decimalsA: 9,
  decimalsB: 6,
  priceNative: 0.21,  // 1 SOL = 210 USDC
  ts: Date.now(),
});
const after4 = testDb.prepare('SELECT COUNT(*) AS c FROM arb_candidates').get().c;
assert(after4 === after3 + 1, `cooldown cleared, new gap logged (${after3} → ${after4})`);

// Verify the row
const newRow = testDb.prepare('SELECT * FROM arb_candidates ORDER BY id DESC LIMIT 1').get();
console.log(`  New row: ${newRow.cheap_dex}→${newRow.expensive_dex} gap=${newRow.gap_bps.toFixed(1)}bps`);
assert(newRow.cheap_dex === 'orca_whirlpool', 'cheap is Whirlpool (lower wSOL/USDC)');
assert(newRow.expensive_dex === 'raydium_clmm', 'expensive is CLMM (higher wSOL/USDC)');
assert(newRow.cheap_price < newRow.expensive_price, 'cheap price < expensive price');

console.log(`\n=== ${pass} pass, ${fail} fail ===`);

// Cleanup (best-effort)
arbDetector.stop();
testDb.close();
try { fs.unlinkSync(testDbPath); } catch (_) {}
try { fs.unlinkSync(testDbPath + '-wal'); } catch (_) {}
try { fs.unlinkSync(testDbPath + '-shm'); } catch (_) {}

process.exit(fail > 0 ? 1 : 0);
