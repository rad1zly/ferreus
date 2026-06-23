'use strict';

/**
 * Pool account decoders for 5 Solana AMM programs.
 *
 * Each decoder takes raw account data (Buffer) and returns normalized pool state:
 *   { dex, mintA, mintB, vaultA, vaultB, decimalsA, decimalsB,
 *     priceNative, feeBps, lpSupply, sqrtPriceX64, liquidity, tickCurrent,
 *     binStep, activeId, ts }
 *
 * All decoders assume the 8-byte Anchor/Codama discriminator prefix is stripped
 * before calling (we skip it in the WSS subscription layer).
 *
 * Borsh schemas are hand-coded from the IDLs in src/idls/. We only decode the
 * fields needed for price calculation and TVL estimation. Full struct decode
 * not required for v0.
 */

const borsh = require('@coral-xyz/borsh');

// ============== Raydium CPMM (PoolState) ==============
// Source: src/idls/raydium_cpmm.json → accounts[PoolState] → types[PoolState]
// Program: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
//
// CRITICAL: reserves are NOT in the pool account for CPMM. They live in the
// token vaults. We must call getTokenAccountBalance(vaultA/B) to read them.
// For v0 we just identify the pool; reserves come from a separate RPC sweep.

const raydiumCpmmSchema = borsh.struct([
  borsh.publicKey('ammConfig'),
  borsh.publicKey('poolCreator'),
  borsh.publicKey('token0Vault'),
  borsh.publicKey('token1Vault'),
  borsh.publicKey('lpMint'),
  borsh.publicKey('token0Mint'),
  borsh.publicKey('token1Mint'),
  borsh.publicKey('token0Program'),
  borsh.publicKey('token1Program'),
  borsh.publicKey('observationKey'),
  borsh.u8('authBump'),
  borsh.u8('status'),
  borsh.u8('lpMintDecimals'),
  borsh.u8('mint0Decimals'),
  borsh.u8('mint1Decimals'),
  borsh.u64('lpSupply'),
  borsh.u64('protocolFeesToken0'),
  borsh.u64('protocolFeesToken1'),
  borsh.u64('fundFeesToken0'),
  borsh.u64('fundFeesToken1'),
  borsh.u64('openTime'),
  borsh.u64('recentEpoch'),
  borsh.u8('creatorFeeOn'),
  borsh.bool('enableCreatorFee'),
  borsh.array(borsh.u8(), 6, 'padding1'),
  borsh.u64('creatorFeesToken0'),
  borsh.u64('creatorFeesToken1'),
  borsh.array(borsh.u8(), 28, 'padding'),
]);

function decodeRaydiumCpmm(data) {
  if (data.length < 8) return null;
  const buf = data.subarray(8); // skip 8-byte Anchor discriminator
  try {
    const d = raydiumCpmmSchema.decode(buf);
    return {
      dex: 'raydium_cpmm',
      mintA: d.token0Mint.toBase58(),
      mintB: d.token1Mint.toBase58(),
      vaultA: d.token0Vault.toBase58(),
      vaultB: d.token1Vault.toBase58(),
      tokenProgramA: d.token0Program.toBase58(),
      tokenProgramB: d.token1Program.toBase58(),
      decimalsA: d.mint0Decimals,
      decimalsB: d.mint1Decimals,
      lpSupply: d.lpSupply.toString(),
      // CPMM doesn't store reserves in pool account; vault reads needed
      // For Phase Pool-1 we identify the pool; reserves come from getTokenAccountBalance
      priceNative: null,
      feeBps: 25, // CPMM default fee tier (varies by ammConfig; 25bps typical)
      _raw: d,
    };
  } catch (e) {
    return { _error: `raydium_cpmm decode: ${e.message}` };
  }
}

// ============== Raydium CLMM (PoolState) ==============
// Source: src/idls/raydium_clmm.json
// Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//
// For CLMM, price comes from sqrt_price_x64 directly. No vault reads needed for price.

