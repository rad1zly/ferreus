'use strict';

// Helper script: discover Solana launchpad program IDs by scanning
// recent on-chain activity. Useful for expanding Ferreus' new-pool
// monitor without hardcoding program addresses.
//
// Usage: node scripts/find-launchpads.js [--limit N]
//
// Strategy: poll getSignaturesForAddress on a curated list of candidate
// program IDs. Report which ones are real (return recent sigs) and how
// many tx in the last 24h. Output: JSON-friendly list.
//
// IMPORTANT: this script does NOT add anything to the bot. It only
// reports. You manually review and add real ones to src/newPoolMonitor.js.

const rpc = require('../src/solanaRpc');
const log = require('../src/logger');

// Curated list of known/candidate Solana launchpad & AMM programs.
// Add new candidates here as you discover them.
const CANDIDATES = {
  // Verified working (already in monitor)
  pumpfun:              '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpfun_amm_migrate:  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjB3kmG9wbUY6',
  raydium_cpmm:         'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydium_amm_v4:       '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydium_clmm:         'CAMMCzo5YL8w4VFFXKVUciNRVvgM3hEGfG5J6YBZ4eK8',
  orca_whirlpool:       'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  meteora_dlmm:         'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  meteora_damm_v2:      'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',

  // Candidate launchpads (verify below)
  meteora_bonding:      'dbcij3LW41p5GFETb4W5Ne25GCfZsgV4S9Ac2PxGi4UP',  // placeholder — verify
  raydium_launchlab:    'FRyN4Wd8iQGDxhb5k5t9dQw1CyyRck2Uz1NN2r7dL8zP',  // placeholder
  believe:              'BoMq2FsZkqj5xAYhBnDEzbaq4eJZu9TspuhcRzzeM4Vk',  // placeholder
  moonshot:             'MoonCV5Mc1...',  // placeholder
};

async function checkProgram(name, address) {
  try {
    const sigs = await rpc.getSignaturesForAddress(address, { limit: 10 });
    if (!sigs) return { name, address, status: 'DNS/RPC error' };
    if (sigs.length === 0) return { name, address, status: 'no signatures', last_block: null };
    const latest = sigs[0];
    const now = Math.floor(Date.now() / 1000);
    const ageSec = now - (latest.blockTime || now);
    return {
      name,
      address,
      status: ageSec < 3600 ? 'very active' : ageSec < 86400 ? 'active' : 'dormant',
      last_sig_age_sec: ageSec,
      sigs_in_10: sigs.length,
    };
  } catch (e) {
    return { name, address, status: `error: ${e.message}` };
  }
}

async function main() {
  log.info('=== Find Solana launchpads / active programs ===\n');
  log.info('Polling getSignaturesForAddress on each candidate...\n');

  const results = [];
  for (const [name, address] of Object.entries(CANDIDATES)) {
    const r = await checkProgram(name, address);
    results.push(r);
    const status = r.status.padEnd(20);
    const sigs = (r.sigs_in_10 ?? '-').toString().padStart(3);
    const age = r.last_sig_age_sec != null ? `${(r.last_sig_age_sec / 3600).toFixed(1)}h ago` : 'n/a';
    log.info(`  ${name.padEnd(22)} ${status} sigs=${sigs}  last=${age}  ${address}`);
  }

  log.info('\n=== Verdict ===');
  const verified = results.filter(r => r.status === 'very active' || r.status === 'active');
  const dormant = results.filter(r => r.status === 'dormant' || r.status === 'no signatures');
  const errors = results.filter(r => r.status.startsWith('error') || r.status === 'DNS/RPC error');

  log.info(`  ✓ Verified active (${verified.length}): ${verified.map(r => r.name).join(', ')}`);
  if (dormant.length) {
    log.info(`  ⚠ Dormant/no sigs (${dormant.length}): ${dormant.map(r => r.name).join(', ')}`);
    log.info('    These program IDs are likely wrong. Cross-check via Solscan.');
  }
  if (errors.length) {
    log.info(`  ✗ Errors (${errors.length}): ${errors.map(r => r.name).join(', ')}`);
  }

  log.info('\nTo add a verified program to Ferreus, copy its address into');
  log.info('src/newPoolMonitor.js → PROGRAMS map.');
}

main().catch(e => {
  log.error(`find-launchpads failed: ${e.message}`);
  console.error(e);
  process.exit(1);
});