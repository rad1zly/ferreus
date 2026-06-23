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
  // Options: dex_dex, new_pool, pumpfun
  ENABLED_DETECTORS: (process.env.ENABLED_DETECTORS || 'dex_dex')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Storage
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'ferreus.db'),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};
