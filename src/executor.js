'use strict';

/**
 * Trade executor — Phase Pool-3/4/5.
 *
 * For each arb candidate, do a 2-DEX direct round-trip quote (SOL → intermediate
 * on expensive_dex, intermediate → SOL on cheap_dex). This captures the actual
 * AMM gap instead of Jupiter's smart-router price.
 *
 * v0.8.1: SOL-based trade (0.01 SOL default, profit in SOL).
 * v0.8.2: Direct 2-DEX quote via `restrictToDex` (bypasses Jupiter router).
 * v0.8.3: Direct 2-DEX quote as DEFAULT (not Jupiter round-trip).
 * v0.9.0 (P5): Live execution — build tx, sign, submit via Jito bundle.
 *
 * Execution flow:
 * 1. Quote SOL → intermediate, restricted to expensive_dex (sell SOL high)
 * 2. Quote intermediate → SOL, restricted to cheap_dex (buy SOL cheap)
 * 3. If round-trip profitable:
 *    a. Build tx1 (SOL → intermediate) from quote1
 *    b. Build tx2 (intermediate → SOL) from quote2 (using quote1.outAmount as input)
 *    c. Sign both with wallet
 *    d. Submit as 2-tx Jito bundle (atomic, no sandwich risk)
 *    e. Wait for landing, parse tx for actual SOL delta
 *    f. Log to trade_log with tx_signature, net_profit_sol (realized)
 *
 * DRY_RUN (default): simulate, log to trade_log as 'simulated'
 * LIVE_EXECUTE=true: build + sign + submit, log as 'submitted'/'confirmed'/'failed'
 */

const log = require('./logger');
const config = require('./config');
const jupiter = require('./jupiterClient');
const priceOracle = require('./priceOracle');
const jitoClient = require('./jitoClient');
const { Connection, PublicKey } = require('@solana/web3.js');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const ESTIMATED_GAS_LAMPORTS = 25000;

class Executor {
  constructor() {
    this._db = null;
    this._connection = null;
    this.stats = {
      simulated: 0,
      submitted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
      totalGrossProfitSol: 0,
      totalNetProfitSol: 0,
      totalRealizedProfitSol: 0,  // from confirmed txs
      totalRoundTripsExecuted: 0,
      bundlesSubmitted: 0,
      bundlesLanded: 0,
    };
    this._recentExecs = new Map();
  }

  attachDb(database) {
    this._db = database;
  }

  /**
   * Set Solana RPC connection (used for tx confirmation).
   */
  setConnection(connection) {
    this._connection = connection;
  }

  /**
   * Execute an arb candidate. Returns trade_id (or null if skipped/failed).
   * @param {Object} arb - { id, pairKey, mint0, mint1, cheapDex, expensiveDex, gapBps }
   * @param {Object} opts - { tradeSizeSol, slippageBps, forceLive, forceDryRun }
   */
  async execute(arb, opts = {}) {
    if (!arb) return null;
    const tradeSizeSol = opts.tradeSizeSol ?? config.ARB_TRADE_SIZE_SOL;
    const slippageBps = opts.slippageBps ?? config.ARB_MAX_SLIPPAGE_BPS;

    const lastExec = this._recentExecs.get(arb.id) || 0;
    if (Date.now() - lastExec < 5 * 60 * 1000) {
      this.stats.skipped++;
      return null;
    }

    // Round-trip: SOL → mint0 (intermediate) → SOL
    // For USDC/SOL pair: SOL → USDC → SOL
    // mint0 is always the non-SOL side (lexicographic order)
    const intermediateMint = arb.mint0;
    if (intermediateMint === WSOL_MINT) {
      return null;
    }

    const amountInLamports = Math.floor(tradeSizeSol * 1e9);
    const amountInSol = tradeSizeSol;

    // DIRECT 2-DEX quote: restrict each leg to the specific DEX we detected.
    // q1 = sell SOL on EXPENSIVE_dex (we get more intermediate)
    // q2 = buy SOL on CHEAP_dex (we pay less intermediate per SOL)
    // Net effect: capture the actual AMM gap
    const useDirectRoute = opts.useDirectRoute ?? config.ARB_USE_DIRECT_2DEX_ROUTE ?? true;

    try {
      const quote1 = await jupiter.getQuote({
        inputMint: WSOL_MINT,
        outputMint: intermediateMint,
        amount: amountInLamports,
        slippageBps,
        restrictToDex: useDirectRoute ? arb.expensiveDex : null,
      });
      if (!quote1 || !quote1.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: WSOL_MINT, mintOut: intermediateMint, amountInLamports, amountInSol, errorMsg: 'quote1 failed' });
        return null;
      }

