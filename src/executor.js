'use strict';

/**
 * Trade executor — Phase Pool-3.
 *
 * For each arb candidate, do a 2-DEX FORCED round-trip:
 *   - Quote 1: SOL → tokenB, force `cheap_dex` (sell SOL where it's valuable)
 *   - Quote 2: tokenB → SOL, force `expensive_dex` (buy SOL where it's cheap)
 *
 * Why forced 2-DEX (vs unrestricted Jupiter):
 * - We DETECTED a real AMM-level gap on a specific pair of DEXes
 * - Unrestricted Jupiter's smart router often picks a single DEX for both legs,
 *   capturing the spread as Jupiter's fee (this is the v0.8.0 problem)
 * - Forced routing makes Jupiter use OUR detected DEXes for each leg,
 *   capturing the actual AMM-level spread as our profit
 *
 * Trade size: configurable via ARB_TRADE_SIZE_SOL (default 0.01 SOL).
 * Profit thresholds: ARB_MIN_PROFIT_SOL (default 0.0001 SOL).
 *
 * Profit calc:
 *   gross_profit_sol = amount_out_sol - amount_in_sol
 *   net_profit_sol   = gross_profit_sol - (jito_tip_sol + gas_sol)
 *   net_profit_usd   = net_profit_sol × sol_usd
 *
 * Mode:
 * - DRY_RUN (default): log only, no real tx
 * - LIVE (LIVE_EXECUTE=true + WALLET_PRIVATE_KEY set): real execution
 *   (Pool-5 final implementation — currently a stub)
 */

