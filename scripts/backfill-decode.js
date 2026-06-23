'use strict';

/**
 * Backfill decoder — re-process historical new_pools sigs that haven't been
 * decoded yet. Useful after upgrading to P1 to find real opportunities from
 * data already collected.
 *
 * Usage: node scripts/backfill-decode.js [--reset] [--limit N]
 *   --reset   clear decode state for all rows (re-process from scratch)
 *   --limit   max rows to process (default: all undecoded)
 */

const log = require('../src/logger');
const db = require('../src/db');
const decoderWorker = require('../src/decoderWorker');

async function run() {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const limitArg = args.find(a => a.startsWith('--limit'));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 999999;

  log.info(`=== Backfill decoder === reset=${reset} limit=${limit}`);

  const database = db.init();
  decoderWorker.attachDb(database);

  if (reset) {
    const r = database.db.prepare('UPDATE new_pools SET decoded = 0, decode_attempts = 0, decode_reason = NULL').run();
    log.info(`[reset] cleared decode state for ${r.changes} rows`);
  }

  const initialUndecoded = database.db.prepare(
    `SELECT COUNT(*) AS c FROM new_pools WHERE decode_attempts = 0`
  ).get().c;
  log.info(`[backfill] ${initialUndecoded} fresh rows to process (decode_attempts=0)`);

  const startTs = Date.now();
  let totalBatches = 0;

  while (true) {
    const remaining = database.db.prepare(
      `SELECT COUNT(*) AS c FROM new_pools WHERE decode_attempts = 0`
    ).get().c;
    if (remaining === 0) break;
    const stats = decoderWorker.getStats();
    const processed = stats.decoded + stats.falsePositives;
    if (processed >= limit) break;

    log.info(`[backfill] ${remaining} fresh rows remaining, batch ${totalBatches + 1}...`);
    const beforeStats = decoderWorker.getStats();
    await decoderWorker.tick();
    const afterStats = decoderWorker.getStats();
    const processedThisBatch = (afterStats.decoded + afterStats.falsePositives) - (beforeStats.decoded + beforeStats.falsePositives);
    totalBatches += 1;
    if (processedThisBatch === 0) {
      log.warn(`[backfill] no progress this batch, breaking to avoid infinite loop`);
      break;
    }
  }

  const stats = decoderWorker.getStats();
  log.info(`\n=== Backfill complete ===`);
  log.info(`  Duration: ${Math.round((Date.now() - startTs) / 1000)}s, ${totalBatches} batches`);
  log.info(`  Decoded: ${stats.decoded}`);
  log.info(`  False positives: ${stats.falsePositives}`);
  log.info(`  Errors: ${stats.errors}`);
  log.info(`  Opportunities logged: ${stats.opportunitiesLogged}`);

  // Summary breakdown by program
  const summary = database.db.prepare(`
    SELECT program,
           COUNT(*) as total,
           SUM(CASE WHEN decoded=1 THEN 1 ELSE 0 END) as real_pools,
           SUM(CASE WHEN decoded=0 AND decode_attempts > 0 THEN 1 ELSE 0 END) as false_pos,
           ROUND(AVG(CASE WHEN gap_bps IS NOT NULL THEN ABS(gap_bps) END), 1) as avg_gap_bps
    FROM new_pools
    GROUP BY program
  `).all();
  log.info(`\n  By program:`);
  for (const r of summary) {
    log.info(`    ${r.program.padEnd(18)} total=${r.total} real=${r.real_pools} fp=${r.false_pos} avg_gap=${r.avg_gap_bps || 'n/a'}bps`);
  }

  process.exit(0);
}

run().catch(e => {
  log.error(`backfill crash: ${e.message}`);
  console.error(e);
  process.exit(1);
});
