'use strict';

/**
 * Trade executor — Phase Pool-3.
 *
 * For each arb candidate, do a Jupiter round-trip quote (SOL → tokenB → SOL)
 * to estimate the realized profit in SOL.
 *
 * v0 mode: DRY_RUN only. Logs every execution attempt as 'simulated'.
 * v5 mode: LIVE_EXECUTE=true + WALLET_PRIVATE_KEY set. Builds + signs + submits
 *   the Jupiter swap transaction, then submits to Jito for atomic landing.
 *
 * Why Jupiter round-trip (vs 2-DEX direct arb):
 * - Jupiter's smart router picks the best path automatically
 * - It MIGHT not pick our specific cheap/expensive DEXes — but if there's a
 *   real arb, Jupiter's best route will likely overlap with the cheapest route
 *   for buying tokenB and the most expensive route for selling it
 * - Atomic (single tx, no sandwich risk)
 * - Free public API
 *
 * Trade size: configurable via ARB_TRADE_SIZE_SOL (default 0.01 SOL).
 * Input/output: SOL (WSOL). For USDC/SOL pair, round-trip is SOL → USDC → SOL.
 * The intermediate is the OTHER side of the pair (mint0 = the smaller mint).
 *
 * Profit calc:
 *   gross_profit_sol = amount_out_sol - amount_in_sol
 *   net_profit_sol = gross_profit_sol - (jito_tip_sol + gas_sol)
 *   net_profit_usd = net_profit_sol × sol_usd
 *
 * Safety guards (from safety.guardTrade):
 * - DRY_RUN: log only, no tx
 * - LIVE_EXECUTE: build + sign + submit
 * - Per-trade max notional enforced
 * - Slippage cap enforced via Jupiter's slippageBps param
 */

const log = require('./logger');
const config = require('./config');
const jupiter = require('./jupiterClient');
const priceOracle = require('./priceOracle');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const WSOL_DECIMALS = 9;

// Estimated gas in lamports (per tx). Solana base fee 5000 + priority fee
// + compute units. Conservative estimate.
const ESTIMATED_GAS_LAMPORTS = 25000;  // ~0.000025 SOL

class Executor {
  constructor() {
    this._db = null;
    this.stats = {
      simulated: 0,
      submitted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
      totalGrossProfitSol: 0,
      totalNetProfitSol: 0,
      totalGrossProfitUsd: 0,
      totalNetProfitUsd: 0,
      totalRoundTripsExecuted: 0,
    };
    this._recentExecs = new Map();  // arbId -> ts, to avoid double-execution
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Execute an arb candidate. Returns trade_id (or null if skipped).
   * @param {Object} arb - { id, pairKey, mint0, mint1, cheapDex, expensiveDex, gapBps, ... }
   * @param {Object} opts - { tradeSizeSol, slippageBps, forceLive }
   */
  async execute(arb, opts = {}) {
    if (!arb) return null;
    const tradeSizeSol = opts.tradeSizeSol ?? config.ARB_TRADE_SIZE_SOL;
    const slippageBps = opts.slippageBps ?? config.ARB_MAX_SLIPPAGE_BPS;

    // Skip if already executed recently (per arb_id, 5 min cooldown)
    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < 5 * 60 * 1000) {
      this.stats.skipped++;
      return null;
    }

    // SOL → mint0 (intermediate, the smaller mint) → SOL
    // For USDC/SOL pair: SOL → USDC → SOL
    // For SOL/BONK pair: SOL → BONK → SOL
    // For SOL/JUP pair: SOL → JUP → SOL
    // (mint0 is always the "other side" since SOL is rarely the smaller mint)
    const intermediateMint = arb.mint0;

    // Sanity: intermediate shouldn't be SOL (would be no-op round-trip)
    if (intermediateMint === WSOL_MINT) {
      // Pair doesn't have a non-SOL side. Skip — the bot detected an
      // arb on a SOL-paired pool but the round-trip would be a no-op.
      return null;
    }

    // Round-trip: SOL → intermediate → SOL
    const amountInLamports = Math.floor(tradeSizeSol * 1e9);  // 0.01 SOL = 10_000_000
    const amountInSol = tradeSizeSol;

    try {
      // Step 1: SOL → intermediate
      const quote1 = await jupiter.getQuote({
        inputMint: WSOL_MINT,
        outputMint: intermediateMint,
        amount: amountInLamports,
        slippageBps,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: WSOL_MINT, mintOut: intermediateMint, amountInLamports, amountInSol, errorMsg: 'quote1 failed' });
        return null;
      }

      // Step 2: intermediate → SOL
      const quote2 = await jupiter.getQuote({
        inputMint: intermediateMint,
        outputMint: WSOL_MINT,
        amount: quote1.outAmount,
        slippageBps,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: intermediateMint, mintOut: WSOL_MINT, amountInLamports: quote1.outAmount, errorMsg: 'quote2 failed' });
        return null;
      }

      // Compute PnL in SOL (and USD for reference)
      const amountOutLamports = Number(quote2.outAmount);
      const amountOutSol = amountOutLamports / 1e9;
      const grossProfitSol = amountOutSol - amountInSol;
      const jitoTipSol = config.JITO_TIP_LAMPORTS / 1e9;
      const gasSol = ESTIMATED_GAS_LAMPORTS / 1e9;
      const netProfitSol = grossProfitSol - jitoTipSol - gasSol;
      const solUsd = priceOracle.cache.get(WSOL_MINT)?.priceUsd || 0;
      const grossProfitUsd = grossProfitSol * solUsd;
      const netProfitUsd = netProfitSol * solUsd;
      const amountInUsd = amountInSol * solUsd;
      const amountOutUsd = amountOutSol * solUsd;
      const netRoiPct = (netProfitSol / amountInSol) * 100;

