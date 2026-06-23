// Test decoder on recent Meteora DLMM sigs to verify new-pool detection
const axios = require('axios');
const idl = require('../src/idlRegistry');
idl.load();

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';
// Use env var
const KEY = process.env.HELIUS_KEY || 'c8fd4872-1ee0-49c2-b4ad-7c27c1fc5b37';
const url = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

(async () => {
  const programs = {
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora_dlmm',
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium_cpmm',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca',
    'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': 'meteora_dbc',
    'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'raydium_launch',
  };

  let totalChecked = 0;
  const discCount = {};
  const matched = [];
  const rawSamples = [];

  for (const [addr, name] of Object.entries(programs)) {
    console.log(`\n=== ${name} (${addr.slice(0, 12)}...) ===`);
    try {
      // Get 10 sigs
      const sigsRes = await axios.post(url, {
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [addr, { limit: 10 }],
      }, { timeout: 10000 });
      const sigs = sigsRes.data.result || [];
      console.log(`  got ${sigs.length} sigs`);

      for (const s of sigs) {
        if (s.err) continue;
        totalChecked += 1;
        await new Promise(r => setTimeout(r, 350)); // 3 RPS
        try {
          const txRes = await axios.post(url, {
            jsonrpc: '2.0', id: 1, method: 'getTransaction',
            params: [s.signature, {
              encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed'
            }],
          }, { timeout: 15000 });
          const tx = txRes.data.result;
          if (!tx) continue;
          const msg = tx.transaction?.message;
          if (!msg) continue;
          const accountKeys = msg.accountKeys || [];
          const allIx = [
            ...(msg.instructions || []),
            ...(msg.innerInstructions || []).flatMap(i => i.instructions || []),
          ];

          for (const ix of allIx) {
            const data = ix.data;
            if (!data) continue;
            let raw;
            try { raw = Buffer.from(data, 'base64'); } catch (_) { continue; }
            if (raw.length < 8) continue;
            const disc = raw.slice(0, 8).toString('hex');
            const accs = ix.accounts || [];
            if (!accs.length) continue;
            const progAddr = accountKeys[accs[0]];
            if (!progAddr) continue;
            const idlEntry = idl.lookup(progAddr, disc);
            if (idlEntry) {
              const key = `${idlEntry.programName}.${idlEntry.name}`;
              discCount[key] = (discCount[key] || 0) + 1;
              if (idlEntry.isNewPool) {
                matched.push({
                  sig: s.signature,
                  name: idlEntry.name,
                  program: idlEntry.programName,
                  progAddr,
                });
                console.log(`  🎉 NEW POOL: ${idlEntry.name} on ${idlEntry.programName} | sig=${s.signature.slice(0, 30)}...`);
              }
            } else if (rawSamples.length < 8) {
              // Save raw sample of UNMATCHED discriminator
              rawSamples.push({
                sig: s.signature.slice(0, 30),
                disc,
                prog: progAddr.slice(0, 12),
                progName: 'unknown',
              });
            }
          }
        } catch (e) {
          if (e.response?.status === 429) {
            console.log('  rate limited, waiting...');
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    } catch (e) {
      console.log(`  err: ${e.message}`);
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Total txs checked: ${totalChecked}`);
  console.log(`\nTop IDL discriminators found:`);
  for (const [k, v] of Object.entries(discCount).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${v}  ${k}`);
  }
  console.log(`\nNew pool matches: ${matched.length}`);

  console.log(`\n=== Raw sample UNMATCHED discriminators ===`);
  for (const s of rawSamples) {
    console.log(`  disc=${s.disc} prog=${s.prog}... sig=${s.sig}`);
  }
})();
