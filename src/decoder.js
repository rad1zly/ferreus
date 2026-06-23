'use strict';

// P1 Decoder — verifies whether a sig is a real new-pool / migration event.
// Uses Anchor discriminator matching (works for all Solana DEX programs,
// not just SPL/system which jsonParsed supports).
//
// Anchor discriminator = first 8 bytes of sha256("global:<instruction_name>")
//
// Real new-pool discriminators:
//   initializePool           5f4d179a1629512c  (Raydium AMM v4, CLMM, CPMM, Orca, Meteora DAMM)
//   initializePool2          de4ce89c93c4b255  (Raydium AMM v4 modern)
//   initialize               afaf6d1f0d989bed  (Raydium CPMM alt)
//   initializeLbPair         d4ef121058d49273  (Meteora DLMM)
//   initializeCustomizablePool f3857fe16779c9d9  (Meteora DAMM v2)
//   initializePoolWithPrice  4057a84502f5ecbb  (Meteora DAMM v2 alt)
//   migrate                  9beae792ec9ea21e  (Pumpfun legacy)
//   migrateToAmm             7601e5d828481e23  (Pumpfun)
//   migrateToLp              b09552950d134f73  (Pumpfun)
//
// False positive discriminators:
//   initializeBinArray       d73e47696818d223  (Meteora DLMM — bin expansion)
//   openPosition             300a646a3066a254  (Orca — add liquidity)
//   addLiquidity             af5dbe403d45f72f
//   swap                     f8c69e91e17587c8

const axios = require('axios');
const log = require('./logger');
const idl = require('./idlRegistry');

const HELIUS_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/';

const PROGRAMS = {
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM:  'CAMMCzo5YL8w4VFFXKVUciNRVvgM3hEGfG5J6YBZ4eK8',
  RAYDIUM_CPMM:  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  ORCA_WHIRL:    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DAMM:  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  METEORA_DLMM:  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PUMPFUN:       '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
};

// Discriminators for new-pool creation (hex strings)
const NEW_POOL_DISCRIMINATORS = new Set([
  '5f4d179a1629512c',  // initializePool
  'de4ce89c93c4b255',  // initializePool2
  'afaf6d1f0d989bed',  // initialize
  'd4ef121058d49273',  // initializeLbPair
  'f3857fe16779c9d9',  // initializeCustomizablePool
  '4057a84502f5ecbb',  // initializePoolWithPrice
  '9beae792ec9ea21e',  // migrate (Pumpfun)
  '7601e5d828481e23',  // migrateToAmm
  'b09552950d134f73',  // migrateToLp
]);

// Discriminators that indicate the tx is NOT a new pool (adds/swaps)
const FALSE_POSITIVE_DISCRIMINATORS = new Set([
  'd73e47696818d223',  // initializeBinArray (Meteora DLMM bin expansion)
  '300a646a3066a254',  // openPosition (Orca)
  'af5dbe403d45f72f',  // addLiquidity
  'f8c69e91e17587c8',  // swap
]);

const INSTRUCTION_NAMES = {
  '5f4d179a1629512c': 'initializePool',
  'de4ce89c93c4b255': 'initializePool2',
  'afaf6d1f0d989bed': 'initialize',
  'd4ef121058d49273': 'initializeLbPair',
  'f3857fe16779c9d9': 'initializeCustomizablePool',
  '4057a84502f5ecbb': 'initializePoolWithPrice',
  '9beae792ec9ea21e': 'migrate',
  '7601e5d828481e23': 'migrateToAmm',
  'b09552950d134f73': 'migrateToLp',
  'd73e47696818d223': 'initializeBinArray',
  '300a646a3066a254': 'openPosition',
  'af5dbe403d45f72f': 'addLiquidity',
  'f8c69e91e17587c8': 'swap',
};

const PROGRAM_ID_TO_NAME = {};
for (const [k, v] of Object.entries(PROGRAMS)) PROGRAM_ID_TO_NAME[v] = k.toLowerCase().replace(/_/g, '');

async function getTransaction(signature) {
  try {
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [signature, {
        encoding: 'json',  // returns dict with ix.data as base64 string
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }],
    }, { timeout: 20000 });
    if (res.data?.error) {
      log.warn(`[decoder] RPC error: ${res.data.error.code} ${res.data.error.message}`);
      return null;
    }
    return res.data?.result || null;
  } catch (e) {
    log.warn(`[decoder] getTransaction failed: ${e.message}`);
    return null;
  }
}

function decodeBase64ToHex(b64) {
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64').toString('hex');
  } catch (_) {
    return null;
  }
}

/**
 * Walk all instructions in a tx (top-level + inner) and return any that
 * match new-pool or false-positive discriminators.
 */
