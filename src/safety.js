'use strict';

const config = require('./config');
const log = require('./logger');

let paused = false;

function pause(reason = 'manual') {
  paused = true;
  log.warn(`[safety] PAUSED — reason: ${reason}`);
}

function resume() {
  paused = false;
  log.info('[safety] RESUMED');
}

function isPaused() {
  return paused;
}

/**
 * Detector gate. P0 detector always runs (paper mode) but pauses can stop
 * notification spam. Returns {allowed, paused}.
 */
function guardDetect() {
  return { allowed: true, paused };
}

/**
 * Trade gate. P0 enforces DRY_RUN. P3+ will add:
 *   - per-trade cap (USD)
 *   - daily loss cap
 *   - max slippage
 *   - per-token blocklist
 */
function guardTrade(opportunity) {
  if (config.DRY_RUN) {
    return { allowed: true, dryRun: true, paused };
  }
  return { allowed: false, reason: 'LIVE mode not enabled in P0' };
}

module.exports = { pause, resume, isPaused, guardDetect, guardTrade };
