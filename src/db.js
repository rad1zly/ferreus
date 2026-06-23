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

  // Idempotent migration — add P1 decode columns if they don't exist
  const cols = db.prepare("PRAGMA table_info(new_pools)").all();
  const colNames = new Set(cols.map(c => c.name));
  const addCol = (name, type) => {
    if (!colNames.has(name)) {
      db.exec(`ALTER TABLE new_pools ADD COLUMN ${name} ${type}`);
    }
  };
  addCol('decoded_at', 'INTEGER');
  addCol('instruction_type', 'TEXT');
  addCol('base_mint', 'TEXT');
  addCol('quote_mint', 'TEXT');
  addCol('base_amount', 'REAL');
  addCol('quote_amount', 'REAL');
  addCol('initial_price', 'REAL');
  addCol('deployer', 'TEXT');
  addCol('confidence', 'TEXT');
  addCol('ref_price_usd', 'REAL');
  addCol('gap_bps', 'REAL');
  addCol('decode_reason', 'TEXT');
  addCol('decode_attempts', 'INTEGER DEFAULT 0');
  if (!colNames.has('decoded')) {
    db.exec("ALTER TABLE new_pools ADD COLUMN decoded INTEGER DEFAULT 0");
  }
  if (!colNames.has('notified')) {
    db.exec("ALTER TABLE new_pools ADD COLUMN notified INTEGER DEFAULT 0");
  }
  if (!colNames.has('kind')) {
    db.exec("ALTER TABLE new_pools ADD COLUMN kind TEXT");
  }

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
      -- P1 decoded fields
      decoded INTEGER DEFAULT 0,             -- 1 if successfully decoded
      decoded_at INTEGER,
      instruction_type TEXT,                 -- 'initializePool2' / 'migrate' / etc
      base_mint TEXT,
      quote_mint TEXT,
      base_amount REAL,
      quote_amount REAL,
      initial_price REAL,                     -- quote per base, raw units
      deployer TEXT,
      confidence TEXT,                       -- 'high' / 'medium' / 'low'
      ref_price_usd REAL,                    -- reference USD price (quote per base)
      gap_bps REAL,                          -- (pool - ref) / ref * 10000
      decode_reason TEXT,                    -- null=not tried, 'no-pool-instruction'=false positive, etc
      decode_attempts INTEGER DEFAULT 0,
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

    -- Pool state (Pool-1: WSS subscription)
    -- Per pool account on-chain state. Updated on every WSS notification.
    -- Used by Phase Pool-2 (cross-DEX compare) to detect arb opportunities.
    CREATE TABLE IF NOT EXISTS pool_state (
      pubkey TEXT PRIMARY KEY,
      dex TEXT NOT NULL,
      mint_a TEXT NOT NULL,
      mint_b TEXT NOT NULL,
      vault_a TEXT,
      vault_b TEXT,
      decimals_a INTEGER,
      decimals_b INTEGER,
      reserve_a_native TEXT,
      reserve_b_native TEXT,
      tvl_usd REAL,
      price_native REAL,
      price_usd REAL,
      fee_bps INTEGER,
      lp_supply TEXT,
      sqrt_price_x64 TEXT,
      liquidity TEXT,
      tick_current INTEGER,
      bin_step INTEGER,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pool_state_pair ON pool_state(mint_a, mint_b);
    CREATE INDEX IF NOT EXISTS idx_pool_state_dex ON pool_state(dex);
    CREATE INDEX IF NOT EXISTS idx_pool_state_ts ON pool_state(ts);

    -- Arb candidates (Pool-2: cross-DEX gap detection)
    -- One row per logged opportunity. Same pair can have multiple rows over time
    -- (cooldown controls spam); use pair_key + ts for dedup.
    CREATE TABLE IF NOT EXISTS arb_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      pair_key TEXT NOT NULL,           -- sorted mint0:mint1
      mint0 TEXT NOT NULL,               -- smaller mint (lexicographic)
      mint1 TEXT NOT NULL,               -- larger mint
      cheap_dex TEXT NOT NULL,
      cheap_price REAL NOT NULL,         -- display price of mint1 in mint0
      cheap_pool TEXT NOT NULL,          -- pool pubkey
      expensive_dex TEXT NOT NULL,
      expensive_price REAL NOT NULL,
      expensive_pool TEXT NOT NULL,
      gap_bps REAL NOT NULL,
      notified INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_arb_candidates_ts ON arb_candidates(ts);
    CREATE INDEX IF NOT EXISTS idx_arb_candidates_pair ON arb_candidates(pair_key);
    CREATE INDEX IF NOT EXISTS idx_arb_candidates_gap ON arb_candidates(gap_bps);
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
        @ts, @token_mint, @token_symbol, @buy_dex, @sell_dex,
        @buy_price_usd, @sell_price_usd, @gap_bps,
        @buy_liquidity_usd, @sell_liquidity_usd, @min_liquidity_usd,
        @trade_size_usd, @est_gross_usd, @est_gas_usd, @est_net_usd, @raw_json
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
    updateNewPoolDecoded: db.prepare(`
      UPDATE new_pools SET
        decoded = @decoded,
        decoded_at = @decoded_at,
        instruction_type = @instruction_type,
        base_mint = @base_mint,
        quote_mint = @quote_mint,
        base_amount = @base_amount,
        quote_amount = @quote_amount,
        initial_price = @initial_price,
        deployer = @deployer,
        confidence = @confidence,
        ref_price_usd = @ref_price_usd,
        gap_bps = @gap_bps,
        decode_reason = @decode_reason,
        decode_attempts = decode_attempts + 1
      WHERE signature = @signature
    `),
    upsertPoolState: db.prepare(`
      INSERT INTO pool_state (
        pubkey, dex, mint_a, mint_b, vault_a, vault_b,
        decimals_a, decimals_b, reserve_a_native, reserve_b_native,
        tvl_usd, price_native, price_usd, fee_bps,
        lp_supply, sqrt_price_x64, liquidity, tick_current, bin_step, ts
      ) VALUES (
        @pubkey, @dex, @mint_a, @mint_b, @vault_a, @vault_b,
        @decimals_a, @decimals_b, @reserve_a_native, @reserve_b_native,
        @tvl_usd, @price_native, @price_usd, @fee_bps,
        @lp_supply, @sqrt_price_x64, @liquidity, @tick_current, @bin_step, @ts
      )
      ON CONFLICT(pubkey) DO UPDATE SET
        dex = excluded.dex,
        mint_a = excluded.mint_a,
        mint_b = excluded.mint_b,
        vault_a = excluded.vault_a,
        vault_b = excluded.vault_b,
        decimals_a = excluded.decimals_a,
        decimals_b = excluded.decimals_b,
        reserve_a_native = excluded.reserve_a_native,
        reserve_b_native = excluded.reserve_b_native,
        tvl_usd = excluded.tvl_usd,
        price_native = excluded.price_native,
        price_usd = excluded.price_usd,
        fee_bps = excluded.fee_bps,
        lp_supply = excluded.lp_supply,
        sqrt_price_x64 = excluded.sqrt_price_x64,
        liquidity = excluded.liquidity,
        tick_current = excluded.tick_current,
        bin_step = excluded.bin_step,
        ts = excluded.ts
    `),
    insertArbCandidate: db.prepare(`
      INSERT INTO arb_candidates (
        ts, pair_key, mint0, mint1,
        cheap_dex, cheap_price, cheap_pool,
        expensive_dex, expensive_price, expensive_pool,
        gap_bps
      ) VALUES (
        @ts, @pair_key, @mint0, @mint1,
        @cheap_dex, @cheap_price, @cheap_pool,
        @expensive_dex, @expensive_price, @expensive_pool,
        @gap_bps
      )
    `),
    countArbCandidates: db.prepare(`SELECT COUNT(*) AS c FROM arb_candidates`),
    recentArbCandidates: db.prepare(`SELECT * FROM arb_candidates ORDER BY ts DESC LIMIT ?`),
    countPoolState: db.prepare(`SELECT COUNT(*) AS c FROM pool_state`),
    countUndecoded: db.prepare(`
      SELECT COUNT(*) AS c FROM new_pools
      WHERE decoded = 0 AND decode_attempts < 3
    `),
    countArbLog: db.prepare(`SELECT COUNT(*) AS c FROM arb_log`),
    countNewPools: db.prepare(`SELECT COUNT(*) AS c FROM new_pools`),
    countNewPoolsByProgram: db.prepare(`SELECT program, COUNT(*) AS c FROM new_pools GROUP BY program`),
    recentNewPools: db.prepare(`SELECT * FROM new_pools ORDER BY detected_at DESC LIMIT ?`),
  };

  return { db, stmts };
}

module.exports = { init };