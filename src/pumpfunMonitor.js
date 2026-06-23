'use strict';

// Pumpfun migration monitor — polls Pumpfun program for sigs. Real migrations
// are complex multi-CPI txs (Pumpfun → Raydium/CLMM/DAMM); they don't have a
// single 'migrate' instruction. The decoder worker uses transaction analysis
// to identify real migrations.

const rpc = require('./solanaRpc');
const log = require('./logger');

const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPFUN_AMM_MIGRATE = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjB3kmG9wbUY6';

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
      sigsInserted: 0,
      errors: 0,
    };
    this.sigsPerProgramPerTick = 3;
  }

  attachDb(database) {
    this.db = database.db || database;
    this.stmts = database.stmts || null;
  }

  insertCandidate(programAddr, sig) {
    if (this.seenSignatures.has(sig.signature)) return false;
    if (!this.stmts) return false;

    this.seenSignatures.set(sig.signature, Date.now() + this.cacheTtlMs);

    try {
      const result = this.stmts.insertNewPool.run({
        signature: sig.signature,
        program: 'pumpfun',
        program_address: programAddr,
        kind: 'pumpfun_candidate',
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
      if (e.message.includes('UNIQUE')) return false;
      log.error(`[pumpfun] insert failed: ${e.message}`);
      this.stats.errors += 1;
      return false;
    }
  }

  async tick() {
    if (!this.stmts) return;
    this.stats.ticks += 1;

    for (const programAddr of [PUMPFUN_PROGRAM, PUMPFUN_AMM_MIGRATE]) {
      try {
        const sigs = await rpc.getSignaturesForAddress(programAddr, { limit: this.sigsPerProgramPerTick });
        if (!sigs) { this.stats.errors += 1; continue; }
        this.stats.sigsSeen += sigs.length;

        for (const sig of sigs) {
          if (sig.err) continue;
          this.insertCandidate(programAddr, sig);
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
    log.info(`[pumpfun] monitor started — collecting sigs every ${interval}ms (decoder worker filters for real migrations)`);
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
    log.info('[pumpfun] monitor stopped');
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new PumpfunMonitor();