'use strict';

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const Detector = require('./detector');
const newPoolMonitor = require('./newPoolMonitor');
const pumpfunMonitor = require('./pumpfunMonitor');
const decoderWorker = require('./decoderWorker');
const poolSubscription = require('./poolSubscription');
const jitoTip = require('./jitoTip');
const coingecko = require('./coingecko');
const telegramBot = require('./telegramBot');
const notifier = require('./notifier');
const safety = require('./safety');

async function main() {
  const enabled = new Set(config.ENABLED_DETECTORS);
  const hasA = enabled.has('dex_dex');
  const hasB = enabled.has('new_pool');
  const hasC = enabled.has('pumpfun');
  const hasD = enabled.has('pool_watch');
  const enabledList = [
    hasA && 'A:DEX-DEX gap',
    hasB && 'B:new-pool events',
    hasC && 'C:Pumpfun migration',
    hasD && 'D:pool-watch (WSS)',
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
  if (hasD) {
    poolSubscription.attachDb(database);
    await poolSubscription.start();
  } else {
    log.info('[main] Detector D (pool-watch) DISABLED — set ENABLED_DETECTORS=pool_watch to enable');
  }

  // --- Auxiliary signals (CoinGecko trending, Jito tip floor) ---
  // CoinGecko: refresh every 5 min — slow signal, mostly informational
  let lastTrendingRefresh = 0;
  const TRENDING_REFRESH_MS = 5 * 60 * 1000;

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

  // Install signal handlers (closure-scoped to hasB/hasC)
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', gracefulShutdown('SIGINT'));
  process.on('SIGTERM', gracefulShutdown('SIGTERM'));

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
        let msg = `📊 ${Math.round((Date.now() - startTs) / 60000)}min uptime\n` +
          `Detector A (DEX-DEX): ${totalOpps} opps`;
        if (npStats) {
          msg += `\nDetector B (new-pool): ${npStats.createEvents} events from ${npStats.sigsSeen} sigs (${npStats.ticks} ticks)`;
        }
        if (pfStats) {
          msg += `\nDetector C (pumpfun):  ${pfStats.migrationEvents} migrations from ${pfStats.sigsSeen} sigs`;
        }
        await notifier.info(msg);
        lastStatsNotif = Date.now();
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

// Graceful shutdown
function gracefulShutdown(signal) {
  return () => {
    log.info(`[main] ${signal} received, stopping detectors...`);
    if (hasB) newPoolMonitor.stop();
    if (hasC) pumpfunMonitor.stop();
    if (hasB || hasC) decoderWorker.stop();
    if (hasD) poolSubscription.stop();
    setTimeout(() => process.exit(0), 1000);
  };
}
// Note: these handlers are set inside main() because `hasB`/`hasC` are closure-scoped.
// To keep behavior simple & safe, install them in main() below.


main().catch(e => {
  log.error(`[main] fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});