'use strict';

/**
 * Trade executor — Phase Pool-3 (v0.8.2 profitable tweaks).
 *
 * Strategy: 2-DEX direct quote via Jupiter's `dexes` + `onlyDirectRoutes=true`.
 * Bypasses Jupiter's smart router to capture the actual AMM-level gap.
 *
 * For each arb candidate (e.g. cheap_dex=orca_whirlpool, expensive_dex=raydium_clmm):
 * - Leg 1: SOL → USDC, forced on EXPENSIVE_dex (where USDC is cheap → we get more USDC per SOL)
 * - Leg 2: USDC → SOL, forced on CHEAP_dex (where SOL is expensive → we get more SOL per USDC)
 * - If Leg 2 output > input: profit in SOL
 *
 * Key v0.8.2 changes:
 * - Jupiter `dexes` param + `onlyDirectRoutes=true` to capture real AMM gap
 * - Higher trade size (0.1 SOL default, was 0.01)
 * - Min gap filter (100bps default, skip small losses)
 * - 10min per-arb cooldown (was 5min)
 * - Jupiter retry/backoff handled in jupiterClient
 *
 * DRY_RUN: log only. LIVE: requires WALLET_PRIVATE_KEY (Pool-5 stub).
 */

const log = require('./logger');
const config = require('./config');
const jupiter = require('./jupiterClient');
const priceOracle = require('./priceOracle');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ESTIMATED_GAS_LAMPORTS = 25000;

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
      profitableTrades: 0,
      unprofitableTrades: 0,
    };
    this._recentExecs = new Map();  // arbId -> ts
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

    // Per-arb cooldown (default 10 min)
    const cooldownMs = config.ARB_EXEC_COOLDOWN_MS || 10 * 60 * 1000;
    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < cooldownMs) {
      this.stats.skipped++;
      return null;
    }

    // Gap filter at execution time (skip small losses)
    const minGapBpsForExec = config.ARB_MIN_GAP_BPS_FOR_EXEC ?? 100;  // 1%
    if (arb.gapBps != null && arb.gapBps < minGapBpsForExec) {
      this.stats.skipped++;
      return null;
    }

    // mint0 is the smaller mint, used as intermediate
    const intermediateMint = arb.mint0;
    if (intermediateMint === WSOL_MINT) return null;  // no-op round-trip

    // SOL → mint0 → SOL
    // Leg 1: sell SOL on EXPENSIVE_dex (we get more mint0 per SOL)
    // Leg 2: buy SOL on CHEAP_dex (we pay less mint0 per SOL)
    const amountInLamports = Math.floor(tradeSizeSol * 1e9);
    const amountInSol = tradeSizeSol;

    try {
      // Leg 1: SOL → intermediate on EXPENSIVE_dex (direct)
      const quote1 = await jupiter.getQuote({
        inputMint: WSOL_MINT,
        outputMint: intermediateMint,
        amount: amountInLamports,
        slippageBps,
        restrictToDex: arb.expensiveDex,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: WSOL_MINT, mintOut: intermediateMint,
          amountInLamports, amountInSol,
          errorMsg: 'leg1 (SOL→mint on expensive_dex) failed',
        });
        this.stats.skipped++;
        return null;
      }

      // Leg 2: intermediate → SOL on CHEAP_dex (direct)
      const quote2 = await jupiter.getQuote({
        inputMint: intermediateMint,
        outputMint: WSOL_MINT,
        amount: quote1.outAmount,
        slippageBps,
        restrictToDex: arb.cheapDex,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: intermediateMint, mintOut: WSOL_MINT,
          amountInLamports: quote1.outAmount, amountInSol,
          errorMsg: 'leg2 (mint→SOL on cheap_dex) failed',
        });
        this.stats.skipped++;
        return null;
      }

      this._recentExecs.set(arb.id, Date.now());

      // Compute PnL
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

      // Profit gate
      const minProfitSol = config.ARB_MIN_PROFIT_SOL || 0;
      if (grossProfitSol < minProfitSol) {
        this.stats.skipped++;
        this.stats.unprofitableTrades++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountInSol, amountOutLamports, amountOutSol,
          amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2, forced_dexes: true }),
        });
        log.info(
          `[exec] SKIP arb#${arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
          `gap=${arb.gapBps?.toFixed(0)}bps | ${tradeSizeSol.toFixed(4)}→${amountOutSol.toFixed(4)} SOL ` +
          `gross=${grossProfitSol.toFixed(6)} SOL net=${netRoiPct.toFixed(2)}% | below min ${minProfitSol} SOL`
        );
        return tradeId;
      }

      // Profitable!
      this.stats.profitableTrades++;
      this.stats.totalGrossProfitSol += grossProfitSol;
      this.stats.totalNetProfitSol += netProfitSol;
      this.stats.totalGrossProfitUsd += grossProfitUsd;
      this.stats.totalNetProfitUsd += netProfitUsd;

      // LIVE mode
      if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
        return await this._executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct);
      }

      // DRY_RUN: log only
      this.stats.simulated++;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT,
        amountInLamports, amountInSol, amountOutLamports, amountOutSol,
        amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
        jitoTipSol, gasSol, solUsd, netRoiPct,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2, forced_dexes: true }),
      });
      log.info(
        `💰 ARB #${tradeId || arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
        `gap=${arb.gapBps?.toFixed(0)}bps | ${amountInSol.toFixed(4)}→${amountOutSol.toFixed(4)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ($${grossProfitUsd.toFixed(4)}) ` +
        `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ($${netProfitUsd.toFixed(4)}) ` +
        `| ROI ${netRoiPct.toFixed(2)}% | 2-DEX DIRECT`
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
   * LIVE execution path (Pool-5 stub). For now logs as simulated.
   * Real implementation: build Jupiter swap tx → sign → Jito bundle submit.
   */
  async _executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct) {
    log.warn(`[exec] LIVE_EXECUTE=true but live execution not yet implemented (Pool-5 stub).`);
    this.stats.simulated++;
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
        strategy: t.strategy || 'direct_2dex',
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