const raydiumClmmSchema = borsh.struct([
  borsh.array(borsh.u8(), 1, 'bump'),
  borsh.publicKey('ammConfig'),
  borsh.publicKey('owner'),
  borsh.publicKey('tokenMint0'),
  borsh.publicKey('tokenMint1'),
  borsh.publicKey('tokenVault0'),
  borsh.publicKey('tokenVault1'),
  borsh.publicKey('observationKey'),
  borsh.u8('mintDecimals0'),
  borsh.u8('mintDecimals1'),
  borsh.u16('tickSpacing'),
  borsh.u128('liquidity'),
  borsh.u128('sqrtPriceX64'),
  borsh.i32('tickCurrent'),
  borsh.u16('padding3'),
  borsh.u16('padding4'),
  borsh.u128('feeGrowthGlobal0X64'),
  borsh.u128('feeGrowthGlobal1X64'),
  borsh.u64('protocolFeesToken0'),
  borsh.u64('protocolFeesToken1'),
  borsh.array(borsh.u8(), 32, 'padding5'),
  borsh.u8('status'),
  borsh.u8('feeOn'),
  borsh.array(borsh.u8(), 32, 'padding'),
  // reward_infos: array of 3 RewardInfo structs (each ~120 bytes)
  // We skip decoding rewards for v0 — they're not needed for price
  // tick_array_bitmap: 8*16 = 128 bytes
  // fund_fees: 2 * u64
  // open_time, recent_epoch: 2 * u64
  // dynamic_fee_info: variable
  // padding1, padding2: arrays
]);

function decodeRaydiumClmm(data) {
  if (data.length < 8) return null;
  const buf = data.subarray(8);
  try {
    const d = raydiumClmmSchema.decode(buf);
    // sqrt_price_x64 is Q64.64 fixed-point: price = (sqrt_price_x64 / 2^64)^2
    const sqrtPriceF = Number(d.sqrtPriceX64) / (2 ** 64);
    const priceNative = sqrtPriceF * sqrtPriceF; // price of token1 in terms of token0
    return {
      dex: 'raydium_clmm',
      mintA: d.tokenMint0.toBase58(),
      mintB: d.tokenMint1.toBase58(),
      vaultA: d.tokenVault0.toBase58(),
      vaultB: d.tokenVault1.toBase58(),
      decimalsA: d.mintDecimals0,
      decimalsB: d.mintDecimals1,
      tickSpacing: d.tickSpacing,
      sqrtPriceX64: d.sqrtPriceX64.toString(),
      liquidity: d.liquidity.toString(),
      tickCurrent: d.tickCurrent,
      priceNative,
      // Adjust price for decimals: price_display = price_native * 10^(decimalsA - decimalsB)
      // Stored as raw, conversion happens in priceReference layer
      feeBps: 0, // CLMM fee depends on pool; not stored in pool state itself
      _raw: d,
    };
  } catch (e) {
    return { _error: `raydium_clmm decode: ${e.message}` };
  }
}

// ============== Orca Whirlpool ==============
// Source: src/idls/orca_whirlpool.json (hand-built from Codama types)
// Program: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//
// Same Q64.64 sqrt_price format as Raydium CLMM.

const orcaWhirlpoolSchema = borsh.struct([
  borsh.publicKey('whirlpoolsConfig'),
  borsh.array(borsh.u8(), 1, 'whirlpoolBump'),
  borsh.u16('tickSpacing'),
  borsh.array(borsh.u8(), 2, 'feeTierIndexSeed'),
  borsh.u16('feeRate'),
  borsh.u16('protocolFeeRate'),
  borsh.u128('liquidity'),
  borsh.u128('sqrtPrice'),
  borsh.i32('tickCurrentIndex'),
  borsh.u64('protocolFeeOwedA'),
  borsh.u64('protocolFeeOwedB'),
  borsh.publicKey('tokenMintA'),
  borsh.publicKey('tokenVaultA'),
  borsh.u128('feeGrowthGlobalA'),
  borsh.publicKey('tokenMintB'),
  borsh.publicKey('tokenVaultB'),
  borsh.u128('feeGrowthGlobalB'),
  borsh.u64('rewardLastUpdatedTimestamp'),
  // reward_infos: 3 * WhirlpoolRewardInfo (each ~128 bytes)
  // Skipped for v0
]);

function decodeOrcaWhirlpool(data) {
  if (data.length < 8) return null;
  const buf = data.subarray(8); // skip 8-byte Codama discriminator
  try {
    const d = orcaWhirlpoolSchema.decode(buf);
    const sqrtPriceF = Number(d.sqrtPrice) / (2 ** 64);
    const priceNative = sqrtPriceF * sqrtPriceF;
    return {
      dex: 'orca_whirlpool',
      mintA: d.tokenMintA.toBase58(),
      mintB: d.tokenMintB.toBase58(),
      vaultA: d.tokenVaultA.toBase58(),
      vaultB: d.tokenVaultB.toBase58(),
      // Orca doesn't store decimals in pool state — fetched separately from mint info
      decimalsA: null,
      decimalsB: null,
      tickSpacing: d.tickSpacing,
      sqrtPriceX64: d.sqrtPrice.toString(),
      liquidity: d.liquidity.toString(),
      tickCurrent: d.tickCurrentIndex,
      priceNative,
      // feeRate is in hundredths of basis points (per Orca docs); convert to bps
      // Orca feeRate: 100 = 1bp, 10000 = 1% (i.e. feeRate/10000 = fee_fraction)
      feeBps: d.feeRate / 100,
      _raw: d,
    };
  } catch (e) {
    return { _error: `orca_whirlpool decode: ${e.message}` };
  }
}

