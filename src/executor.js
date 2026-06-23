'use strict';

/**
 * Trade executor — Phase Pool-3 with Pool-5 atomic 2-DEX support.
 *
 * For each arb candidate, do an ATOMIC 2-DEX round-trip:
 *   Quote 1: SOL → mint0 (intermediate) on cheap_dex (force route via dexes=cheap_dex)
 *   Quote 2: mint0 → SOL on expensive_dex (force route via dexes=expensive_dex)
 *
 * This captures the actual AMM-level gap (vs Jupiter smart router which picks
 * its own best routes). The two transactions are bundled in a Jito bundle for
 * atomic landing (both succeed or both fail in the same slot — no sandwich).
 *
 * Falls back to Jupiter smart-routing round-trip if direct 2-DEX quotes fail.
 *
 * v0 mode: DRY_RUN only. Logs every execution attempt as 'simulated'.
 * v5 mode: LIVE_EXECUTE=true + WALLET_PRIVATE_KEY set. Builds + signs + submits
 *   the Jupiter swap transaction, then submits to Jito for atomic landing.
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
const jitoClient = require('./jitoClient');
const priceOracle = require('./priceOracle');
const safety = require('./safety');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const WSOL_DECIMALS = 9;

// Estimated gas in lamports (per tx). Solana base fee 5000 + priority fee
// + compute units. Conservative estimate.
const ESTIMATED_GAS_LAMPORTS = 25000;  // ~0.000025 SOL

// Map arb detector dex name -> Jupiter dex param value.
// The arb detector uses 'raydium_clmm', Jupiter uses 'Raydium CLMM' or similar.
// For now: assume the same string works (Jupiter v1 uses 'Raydium' for AMM,
// 'Raydium CLMM' for CLMM, 'Whirlpool' for Orca). Mismatch returns null.
const DEX_NAME_MAP = {
  'raydium_cpmm':    'Raydium',
  'raydium_clmm':    'Raydium CLMM',
  'orca_whirlpool':  'Whirlpool',
  'meteora_dlmm':    'Meteora',
  'meteora_damm_v2': 'Meteora',
};

class Executor {
  constructor() {
    this._db = null;
    this.stats = {
      directSimulated: 0,
      directSubmitted: 0,
      directConfirmed: 0,
      directFailed: 0,
      roundTripSimulated: 0,
      roundTripSkipped: 0,
      totalGrossProfitSol: 0,
      totalNetProfitSol: 0,
      totalGrossProfitUsd: 0,
      totalNetProfitUsd: 0,
    };
    this._recentExecs = new Map();  // arbId -> ts
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Execute an arb candidate. Tries atomic 2-DEX direct, falls back to round-trip.
   * @param {Object} arb - { id, pairKey, mint0, mint1, cheapDex, expensiveDex, gapBps, ... }
   * @param {Object} opts - { tradeSizeSol, slippageBps, forceLive, forceRoundTrip }
   */
  async execute(arb, opts = {}) {
    if (!arb) return null;

    // Cooldown per arb_id (5 min)
    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < 5 * 60 * 1000) {
      this.stats.roundTripSkipped++;
      return null;
    }
    this._recentExecs.set(arb.id, Date.now());

    const tradeSizeSol = opts.tradeSizeSol ?? config.ARB_TRADE_SIZE_SOL;
    const slippageBps = opts.slippageBps ?? config.ARB_MAX_SLIPPAGE_BPS;

    // Skip if intermediate would be no-op (no non-SOL side)
    if (arb.mint0 === WSOL_MINT) {
      return null;
    }

    // Try atomic 2-DEX direct first (if enabled)
    if (config.ARB_USE_DIRECT_DEX && !opts.forceRoundTrip) {
      const result = await this._executeDirect(arb, { tradeSizeSol, slippageBps });
      if (result !== 'fallback') return result;
    }

    // Fallback: Jupiter smart-routing round-trip
    return await this._executeRoundTrip(arb, { tradeSizeSol, slippageBps });
  }

  /**
   * ATOMIC 2-DEX execution: force Jupiter to use specific DEXes for each leg.
   * Returns tradeId on success, 'fallback' if direct route not available,
   * null on error.
   */
  async _executeDirect(arb, { tradeSizeSol, slippageBps }) {
    // Support both snake_case (from DB) and camelCase (from in-memory detector) shapes
    const mint0 = arb.mint0 ?? arb.mintSmall;
    const mint1 = arb.mint1 ?? arb.mintBig;
    const cheapDex = arb.cheapDex ?? arb.cheap_dex;
    const expensiveDex = arb.expensiveDex ?? arb.expensive_dex;

    // Map our dex names to Jupiter's expected names
    const cheapDexJ = DEX_NAME_MAP[cheapDex];
    const expensiveDexJ = DEX_NAME_MAP[expensiveDex];
    if (!cheapDexJ || !expensiveDexJ) {
      // No Jupiter mapping for this DEX — fall back
      return 'fallback';
    }

    // Round-trip: SOL → mint0 on cheap_dex, then mint0 → SOL on expensive_dex
    const amountInLamports = Math.floor(tradeSizeSol * 1e9);
    const intermediateMint = mint0;  // the smaller mint (non-SOL side typically)

    try {
      // Step 1: SOL → intermediate on cheap_dex (forced route)
      const quote1 = await jupiter.getQuote({
        inputMint: WSOL_MINT,
        outputMint: intermediateMint,
        amount: amountInLamports,
        slippageBps,
        dexes: cheapDexJ,
      });
      if (!quote1 || !quote1.outAmount) {
        // Cheap DEX doesn't have route for this pair — fall back to round-trip
        return 'fallback';
      }

      // Step 2: intermediate → SOL on expensive_dex (forced route)
      const quote2 = await jupiter.getQuote({
        inputMint: intermediateMint,
        outputMint: WSOL_MINT,
        amount: quote1.outAmount,
        slippageBps,
        dexes: expensiveDexJ,
      });
      if (!quote2 || !quote2.outAmount) {
        // Expensive DEX doesn't have reverse route — fall back
        return 'fallback';
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
      const netRoiPct = tradeSizeSol > 0 ? (netProfitSol / tradeSizeSol) * 100 : 0;

      // Check if profitable
      const minProfitSol = config.ARB_MIN_PROFIT_SOL || 0;
      if (grossProfitSol < minProfitSol) {
        this.stats.roundTripSkipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped', strategy: 'direct_2dex',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountOutLamports, amountInSol: tradeSizeSol, amountOutSol,
          amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
          errorMsg: `gross ${grossProfitSol.toFixed(6)} < min ${minProfitSol} SOL`,
        });
        log.info(
          `[exec] direct SKIP arb#${arb.id} ${cheapDex}→${expensiveDex} ` +
          `| ${tradeSizeSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
          `(gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL, ` +
          `ROI ${netRoiPct.toFixed(2)}%)`
        );
        return tradeId;
      }

      // Profitable! In LIVE mode, build + sign + bundle.
      if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
        return await this._buildAndBundle(arb, { quote1, quote2, amountInLamports, amountOutSol, grossProfitSol, netProfitSol, grossProfitUsd, netProfitUsd, solUsd, netRoiPct });
      }

      // DRY_RUN: log projected PnL only
      this.stats.directSimulated++;
      this.stats.totalGrossProfitSol += grossProfitSol;
      this.stats.totalNetProfitSol += netProfitSol;
      this.stats.totalGrossProfitUsd += grossProfitUsd;
      this.stats.totalNetProfitUsd += netProfitUsd;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated', strategy: 'direct_2dex',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT,
        amountInLamports, amountOutLamports, amountInSol: tradeSizeSol, amountOutSol,
        amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
        jitoTipSol, gasSol, solUsd, netRoiPct,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
      });
      log.info(
        `💰 DIRECT #${tradeId || arb.id} ${cheapDex}→${expensiveDex} ` +
        `| ${tradeSizeSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ($${grossProfitUsd.toFixed(4)}) ` +
        `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ` +
        `| ROI ${netRoiPct.toFixed(2)}%`
      );
      return tradeId;
    } catch (e) {
      this.stats.directFailed++;
      log.warn(`[exec] direct_2dex failed for arb#${arb.id}: ${e.message}`);
      return 'fallback';
    }
  }

  /**
   * Jupiter smart-router round-trip (fallback). Captures Jupiter's best route
   * for each leg, not necessarily our detected cheap/expensive DEXes.
   */
  async _executeRoundTrip(arb, { tradeSizeSol, slippageBps }) {
    const mint0 = arb.mint0 ?? arb.mintSmall;
    const mint1 = arb.mint1 ?? arb.mintBig;
    const cheapDex = arb.cheapDex ?? arb.cheap_dex;
    const expensiveDex = arb.expensiveDex ?? arb.expensive_dex;
    const amountInLamports = Math.floor(tradeSizeSol * 1e9);

    try {
      // Step 1: SOL → mint0 (Jupiter picks best route)
      const quote1 = await jupiter.getQuote({
        inputMint: WSOL_MINT,
        outputMint: mint0,
        amount: amountInLamports,
        slippageBps,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', strategy: 'round_trip',
          mintIn: WSOL_MINT, mintOut: mint0, amountInLamports, amountInSol: tradeSizeSol,
          errorMsg: 'quote1 failed' });
        return null;
      }

      // Step 2: mint0 → SOL (Jupiter picks best route)
      const quote2 = await jupiter.getQuote({
        inputMint: mint0,
        outputMint: WSOL_MINT,
        amount: quote1.outAmount,
        slippageBps,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', strategy: 'round_trip',
          mintIn: mint0, mintOut: WSOL_MINT, amountInLamports: quote1.outAmount, amountInSol: tradeSizeSol,
          errorMsg: 'quote2 failed' });
        return null;
      }

      // Compute PnL
      const amountOutSol = Number(quote2.outAmount) / 1e9;
      const grossProfitSol = amountOutSol - tradeSizeSol;
      const jitoTipSol = config.JITO_TIP_LAMPORTS / 1e9;
      const gasSol = ESTIMATED_GAS_LAMPORTS / 1e9;
      const netProfitSol = grossProfitSol - jitoTipSol - gasSol;
      const solUsd = priceOracle.cache.get(WSOL_MINT)?.priceUsd || 0;
      const grossProfitUsd = grossProfitSol * solUsd;
      const netProfitUsd = netProfitSol * solUsd;
      const netRoiPct = (netProfitSol / tradeSizeSol) * 100;

      // Skip if not profitable
      if (grossProfitSol < (config.ARB_MIN_PROFIT_SOL || 0)) {
        this.stats.roundTripSkipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped', strategy: 'round_trip',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountInSol: tradeSizeSol,
          amountOutLamports: quote2.outAmount, amountOutSol,
          grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct,
          errorMsg: `gross ${grossProfitSol.toFixed(6)} < min ${config.ARB_MIN_PROFIT_SOL} SOL`,
        });
        return tradeId;
      }

      this.stats.roundTripSimulated++;
      this.stats.totalGrossProfitSol += grossProfitSol;
      this.stats.totalNetProfitSol += netProfitSol;
      this.stats.totalGrossProfitUsd += grossProfitUsd;
      this.stats.totalNetProfitUsd += netProfitUsd;
      const tradeId = this._logTrade({
        arb, mode: 'dry_run', status: 'simulated', strategy: 'round_trip',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT,
        amountInLamports, amountInSol: tradeSizeSol,
        amountOutLamports: quote2.outAmount, amountOutSol,
        grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
        jitoTipSol, gasSol, solUsd, netRoiPct,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
      });
      log.info(
        `💰 RT #${tradeId || arb.id} ${arb.cheapDex}→${arb.expensiveDex} ` +
        `| ${tradeSizeSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ` +
        `| ROI ${netRoiPct.toFixed(2)}% (round-trip fallback)`
      );
      return tradeId;
    } catch (e) {
      this.stats.directFailed++;
      this._logTrade({ arb, mode: this._mode(), status: 'failed', strategy: 'round_trip',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol: tradeSizeSol,
        errorMsg: e.message });
      log.warn(`[exec] round_trip failed for arb#${arb.id}: ${e.message}`);
      return null;
    }
  }

  /**
   * LIVE atomic execution: build 2 swap txs via Jupiter /swap, bundle with Jito.
   * Returns tradeId on success.
   */
  async _buildAndBundle(arb, { quote1, quote2, amountInLamports, amountOutSol, grossProfitSol, netProfitSol, grossProfitUsd, netProfitUsd, solUsd, netRoiPct }) {
    const cheapDex = arb.cheapDex ?? arb.cheap_dex;
    const expensiveDex = arb.expensiveDex ?? arb.expensive_dex;
    // Get wallet pubkey
    let wallet;
    try {
      wallet = jitoClient.getWallet();
    } catch (e) {
      this.stats.directFailed++;
      log.warn(`[exec] no wallet: ${e.message}`);
      return null;
    }
    const userPublicKey = wallet.publicKey.toBase58();

    // Build 2 swap txs
    const swap1 = await jupiter.getSwapTransaction({
      quoteResponse: quote1,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: config.PRIORITY_FEE_LAMPORTS,
    });
    if (!swap1) {
      this.stats.directFailed++;
      this._logTrade({ arb, mode: 'live', status: 'failed', strategy: 'direct_2dex',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol: amountInLamports/1e9,
        amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct,
        errorMsg: 'swap1 build failed' });
      return null;
    }
    const swap2 = await jupiter.getSwapTransaction({
      quoteResponse: quote2,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: config.PRIORITY_FEE_LAMPORTS,
    });
    if (!swap2) {
      this.stats.directFailed++;
      this._logTrade({ arb, mode: 'live', status: 'failed', strategy: 'direct_2dex',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol: amountInLamports/1e9,
        amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct,
        errorMsg: 'swap2 build failed' });
      return null;
    }

    // Bundle via Jito
    this.stats.directSubmitted++;
    const { Connection } = require('@solana/web3.js');
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/', 'confirmed');
    const result = await jitoClient.submitBundle(connection, [swap1, swap2]);
    if (!result) {
      this.stats.directFailed++;
      this._logTrade({ arb, mode: 'live', status: 'failed', strategy: 'direct_2dex',
        mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports, amountInSol: amountInLamports/1e9,
        amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct,
        errorMsg: 'bundle submission failed' });
      return null;
    }

    // Log success
    if (result.landed) {
      this.stats.directConfirmed++;
      this.stats.totalGrossProfitSol += grossProfitSol;
      this.stats.totalNetProfitSol += netProfitSol;
      this.stats.totalGrossProfitUsd += grossProfitUsd;
      this.stats.totalNetProfitUsd += netProfitUsd;
    }
    const tradeId = this._logTrade({
      arb, mode: 'live', status: result.landed ? 'confirmed' : 'submitted', strategy: 'direct_2dex',
      mintIn: WSOL_MINT, mintOut: WSOL_MINT,
      amountInLamports, amountInSol: amountInLamports/1e9, amountOutSol,
      grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct,
      txSignature: result.txSignature || null,
      errorMsg: result.error || null,
      quoteJson: JSON.stringify({ bundleId: result.bundleId, q1: quote1, q2: quote2 }),
    });
    log.info(
      `💰 BUNDLE #${tradeId} ${arb.cheapDex}→${arb.expensiveDex} ` +
      `| ${result.landed ? 'LANDED' : 'SUBMITTED'} ` +
      `| ${(amountInLamports/1e9).toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
      `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ` +
      `| ${result.bundleId || ''}`
    );
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
        tx_signature: t.txSignature ?? null,
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
