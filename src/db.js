'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * Initialize SQLite + schema. Idempotent — re-running is a no-op
 * (per snipetrench pattern #7: migrations are idempotent).
 */
function init() {
  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS arb_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      buy_dex TEXT NOT NULL,
      sell_dex TEXT NOT NULL,
      buy_price_usd REAL NOT NULL,
      sell_price_usd REAL NOT NULL,
      gap_bps REAL NOT NULL,
      buy_liquidity_usd REAL,
      sell_liquidity_usd REAL,
      min_liquidity_usd REAL,
      trade_size_usd REAL,
      est_gross_usd REAL,
      est_gas_usd REAL,
      est_net_usd REAL,
      raw_json TEXT,
      notified INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_arb_log_ts ON arb_log(ts);
    CREATE INDEX IF NOT EXISTS idx_arb_log_mint ON arb_log(token_mint);
    CREATE INDEX IF NOT EXISTS idx_arb_log_gap ON arb_log(gap_bps);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_stats (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
  `);

  return db;
}

module.exports = { init };
