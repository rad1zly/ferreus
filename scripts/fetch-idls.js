'use strict';

/**
 * Fetch Anchor IDL JSON from on-chain for a Solana program.
 *
 * Anchor stores IDLs at a PDA derived from the program_id with seed "anchor:idl".
 * The account data layout (Anchor v0.29+):
 *   8 bytes   discriminator (first 8 bytes of sha256("anchor:idl"))
 *   36 bytes  authority (1 tag + 32 pubkey)
 *   ... rest is borsh-serialized Idl struct
 *
 * We bypass the complex borsh decoding and try a simpler approach:
 * 1. Get the account info
 * 2. Skip first 8 + 36 = 44 bytes (discriminator + authority)
 * 3. The remaining data should be borsh-serialized Idl struct
 * 4. Try to find JSON content within (since IDL data may be appended raw)
 *
 * Note: most modern Anchor programs (post-v0.27) store the IDL as raw JSON
 * inside a vec<u8>. We can extract it by searching for the first '{' in the
 * remaining bytes and parsing until the last '}'.
 */

const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

// Anchor IDL account discriminator (first 8 bytes of sha256("anchor:idl"))
const ANCHOR_IDL_DISCRIMINATOR = Buffer.from([0xa0, 0xe7, 0xa6, 0x92, 0xb8, 0xd1, 0x2c, 0x81]);

// Anchor IDL PDA = findProgramAddressSync([Buffer.from("anchor:idl")], programId)
function findIdlAddress(programId) {
  const programIdKey = new PublicKey(programId);
  // Use PublicKey.findProgramAddressSync for PDA derivation
  const [idlAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('anchor:idl')],
    programIdKey
  );
  return idlAddress;
}

async function fetchIdlForProgram(connection, programId) {
  const idlAddress = findIdlAddress(programId);
  const accountInfo = await connection.getAccountInfo(idlAddress, 'confirmed');
  if (!accountInfo) {
    throw new Error(`No IDL account at ${idlAddress.toBase58()} for program ${programId}`);
  }
  const data = accountInfo.data;

  // Verify discriminator
  const disc = data.subarray(0, 8);
  if (!disc.equals(ANCHOR_IDL_DISCRIMINATOR)) {
    throw new Error(`Bad IDL discriminator: ${disc.toString('hex')}`);
  }

  // Skip discriminator (8) + authority Option<Pubkey> (4 + 32 = 36 bytes max, but in
  // practice authority is 1 byte tag + 32 byte pubkey = 33 bytes, with potential padding)
  // For modern Anchor, the layout is:
  //   8: discriminator
  //   36: authority (Option<Pubkey>)
  //   then serialized Idl struct (borsh)
  // The Idl struct contains a `data: Vec<u8>` field that has the raw IDL bytes
  // encoded as JSON. We'll find the JSON in the data section.

  // Simple approach: find first '{' byte and parse from there
  let start = 44; // skip discriminator + authority
  // The borsh Idl struct has many fields, but the data field (Vec<u8>) is at the
  // end of the struct. The actual IDL bytes are length-prefixed.
  // To simplify: scan for the first '{' from various offsets.

  let jsonStart = -1;
  for (let off = 8; off < Math.min(200, data.length); off++) {
    if (data[off] === 0x7B /* '{' */) {
      // Check if next chars look like JSON (key: value)
      jsonStart = off;
      break;
    }
  }

  if (jsonStart === -1) {
    // Try the post-44 region only
    for (let off = 44; off < data.length; off++) {
      if (data[off] === 0x7B) {
        jsonStart = off;
        break;
      }
    }
  }

  if (jsonStart === -1) {
    throw new Error('Could not find JSON start in IDL data');
  }

  // Find the matching closing brace by tracking depth
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < data.length; i++) {
    const c = data[i];
    if (escape) { escape = false; continue; }
    if (c === 0x5C /* '\\' */ && inString) { escape = true; continue; }
    if (c === 0x22 /* '"' */) { inString = !inString; continue; }
    if (inString) continue;
    if (c === 0x7B /* '{' */) depth++;
    else if (c === 0x7D /* '}' */) {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }

  if (jsonEnd === -1) {
    throw new Error('Could not find JSON end in IDL data');
  }

  const jsonBytes = data.subarray(jsonStart, jsonEnd + 1);
  return JSON.parse(jsonBytes.toString('utf8'));
}

async function main() {
  const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/';
  const connection = new Connection(RPC_URL, 'confirmed');

  // IDL sources — mainnet program addresses
  const programs = [
    { name: 'raydium_cpmm',    program: 'CPMMoo8L3F4KyTGVmcXbhabF8gKLf9g6W3pZBf8T8dH1' },
    { name: 'raydium_clmm',    program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' },
    { name: 'orca_whirlpool',  program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' },
    { name: 'meteora_dlmm',    program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' },
    { name: 'meteora_damm_v2', program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' },
  ];

  const outDir = path.join(__dirname, 'idls');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const p of programs) {
    const outPath = path.join(outDir, `${p.name}.json`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      try {
        const idl = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        console.log(`[skip] ${p.name} (${outPath}, ${idl.accounts?.length || 0} accounts)`);
        continue;
      } catch (e) { /* fall through to re-fetch */ }
    }
    try {
      console.log(`[fetch] ${p.name} from ${p.program}...`);
      const idl = await fetchIdlForProgram(connection, p.program);
      fs.writeFileSync(outPath, JSON.stringify(idl, null, 2));
      console.log(`  ✓ ${p.name}: ${idl.accounts?.length || 0} accounts, ${idl.types?.length || 0} types, ${(JSON.stringify(idl).length / 1024).toFixed(1)}KB → ${outPath}`);
    } catch (e) {
      console.log(`  ✗ ${p.name}: ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { fetchIdlForProgram, findIdlAddress };
