'use strict';

const config = require('./config');
const log = require('./logger');

let paused = false;
let killSwitch = false;
let dailyLossSol = 0;
let dailyResetTs = Date.now();

function pause(reason = 'manual') {
  paused = true;
  log.warn(`[safety] PAUSED — reason: ${reason}`);
}

function resume() {
  paused = false;
  log.info(`[safety] resumed`);
}

function isPaused() {
  return paused;
}

function checkKillSwitch() {
  return killSwitch;
}

function triggerKillSwitch(reason) {
  killSwitch = true;
  log.error(`[safety] KILL SWITCH TRIGGERED — reason: ${reason}`);
}

/**
 * P5: Pre-execution safety check. Returns { ok, reason }.
 *
 * Guards (all must pass for live execution):
 * 1. Bot not paused
 * 2. Kill switch not engaged
 * 3. LIVE_EXECUTE enabled
 * 4. Wallet key loaded
 * 5. Trade notional within ARB_MAX_NOTIONAL_SOL
 * 6. Projected profit > 0 (after tip + gas)
 * 7. Daily loss limit not exceeded (config.ARB_DAILY_LOSS_SOL)
 * 8. Wallet has enough SOL (estimated: tradeSize + tx fees + tip)
 * 9. Mint allowlist (or denylist) check
 *
 * In DRY_RUN mode, only checks 1, 2, 8 (with relaxed notional/profit).
 */
async function guardTrade({ tradeSizeSol, expectedProfitSol, mintIn, mintOut, connection, walletPubkey }) {
  if (paused) return { ok: false, reason: 'bot paused' };
  if (killSwitch) return { ok: false, reason: 'kill switch engaged' };

  // Reset daily loss counter at UTC midnight
  const now = Date.now();
  const utcDay = Math.floor(now / 86400000);
  const lastDay = Math.floor(dailyResetTs / 86400000);
  if (utcDay > lastDay) {
    dailyLossSol = 0;
    dailyResetTs = now;
  }

  const isLive = config.LIVE_EXECUTE && config.WALLET_PRIVATE_KEY;
  if (!isLive) {
    return { ok: true, reason: 'dry_run mode' };
  }

  // Live guards
  if (!connection) return { ok: false, reason: 'no RPC connection' };
  if (!walletPubkey) return { ok: false, reason: 'no wallet pubkey' };

  // Notional cap
  const maxNotional = config.ARB_MAX_NOTIONAL_SOL || 1.0;  // 1 SOL default
  if (tradeSizeSol > maxNotional) {
    triggerKillSwitch(`trade size ${tradeSizeSol} SOL > max ${maxNotional} SOL`);
    return { ok: false, reason: `notional > max (${tradeSizeSol} > ${maxNotional})` };
  }

  // Profit must be positive
  if (expectedProfitSol <= 0) {
    return { ok: false, reason: `no profit (${expectedProfitSol.toFixed(6)} SOL)` };
  }

  // Daily loss limit
  const dailyLossLimit = config.ARB_DAILY_LOSS_SOL || 0.1;  // 0.1 SOL = $7 default
  if (dailyLossSol >= dailyLossLimit) {
    triggerKillSwitch(`daily loss limit reached: ${dailyLossSol} SOL`);
    return { ok: false, reason: `daily loss limit reached` };
  }

  // Mint allowlist (if configured)
  const allowlist = config.ARB_MINT_ALLOWLIST;  // comma-separated mint pubkeys
  if (allowlist) {
    const allowed = allowlist.split(',').map(s => s.trim());
    if (mintIn && !allowed.includes(mintIn)) {
      return { ok: false, reason: `mint_in not in allowlist: ${mintIn}` };
    }
    if (mintOut && !allowed.includes(mintOut)) {
      return { ok: false, reason: `mint_out not in allowlist: ${mintOut}` };
    }
  }

  // Check wallet balance
  try {
    const balance = await connection.getBalance(walletPubkey);
    const balanceSol = balance / 1e9;
    const requiredSol = tradeSizeSol + (config.JITO_TIP_LAMPORTS / 1e9) + 0.001;  // 0.001 buffer for tx fees
    if (balanceSol < requiredSol) {
      return { ok: false, reason: `insufficient balance: ${balanceSol.toFixed(4)} < ${requiredSol.toFixed(4)} SOL` };
    }
  } catch (e) {
    return { ok: false, reason: `balance check failed: ${e.message}` };
  }

  return { ok: true, reason: 'all guards passed' };
}

function recordLoss(solAmount) {
  dailyLossSol += Math.abs(solAmount);
  log.warn(`[safety] loss recorded: ${solAmount} SOL (daily total: ${dailyLossSol} SOL)`);
}

function recordProfit(solAmount) {
  log.info(`[safety] profit recorded: +${solAmount} SOL (daily total profit: -${dailyLossSol} SOL)`);
}

function getStatus() {
  return { paused, killSwitch, dailyLossSol, dailyResetTs };
}

module.exports = {
  pause,
  resume,
  isPaused,
  triggerKillSwitch,
  checkKillSwitch,
  guardTrade,
  recordLoss,
  recordProfit,
  getStatus,
};
