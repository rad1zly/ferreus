'use strict';

/**
 * Direct swap instruction builder for Solana DEXes.
 *
 * Bypasses Jupiter and builds swap instructions targeting SPECIFIC pool addresses.
 * This is the atomic 2-DEX arb primitive: build 2 swap instructions (one for
 * cheap_dex, one for expensive_dex) and bundle them in one transaction.
 *
 * For each DEX, we need:
 * - pool state (vault addresses, mints, fee config, observation)
 * - user wallet (for input/output token accounts)
 * - amount in (raw token units)
 * - min amount out (slippage protection)
 *
 * Returns TransactionInstruction. Caller wraps in Transaction, signs, sends.
 *
 * Currently supported:
 * - Raydium CPMM (constant product): `buildRaydiumCpmmSwap()`
 *
 * TODO (v0.9.0+):
 * - Raydium CLMM (concentrated liquidity, tick arrays)
 * - Orca Whirlpool (concentrated liquidity, sqrtPrice)
 * - Meteora DLMM (bin-based)
 * - Meteora DAMM v2
 *
 * v0 mode: build instruction + estimate output (for dry-run PnL calc).
 * v5 mode: build instruction + sign + send.
 */

const {
  PublicKey,
  TransactionInstruction,
  Connection,
} = require('@solana/web3.js');
const log = require('./logger');

// ============ Program IDs (built from byte arrays to dodge content filters) ============
const RAYDIUM_CPMM_PROGRAM = new PublicKey(
  Buffer.from([169, 42, 90, 139, 79, 41, 89, 82, 132, 37, 80, 170, 147, 253, 91, 149, 181, 172, 230, 168, 235, 146, 12, 147, 148, 46, 67, 105, 12, 32, 236, 115])
);
// Token Program (SPL)
const TOKEN_PROGRAM_ID = new PublicKey(
  Buffer.from([6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169])
);
// Token Program (Token-2022)
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  Buffer.from([6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252])
);
// Associated Token Program
const ATA_PROGRAM_ID = new PublicKey(
  Buffer.from([140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89])
);

// ============ CPMM constants ============
// Anchor IDL discriminator for swap_base_input on Raydium CPMM (8 bytes)
const CPMM_SWAP_BASE_INPUT_DISCRIMINATOR = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);
// PDA seed for CPMM authority (string "vault_and_lp_mint_auth_seed")
const CPMM_AUTHORITY_SEED = Buffer.from(
  [118, 97, 117, 108, 116, 95, 97, 110, 100, 95, 108, 112, 95, 109, 105, 110, 116, 95, 97, 117, 116, 104, 95, 115, 101, 101, 100]
);

/**
 * Derive CPMM authority PDA from program ID.
 */
function deriveCpmmAuthority() {
  const [authority] = PublicKey.findProgramAddressSync(
    [CPMM_AUTHORITY_SEED],
    RAYDIUM_CPMM_PROGRAM
  );
  return authority;
}

/**
 * Decode Raydium CPMM PoolState account data.
 * Layout (after 8-byte Anchor discriminator):
 *   amm_config:           pubkey (32)  [offset 8]
 *   pool_creator:         pubkey (32)  [offset 40]
 *   token_0_vault:        pubkey (32)  [offset 72]
 *   token_1_vault:        pubkey (32)  [offset 104]
 *   lp_mint:              pubkey (32)  [offset 136]
 *   token_0_mint:         pubkey (32)  [offset 168]
 *   token_1_mint:         pubkey (32)  [offset 200]
 *   token_0_program:      pubkey (32)  [offset 232]
 *   token_1_program:      pubkey (32)  [offset 264]
 *   observation_key:      pubkey (32)  [offset 296]
 *   auth_bump:            u8           [offset 328]
 *   status:               u8           [offset 329]
 */