function findInstructionByDiscriminator(tx) {
  const msg = tx.transaction?.message;
  if (!msg) return { newPoolHit: null, falsePositiveHit: null };
  const accountKeys = msg.accountKeys || [];

  // Build list of all instructions with their programId
  const candidates = [];
  for (const ix of msg.instructions || []) {
    candidates.push({
      programId: ix.programId,
      data: ix.data,
      accountIndexes: ix.accounts || [],
    });
  }
  for (const inner of msg.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      candidates.push({
        programId: ix.programId,
        data: ix.data,
        accountIndexes: ix.accounts || [],
      });
    }
  }

  let newPoolHit = null;
  let falsePositiveHit = null;

  for (const c of candidates) {
    const hex = decodeBase64ToHex(c.data);
    if (!hex || hex.length < 16) continue; // need at least 8 bytes
    const disc = hex.slice(0, 16);

    // IDL-based lookup (authoritative)
    const idlEntry = idl.lookup(c.programId, disc);
    if (idlEntry) {
      if (idlEntry.isNewPool) {
        newPoolHit = {
          discriminator: disc,
          instructionName: idlEntry.name,
          programId: c.programId,
          programName: idlEntry.programName,
          accountIndexes: c.accountIndexes,
          accountKeys: accountKeys,
          args: idlEntry.args,
        };
        break; // first match wins
      }
      if (idlEntry.isAddLiquidity) {
        falsePositiveHit = {
          discriminator: disc,
          instructionName: idlEntry.name,
        };
      }
    }
  }

  return { newPoolHit, falsePositiveHit };
}

function computeTokenChanges(tx) {
  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];
  const preByKey = new Map();
  for (const b of pre) {
    preByKey.set(`${b.accountIndex}-${b.mint}`, b.uiTokenAmount?.uiAmount || 0);
  }
  const out = new Map();
  for (const p of post) {
    const key = `${p.accountIndex}-${p.mint}`;
    const prev = preByKey.get(key) || 0;
    const next = p.uiTokenAmount?.uiAmount || 0;
    const delta = next - prev;
    if (Math.abs(delta) > 0.0000001) {
      const existing = out.get(p.mint) || { delta: 0, decimals: p.uiTokenAmount?.decimals, owner: p.owner };
      existing.delta += delta;
      out.set(p.mint, existing);
    }
  }
  return out;
}

/**
 * Heuristic to derive baseMint/quoteMint from token balance changes.
 * For new pools, the pool vault receives both base + quote tokens.
 * We look for the largest balance change as base, second as quote.
 */
function deriveMintsFromChanges(tokenChanges) {
  const sorted = [...tokenChanges.entries()]
    .map(([mint, info]) => ({ mint, ...info }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (sorted.length === 0) return { baseMint: null, quoteMint: null };
  if (sorted.length === 1) return { baseMint: sorted[0].mint, quoteMint: null };
  return {
    baseMint: sorted[0].mint,
    quoteMint: sorted[1].mint,
    baseAmount: Math.abs(sorted[0].delta),
    quoteAmount: Math.abs(sorted[1].delta),
    baseDecimals: sorted[0].decimals,
    quoteDecimals: sorted[1].decimals,
  };
}

async function decodeNewPool(sig) {
  const tx = await getTransaction(sig);
  if (!tx) return { decoded: false, reason: 'tx-not-found' };
  if (tx.meta?.err) return { decoded: false, reason: 'tx-failed' };

  const result = findInstructionByDiscriminator(tx);
  const tokenChanges = computeTokenChanges(tx);
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const deployer = accountKeys[0]?.pubkey || null;
  const slot = tx.slot;
  const blockTime = tx.blockTime;

  if (result.falsePositiveHit && !result.newPoolHit) {
    return { decoded: false, reason: `false-positive:${result.falsePositiveHit.instructionName}` };
  }
  if (!result.newPoolHit) {
    return { decoded: false, reason: 'no-pool-instruction' };
  }

  // Real new pool! Derive mints + amounts from token balance changes
  const mints = deriveMintsFromChanges(tokenChanges);
  let initialPrice = null;
  if (mints.baseMint && mints.quoteMint && mints.baseAmount > 0 && mints.quoteAmount > 0) {
    const baseDecimals = mints.baseDecimals ?? 9;
    const quoteDecimals = mints.quoteDecimals ?? 9;
    const baseRaw = mints.baseAmount * Math.pow(10, baseDecimals);
    const quoteRaw = mints.quoteAmount * Math.pow(10, quoteDecimals);
    if (baseRaw > 0) initialPrice = quoteRaw / baseRaw;
  }

  // Determine kind
  const isPumpfunMigration = accountKeys.includes(PROGRAMS.PUMPFUN);
  const kind = isPumpfunMigration ? 'pumpfun_migration' : 'pool_create';
  const confidence = isPumpfunMigration ? 'medium' : 'high';

  return {
    decoded: true,
    kind,
    instructionType: result.newPoolHit.instructionName,
    baseMint: mints.baseMint,
    quoteMint: mints.quoteMint,
    baseAmount: mints.baseAmount,
    quoteAmount: mints.quoteAmount,
    initialPrice,
    deployer,
    slot,
    timestamp: blockTime,
    sig,
    confidence,
  };
}

module.exports = {
  decodeNewPool,
  computeTokenChanges,
  findInstructionByDiscriminator,
  deriveMintsFromChanges,
  getTransaction,
  NEW_POOL_DISCRIMINATORS,
  FALSE_POSITIVE_DISCRIMINATORS,
  PROGRAMS,
  INSTRUCTION_NAMES,
};