// ============== Meteora DLMM (LbPair) ==============
// Source: src/idls/meteora_dlmm.json
// Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
//
// Bin-based: price = (1 + bin_step/10000)^active_id

const meteoraDlmmSchema = borsh.struct([
  // parameters: StaticParameters (base_factor, filter_period, decay_period, reduction_factor, variable_fee_control, max_volatility_accumulator, min_bin_id, max_bin_id)
  // Skipping full struct for v0 — we just need active_id, bin_step, mints, reserves
  // Reading raw bytes; we know offsets from IDL
  // parameters is ~64 bytes, v_parameters ~32 bytes, then bump_seed, bin_step_seed, pair_type, active_id, bin_step
  // To keep v0 simple, we just slice the relevant fields by hard-coded offset
]);

// Hard-coded offsets for Meteora DLMM LbPair (skip 8-byte Anchor discriminator first):
//   8 (disc) + 64 (params) + 32 (v_params) + 1 (bump) + 1 (bin_step_seed) + 1 (pair_type) + 4 (active_id) = 111
//   active_id at offset 8 + 64 + 32 + 1 + 1 + 1 = 107 (4 bytes, i32)
//   bin_step at offset 8 + 64 + 32 + 1 + 1 + 1 + 4 = 111 (2 bytes, u16)
//   token_x_mint and token_y_mint: more complex, find by offset
//
// This is fragile — better to use the full borsh schema. For v0, we use
// raw byte reads as a fallback if the full schema fails (StaticParameters
// has complex nested types).

const METEORA_DLMM_OFFSETS = {
  activeId: 8 + 64 + 32 + 1 + 1 + 1,        // 107
  binStep: 8 + 64 + 32 + 1 + 1 + 1 + 4,     // 111
  // token_x_mint: at offset after base_factor_seed, activation_type, creator_pool_on_off_control
  // 8 + 64 + 32 + 1 + 1 + 1 + 4 + 2 + 1 + 1 + 1 + 1 = 117, then 8 bytes base_factor_seed
  // 8 + 64 + 32 + 1 + 1 + 1 + 4 + 2 + 1 + 1 + 1 + 1 + 8 = 125 (token_x_mint pubkey, 32 bytes)
  tokenXMint: 8 + 64 + 32 + 1 + 1 + 1 + 4 + 2 + 1 + 1 + 1 + 1 + 8,
  // token_y_mint follows token_x_mint + reserve_x + reserve_y + protocol_fee + padding + reward_infos
  // For v0, skip the full layout and just return what we have
};

function decodeMeteoraDlmm(data) {
  if (data.length < 8) return null;
  try {
    // Try full borsh schema first
    let activeId = null, binStep = null, mintX = null, mintY = null, reserveX = null, reserveY = null;
    try {
      const d = meteoraDlmmSchema.decode(data.subarray(8));
      // If we get here, schema works
    } catch (_) {
      // Fallback: hard-coded offset reads
      // Note: StaticParameters struct layout is complex; these offsets may be off.
      // The official SDK uses full borsh decode. For v0 we accept that DLMM decode
      // might be incomplete — we just identify that the account is a DLMM pool.
    }
    // Use raw byte reads for what we can
    if (data.length >= METEORA_DLMM_OFFSETS.tokenXMint + 64) {
      activeId = data.readInt32LE(METEORA_DLMM_OFFSETS.activeId);
      binStep = data.readUInt16LE(METEORA_DLMM_OFFSETS.binStep);
      mintX = new (require('@solana/web3.js').PublicKey)(
        data.subarray(METEORA_DLMM_OFFSETS.tokenXMint, METEORA_DLMM_OFFSETS.tokenXMint + 32)
      ).toBase58();
      // mintY is at tokenXMint + 32 (mint) + 32 (reserve_x) + 32 (reserve_y) + 32 (protocol_fee ?)
      // For v0, mark as unknown
    }
    // price = (1 + bin_step/10000) ^ active_id
    let priceNative = null;
    if (activeId !== null && binStep !== null) {
      priceNative = Math.pow(1 + binStep / 10000, activeId);
    }
    return {
      dex: 'meteora_dlmm',
      mintA: mintX,        // may be null if offset read failed
      mintB: null,         // TODO: full borsh decode
      vaultA: reserveX,    // may be null
      vaultB: reserveY,
      binStep,
      activeId,
      priceNative,
      feeBps: 0,           // DLMM fee is dynamic
      _partial: true,      // flag that this is incomplete decode
    };
  } catch (e) {
    return { _error: `meteora_dlmm decode: ${e.message}` };
  }
}