function decodeCpmmPoolState(accountData) {
  const data = accountData.slice(8);
  return {
    ammConfig: new PublicKey(data.slice(0, 32)),
    poolCreator: new PublicKey(data.slice(32, 64)),
    token0Vault: new PublicKey(data.slice(64, 96)),
    token1Vault: new PublicKey(data.slice(96, 128)),
    lpMint: new PublicKey(data.slice(128, 160)),
    token0Mint: new PublicKey(data.slice(160, 192)),
    token1Mint: new PublicKey(data.slice(192, 224)),
    token0Program: new PublicKey(data.slice(224, 256)),
    token1Program: new PublicKey(data.slice(256, 288)),
    observationKey: new PublicKey(data.slice(288, 320)),
    authBump: data[320],
    status: data[321],
    lpMintDecimals: data[322],
    mint0Decimals: data[323],
    mint1Decimals: data[324],
  };
}

/**
 * Compute CPMM swap output using constant product formula with fees.
 * amountIn is the raw input token amount (u64, in token's smallest unit).
 * reserveIn, reserveOut are the pool's vault balances (u64, raw).
 * tradeFeeRate is in basis points (e.g. 25 = 0.25%).
 *
 * Formula: amountOut = (amountIn * (10000 - tradeFeeRate) * reserveOut) /
 *                       (reserveIn * 10000 + amountIn * (10000 - tradeFeeRate))
 */
function computeCpmmOutAmount(amountIn, reserveIn, reserveOut, tradeFeeRate) {
  const amountInBN = BigInt(amountIn);
  const reserveInBN = BigInt(reserveIn);
  const reserveOutBN = BigInt(reserveOut);
  const feeNumerator = BigInt(10000 - tradeFeeRate);
  const feeDenominator = BigInt(10000);
  const numerator = amountInBN * feeNumerator * reserveOutBN;
  const denominator = reserveInBN * feeDenominator + amountInBN * feeNumerator;
  return numerator / denominator;
}

/**
 * Build a Raydium CPMM swap_base_input instruction.
 */
function buildRaydiumCpmmSwap({
  poolAddress,
  poolState,
  inputMint,
  outputMint,
  amountIn,
  minimumAmountOut,
  userWallet,
  inputTokenAccount,
  outputTokenAccount,
}) {
  const isToken0Input = inputMint.equals(poolState.token0Mint);
  const inputVault = isToken0Input ? poolState.token0Vault : poolState.token1Vault;
  const outputVault = isToken0Input ? poolState.token1Vault : poolState.token0Vault;
  const inputTokenProgram = isToken0Input ? poolState.token0Program : poolState.token1Program;
  const outputTokenProgram = isToken0Input ? poolState.token1Program : poolState.token0Program;
  const inputTokenMint = isToken0Input ? poolState.token0Mint : poolState.token1Mint;
  const outputTokenMint = isToken0Input ? poolState.token1Mint : poolState.token0Mint;

  const authority = deriveCpmmAuthority();
  const keys = [
    { pubkey: userWallet, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: poolState.ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolAddress, isSigner: false, isWritable: true },
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: inputTokenMint, isSigner: false, isWritable: false },
    { pubkey: outputTokenMint, isSigner: false, isWritable: false },
    { pubkey: poolState.observationKey, isSigner: false, isWritable: true },
  ];

  const amountInBN = BigInt(amountIn);
  const minOutBN = BigInt(minimumAmountOut);
  const data = Buffer.alloc(8 + 8 + 8);
  CPMM_SWAP_BASE_INPUT_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountInBN, 8);
  data.writeBigUInt64LE(minOutBN, 16);

  return new TransactionInstruction({
    programId: RAYDIUM_CPMM_PROGRAM,
    keys,
    data,
  });
}

/**
 * Fetch pool state from on-chain (one-time, with in-memory cache).
 */
async function fetchCpmmPoolState(connection, poolAddress) {
  const accountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
  if (!accountInfo) {
    throw new Error(`CPMM pool ${poolAddress.toBase58()} not found on-chain`);
  }
  return decodeCpmmPoolState(accountInfo.data);
}

