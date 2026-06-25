'use strict';

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const Detector = require('./detector');
const newPoolMonitor = require('./newPoolMonitor');
const pumpfunMonitor = require('./pumpfunMonitor');
const decoderWorker = require('./decoderWorker');
const poolSubscription = require('./poolSubscription');
const arbDetector = require('./arbDetector');
const vaultReader = require('./vaultReader');
const executor = require('./executor');
const jitoClient = require('./jitoClient');
const jitoTip = require('./jitoTip');
const coingecko = require('./coingecko');
const priceOracle = require('./priceOracle');
const weirdDetector = require('./weirdDetector');
const pathFinder = require('./pathFinder');
const telegramBot = require('./telegramBot');
const notifier = require('./notifier');
const safety = require('./safety');

async function main() {
  const enabled = new Set(config.ENABLED_DETECTORS);
  const hasA = enabled.has('dex_dex');
  const hasB = enabled.has('new_pool');
  const hasC = enabled.has('pumpfun');
  const hasD = enabled.has('pool_watch');
  const hasE = enabled.has('pool_arb');
  const enabledList = [
    hasA && 'A:DEX-DEX gap',
    hasB && 'B:new-pool events',
    hasC && 'C:Pumpfun migration',
    hasD && 'D:pool-watch (WSS)',
    hasE && 'E:cross-DEX arb',
  ].filter(Boolean).join(' | ') || 'NONE';

  log.info(`🔥 Ferreus — Solana Arbitrage Detector`);
  log.info(
    `Mode: ${config.DRY_RUN ? 'DRY_RUN' : 'LIVE'} | ` +
    `Poll: ${config.POLL_INTERVAL_MS}ms | ` +
    `Min gap: ${config.MIN_GAP_BPS}bps | Min TVL: $${config.MIN_TVL_USD}`
  );
  log.info(`Enabled detectors: ${enabledList}`);

  // --- DB ---
  const database = db.init();
  log.info(`[db] ready at ${config.DB_PATH}`);

  // --- Telegram bot ---
  const bot = telegramBot.create(database);
  if (bot) {
    await telegramBot.launch();
  } else {
    log.warn('[main] running WITHOUT Telegram notifier — log to console + DB only');
  }

  // --- Detector A: DEX-DEX gap (existing, async polling inside its own loop) ---
  const detector = new Detector(database);
  await detector.refreshTokenList();

  // --- P5: Live execution wiring ---
  // If LIVE_EXECUTE is on, load wallet and pass Solana connection to executor.
  if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
    try {
      jitoClient.loadWallet();
      const { Connection: SolConn } = require('@solana/web3.js');
      const liveConn = new SolConn(config.RPC_URL, 'confirmed');
      executor.setConnection(liveConn);
      log.warn(`[boot] LIVE_EXECUTE=true, wallet=${jitoClient.getWallet().publicKey.toBase58().slice(0,8)}…`);
    } catch (e) {
      log.error(`[boot] live setup failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    log.info(`[boot] DRY_RUN mode (set LIVE_EXECUTE=true + WALLET_PRIVATE_KEY to go live)`);
  }
  executor.attachDb(database);

  // Pre-load decimals for arb detector (covers Orca Whirlpool which doesn't store decimals on-chain)
  arbDetector.setDecimalsBulk(detector.tokens);

  // Pre-load wallet for live mode (Phase Pool-5)
  if (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY) {
    try { jitoClient.loadWallet(); } catch (e) { log.warn(`[main] wallet load failed: ${e.message}`); }
  }

  // Hook notifier into logOpportunity
  const origLog = detector.logOpportunity.bind(detector);
  detector.logOpportunity = async (opp) => {
    const id = await origLog(opp);
    opp.id = id;
    const sent = await notifier.opportunityDetected(opp);
    if (sent) {
      try {
        database.stmts.insertArbLog; // no-op: re-use prepared
        database.db.prepare('UPDATE arb_log SET notified = 1 WHERE id = ?').run(id);
      } catch (_) { /* non-fatal */ }
    }
    return id;
  };

  // --- Detectors B + C: event-driven monitors (self-managed timers) ---
  if (hasB) {
    newPoolMonitor.attachDb(database);
    newPoolMonitor.start();
  } else {
    log.info('[main] Detector B (new-pool) DISABLED — set ENABLED_DETECTORS=new_pool to enable');
  }
  if (hasC) {
    pumpfunMonitor.attachDb(database);
    pumpfunMonitor.start();
  } else {
    log.info('[main] Detector C (pumpfun) DISABLED — set ENABLED_DETECTORS=pumpfun to enable');
  }

  // --- P1 Decoder worker: only run if B or C active ---
  if (hasB || hasC) {
    decoderWorker.attachDb(database);
    decoderWorker.start();
  } else {
    log.info('[main] Decoder worker DISABLED (no B/C detectors active)');
  }

  // --- Detector D: pool-watch (WSS subscription) — Phase Pool-1 of dead-pool MEV ---
  // Detector E (cross-DEX arb) starts automatically with D (uses same data)
  if (hasD) {
    poolSubscription.attachDb(database);
    // Wire weird-pool detector (Phase Weird-1/2/3) — pivot to "find exotic pools"
    weirdDetector.attachDb(database);
    weirdDetector.setPathFinder(pathFinder);
    poolSubscription.onNewPool((pool) => weirdDetector.onNewPool(pool));
    await poolSubscription.start();
    if (hasE) arbDetector.start();
  } else {
    log.info('[main] Detector D (pool-watch) DISABLED — set ENABLED_DETECTORS=pool_watch to enable');
    if (hasE) {
      log.warn('[main] Detector E (pool-arb) requires Detector D — starting pool-watch too');
      poolSubscription.attachDb(database);
      weirdDetector.attachDb(database);
      weirdDetector.setPathFinder(pathFinder);
      poolSubscription.onNewPool((pool) => weirdDetector.onNewPool(pool));
      await poolSubscription.start();
      arbDetector.start();
    }
  }
  const TRENDING_REFRESH_MS = 5 * 60 * 1000;
  let lastTrendingRefresh = 0;
  let lastPriceRefresh = 0;
  let lastArbProcess = 0;

  // Jito tip: refresh every 60s (cached internally), show at startup
  const initialTip = await jitoTip.getTipFloor();
  if (initialTip) {
    log.info(`[main] Jito tip floor ready — p50=${(initialTip.p50_lamports/1e9).toFixed(4)} SOL`);
  }

  // --- Detector A loop (separate from B/C which self-tick) ---
  let totalOpps = 0;
  let lastTokenListRefresh = Date.now();
  const startTs = Date.now();

  // Hook new-pool DB insert for Telegram notif (best-effort, doesn't block detector)
  const origInsertNewPool = database.stmts.insertNewPool;
  // (newPoolMonitor already calls database.stmts.insertNewPool internally;
  //  we post-facto notify by polling DB or via wrapping. Keep simple: just log here.)

  // --- Startup notif ---
  if (notifier.isReady()) {
    await notifier.info(
      `Ferreus online — DRY_RUN=${config.DRY_RUN}, ` +
      `poll ${config.POLL_INTERVAL_MS}ms, ${detector.tokens.length} tokens\n` +
      `Detectors: ${enabledList}`
    );
  }

  log.info('[main] all detectors running. Ctrl+C to stop.');

  // Install signal handlers (safe — operates on module-level detector refs)
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  setupShutdownHandlers();

  // Periodic stats summary

  // --- Periodic stats notif + token list refresh ---
  let lastStatsNotif = 0;
  const STATS_INTERVAL = 600000; // 10 min

  while (true) {
    try {
      if (!safety.isPaused()) {
        const found = await detector.tick();
        totalOpps += found;
      }

      // Periodic token list refresh (hourly)
      if (Date.now() - lastTokenListRefresh > config.TOKEN_LIST_REFRESH_MS) {
        try {
          await detector.refreshTokenList();
          arbDetector.setDecimalsBulk(detector.tokens);
          lastTokenListRefresh = Date.now();
        } catch (e) {
          log.warn(`[main] token list refresh: ${e.message}`);
        }
      }

      // CoinGecko trending refresh (5 min)
      if (Date.now() - lastTrendingRefresh > TRENDING_REFRESH_MS) {
        try {
          const solTrending = await coingecko.getSolanaTrending();
          if (solTrending.length > 0) {
            const top = solTrending.slice(0, 5).map(t => `${t.symbol}(#${t.marketCapRank || '?'})`).join(', ');
            log.info(`[coingecko] Solana trending top 5: ${top}`);
          }
          lastTrendingRefresh = Date.now();
        } catch (e) {
          log.warn(`[main] coingecko trending refresh: ${e.message}`);
        }
      }

      // Periodic stats summary
      if (notifier.isReady() && Date.now() - lastStatsNotif > STATS_INTERVAL) {
        const npStats = hasB ? newPoolMonitor.getStats() : null;
        const pfStats = hasC ? pumpfunMonitor.getStats() : null;
        const poolStats = hasD ? poolSubscription.getStats() : null;
        const arbStats = (hasD && hasE) ? arbDetector.getStats() : null;
        const vaultStats = (hasD && config.VAULT_READER_ENABLED) ? vaultReader.getStats() : null;
        const execStats = (hasD && hasE) ? executor.getStats() : null;
        const weirdStats = hasD ? weirdDetector.getStats() : null;
        const pathStats = hasD ? pathFinder.getStats() : null;
        let msg = `📊 ${Math.round((Date.now() - startTs) / 60000)}min uptime\n` +
          `Detector A (DEX-DEX): ${totalOpps} opps`;
        if (npStats) {
          msg += `\nDetector B (new-pool): ${npStats.createEvents} events from ${npStats.sigsSeen} sigs (${npStats.ticks} ticks)`;
        }
        if (pfStats) {
          msg += `\nDetector C (pumpfun):  ${pfStats.migrationEvents} migrations from ${pfStats.sigsSeen} sigs`;
        }
        if (poolStats) {
          msg += `\nDetector D (pool-watch): ${poolStats.events} events, ${poolStats.decoded} decoded, ${poolStats.errors} errs, ${poolStats.newPoolsDetected} new pools`;
        }
        if (arbStats) {
          msg += `\nDetector E (pool-arb): ${arbStats.gapsLogged} arbs logged, ${arbStats.pairsTracked} pairs tracked`;
        }
        if (vaultStats && vaultStats.poolsTracked > 0) {
          msg += `\nVault reader: ${vaultStats.vaultsCached}/${vaultStats.vaultsTracked} cached, ${vaultStats.refreshes} refreshes`;
        }
        if (execStats && (execStats.simulated + execStats.submitted + execStats.failed) > 0) {
          msg += `\nExecutor: ${execStats.simulated} sim, ${execStats.failed} fail, est profit=${execStats.totalGrossProfitSol.toFixed(6)} SOL`;
        }
        if (weirdStats) {
          msg += `\nWeird detector: ${weirdStats.newPoolsSeen} new pools seen, ${weirdStats.weirdPoolsFound} weird flagged, ${weirdStats.pathsFound} paths`;
        }
        await notifier.info(msg);
        lastStatsNotif = Date.now();
      }

      // --- Pool-2.6: USD price refresh (every 60s) ---
      if (Date.now() - lastPriceRefresh > 60000) {
        try {
          const usdPrices = await priceOracle.getPriceUsdBulk([
            'So11111111111111111111111111111111111111112',  // wSOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          ]);
          arbDetector.setUsdPriceCache(usdPrices);
          lastPriceRefresh = Date.now();
        } catch (e) {
          log.warn(`[main] USD price refresh: ${e.message}`);
        }
      }

      // --- Pool-3: process new arbs (every 10s) ---
      // Jupiter throttle: 1 RPS + 2 quotes per arb = 1 arb every ~2.5s
      // Poll every 10s to keep rate of new arb attempts sustainable
      // Run if DRY_RUN (simulate) OR LIVE_EXECUTE with key (real)
      const executionEnabled = config.DRY_RUN || (config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY);
      if (Date.now() - lastArbProcess > 10000 && executionEnabled) {
        try {
          // Find arbs that haven't been executed yet
          const newArbs = database.db.prepare(`
            SELECT * FROM arb_candidates
            WHERE executed = 0
            ORDER BY ts DESC LIMIT 5
          `).all();
          for (const arb of newArbs) {
            // safety guard
            const guard = await safety.guardTrade({
              tradeSizeSol: config.ARB_TRADE_SIZE_SOL,
              expectedProfitSol: (arb.gap_bps || 0) / 10000 * config.ARB_TRADE_SIZE_SOL * 0.5,  // rough estimate
              mintIn: 'So11111111111111111111111111111111111111112',
              mintOut: 'So11111111111111111111111111111111111111112',
              connection: executor._connection,
              walletPubkey: config.LIVE_EXECUTE && jitoClient.getWallet() ? jitoClient.getWallet().publicKey : null,
            });
            if (!guard.ok) {
              log.info(`[main] guard reject arb#${arb.id}: ${guard.reason}`);
              continue;
            }
            await executor.execute(arb);
          }
          lastArbProcess = Date.now();
        } catch (e) {
          log.warn(`[main] arb processing: ${e.message}`);
        }
      }
    } catch (e) {
      log.error(`[main] loop error: ${e.message}`);
    }
    await sleep(config.POLL_INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Graceful shutdown — installed in main() (needs closure over detectors)
function setupShutdownHandlers() {
  const handlers = ['SIGINT', 'SIGTERM'];
  const cleanup = (signal) => {
    log.info(`[main] ${signal} received, stopping detectors...`);
    // best-effort: try to stop everything we know about
    try { if (typeof newPoolMonitor !== 'undefined') newPoolMonitor.stop(); } catch (e) {}
    try { if (typeof pumpfunMonitor !== 'undefined') pumpfunMonitor.stop(); } catch (e) {}
    try { if (typeof decoderWorker !== 'undefined') decoderWorker.stop(); } catch (e) {}
    try { if (typeof poolSubscription !== 'undefined') poolSubscription.stop(); } catch (e) {}
    try { if (typeof arbDetector !== 'undefined') arbDetector.stop(); } catch (e) {}
    try { if (typeof coingecko !== 'undefined') coingecko.stop && coingecko.stop(); } catch (e) {}
    setTimeout(() => process.exit(0), 1000);
  };
  for (const sig of handlers) process.on(sig, () => cleanup(sig));
}


main().catch(e => {
  log.error(`[main] fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});