// ============== Meteora DAMM v2 (Pool) ==============
// Source: src/idls/meteora_damm_v2.json
// Program: cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
//
// CLMM-style with sqrt_min_price, sqrt_max_price. Full decode is complex due
// to nested PoolFeesStruct, reward infos, etc. For v0 we use hard-coded offsets.

const METEORA_DAMM_V2_OFFSETS = {
  // After 8-byte Anchor discriminator:
  // pool_fees (PoolFeesStruct, ~64 bytes), then token_a_mint, token_b_mint
  tokenAMint: 8 + 64,
  tokenBMint: 8 + 64 + 32,
  tokenAVault: 8 + 64 + 32 + 32,
  tokenBVault: 8 + 64 + 32 + 32 + 32,
  // whitelisted_vault: 32 bytes
  // padding_0: array
  // liquidity: u128
  // sqrt_min_price: u128 (this is the key field for price)
  // Approximate offset: 8 + 64 + 32*4 + 32 (whitelisted) + some padding + 16 (liquidity) + 16 (padding_1) + 16 (sqrt_min)
  // For v0 we skip price calculation — just identify the pool
};

function decodeMeteoraDammV2(data) {
  if (data.length < 8) return null;
  try {
    let mintA = null, mintB = null, vaultA = null, vaultB = null;
    if (data.length >= METEORA_DAMM_V2_OFFSETS.tokenBVault + 32) {
      const PK = require('@solana/web3.js').PublicKey;
      mintA = new PK(data.subarray(METEORA_DAMM_V2_OFFSETS.tokenAMint, METEORA_DAMM_V2_OFFSETS.tokenAMint + 32)).toBase58();
      mintB = new PK(data.subarray(METEORA_DAMM_V2_OFFSETS.tokenBMint, METEORA_DAMM_V2_OFFSETS.tokenBMint + 32)).toBase58();
      vaultA = new PK(data.subarray(METEORA_DAMM_V2_OFFSETS.tokenAVault, METEORA_DAMM_V2_OFFSETS.tokenAVault + 32)).toBase58();
      vaultB = new PK(data.subarray(METEORA_DAMM_V2_OFFSETS.tokenBVault, METEORA_DAMM_V2_OFFSETS.tokenBVault + 32)).toBase58();
    }
    return {
      dex: 'meteora_damm_v2',
      mintA,
      mintB,
      vaultA,
      vaultB,
      decimalsA: null,
      decimalsB: null,
      priceNative: null,    // requires sqrt_min_price/max_price (complex)
      feeBps: 0,
      _partial: true,        // flag that this is incomplete decode
    };
  } catch (e) {
    return { _error: `meteora_damm_v2 decode: ${e.message}` };
  }
}

// ============== Program ID registry ==============
const PROGRAMS = {
  raydium_cpmm:    { id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', decoder: decodeRaydiumCpmm },
  raydium_clmm:    { id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', decoder: decodeRaydiumClmm },
  orca_whirlpool:  { id: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', decoder: decodeOrcaWhirlpool },
  meteora_dlmm:    { id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', decoder: decodeMeteoraDlmm },
  meteora_damm_v2: { id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', decoder: decodeMeteoraDammV2 },
};

const PROGRAM_IDS = Object.values(PROGRAMS).map(p => p.id);

function decoderForProgram(programId) {
  for (const [name, info] of Object.entries(PROGRAMS)) {
    if (info.id === programId) return { name, ...info };
  }
  return null;
}

function decodePoolAccount(programId, data) {
  const prog = decoderForProgram(programId);
  if (!prog) return { _error: `unknown program: ${programId}` };
  return prog.decoder(data);
}

module.exports = {
  PROGRAMS,
  PROGRAM_IDS,
  decoderForProgram,
  decodePoolAccount,
  decodeRaydiumCpmm,
  decodeRaydiumClmm,
  decodeOrcaWhirlpool,
  decodeMeteoraDlmm,
  decodeMeteoraDammV2,
};