      this._recentExecs.set(arb.id, Date.now());
      this.stats.totalRoundTripsExecuted++;

      // If profit is too low, skip execution but log the simulation
      const minProfitSol = config.ARB_MIN_PROFIT_SOL || 0;
      const minProfitUsd = config.ARB_MIN_PROFIT_USD || 0;
      if (grossProfitSol < minProfitSol || (minProfitUsd > 0 && grossProfitUsd < minProfitUsd)) {
        this.stats.skipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountInSol, amountOutLamports, amountOutSol,
          amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
        });
        log.info(
          `[exec] SKIP arb#${arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
          `| ${amountInSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
          `(gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL, ` +
          `net ${netRoiPct.toFixed(2)}%)`
        );
        return tradeId;
      }

      // If LIVE_EXECUTE is on, actually execute
      if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
        return await this._executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct);
      }

      // Otherwise simulate only
      this.stats.simulated++;
      this.stats.totalGrossProfitSol += grossProfitSol;
      this.stats.totalNetProfitSol += netProfitSol;
      this.stats.totalGrossProfitUsd += grossProfitUsd;
      this.stats.totalNetProfitUsd += netProfitUsd;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT,
        amountInLamports, amountInSol, amountOutLamports, amountOutSol,
        amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
        jitoTipSol, gasSol, solUsd, netRoiPct,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
      });
      log.info(
        `💰 ARB #${tradeId || arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
        `| ${amountInSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ($${grossProfitUsd.toFixed(4)}) ` +
        `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ($${netProfitUsd.toFixed(4)}) ` +
        `| ROI ${netRoiPct.toFixed(2)}%`
      );
      return tradeId;
    } catch (e) {
      this.stats.failed++;
      this._logTrade({ arb, mode: this._mode(), status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol, errorMsg: e.message });
      log.warn(`[exec] failed for arb#${arb.id}: ${e.message}`);
      return null;
    }
  }

  /**
   * LIVE execution path. Builds the Jupiter swap transaction, signs it, and
   * submits via Jito bundle.
   *
   * P5 implementation — currently a stub that simulates only. Full implementation
   * requires:
   * 1. Wallet keypair (from config.WALLET_PRIVATE_KEY)
   * 2. Jupiter /swap/v1/swap endpoint to get the transaction
   * 3. Sign the transaction
   * 4. Submit via Jito bundle API (or raw sendTransaction with priority fee)
   * 5. Wait for confirmation
   * 6. Log to trade_log with tx_signature
   */
  async _executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct) {
    // STUB: real implementation in Pool-5
    log.warn(`[exec] LIVE_EXECUTE=true but live execution not yet implemented (Pool-5 stub). Logging as simulated.`);
    this.stats.simulated++;
    this.stats.totalGrossProfitSol += grossProfitSol;
    this.stats.totalNetProfitSol += netProfitSol;
    const tradeId = this._logTrade({
      arb, mode: 'live', status: 'simulated',
      mintIn: WSOL_MINT, mintOut: WSOL_MINT,
      amountInLamports: String(Math.floor(amountInSol * 1e9)),
      amountInSol, amountOutLamports: String(Math.floor(amountOutSol * 1e9)), amountOutSol,
      grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
      jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9,
      solUsd, netRoiPct,
      errorMsg: 'live execution not yet implemented (Pool-5 stub)',
    });
    return tradeId;
  }

  _mode() {
    return (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) ? 'live' : 'dry_run';
  }

  _logTrade(t) {
    if (!this._db) return null;
    try {
      const row = {
        ts: Date.now(),
        arb_id: t.arb?.id || null,
        mode: t.mode || 'dry_run',
        status: t.status || 'simulated',
        mint_in: t.mintIn,
        mint_out: t.mintOut,
        amount_in_raw: t.amountInLamports != null ? String(t.amountInLamports) : '0',
        amount_out_raw: t.amountOutLamports != null ? String(t.amountOutLamports) : null,
        amount_in_sol: t.amountInSol ?? null,
        amount_out_sol: t.amountOutSol ?? null,
        amount_in_usd: t.amountInUsd ?? null,
        amount_out_usd: t.amountOutUsd ?? null,
        gross_profit_sol: t.grossProfitSol ?? null,
        gross_profit_usd: t.grossProfitUsd ?? null,
        net_profit_sol: t.netProfitSol ?? null,
        net_profit_usd: t.netProfitUsd ?? null,
        jito_tip_lamports: config.JITO_TIP_LAMPORTS,
        jito_tip_sol: t.jitoTipSol ?? null,
        priority_fee_lamports: config.PRIORITY_FEE_LAMPORTS,
        gas_lamports: ESTIMATED_GAS_LAMPORTS,
        gas_sol: t.gasSol ?? null,
        sol_usd_at_exec: t.solUsd ?? null,
        net_roi_pct: t.netRoiPct ?? null,
        tx_signature: null,
        error_msg: t.errorMsg || null,
        quote_json: t.quoteJson || null,
        raw_json: null,
      };
      const info = this._db.stmts.insertTradeLog.run(row);
      const tradeId = info.lastInsertRowid;
      if (t.arb?.id && (t.status === 'simulated' || t.status === 'submitted' || t.status === 'confirmed')) {
        this._db.stmts.markArbExecuted.run({ trade_id: tradeId, arb_id: t.arb.id });
      }
      return tradeId;
    } catch (e) {
      log.warn(`[exec] trade_log insert failed: ${e.message}`);
      return null;
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = new Executor();
