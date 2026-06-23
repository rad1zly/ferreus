'use strict';

/**
 * Trade executor — Phase Pool-3.
 *
 * For each arb candidate, take a Jupiter round-trip quote (USDC → tokenB → USDC)
 * to estimate the realized profit. Log projected PnL to trade_log.
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
 * Trade size: configurable via ARB_TRADE_SIZE_USDC (default 100 USDC). For
 * Jupiter round-trip, we use USDC as the entry/exit token (deep liquidity).
 *
 * Profit calc:
 *   gross_profit_usd = amount_out_usd - amount_in_usd
 *   net_profit_usd = gross_profit_usd - gas_usd - jito_tip_usd
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
const jitoTip = require('./jitoTip');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS = 6;

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
      totalProjectedProfitUsd: 0,
      realizedProfitUsd: 0,
    };
    this._recentExecs = new Map();  // arbId -> ts, to avoid double-execution
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Execute an arb candidate. Returns trade_id (or null if skipped).
   * @param {Object} arb - { id, pairKey, mint0, mint1, cheapDex, expensiveDex, gapBps, ... }
   * @param {Object} opts - { tradeSizeUsd, slippageBps, forceLive }
   */
  async execute(arb, opts = {}) {
    if (!arb) return null;
    const tradeSize = opts.tradeSizeUsd ?? config.ARB_TRADE_SIZE_USDC;
    const slippageBps = opts.slippageBps ?? config.ARB_MAX_SLIPPAGE_BPS;

    // Skip if already executed recently (per arb_id, 5 min cooldown)
    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < 5 * 60 * 1000) {
      this.stats.skipped++;
      return null;
    }

    // The intermediate token is the one we want to buy cheap, sell expensive.
    // Use mint1 (the larger mint) as the intermediate by convention; this works
    // for the most common case (USDC is mint0, tokenB is mint1).
    const intermediateMint = arb.mint1;

    // Round-trip: USDC → intermediate → USDC
    const amountInRaw = Math.floor(tradeSize * Math.pow(10, USDC_DECIMALS));  // 100 USDC = 100_000_000
    const amountInUi = tradeSize;  // human-readable USD (since USDC ≈ USD)

    try {
      // Step 1: USDC → intermediate
      const quote1 = await jupiter.getQuote({
        inputMint: USDC_MINT,
        outputMint: intermediateMint,
        amount: amountInRaw,
        slippageBps,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: USDC_MINT, mintOut: intermediateMint, amountInRaw, amountInUi, errorMsg: 'quote1 failed' });
        return null;
      }

      // Step 2: intermediate → USDC
      const quote2 = await jupiter.getQuote({
        inputMint: intermediateMint,
        outputMint: USDC_MINT,
        amount: quote1.outAmount,
        slippageBps,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: intermediateMint, mintOut: USDC_MINT, amountInRaw: quote1.outAmount, errorMsg: 'quote2 failed' });
        return null;
      }

      // Compute PnL
      const amountOutRaw = quote2.outAmount;
      const amountOutUi = Number(amountOutRaw) / Math.pow(10, USDC_DECIMALS);
      const grossProfitUsd = amountOutUi - amountInUi;
      const solUsd = priceOracle.cache.get(WSOL_MINT)?.priceUsd || 0;
      const jitoTipUsd = (config.JITO_TIP_LAMPORTS / 1e9) * solUsd;
      const gasUsd = (ESTIMATED_GAS_LAMPORTS / 1e9) * solUsd;
      const netProfitUsd = grossProfitUsd - jitoTipUsd - gasUsd;
      const netProfitSol = solUsd > 0 ? netProfitUsd / solUsd : 0;

      this._recentExecs.set(arb.id, Date.now());

      // If profit is too low, skip execution but log the simulation
      if (grossProfitUsd < config.ARB_MIN_PROFIT_USD) {
        this.stats.skipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: USDC_MINT, mintOut: USDC_MINT,
          amountInRaw, amountInUi, amountOutRaw, amountOutUi,
          grossProfitUsd, jitoTipUsd, gasUsd, netProfitUsd, netProfitSol,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
        });
        log.info(
          `[exec] SKIP arb#${arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
          `| in=${amountInUi.toFixed(2)} USDC out=${amountOutUi.toFixed(2)} ` +
          `| profit=${grossProfitUsd.toFixed(3)} USD (below threshold)`
        );
        return tradeId;
      }

      // If LIVE_EXECUTE is on, actually execute
      if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
        return await this._executeLive(arb, quote1, quote2, amountInUi, amountOutUi, grossProfitUsd, netProfitUsd, netProfitSol);
      }

      // Otherwise simulate only
      this.stats.simulated++;
      this.stats.totalProjectedProfitUsd += grossProfitUsd;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated',
        mintIn: USDC_MINT, mintOut: USDC_MINT,
        amountInRaw, amountInUi, amountOutRaw, amountOutUi,
        grossProfitUsd, jitoTipUsd, gasUsd, netProfitUsd, netProfitSol,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
      });
      log.info(
        `💰 ARB #${tradeId || arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
        `| in=${amountInUi.toFixed(2)} → out=${amountOutUi.toFixed(2)} USDC ` +
        `| profit=$${grossProfitUsd.toFixed(3)} (net=$${netProfitUsd.toFixed(3)}) ` +
        `| ${this._mode()}`
      );
      return tradeId;
    } catch (e) {
      this.stats.failed++;
      this._logTrade({ arb, mode: this._mode(), status: 'failed', mintIn: USDC_MINT, mintOut: USDC_MINT, amountInRaw, amountInUi, errorMsg: e.message });
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
  async _executeLive(arb, quote1, quote2, amountInUi, amountOutUi, grossProfitUsd, netProfitUsd, netProfitSol) {
    // STUB: real implementation in Pool-5
    // For now, log the intent and treat as simulated
    log.warn(`[exec] LIVE_EXECUTE=true but live execution not yet implemented (Pool-5 stub). Logging as simulated.`);
    this.stats.simulated++;
    this.stats.totalProjectedProfitUsd += grossProfitUsd;
    const tradeId = this._logTrade({
      arb, mode: 'live', status: 'simulated',  // not 'submitted' since we're not actually submitting yet
      mintIn: USDC_MINT, mintOut: USDC_MINT,
      amountInRaw: String(Math.floor(amountInUi * 1e6)),
      amountInUi, amountOutRaw: String(Math.floor(amountOutUi * 1e6)), amountOutUi,
      grossProfitUsd, netProfitUsd, netProfitSol,
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
        amount_in_raw: t.amountInRaw || '0',
        amount_out_raw: t.amountOutRaw || null,
        amount_in_usd: t.amountInUi || null,
        amount_out_usd: t.amountOutUi || null,
        gross_profit_usd: t.grossProfitUsd || null,
        jito_tip_lamports: config.JITO_TIP_LAMPORTS,
        priority_fee_lamports: config.PRIORITY_FEE_LAMPORTS,
        gas_lamports: ESTIMATED_GAS_LAMPORTS,
        net_profit_usd: t.netProfitUsd || null,
        net_profit_sol: t.netProfitSol || null,
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
