'use strict';

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const Detector = require('./detector');
const newPoolMonitor = require('./newPoolMonitor');
const pumpfunMonitor = require('./pumpfunMonitor');
const telegramBot = require('./telegramBot');
const notifier = require('./notifier');
const safety = require('./safety');

async function main() {
  log.info('🔥 Ferreus — Solana Arbitrage Detector v0.2.0 (dual-detector)');
  log.info(
    `Mode: ${config.DRY_RUN ? 'DRY_RUN' : 'LIVE'} | ` +
    `Poll: ${config.POLL_INTERVAL_MS}ms | ` +
    `Min gap: ${config.MIN_GAP_BPS}bps | Min TVL: $${config.MIN_TVL_USD}`
  );
  log.info('Detectors: A=DEX-DEX gap | B=new-pool events | C=Pumpfun migration');

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
  newPoolMonitor.attachDb(database);
  pumpfunMonitor.attachDb(database);
  newPoolMonitor.start();
  pumpfunMonitor.start();

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
      `poll ${config.POLL_INTERVAL_MS}ms, ${detector.tokens.length} tokens, ` +
      `monitoring 6 DEX programs + Pumpfun migration`
    );
  }

  log.info('[main] all detectors running. Ctrl+C to stop.');

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

      // Periodic stats summary
      if (notifier.isReady() && Date.now() - lastStatsNotif > STATS_INTERVAL) {
        const npStats = newPoolMonitor.getStats();
        const pfStats = pumpfunMonitor.getStats();
        await notifier.info(
          `📊 ${Math.round((Date.now() - startTs) / 60000)}min uptime\n` +
          `Detector A (DEX-DEX): ${totalOpps} opps\n` +
          `Detector B (new-pool): ${npStats.createEvents} events from ${npStats.sigsSeen} sigs (${npStats.ticks} ticks)\n` +
          `Detector C (pumpfun):  ${pfStats.migrationEvents} migrations from ${pfStats.sigsSeen} sigs`
        );
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
process.on('SIGINT', async () => {
  log.info('[main] SIGINT received, stopping detectors...');
  newPoolMonitor.stop();
  pumpfunMonitor.stop();
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGTERM', async () => {
  log.info('[main] SIGTERM received, stopping detectors...');
  newPoolMonitor.stop();
  pumpfunMonitor.stop();
  setTimeout(() => process.exit(0), 500);
});

main().catch(e => {
  log.error(`[main] fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});