'use strict';

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const Detector = require('./detector');
const telegramBot = require('./telegramBot');
const notifier = require('./notifier');
const safety = require('./safety');

async function main() {
  log.info('🔥 Ferreus — Solana Arbitrage Detector v0.1.0');
  log.info(
    `Mode: ${config.DRY_RUN ? 'DRY_RUN' : 'LIVE'} | ` +
    `Poll: ${config.POLL_INTERVAL_MS}ms × ${config.SCAN_BATCH_SIZE}/tick | ` +
    `Min gap: ${config.MIN_GAP_BPS}bps | Min TVL: $${config.MIN_TVL_USD}`
  );

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

  // --- Detector ---
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
        database.prepare('UPDATE arb_log SET notified = 1 WHERE id = ?').run(id);
      } catch (_) { /* non-fatal */ }
    }
    return id;
  };

  // --- Startup notif ---
  if (notifier.isReady()) {
    await notifier.info(
      `Ferreus online — DRY_RUN=${config.DRY_RUN}, ` +
      `poll ${config.POLL_INTERVAL_MS}ms, ${detector.tokens.length} tokens in list`
    );
  }

  // --- Main loop ---
  log.info('[main] starting detector loop...');
  const startTs = Date.now();
  let totalOpps = 0;
  while (true) {
    try {
      if (!safety.isPaused()) {
        const found = await detector.tick();
        totalOpps += found;
      }
    } catch (e) {
      log.error(`[main] tick error: ${e.message}`);
    }
    await sleep(config.POLL_INTERVAL_MS);

    // Periodic token list refresh
    if (Date.now() - startTs > 0 && (Date.now() - startTs) % config.TOKEN_LIST_REFRESH_MS < config.POLL_INTERVAL_MS) {
      try {
        await detector.refreshTokenList();
      } catch (e) {
        log.warn(`[main] token list refresh: ${e.message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('[main] SIGINT received, exiting...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log.info('[main] SIGTERM received, exiting...');
  process.exit(0);
});

main().catch(e => {
  log.error(`[main] fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
