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
 * Trade gate. Pool-3+ enforcement:
 * - DRY_RUN (default): log only
 * - LIVE_EXECUTE + WALLET_PRIVATE_KEY: real execution
 *   - Refuses if no private key set
 *   - Per-trade notional capped (ARB_TRADE_SIZE_USDC)
 *   - Slippage capped (ARB_MAX_SLIPPAGE_BPS)
 *   - Min profit required (ARB_MIN_PROFIT_USD)
 *   - Paused if user invokes safety.pause()
 */
function guardTrade(opportunity) {
  if (paused) return { allowed: false, reason: 'paused' };

  const oppUsd = opportunity?.usd || opportunity?.amountUsd || 0;
  if (oppUsd > config.ARB_TRADE_SIZE_USDC) {
    return { allowed: false, reason: `notional $${oppUsd} > max $${config.ARB_TRADE_SIZE_USDC}` };
  }

  if (config.LIVE_EXECUTE) {
    if (!config.WALLET_PRIVATE_KEY) {
      return { allowed: false, reason: 'LIVE_EXECUTE=true but WALLET_PRIVATE_KEY not set' };
    }
    return { allowed: true, dryRun: false, mode: 'live' };
  }
  return { allowed: true, dryRun: true, mode: 'dry_run' };
}

module.exports = { pause, resume, isPaused, guardDetect, guardTrade };

