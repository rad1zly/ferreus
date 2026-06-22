'use strict';

// Pumpfun migration monitor. Per @uyar121 thread:
// "hunting arbitrage dari token baru (misal migrasi dari Pumpfun dan add new liq
//  di Meteora)" — these are the highest-alpha events.
// Pumpfun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//
// P0 strategy: poll signatures on Pumpfun program, filter logs for "migrate"
//   pattern (Raydium AMM v4 migration, Pump.fun's graduation event).
//   Token mint + new pool address extracted in P1 (decoder complexity).

const rpc = require('./solanaRpc');
const log = require('./logger');
const safety = require('./safety');

const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPFUN_AMM_MIGRATE = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjB3kmG9wbUY6';

const MIGRATION_LOG_PATTERNS = [
  'migrate',         // Pumpfun graduation
  'graduated',       // sometimes "Pool graduated"
  'migrate_pool',
  'raydiummigrate',  // Pumpfun's specific log
  'migratetoamm',
];

class PumpfunMonitor {
  constructor() {
    this.db = null;
    this.stmts = null;
    this.seenSignatures = new Map();
    this.cacheTtlMs = 3600000;
    this.running = false;
    this.timer = null;
    this.stats = {
      ticks: 0,
      sigsSeen: 0,
      migrationEvents: 0,
      errors: 0,
    };
    this.maxSigsPerProgramPerTick = 1;
  }

  attachDb(database) {
    this.db = database.db || database;
    this.stmts = database.stmts || null;
  }

  matchMigration(logs) {
    if (!Array.isArray(logs)) return { matched: false };
    const joined = logs.join('\n').toLowerCase();
    for (const pat of MIGRATION_LOG_PATTERNS) {
      if (joined.includes(pat)) return { matched: true, pattern: pat };
    }
    return { matched: false };
  }

  async processSignature(sig) {
    if (!this.stmts) {
      log.error('[pumpfun] db not attached, call attachDb() first');
      return null;
    }
    if (this.seenSignatures.has(sig.signature)) return null;
    const tx = await rpc.getTransaction(sig.signature);
    if (!tx || !tx.meta) return null;

    const logs = tx.meta.logMessages || [];
    const match = this.matchMigration(logs);

    this.seenSignatures.set(sig.signature, Date.now() + this.cacheTtlMs);

    if (!match.matched) return null;

    const record = {
      signature: sig.signature,
      program: 'pumpfun',
      program_address: PUMPFUN_PROGRAM,
      kind: 'pumpfun_migration',
      pattern: match.pattern,
      slot: sig.slot,
      block_time: sig.blockTime,
      err: sig.err ? JSON.stringify(sig.err) : null,
      fee: tx.meta.fee,
      log_count: logs.length,
      detected_at: Date.now(),
    };

    try {
      this.stmts.insertNewPool.run(record);
      this.stats.migrationEvents += 1;
      log.info(`[pumpfun] migration | pattern=${match.pattern} | sig=${sig.signature.slice(0, 16)}...`);
      return record;
    } catch (e) {
      log.error(`[pumpfun] db insert failed: ${e.message}`);
      return null;
    }
  }

  async tick() {
    if (!safety.guardDetect('pumpfun')) return;
    this.stats.ticks += 1;

    for (const programAddr of [PUMPFUN_PROGRAM, PUMPFUN_AMM_MIGRATE]) {
      try {
        const sigs = await rpc.getSignaturesForAddress(programAddr, { limit: 5 });
        if (!sigs) { this.stats.errors += 1; continue; }
        this.stats.sigsSeen += sigs.length;

        let processed = 0;
        for (const sig of sigs) {
          if (sig.err) continue;
          if (this.seenSignatures.has(sig.signature)) continue;
          if (processed >= this.maxSigsPerProgramPerTick) break;
          await this.processSignature(sig);
          processed += 1;
        }
      } catch (e) {
        this.stats.errors += 1;
        log.warn(`[pumpfun] poll failed: ${e.message}`);
      }
    }

    const now = Date.now();
    for (const [k, exp] of this.seenSignatures) {
      if (exp < now) this.seenSignatures.delete(k);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const interval = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
    log.info(`[pumpfun] migration monitor started — polling every ${interval}ms`);
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (e) { log.error(`[pumpfun] tick error: ${e.message}`); }
      if (this.running) this.timer = setTimeout(loop, interval);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    log.info('[pumpfun] migration monitor stopped');
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new PumpfunMonitor();