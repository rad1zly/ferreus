'use strict';

// Event-driven monitor: polls DEX programs for new transactions,
// identifies pool-creation events, decodes basic info, logs to DB.
//
// Programs monitored (verified working 2026-06-22 via getSignaturesForAddress):
//   Raydium CPMM, Raydium CLMM, Raydium AMM v4, Orca Whirlpool,
//   Meteora DAMM v2, Meteora DLMM
//
// Detection strategy (P0): poll signatures every POLL_INTERVAL_MS, fetch tx,
//   scan logs for "initialize"-ish patterns. Decode of pool address/token mints
//   deferred to P1 (decoder complexity).
//
// Rate-limit note (per snipetrench pattern #12 + 2026-06-22 testing):
// Public Solana RPC burst limit ~10 RPS. We process max 1 new sig per program
// per tick to stay under that ceiling.

const rpc = require('./solanaRpc');
const log = require('./logger');
const safety = require('./safety');

const PROGRAMS = {
  RAYDIUM_CPMM:  { name: 'raydium_cpmm',  address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' },
  RAYDIUM_CLMM:  { name: 'raydium_clmm',  address: 'CAMMCzo5YL8w4VFFXKVUciNRVvgM3hEGfG5J6YBZ4eK8' },
  RAYDIUM_AMM_V4:{ name: 'raydium_amm_v4',address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
  ORCA_WHIRL:    { name: 'orca_whirlpool',address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' },
  METEORA_DAMM:  { name: 'meteora_damm_v2',address: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' },
  METEORA_DLMM:  { name: 'meteora_dlmm',  address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' },
};

// Log patterns that suggest pool creation. Match is case-insensitive substring.
const CREATE_LOG_PATTERNS = [
  'initializepool',
  'initialize_pool',
  'initialize_pool2',
  'create_pool',
  'createpool',
  'initpool',
  'openposition',     // Orca position = new pool exposure
  'addliquidity',     // weak signal: could be add OR new
  'initializebin',    // Meteora bin
];

class NewPoolMonitor {
  constructor() {
    this.db = null;
    this.stmts = null;
    this.seenSignatures = new Map();
    this.cacheTtlMs = 3600000; // 1h
    this.running = false;
    this.timer = null;
    this.stats = {
      ticks: 0,
      sigsSeen: 0,
      createEvents: 0,
      errors: 0,
    };
    this.maxSigsPerProgramPerTick = 3; // Helius free tier: 50+ RPS OK, 3 sigs/tick = 24 RPC calls per tick
  }

  /**
   * Inject the database handle from index.js (avoids re-init per insert).
   */
  attachDb(database) {
    this.db = database.db || database;
    this.stmts = database.stmts || null;
  }

  matchCreatePattern(logs) {
    if (!Array.isArray(logs)) return { matched: false };
    const joined = logs.join('\n').toLowerCase();
    for (const pat of CREATE_LOG_PATTERNS) {
      if (joined.includes(pat)) {
        return { matched: true, pattern: pat };
      }
    }
    return { matched: false };
  }

  async processSignature(programKey, sig) {
    if (!this.stmts) {
      log.error('[new-pool] db not attached, call attachDb() first');
      return null;
    }
    if (this.seenSignatures.has(sig.signature)) return null;

    const tx = await rpc.getTransaction(sig.signature);
    if (!tx || !tx.meta) return null;

    const logs = tx.meta.logMessages || [];
    const match = this.matchCreatePattern(logs);

    // Cache regardless (avoid refetching on next poll cycle)
    this.seenSignatures.set(sig.signature, Date.now() + this.cacheTtlMs);

    if (!match.matched) return null;

    const program = PROGRAMS[programKey];
    const record = {
      signature: sig.signature,
      program: program.name,
      program_address: program.address,
      kind: 'pool_create',
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
      this.stats.createEvents += 1;
      log.info(`[new-pool] ${program.name} | pattern=${match.pattern} | sig=${sig.signature.slice(0, 16)}...`);
      return record;
    } catch (e) {
      log.error(`[new-pool] db insert failed: ${e.message}`);
      return null;
    }
  }

  async tick() {
    if (!safety.guardDetect('new-pool')) return;

    this.stats.ticks += 1;

    for (const [key, program] of Object.entries(PROGRAMS)) {
      try {
        const sigs = await rpc.getSignaturesForAddress(program.address, { limit: 5 });
        if (!sigs) {
          this.stats.errors += 1;
          continue;
        }
        this.stats.sigsSeen += sigs.length;

        let processed = 0;
        for (const sig of sigs) {
          if (sig.err) continue;
          if (this.seenSignatures.has(sig.signature)) continue;
          if (processed >= this.maxSigsPerProgramPerTick) break;
          await this.processSignature(key, sig);
          processed += 1;
        }
      } catch (e) {
        this.stats.errors += 1;
        log.warn(`[new-pool] ${program.name} poll failed: ${e.message}`);
      }
    }

    // Prune old cache entries
    const now = Date.now();
    for (const [k, exp] of this.seenSignatures) {
      if (exp < now) this.seenSignatures.delete(k);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const interval = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
    log.info(`[new-pool] monitor started — polling ${Object.keys(PROGRAMS).length} programs every ${interval}ms`);
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (e) { log.error(`[new-pool] tick error: ${e.message}`); }
      if (this.running) this.timer = setTimeout(loop, interval);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    log.info('[new-pool] monitor stopped');
  }

  getStats() {
    return { ...this.stats, programs: Object.keys(PROGRAMS).length };
  }
}

module.exports = new NewPoolMonitor();