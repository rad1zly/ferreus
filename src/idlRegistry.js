'use strict';

// Loads Solana program IDL files and builds a complete discriminator map.
// Source: https://github.com/tenequm/solana-idls (41+ protocols)
//
// Each IDL is an Anchor JSON file with:
//   - instructions: [{ name, discriminator (base58 or hex), accounts, args }]
//   - accounts: account schemas
//   - types: type definitions
//
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const IDL_DIR = path.resolve(__dirname, '..', 'idls');

// Program ID -> filename mapping. Mappings verified against tenequm/solana-idls.
const IDL_PROGRAMS = {
  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm.json',         // AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium-cp-swap.json',     // CPMM
  'CAMMCzo5YL8w4VFFXKVUciNRVvgM3hEGfG5J6YBZ4eK8': 'raydium-amm-v3.json',       // CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'raydium-launchpad.json',   // Launchpad
  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca-whirlpools.json',
  // Meteora
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora-dlmm.json',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'meteora-cp-amm.json',       // DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'meteora-amm.json',          // AMM pools
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': 'meteora-dbc.json',          // Dynamic Bonding Curve
  // Pump.fun
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun-bonding.json',
  // Moonshot
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': 'moonshot.json',
};

// Heuristic to identify "new pool creation" instructions by name.
// Conservative: must indicate a CREATE/INITIALIZE action, not a config update.
function isNewPoolInstruction(name) {
  if (!name) return false;
  const n = name.toLowerCase();

  // Exclude config-only / set* operations
  if (n.startsWith('set') || n.startsWith('update_') || n.startsWith('create_config') ||
      n.startsWith('create_amm_config') || n.includes('config')) {
    return false;
  }

  // Pump.fun: only specific migration instructions
  if (n === 'migrate' || n === 'migrate_to_amm' || n === 'migrate_to_lp' ||
      n === 'migratetoamm' || n === 'migratetolp') {
    return true;
  }

  // Initialize patterns
  if (n === 'initialize' || n === 'initialize2' || n === 'initialize_pool' ||
      n === 'initializepool' || n === 'initialize_lb_pair' || n === 'initializelbpair' ||
      n === 'initialize_lb_pair2' || n === 'initializelbpair2' ||
      n === 'initialize_customizable_pool' || n === 'initializecustomizablepool' ||
      n === 'initialize_pool_with_price' || n === 'initializepoolwithprice' ||
      n === 'initialize_pool_v2' || n === 'initializepoolv2' ||
      n === 'initialize_pool_with_adaptive_fee' || n === 'initializepoolwithadaptivefee' ||
      n === 'initialize_pool_with_dynamic_config' || n === 'initializepoolwithdynamicconfig' ||
      n === 'initialize_spot_pool' || n === 'initializespotpool') {
    return true;
  }

  // Create pool patterns
  if (n === 'create_pool' || n === 'createpool') {
    return true;
  }

  return false;
}

// Heuristic for "add liquidity" or other false positives
function isAddLiquidityInstruction(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  if (n.includes('addliquidity') || n.includes('add_liquidity')) return true;
  if (n.includes('openposition') || n.includes('open_position')) return true;
  if (n.includes('increaseliquidity') || n.includes('increase_liquidity')) return true;
  if (n.includes('initializebinarray') || n.includes('initialize_bin_array')) return true;
  if (n === 'swap' || n.endsWith('_swap') || n.startsWith('swap_')) return true;
  return false;
}

/**
 * Convert a discriminator from base58 (Anchor format) to hex string
 */
function base58ToHex(b58) {
  if (!b58) return null;
  try {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt(0);
    for (const c of b58) {
      const idx = ALPHABET.indexOf(c);
      if (idx === -1) return null;
      num = num * BigInt(58) + BigInt(idx);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    // Pad to 16 chars (8 bytes)
    while (hex.length < 16) hex = '0' + hex;
    return hex;
  } catch (_) {
    return null;
  }
}

class IDLRegistry {
  constructor() {
    this.discrToInstruction = new Map(); // `${programId}:${discHex}` -> { name, isNewPool, isAddLiquidity, programId, file }
    this.programNames = new Map(); // programId -> display name
    this.instructionArgs = new Map(); // `${programId}:${discHex}` -> args array (for future decoder)
    this.loaded = false;
  }

  load() {
    if (this.loaded) return { programs: this.programNames.size, instructions: this.discrToInstruction.size };

    let totalInstructions = 0;
    for (const [programId, filename] of Object.entries(IDL_PROGRAMS)) {
      const path_ = path.join(IDL_DIR, filename);
      if (!fs.existsSync(path_)) {
        log.warn(`[idl] missing IDL: ${filename}`);
        continue;
      }
      try {
        const idl = JSON.parse(fs.readFileSync(path_, 'utf8'));
        this.programNames.set(programId, filename.replace('.json', ''));
        if (idl.instructions) {
          for (const ix of idl.instructions) {
            // Discriminator can be in 4 forms:
            //   1. hex string (16 chars)
            //   2. base58 string (anchor format)
            //   3. array of bytes
            //   4. missing — compute via sha256('global:<name>')[:8]
            let discHex = null;
            if (typeof ix.discriminator === 'string') {
              if (ix.discriminator.length === 16) {
                discHex = ix.discriminator;
              } else {
                discHex = base58ToHex(ix.discriminator);
              }
            } else if (Array.isArray(ix.discriminator)) {
              discHex = Buffer.from(ix.discriminator).toString('hex');
            } else if (ix.discriminator === undefined || ix.discriminator === null) {
              // Compute from name (Anchor convention)
              const hash = crypto.createHash('sha256')
                .update(`global:${ix.name}`)
                .digest();
              discHex = hash.slice(0, 8).toString('hex');
            }
            if (!discHex || discHex.length !== 16) {
              log.warn(`[idl] invalid discriminator for ${filename}:${ix.name}`);
              continue;
            }
            const key = `${programId}:${discHex}`;
            this.discrToInstruction.set(key, {
              name: ix.name,
              isNewPool: isNewPoolInstruction(ix.name),
              isAddLiquidity: isAddLiquidityInstruction(ix.name),
              programId,
              programName: filename.replace('.json', ''),
              args: ix.args || [],
            });
            if (ix.args) this.instructionArgs.set(key, ix.args);
            totalInstructions += 1;
          }
        }
      } catch (e) {
        log.error(`[idl] failed to parse ${filename}: ${e.message}`);
      }
    }
    this.loaded = true;
    log.info(`[idl] loaded ${this.programNames.size} programs, ${totalInstructions} instructions from ${IDL_DIR}`);
    return { programs: this.programNames.size, instructions: totalInstructions };
  }

  /**
   * Look up an instruction by programId + 8-byte discriminator hex.
   */
  lookup(programId, discHex) {
    return this.discrToInstruction.get(`${programId}:${discHex}`) || null;
  }

  /**
   * Get all new-pool instruction names (for reporting).
   */
  newPoolInstructionNames() {
    return [...this.discrToInstruction.values()]
      .filter(x => x.isNewPool)
      .map(x => `${x.programName}:${x.name}`);
  }

  getProgramName(programId) {
    return this.programNames.get(programId) || 'unknown';
  }
}

module.exports = new IDLRegistry();
