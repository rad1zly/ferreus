'use strict';

// Decoder worker — picks up undecoded new_pools rows, runs decoder + price oracle,
// updates DB with decoded data + reference price + gap. Marks false positives.

const log = require('./logger');
const decoder = require('./decoder');
const priceOracle = require('./priceOracle');

class DecoderWorker {
  constructor() {
    this.db = null;
    this.stmts = null;
    this.running = false;
    this.timer = null;
    this.stats = {
      ticks: 0,
      decoded: 0,
      falsePositives: 0,
      errors: 0,
      opportunitiesLogged: 0,
    };
    this.minGapBps = parseInt(process.env.MIN_GAP_BPS || '50', 10);
    this.batchSize = 5;
  }

  attachDb(database) {
    this.db = database.db || database;
    this.stmts = database.stmts || null;
  }

  /**
   * Decode a single new_pools row. Returns true if processed.
   */
  async processRow(row) {
    try {
      const result = await decoder.decodeNewPool(row.signature);

      if (!result.decoded) {
        this.stmts.updateNewPoolDecoded.run({
          signature: row.signature,
          decoded: 0,
          decoded_at: Date.now(),
          instruction_type: null,
          base_mint: null,
          quote_mint: null,
          base_amount: 0,
          quote_amount: 0,
          initial_price: null,
          deployer: null,
          confidence: 'low',
          ref_price_usd: null,
          gap_bps: null,
          decode_reason: result.reason || 'unknown',
        });
        this.stats.falsePositives += 1;
        return false;
      }

      // Real pool creation detected. Compute reference price.
      let refPriceUsd = null;
      let gapBps = null;
      const poolPrice = result.initialPrice;
      if (poolPrice != null && result.baseMint && result.quoteMint) {
        try {
          const oracle = await priceOracle.computeArbGap({
            poolPrice,
            baseMint: result.baseMint,
            quoteMint: result.quoteMint,
          });
          if (oracle.gapBps != null) {
            gapBps = oracle.gapBps;
            refPriceUsd = oracle.refPrice;
          }
        } catch (e) {
          log.warn(`[decoder-worker] oracle failed: ${e.message}`);
        }
      }

      this.stmts.updateNewPoolDecoded.run({
        signature: row.signature,
        decoded: 1,
        decoded_at: Date.now(),
        instruction_type: result.instructionType,
        base_mint: result.baseMint,
        quote_mint: result.quoteMint,
        base_amount: result.baseAmount,
        quote_amount: result.quoteAmount,
        initial_price: result.initialPrice,
        deployer: result.deployer,
        confidence: result.confidence || 'medium',
        ref_price_usd: refPriceUsd,
        gap_bps: gapBps,
        decode_reason: null,
      });

      this.stats.decoded += 1;
      log.info(
        `[decoder] ${result.kind} | ${result.instructionType} | ` +
        `base=${(result.baseMint || '?').slice(0, 8)}... ` +
        `gap=${gapBps != null ? gapBps.toFixed(1) + 'bps' : 'n/a'}`
      );

      // If gap is interesting, also log to arb_log
      if (gapBps != null && Math.abs(gapBps) >= this.minGapBps) {
        await this.logOpportunity({ ...result, gapBps, refPriceUsd });
      }

      return true;
    } catch (e) {
      log.error(`[decoder-worker] processRow failed: ${e.message}`);
      this.stats.errors += 1;
      return false;
    }
  }

  async logOpportunity(d) {
    try {
      const estNetUsd = Math.abs(d.gapBps) * 0.01; // rough estimate
      this.stmts.insertArbLog.run({
        ts: Date.now(),
        token_mint: d.baseMint || 'unknown',
        token_symbol: (d.baseMint || '').slice(0, 8) + '...',
        buy_dex: d.kind || 'new-pool',
        sell_dex: 'reference',
        buy_price_usd: d.initialPrice,
        sell_price_usd: d.refPriceUsd,
        gap_bps: d.gapBps,
        buy_liquidity_usd: null,
        sell_liquidity_usd: null,
        min_liquidity_usd: null,
        trade_size_usd: 1000,
        est_gross_usd: estNetUsd,
        est_gas_usd: 0.01,
        est_net_usd: estNetUsd - 0.01,
        raw_json: JSON.stringify(d),
      });
      this.stats.opportunitiesLogged += 1;
      log.info(
        `[opportunity] NEW POOL: ${d.kind} ${(d.baseMint || '').slice(0, 8)}... ` +
        `gap=${d.gapBps.toFixed(1)}bps est=$${(estNetUsd - 0.01).toFixed(2)}`
      );
    } catch (e) {
      log.warn(`[decoder-worker] logOpportunity failed: ${e.message}`);
    }
  }

  async tick() {
    if (!this.stmts) return;
    this.stats.ticks += 1;

    // Only process fresh rows (attempts = 0) — already-tried rows are not re-run
    const rows = this.db.prepare(`
      SELECT * FROM new_pools
      WHERE decoded = 0 AND decode_attempts = 0
      ORDER BY detected_at DESC
      LIMIT ?
    `).all(this.batchSize);

    for (const row of rows) {
      await this.processRow(row);
      // Throttle to avoid Helius rate limit
      await new Promise(r => setTimeout(r, 250));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`[decoder-worker] started — polling for undecoded events every 10s`);
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); }
      catch (e) { log.error(`[decoder-worker] tick error: ${e.message}`); }
      if (this.running) this.timer = setTimeout(loop, 10000);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    log.info('[decoder-worker] stopped');
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new DecoderWorker();