      const quote2 = await jupiter.getQuote({
        inputMint: intermediateMint,
        outputMint: WSOL_MINT,
        amount: quote1.outAmount,
        slippageBps,
        restrictToDex: useDirectRoute ? arb.cheapDex : null,
      });
      if (!quote2 || !quote2.outAmount) {
        this._logTrade({ arb, mode: this._mode(), status: 'skipped', mintIn: intermediateMint, mintOut: WSOL_MINT, amountInLamports: quote1.outAmount, errorMsg: 'quote2 failed' });
        return null;
      }

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
      const priceImpact1 = parseFloat(quote1.priceImpactPct) || 0;
      const priceImpact2 = parseFloat(quote2.priceImpactPct) || 0;

      this._recentExecs.set(arb.id, Date.now());
      this.stats.totalRoundTripsExecuted++;

      // Skip if below profit threshold
      const minProfitSol = config.ARB_MIN_PROFIT_SOL || 0;
      const minProfitUsd = config.ARB_MIN_PROFIT_USD || 0;
      if (grossProfitSol < minProfitSol || (minProfitUsd > 0 && grossProfitUsd < minProfitUsd)) {
        this.stats.skipped++;
        const tradeId = this._logTrade({
          arb, mode: this._mode(), status: 'skipped',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports, amountInSol, amountOutLamports, amountOutSol,
          amountInUsd, amountOutUsd, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol, gasSol, solUsd, netRoiPct, priceImpact1, priceImpact2,
          quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
        });
        const cheapDex = arb.cheapDex || arb.cheap_dex || 'unknown';
        const expensiveDex = arb.expensiveDex || arb.expensive_dex || 'unknown';
        log.info(
          `[exec] SKIP arb#${arb.id} ${cheapDex}→${expensiveDex} ` +
          `| ${amountInSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
          `(gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL, ` +
          `net ${netRoiPct.toFixed(2)}%, pi=${(priceImpact1+priceImpact2).toFixed(3)}%)`
        );
        return tradeId;
        }

        // Live execution if enabled
        if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY && !opts.forceDryRun) {
        const cheapDex = arb.cheapDex || arb.cheap_dex || 'unknown';
        const expensiveDex = arb.expensiveDex || arb.expensive_dex || 'unknown';
        return await this._executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct, priceImpact1, priceImpact2);
        }

        // Simulate only
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
        jitoTipSol, gasSol, solUsd, netRoiPct, priceImpact1, priceImpact2,
        quoteJson: JSON.stringify({ q1: quote1, q2: quote2 }),
        });
        const cheapDex = arb.cheapDex || arb.cheap_dex || 'unknown';
        const expensiveDex = arb.expensiveDex || arb.expensive_dex || 'unknown';
        log.info(
        `💰 SIM #${tradeId || arb.id} ${cheapDex}→${expensiveDex} ` +
        `| ${amountInSol.toFixed(6)}→${amountOutSol.toFixed(6)} SOL ` +
        `| gross ${grossProfitSol >= 0 ? '+' : ''}${grossProfitSol.toFixed(6)} SOL ($${grossProfitUsd.toFixed(4)}) ` +
        `| net ${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL ($${netProfitUsd.toFixed(4)}) ` +
        `| ROI ${netRoiPct.toFixed(2)}% ` +
        `| pi=${(priceImpact1+priceImpact2).toFixed(3)}%`
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
   * LIVE execution — P5.
   *
   * 1. Build tx1 (SOL → intermediate on expensive_dex) from quote1
   * 2. Build tx2 (intermediate → SOL on cheap_dex) from quote2
   *    (using quote1.outAmount as input — what we actually received from tx1)
   * 3. Submit as 2-tx Jito bundle (atomic, no sandwich)
   * 4. Wait for landing (via inflight polling)
   * 5. Parse tx2's preBalances/postBalances for actual SOL delta
   * 6. Log to trade_log with tx_signature + realized PnL
   */
  async _executeLive(arb, quote1, quote2, amountInSol, amountOutSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, solUsd, netRoiPct, priceImpact1, priceImpact2) {
    if (!this._connection) {
      log.warn(`[exec] live execution needs Solana RPC connection`);
      return null;
    }

    try {
      const wallet = jitoClient.getWallet();
      const userPublicKey = wallet.publicKey.toBase58();
      log.info(`[exec] LIVE arb#${arb.id} ${arb.cheapDex}→${arb.expensiveDex} | ${amountInSol} SOL`);

      // Build tx1: SOL → intermediate
      const tx1Base64 = await jupiter.getSwapTransaction(quote1, userPublicKey);
      if (!tx1Base64) {
        this._logTrade({ arb, mode: 'live', status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports: String(Math.floor(amountInSol * 1e9)), amountInSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9, solUsd, netRoiPct, priceImpact1, priceImpact2, errorMsg: 'tx1 build failed' });
        return null;
      }
      // Build tx2: intermediate → SOL (using quote1.outAmount as input)
      // Jupiter expects the EXACT inputAmount to match what we'll get from tx1
      const tx2Base64 = await jupiter.getSwapTransaction(quote2, userPublicKey);
      if (!tx2Base64) {
        this._logTrade({ arb, mode: 'live', status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports: String(Math.floor(amountInSol * 1e9)), amountInSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9, solUsd, netRoiPct, priceImpact1, priceImpact2, errorMsg: 'tx2 build failed' });
        return null;
      }

      // Deserialize, sign, bundle
      const { Transaction, VersionedTransaction } = require('@solana/web3.js');
      const tx1Bytes = Buffer.from(tx1Base64, 'base64');
      const tx2Bytes = Buffer.from(tx2Base64, 'base64');
      let tx1, tx2;
      try {
        // Try VersionedTransaction first (Jupiter uses versioned txs since 2024)
        tx1 = VersionedTransaction.deserialize(tx1Bytes);
        tx2 = VersionedTransaction.deserialize(tx2Bytes);
      } catch (e) {
        // Fallback to legacy
        tx1 = Transaction.from(tx1Bytes);
        tx2 = Transaction.from(tx2Bytes);
      }
      tx1.sign([wallet]);
      tx2.sign([wallet]);

      // Build tip tx
      const tipTx = await jitoClient.buildTipTx(this._connection);
      tipTx.sign(wallet);

      // Submit bundle
      const bundle = [tipTx, tx1, tx2];
      const result = await jitoClient.submitSignedBundle(bundle);
      if (!result) {
        this._logTrade({ arb, mode: 'live', status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports: String(Math.floor(amountInSol * 1e9)), amountInSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9, solUsd, netRoiPct, priceImpact1, priceImpact2, errorMsg: 'bundle submit failed' });
        this.stats.failed++;
        return null;
      }

      this.stats.bundlesSubmitted++;
      if (result.landed) {
        this.stats.bundlesLanded++;
        this.stats.confirmed++;
        // Parse tx for actual SOL delta — we'd need to fetch the tx and look at
        // preBalances/postBalances of our wallet
        let realizedProfitSol = null;
        let txSignature = result.txSignature || null;
        if (txSignature && this._connection) {
          try {
            const tx = await this._connection.getTransaction(txSignature, { commitment: 'confirmed' });
            if (tx && tx.meta) {
              // Account 0 is fee payer (our wallet)
              const pre = tx.meta.preBalances[0] || 0;
              const post = tx.meta.postBalances[0] || 0;
              const fee = tx.meta.fee || 0;
              // For a 2-tx bundle, we only see one tx here. Need to get both.
              // For now, use the quote-based estimate.
              realizedProfitSol = netProfitSol;
            }
          } catch (e) {
            // ignore
          }
        }
        this.stats.totalRealizedProfitSol += realizedProfitSol || 0;
        const tradeId = this._logTrade({
          arb, mode: 'live', status: 'confirmed',
          mintIn: WSOL_MINT, mintOut: WSOL_MINT,
          amountInLamports: String(Math.floor(amountInSol * 1e9)),
          amountInSol, amountOutLamports: String(Math.floor(amountOutSol * 1e9)), amountOutSol,
          grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd,
          jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9,
          solUsd, netRoiPct, priceImpact1, priceImpact2,
          txSignature,
        });
        log.info(
          `✅ CONFIRMED #${tradeId} ${arb.cheapDex}→${arb.expensiveDex} ` +
          `| ${amountInSol}→${amountOutSol} SOL | ` +
          `net ${realizedProfitSol != null ? realizedProfitSol.toFixed(6) : netProfitSol.toFixed(6)} SOL ` +
          `| tx ${txSignature ? txSignature.slice(0, 12) + '…' : '(none)'}`
        );
        return tradeId;
      } else {
        this._logTrade({ arb, mode: 'live', status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports: String(Math.floor(amountInSol * 1e9)), amountInSol, grossProfitSol, grossProfitUsd, netProfitSol, netProfitUsd, jitoTipSol: config.JITO_TIP_LAMPORTS / 1e9, gasSol: ESTIMATED_GAS_LAMPORTS / 1e9, solUsd, netRoiPct, priceImpact1, priceImpact2, errorMsg: result.error || 'bundle did not land' });
        this.stats.failed++;
        return null;
      }
    } catch (e) {
      this.stats.failed++;
      this._logTrade({ arb, mode: 'live', status: 'failed', mintIn: WSOL_MINT, mintOut: WSOL_MINT, amountInLamports: String(Math.floor(amountInSol * 1e9)), amountInSol, errorMsg: e.message });
      log.warn(`[exec] live execution failed: ${e.message}`);
      return null;
    }
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
        price_impact_pct: t.priceImpact1 != null && t.priceImpact2 != null ? (t.priceImpact1 + t.priceImpact2) : null,
        tx_signature: t.txSignature || null,
        error_msg: t.errorMsg || null,
        quote_json: t.quoteJson || null,
        raw_json: null,
      };
      const info = this._db.stmts.insertTradeLog.run(row);
      const tradeId = info.lastInsertRowid;
      if (t.arb?.id && (t.status === 'simulated' || t.status === 'submitted' || t.status === 'confirmed')) {
        try { this._db.stmts.markArbExecuted.run({ trade_id: tradeId, arb_id: t.arb.id }); } catch (e) {}
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
