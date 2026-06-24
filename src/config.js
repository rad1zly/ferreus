'use strict';

const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

/**
 * Decode a value. If prefixed with `B64:`, base64-decode first (per snipetrench
 * v0.2.0 pattern: B64 secrets avoid leakage in chat logs / IDE history).
 * Otherwise return the raw string. Returns defaultValue on missing/empty.
 */
function envString(key, defaultValue = null) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw.startsWith('B64:')) {
    try { return Buffer.from(raw.slice(4), 'base64').toString('utf8'); }
    catch { return defaultValue; }
  }
  return raw;
}

function envInt(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? defaultValue : n;
}

function envFloat(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

function envBool(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

module.exports = {
  ROOT,

  // Telegram
  TELEGRAM_BOT_TOKEN: envString('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: envString('TELEGRAM_CHAT_ID'),

  // Mode
  DRY_RUN: envBool('DRY_RUN', true),

  // Detector
  POLL_INTERVAL_MS: envInt('POLL_INTERVAL_MS', 5000),
  SCAN_BATCH_SIZE: envInt('SCAN_BATCH_SIZE', 5),
  DETECT_TOP_N: envInt('DETECT_TOP_N', 200),
  MIN_GAP_BPS: envInt('MIN_GAP_BPS', 50),
  MIN_TVL_USD: envInt('MIN_TVL_USD', 50000),
  TRADE_SIZE_USD: envInt('TRADE_SIZE_USD', 1000),
  TOKEN_LIST_REFRESH_MS: envInt('TOKEN_LIST_REFRESH_MS', 3600000),

  // Enabled detectors (comma-separated). Default: dex_dex only.
  // Options: dex_dex, new_pool, pumpfun, pool_watch, pool_arb
  ENABLED_DETECTORS: (process.env.ENABLED_DETECTORS || 'dex_dex')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Cross-DEX arb detector (Phase Pool-2)
  ARB_MIN_GAP_BPS: envInt('ARB_MIN_GAP_BPS', 30),        // 0.3% default
  ARB_COOLDOWN_MS: envInt('ARB_COOLDOWN_MS', 60000),     // 1 min per pair
  // Cross-DEX arb detector (Phase Pool-2)
  ARB_MIN_GAP_BPS: envInt('ARB_MIN_GAP_BPS', 30),        // 0.3% default (detection)
  ARB_COOLDOWN_MS: envInt('ARB_COOLDOWN_MS', 60000),     // 1 min per pair
  ARB_MIN_TVL_USD: envInt('ARB_MIN_TVL_USD', 0),         // 0 = disabled (no filter)
  // Trade size — primary is SOL (0.1 SOL = 100M lamports ≈ $7 at SOL=$71)
  ARB_TRADE_SIZE_SOL: envFloat('ARB_TRADE_SIZE_SOL', 0.1),
  ARB_TRADE_SIZE_USDC: envInt('ARB_TRADE_SIZE_USDC', 0),  // legacy, 0 = use SOL
  // Min profit thresholds (in SOL, since trade size is in SOL)
  ARB_MIN_PROFIT_SOL: envFloat('ARB_MIN_PROFIT_SOL', 0.00005),  // 0.00005 SOL ≈ 0.35¢
  ARB_MIN_PROFIT_USD: envInt('ARB_MIN_PROFIT_USD', 0),         // 0 = disabled
  ARB_MAX_SLIPPAGE_BPS: envInt('ARB_MAX_SLIPPAGE_BPS', 50),
  // Pool-3: direct 2-DEX quote (bypasses Jupiter smart router, captures AMM gap)
  ARB_USE_DIRECT_2DEX_ROUTE: envBool('ARB_USE_DIRECT_2DEX_ROUTE', true),
  // Pool-5: live execution
  LIVE_EXECUTE: envBool('LIVE_EXECUTE', false),
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || null,
  // Pool-3: execution-time gap filter (skip attempts on tiny AMM gaps that won't cover fees)
  ARB_MIN_GAP_BPS_FOR_EXEC: envInt('ARB_MIN_GAP_BPS_FOR_EXEC', 100),  // 1% default
  // Pool-3: per-arb execution cooldown (avoid double-fee on same opportunity)
  ARB_EXEC_COOLDOWN_MS: envInt('ARB_EXEC_COOLDOWN_MS', 10 * 60 * 1000),  // 10 min
  // Pool-5 atomic execution: use direct 2-DEX quote (force route via specific DEX)
  // instead of Jupiter smart router. Captures the actual AMM-level gap.
  ARB_USE_DIRECT_DEX: envBool('ARB_USE_DIRECT_DEX', true),

  // Pool subscription programs (CPU tuning)
  POOL_WATCH_CPMM_ENABLED: envBool('POOL_WATCH_CPMM_ENABLED', true),
  POOL_WATCH_CLMM_ENABLED: envBool('POOL_WATCH_CLMM_ENABLED', true),
  POOL_WATCH_WHIRLPOOL_ENABLED: envBool('POOL_WATCH_WHIRLPOOL_ENABLED', true),
  // DLMM/DAMM v2 — partial decoders, high error rate. Default OFF until full decoder.
  POOL_WATCH_DLMM_ENABLED: envBool('POOL_WATCH_DLMM_ENABLED', false),
  POOL_WATCH_DAMM_V2_ENABLED: envBool('POOL_WATCH_DAMM_V2_ENABLED', false),
  // Per-pool decode throttle (ms) — skip re-decode same pool within N ms
  POOL_DECODE_THROTTLE_MS: envInt('POOL_DECODE_THROTTLE_MS', 5000),
  // Error log sampling (1 in N errors logged to stdout)
  POOL_ERROR_LOG_SAMPLE: envInt('POOL_ERROR_LOG_SAMPLE', 100),
  // Stats log interval (ms) — default 60s to reduce log overhead
  POOL_STATS_INTERVAL_MS: envInt('POOL_STATS_INTERVAL_MS', 60000),
  // Max in-flight events (backpressure — drop new events if queue full)
  POOL_MAX_INFLIGHT: envInt('POOL_MAX_INFLIGHT', 2000),
  // Vault reader (Pool-2.5)
  VAULT_READER_ENABLED: envBool('VAULT_READER_ENABLED', true),
  VAULT_REFRESH_MS: envInt('VAULT_REFRESH_MS', 10000),
  VAULT_BATCH_SIZE: envInt('VAULT_BATCH_SIZE', 100),
  // Price oracle
  PRICE_REFRESH_MS: envInt('PRICE_REFRESH_MS', 3600000),
  // Jito bundle
  JITO_TIP_LAMPORTS: envInt('JITO_TIP_LAMPORTS', 10000),   // 0.00001 SOL default
  JITO_BLOCK_ENGINE_URL: envString('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf/api/v1/bundles'),
  PRIORITY_FEE_LAMPORTS: envInt('PRIORITY_FEE_LAMPORTS', 1000),  // 0.000001 SOL

  // Storage
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'ferreus.db'),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};
