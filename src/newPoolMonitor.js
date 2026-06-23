'use strict';

// Event-driven monitor: polls DEX programs for new signatures, fetches
// transactions, inserts them into DB. P1 decoder (separate worker) decides
// whether each tx is a real new-pool creation or a false positive.

const rpc = require('./solanaRpc');
const log = require('./logger');

const PROGRAMS = {
  RAYDIUM_CPMM:  { name: 'raydium_cpmm',  address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' },
  RAYDIUM_CLMM:  { name: 'raydium_clmm',  address: 'CAMMCzo5YL8w4VFFXKVUciNRVvgM3hEGfG5J6YBZ4eK8' },
  RAYDIUM_AMM_V4:{ name: 'raydium_amm_v4',address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' },
  ORCA_WHIRL:    { name: 'orca_whirlpool',address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' },
  METEORA_DAMM:  { name: 'meteora_damm_v2',address: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' },
  METEORA_DLMM:  { name: 'meteora_dlmm',  address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' },
  // Launchpads (high-signal for new pool creation):
  RAYDIUM_LAUNCHPAD:  { name: 'raydium_launchpad',  address: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj' },
  METEORA_DBC:        { name: 'meteora_dbc',        address: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' },
  MOONSHOT:           { name: 'moonshot',           address: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG' },
};

class NewPoolMonitor {
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
      sigsInserted: 0,
      errors: 0,
    };
    // Each sig = 1 getSignaturesForAddress + 1 getTransaction = 2 RPC calls.
    // 6 programs × 1 sig = 6 calls per tick. At 20s = 0.3 RPS — well under Helius 10 RPS.
    this.sigsPerProgramPerTick = 1;
  }

  attachDb(database) {
    this.db = database.db || database;
    this.stmts = database.stmts || null;
  }

  /**
   * Insert a candidate signature into DB. The decoder worker will pick it
   * up and decide if it's a real new-pool event.
   */
  insertCandidate(programKey, sig) {
    if (this.seenSignatures.has(sig.signature)) return false;
    if (!this.stmts) return false;

    this.seenSignatures.set(sig.signature, Date.now() + this.cacheTtlMs);

    try {
      const program = PROGRAMS[programKey];
      const result = this.stmts.insertNewPool.run({
        signature: sig.signature,
        program: program.name,
        program_address: program.address,
        kind: 'candidate', // decoder will update to 'pool_create' or 'false_positive'
        pattern: null,
        slot: sig.slot,
        block_time: sig.blockTime,
        err: sig.err ? JSON.stringify(sig.err) : null,
        fee: null,
        log_count: null,
        detected_at: Date.now(),
      });
      this.stats.sigsInserted += 1;
      return result.changes > 0;
    } catch (e) {
      // UNIQUE constraint = already in DB, that's fine
      if (e.message.includes('UNIQUE')) return false;
      log.error(`[new-pool] insert failed: ${e.message}`);
      this.stats.errors += 1;
      return false;
    }
  }

  async tick() {
    if (!this.stmts) return;
    this.stats.ticks += 1;

    for (const [key, program] of Object.entries(PROGRAMS)) {
      try {
        const sigs = await rpc.getSignaturesForAddress(program.address, { limit: this.sigsPerProgramPerTick });
        if (!sigs) {
          this.stats.errors += 1;
          continue;
        }
        this.stats.sigsSeen += sigs.length;

        for (const sig of sigs) {
          if (sig.err) continue; // skip failed txs
          this.insertCandidate(key, sig);
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
    const interval = parseInt(process.env.POLL_INTERVAL_MS || '20000', 10);
    log.info(`[new-pool] monitor started — collecting all sigs from ${Object.keys(PROGRAMS).length} programs every ${interval}ms (decoder worker filters for real pools)`);
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