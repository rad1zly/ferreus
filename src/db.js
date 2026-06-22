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

    -- New-pool events (Detector B + Pumpfun monitor)
    CREATE TABLE IF NOT EXISTS new_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      program TEXT NOT NULL,
      program_address TEXT NOT NULL,
      kind TEXT,                              -- 'pool_create' | 'pumpfun_migration' (nullable for legacy rows)
      pattern TEXT,
      slot INTEGER,
      block_time INTEGER,
      err TEXT,
      fee INTEGER,
      log_count INTEGER,
      detected_at INTEGER NOT NULL,
      -- P1 will add: pool_address, base_mint, quote_mint, deployer, initial_liquidity
      decoded INTEGER DEFAULT 0,
      evaluated INTEGER DEFAULT 0,
      notified INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_new_pools_ts ON new_pools(detected_at);
    CREATE INDEX IF NOT EXISTS idx_new_pools_program ON new_pools(program);
    CREATE INDEX IF NOT EXISTS idx_new_pools_kind ON new_pools(kind);

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

  // Prepared statements (per snipetrench pattern — pre-compile for speed)
  const stmts = {
    insertArbLog: db.prepare(`
      INSERT INTO arb_log (
        ts, token_mint, token_symbol, buy_dex, sell_dex,
        buy_price_usd, sell_price_usd, gap_bps,
        buy_liquidity_usd, sell_liquidity_usd, min_liquidity_usd,
        trade_size_usd, est_gross_usd, est_gas_usd, est_net_usd, raw_json
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `),
    insertNewPool: db.prepare(`
      INSERT OR IGNORE INTO new_pools (
        signature, program, program_address, kind, pattern,
        slot, block_time, err, fee, log_count, detected_at
      ) VALUES (
        @signature, @program, @program_address, @kind, @pattern,
        @slot, @block_time, @err, @fee, @log_count, @detected_at
      )
    `),
    countArbLog: db.prepare(`SELECT COUNT(*) AS c FROM arb_log`),
    countNewPools: db.prepare(`SELECT COUNT(*) AS c FROM new_pools`),
    countNewPoolsByProgram: db.prepare(`SELECT program, COUNT(*) AS c FROM new_pools GROUP BY program`),
    recentNewPools: db.prepare(`SELECT * FROM new_pools ORDER BY detected_at DESC LIMIT ?`),
  };

  return { db, stmts };
}

module.exports = { init };