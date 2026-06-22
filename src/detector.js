'use strict';

const config = require('./config');
const log = require('./logger');
const jupiter = require('./jupiterClient');
const dexscreener = require('./dexScreener');
const safety = require('./safety');

class Detector {
  constructor(db) {
    this.db = db;
    this.tokens = [];
    this.cursor = 0;
    this.scannedThisRun = 0;
  }

  /**
   * Refresh the active token list from Jupiter strict.
   * Called on startup + every TOKEN_LIST_REFRESH_MS.
   */
  async refreshTokenList() {
    const list = await jupiter.getTokenList();
    this.tokens = list
      .filter(t => t.address && t.symbol && t.name)
      .slice(0, config.DETECT_TOP_N);
    this.cursor = 0;
    log.info(`[detector] token list: ${this.tokens.length} active candidates`);
  }

  /**
   * One detector tick. Round-robins through the token list.
   * Returns number of opportunities logged this tick.
   */
  async tick() {
    if (this.tokens.length === 0) {
      await this.refreshTokenList();
      return 0;
    }
    const batchSize = config.SCAN_BATCH_SIZE;
    let found = 0;
    for (let i = 0; i < batchSize; i++) {
      const t = this.tokens[this.cursor];
      this.cursor = (this.cursor + 1) % this.tokens.length;
      if (!t) continue;
      try {
        const opp = await this.scanToken(t);
        if (opp) {
          const id = await this.logOpportunity(opp);
          opp.id = id;
          found++;
        }
      } catch (e) {
        log.warn(`[detector] scan ${t.symbol} failed: ${e.message}`);
      }
      // Avoid hammering DexScreener
      await sleep(200);
    }
    this.scannedThisRun += batchSize;
    return found;
  }

  /**
   * Scan a single token for cross-DEX price gap.
   * Returns an opportunity object or null.
   */
  async scanToken(token) {
    const pairs = await dexscreener.getTokenPairs(token.address);
    if (pairs.length < 2) return null;

    const byDex = dexscreener.groupByDex(pairs);
    if (byDex.length < 2) return null;

    // Find lowest (buy) and highest (sell) price
    let bestBuy = null;
    let bestSell = null;
    for (const p of byDex) {
      if (!bestBuy || p.price < bestBuy.price) bestBuy = p;
      if (!bestSell || p.price > bestSell.price) bestSell = p;
    }
    if (!bestBuy || !bestSell || bestBuy.dexId === bestSell.dexId) return null;

    const minPrice = bestBuy.price;
    const maxPrice = bestSell.price;
    const gapBps = ((maxPrice - minPrice) / minPrice) * 10000;
    if (gapBps < config.MIN_GAP_BPS) return null;

    // Liquidity floor
    const minLiq = Math.min(bestBuy.liquidity, bestSell.liquidity);
    if (minLiq < config.MIN_TVL_USD) return null;

    // Trade sizing: max 1% of smaller pool (avoid slippage death)
    const sizeUsd = Math.min(config.TRADE_SIZE_USD, minLiq * 0.01);
    const estGrossUsd = (gapBps / 10000) * sizeUsd;
    // Solana gas ~$0.005/tx typical, x2 legs = $0.01
    const estGasUsd = 0.01;
    const estNetUsd = estGrossUsd - estGasUsd;
    if (estNetUsd < 0.5) return null; // not worth it

    return {
      token_mint: token.address,
      token_symbol: token.symbol,
      buy_dex: bestBuy.dexId,
      sell_dex: bestSell.dexId,
      buy_price_usd: minPrice,
      sell_price_usd: maxPrice,
      gap_bps: gapBps,
      buy_liquidity_usd: bestBuy.liquidity,
      sell_liquidity_usd: bestSell.liquidity,
      min_liquidity_usd: minLiq,
      trade_size_usd: sizeUsd,
      est_gross_usd: estGrossUsd,
      est_gas_usd: estGasUsd,
      est_net_usd: estNetUsd,
      raw: { byDex, token },
    };
  }

  /**
   * Persist opportunity to SQLite. Returns the inserted row id.
   */
  async logOpportunity(opp) {
    const stmt = this.db.prepare(`
      INSERT INTO arb_log
      (ts, token_mint, token_symbol, buy_dex, sell_dex, buy_price_usd, sell_price_usd,
       gap_bps, buy_liquidity_usd, sell_liquidity_usd, min_liquidity_usd, trade_size_usd,
       est_gross_usd, est_gas_usd, est_net_usd, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      Date.now(),
      opp.token_mint, opp.token_symbol, opp.buy_dex, opp.sell_dex,
      opp.buy_price_usd, opp.sell_price_usd, opp.gap_bps,
      opp.buy_liquidity_usd, opp.sell_liquidity_usd, opp.min_liquidity_usd,
      opp.trade_size_usd, opp.est_gross_usd, opp.est_gas_usd, opp.est_net_usd,
      JSON.stringify(opp.raw),
    );
    log.info(
      `[detector] GAP ${opp.gap_bps.toFixed(1)}bps ${opp.token_symbol} ` +
      `${opp.buy_dex}→${opp.sell_dex} ~$${opp.est_net_usd.toFixed(2)} net ` +
      `(id=${result.lastInsertRowid})`
    );
    return result.lastInsertRowid;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = Detector;
