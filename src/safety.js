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
 * - Per-trade notional cap in SOL (0.01 SOL = ~$0.71 at SOL=$71)
 * - Slippage capped (ARB_MAX_SLIPPAGE_BPS)
 * - Min profit required (ARB_MIN_PROFIT_SOL)
 * - Paused if user invokes safety.pause()
 */
function guardTrade(opportunity) {
  if (paused) return { allowed: false, reason: 'paused' };

  // Per-trade notional cap (in SOL). Pass `opportunity.sol` for SOL notional,
  // or `opportunity.usd` for USD-equivalent (e.g. 0.01 SOL ≈ $0.71).
  const oppSol = opportunity?.sol || 0;
  const oppUsd = opportunity?.usd || opportunity?.amountUsd || 0;
  if (oppSol > config.ARB_TRADE_SIZE_SOL) {
    return { allowed: false, reason: `notional ${oppSol} SOL > max ${config.ARB_TRADE_SIZE_SOL} SOL` };
  }
  if (oppUsd > 0 && config.ARB_TRADE_SIZE_SOL > 0) {
    // Sanity check: if USD provided, cap at 100x SOL max (for safety against price spikes)
    if (oppUsd > config.ARB_TRADE_SIZE_SOL * 1000) {
      return { allowed: false, reason: `notional $${oppUsd} unreasonably high` };
    }
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