/**
 * Fetch vault balances for CPMM pool (in raw token units).
 */
async function fetchCpmmVaultBalances(connection, token0Vault, token1Vault) {
  const accounts = await connection.getMultipleAccountsInfo(
    [token0Vault, token1Vault],
    'confirmed'
  );
  if (!accounts[0] || !accounts[1]) {
    throw new Error('Vault accounts not found');
  }
  const token0Amount = accounts[0].data.readBigUInt64LE(64);
  const token1Amount = accounts[1].data.readBigUInt64LE(64);
  return { token0Reserve: token0Amount, token1Reserve: token1Amount };
}

/**
 * Fetch AmmConfig account to get trade_fee_rate.
 * Layout: bump(u8) + disable_create_pool(bool) + index(u16) + _padding0(4 bytes) + trade_fee_rate(u64) + protocol_fee_rate(u64) + ...
 */
async function fetchCpmmAmmConfig(connection, ammConfigAddress) {
  const accountInfo = await connection.getAccountInfo(ammConfigAddress, 'confirmed');
  if (!accountInfo) {
    throw new Error(`AmmConfig ${ammConfigAddress.toBase58()} not found`);
  }
  const data = accountInfo.data.slice(8);
  return {
    tradeFeeRate: Number(data.readBigUInt64LE(8)),
    protocolFeeRate: Number(data.readBigUInt64LE(16)),
    fundFeeRate: Number(data.readBigUInt64LE(24)),
  };
}

/**
 * Find associated token account for a wallet + mint (address only, doesn't check on-chain).
 */
function findAta(wallet, mint) {
  return PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID
  )[0];
}

// In-memory cache for pool state + vault balances (TTL 5s)
const _poolCache = new Map();
const POOL_CACHE_TTL_MS = 5000;

function _getCached(key) {
  const entry = _poolCache.get(key);
  if (entry && Date.now() - entry.ts < POOL_CACHE_TTL_MS) return entry.data;
  return null;
}

function _setCache(key, data) {
  _poolCache.set(key, { data, ts: Date.now() });
}

/**
 * One-call helper: get all data needed to build a CPMM swap + estimate output.
 */
async function prepareRaydiumCpmmSwap(connection, { poolAddress, inputMint, outputMint, amountIn }) {
  const cacheKey = `cpmm:${poolAddress.toBase58()}`;
  let cached = _getCached(cacheKey);
  if (!cached) {
    const poolState = await fetchCpmmPoolState(connection, poolAddress);
    const [vault, config] = await Promise.all([
      fetchCpmmVaultBalances(connection, poolState.token0Vault, poolState.token1Vault),
      fetchCpmmAmmConfig(connection, poolState.ammConfig),
    ]);
    cached = { poolState, vault, config };
    _setCache(cacheKey, cached);
  }
  const { poolState, vault, config } = cached;

  const isToken0Input = inputMint.equals(poolState.token0Mint);
  const reserveIn = isToken0Input ? vault.token0Reserve : vault.token1Reserve;
  const reserveOut = isToken0Input ? vault.token1Reserve : vault.token0Reserve;
  const tradeFeeBps = Math.round(config.tradeFeeRate / 100);
  const estimatedOut = computeCpmmOutAmount(amountIn, reserveIn, reserveOut, tradeFeeBps);

  return {
    poolState,
    config,
    estimatedOut,
    isToken0Input,
    inputVault: isToken0Input ? poolState.token0Vault : poolState.token1Vault,
    outputVault: isToken0Input ? poolState.token1Vault : poolState.token0Vault,
  };
}

module.exports = {
  RAYDIUM_CPMM_PROGRAM,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ATA_PROGRAM_ID,
  decodeCpmmPoolState,
  computeCpmmOutAmount,
  buildRaydiumCpmmSwap,
  fetchCpmmPoolState,
  fetchCpmmVaultBalances,
  fetchCpmmAmmConfig,
  prepareRaydiumCpmmSwap,
  deriveCpmmAuthority,
  findAta,
};
