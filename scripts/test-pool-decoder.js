'use strict';

/**
 * Smoke test for pool decoder. Fetches real pool accounts via getProgramAccounts
 * and validates that decoders produce sensible output.
 *
 * Run: node scripts/test-pool-decoder.js
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const decoder = require('../src/poolDecoder');
const log = require('../src/logger');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/';

async function testProgram(connection, name, programId, limit = 3) {
  log.info(`\n=== ${name} (${programId}) ===`);
  try {
    const pid = new PublicKey(programId);
    const accounts = await connection.getProgramAccounts(pid, {
      dataSlice: { offset: 0, length: 0 }, // just get count + addresses, not data
      limit,
    });
    log.info(`  getProgramAccounts returned ${accounts.length} account addresses (data sliced)`);

    // Now fetch full data for the first account
    if (accounts.length > 0) {
      const first = accounts[0];
      const info = await connection.getAccountInfo(first.pubkey, 'confirmed');
      if (info) {
        log.info(`  First account ${first.pubkey.toBase58().slice(0, 8)}... data len=${info.data.length}`);
        const decoded = decoder.decodePoolAccount(programId, info.data);
        if (decoded._error) {
          log.error(`  ✗ ${decoded._error}`);
          return { name, ok: false, error: decoded._error };
        } else {
          log.info(`  ✓ decoded: dex=${decoded.dex}`);
          log.info(`    mintA: ${decoded.mintA?.slice(0, 12) || 'null'}...`);
          log.info(`    mintB: ${decoded.mintB?.slice(0, 12) || 'null'}...`);
          log.info(`    vaultA: ${decoded.vaultA?.slice(0, 12) || 'null'}...`);
          log.info(`    decimalsA: ${decoded.decimalsA} | decimalsB: ${decoded.decimalsB}`);
          log.info(`    priceNative: ${decoded.priceNative?.toExponential(3) || 'null'}`);
          if (decoded.sqrtPriceX64) log.info(`    sqrtPriceX64: ${decoded.sqrtPriceX64.slice(0, 20)}...`);
          if (decoded.liquidity) log.info(`    liquidity: ${decoded.liquidity.slice(0, 20)}...`);
          if (decoded.tickCurrent !== undefined) log.info(`    tickCurrent: ${decoded.tickCurrent}`);
          if (decoded.binStep) log.info(`    binStep: ${decoded.binStep}`);
          if (decoded.activeId !== null && decoded.activeId !== undefined) log.info(`    activeId: ${decoded.activeId}`);
          if (decoded._partial) log.warn('    (partial decode)');
          return { name, ok: true, mintA: decoded.mintA, mintB: decoded.mintB };
        }
      }
    }
    return { name, ok: false, error: 'no accounts' };
  } catch (e) {
    log.error(`  ✗ ${e.message}`);
    return { name, ok: false, error: e.message };
  }
}

async function main() {
  log.info('=== Ferreus Pool Decoder Smoke Test ===');
  const connection = new Connection(RPC, 'confirmed');
  const results = [];
  for (const [name, info] of Object.entries(decoder.PROGRAMS)) {
    results.push(await testProgram(connection, name, info.id, 2));
    await new Promise(r => setTimeout(r, 500));
  }
  log.info('\n=== Summary ===');
  results.forEach(r => log.info(`  ${r.name}: ${r.ok ? 'OK' : 'FAIL'} ${r.error || ''}`));
  const okCount = results.filter(r => r.ok).length;
  log.info(`\n${okCount}/${results.length} decoders working`);
  process.exit(okCount === results.length ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { log.error(`fatal: ${e.message}`); console.error(e); process.exit(1); }
  );
}