const log = require('./logger');
const config = require('./config');
const jupiter = require('./jupiterClient');
const priceOracle = require('./priceOracle');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Estimated gas in lamports (per tx). Solana base fee 5000 + priority fee
// + compute units. Conservative estimate.
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
      totalRoundTrips: 0,
      // Forced-DEX profit tracking
      forcedProfitSol: 0,
      forcedProfitUsd: 0,
      // Unrestricted profit tracking (fallback)
      unforcedProfitSol: 0,
      unforcedProfitUsd: 0,
    };
    this._recentExecs = new Map();  // arbId -> ts, cooldown 5min
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Execute an arb candidate. Returns trade_id (or null if skipped).
   *
   * @param {Object} arb - { id, pairKey, mint0, mint1, cheapDex, expensiveDex, gapBps, ... }
   * @param {Object} opts - { tradeSizeSol, slippageBps, forceDexes }
   */
  async execute(arb, opts = {}) {
    if (!arb) return null;
    const tradeSizeSol = opts.tradeSizeSol ?? config.ARB_TRADE_SIZE_SOL;
    const slippageBps = opts.slippageBps ?? config.ARB_MAX_SLIPPAGE_BPS;
    const forceDexes = opts.forceDexes ?? true;  // default: use forced 2-DEX

    // 5min cooldown per arb_id (avoid double-fee on same opportunity)
    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < 5 * 60 * 1000) {
      this.stats.skipped++;
      return null;
    }

    const intermediateMint = arb.mint0;
    // Skip if pair doesn't have a non-SOL side (no-op round-trip)
    if (intermediateMint === WSOL_MINT) return null;

    const amountInLamports = Math.floor(tradeSizeSol * 1e9);

    try {
      // === Leg 1: SOL → tokenB on cheap_dex (sell SOL where valuable) ===
      const quote1 = await this._getLeg1Quote({
        amountInLamports, intermediateMint, cheapDex: arb.cheapDex, slippageBps, forceDexes,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: WSOL_MINT, mintOut: intermediateMint, amountInLamports, amountInSol: tradeSizeSol, errorMsg: 'quote1 failed', quoteJson: quote1 ? JSON.stringify(quote1) : null });
        return null;
      }

      // === Leg 2: tokenB → SOL on expensive_dex (buy SOL where cheap) ===
      const quote2 = await this._getLeg2Quote({
        amountOutLamports: quote1.outAmount, intermediateMint, expensiveDex: arb.expensiveDex, slippageBps, forceDexes,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: intermediateMint, mintOut: WSOL_MINT, amountInLamports: quote1.outAmount, errorMsg: 'quote2 failed', quoteJson: quote2 ? JSON.stringify(quote2) : null });
        return null;
      }

      this._recentExecs.set(arb.id, Date.now());
      this.stats.totalRoundTrips++;
      if (forceDexes) {
        this.stats.forcedProfitSol += 0; // accumulator set below
      }

      // Compute PnL
      const amountOutLamports = Number(quote2.outAmount);
      const amountOutSol = amountOutLamports / 1e9;
      const grossProfitSol = amountOutSol - tradeSizeSol;
      const jitoTipSol = config.JITO_TIP_LAMPORTS / 1e9;
      const gasSol = ESTIMATED_GAS_LAMPORTS / 1e9;
      const netProfitSol = grossProfitSol - jitoTipSol - gasSol;
      const solUsd = priceOracle.cache.get(WSOL_MINT)?.priceUsd || 0;
      const grossProfitUsd = grossProfitSol * solUsd;
      const netProfitUsd = netProfitSol * solUsd;
      const amountInUsd = tradeSizeSol * solUsd;
      const amountOutUsd = amountOutSol * solUsd;
      const netRoiPct = (netProfitSol / tradeSizeSol) * 100;

      // Update stats
      if (forceDexes) {
        this.stats.forcedProfitSol += grossProfitSol;
        this.stats.forcedProfitUsd += grossProfitUsd;
      } else {
        this.stats.unforcedProfitSol += grossProfitSol;
        this.stats.unforcedProfitUsd += grossProfitUsd;
      }

      // Profit threshold gate
      const minProfitSol = config.ARB_MIN_PROFIT_SOL || 0;
      if (grossProfitSol < minProfitSol) {
        this.stats.skipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountInSol: tradeSizeSol, amountOutLamports, amountOutSol,
          amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2, forceDexes }),
        });
        log.info(
          `[exec] SKIP arb#${arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
          `| ${tradeSizeSol.toFixed(4)}→${amountOutSol.toFixed(4)} SOL ` +
          `(gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL, ` +
          `below min ${minProfitSol} SOL)` +
          (forceDexes ? ' [forced-dex]' : ' [unforced]')
        );
        return tradeId;
      }

      // LIVE mode
      if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
        return await this._executeLive(arb, quote1, quote2, tradeSizeSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct);
      }

      // DRY_RUN
      this.stats.simulated++;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT,
        amountInLamports, amountInSol: tradeSizeSol, amountOutLamports, amountOutSol,
        amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
        jitoTipSol, gasSol, solUsd, netRoiPct,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2, forceDexes }),
      });
      log.info(
        `💰 ARB #${tradeId || arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
        `| ${tradeSizeSol.toFixed(4)}→${amountOutSol.toFixed(4)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ($${grossProfitUsd.toFixed(4)}) ` +
        `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ($${netProfitUsd.toFixed(4)}) ` +
        `| ROI ${netRoiPct.toFixed(2)}%` +
        (forceDexes ? ' [forced-dex]' : ' [unforced]')
      );
      return tradeId;
    } catch (e) {
      this.stats.failed++;
      this._logTrade({ arb, mode: this._mode(), status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol: tradeSizeSol, errorMsg: e.message });
      log.warn(`[exec] failed for arb#${arb.id}: ${e.message}`);
      return null;
    }
  }

  /**
   * Leg 1: SOL → tokenB.
   * Forced mode: try cheap_dex first, fallback to unrestricted.
   * Unforced mode: unrestricted.
   */
  async _getLeg1Quote({ amountInLamports, intermediateMint, cheapDex, slippageBps, forceDexes }) {
    if (!forceDexes) {
      return await jupiter.getQuote({
        inputMint: WSOL_MINT, outputMint: intermediateMint,
        amount: amountInLamports, slippageBps,
      });
    }
    // Try forced cheap_dex
    const forced = await jupiter.getQuote({
      inputMint: WSOL_MINT, outputMint: intermediateMint,
      amount: amountInLamports, slippageBps,
      dexes: cheapDex ? [jupiter.jupLabel(cheapDex)].filter(Boolean) : undefined,
    });
    if (forced && forced.outAmount) return { ...forced, _forcedDex: cheapDex };
    // Fallback to unrestricted if forced failed (no route on that DEX)
    log.info(`[exec] leg1 forced (${cheapDex}) no route, falling back to unrestricted`);
    const fallback = await jupiter.getQuote({
      inputMint: WSOL_MINT, outputMint: intermediateMint,
      amount: amountInLamports, slippageBps,
    });
    if (fallback && fallback.outAmount) return { ...fallback, _forcedDex: null, _fallback: true };
    return null;
  }

  /**
   * Leg 2: tokenB → SOL.
   * Forced mode: try expensive_dex first, fallback to unrestricted.
   */
  async _getLeg2Quote({ amountOutLamports, intermediateMint, expensiveDex, slippageBps, forceDexes }) {
    if (!forceDexes) {
      return await jupiter.getQuote({
        inputMint: intermediateMint, outputMint: WSOL_MINT,
        amount: amountOutLamports, slippageBps,
      });
    }
    const forced = await jupiter.getQuote({
      inputMint: intermediateMint, outputMint: WSOL_MINT,
      amount: amountOutLamports, slippageBps,
      dexes: expensiveDex ? [jupiter.jupLabel(expensiveDex)].filter(Boolean) : undefined,
    });
    if (forced && forced.outAmount) return { ...forced, _forcedDex: expensiveDex };
    log.info(`[exec] leg2 forced (${expensiveDex}) no route, falling back to unrestricted`);
    const fallback = await jupiter.getQuote({
      inputMint: intermediateMint, outputMint: WSOL_MINT,
      amount: amountOutLamports, slippageBps,
    });
    if (fallback && fallback.outAmount) return { ...fallback, _forcedDex: null, _fallback: true };
    return null;
  }

  /**
   * LIVE execution path. Builds the Jupiter swap transaction, signs it, and
   * submits via Jito bundle.
   *
   * P5 final implementation — currently a stub.
   * Requires:
   * 1. Wallet keypair (from config.WALLET_PRIVATE_KEY)
   * 2. Jupiter /swap/v1/swap endpoint to get the transaction
   * 3. Sign the transaction
   * 4. Submit via Jito bundle API
   * 5. Wait for confirmation
   * 6. Log to trade_log with tx_signature
   */
  async _executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct) {
    log.warn(`[exec] LIVE_EXECUTE=true but live execution not yet implemented (Pool-5 stub). Logging as simulated.`);
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
