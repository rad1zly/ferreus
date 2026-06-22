'use strict';

const config = require('./config');
const log = require('./logger');

let bot = null;
let notifCount = 0;
let lastNotifTs = 0;

/**
 * Wire Telegram bot into the notifier. CRITICAL: call immediately after
 * `new Telegraf(token)`, BEFORE `bot.launch()`. Per snipetrench
 * pattern #9, the long-poll can hang in 409 retry hell for minutes;
 * direct Bot API calls work from the moment Telegraf is constructed.
 */
function attachBot(telegrafBot) {
  bot = telegrafBot;
  if (bot) log.info('[notifier] attached to bot');
}

function isReady() {
  return bot !== null && !!config.TELEGRAM_CHAT_ID;
}

async function opportunityDetected(opp) {
  lastNotifTs = Date.now();
  if (!isReady()) {
    log.info(`[notifier] (no bot) GAP ${opp.gap_bps.toFixed(1)}bps ${opp.token_symbol}`);
    return false;
  }
  try {
    const text = formatOpportunity(opp);
    await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' });
    notifCount++;
    return true;
  } catch (e) {
    log.error(`[notifier] send failed: ${e.message}`);
    return false;
  }
}

function formatOpportunity(opp) {
  return [
    `🔔 <b>ARB GAP DETECTED</b>`,
    ``,
    `Token: <b>${escapeHtml(opp.token_symbol)}</b> (<code>${opp.token_mint.slice(0, 8)}…</code>)`,
    `Buy:  <b>${opp.buy_dex}</b> @ $${fmt(opp.buy_price_usd)}`,
    `Sell: <b>${opp.sell_dex}</b> @ $${fmt(opp.sell_price_usd)}`,
    `Gap:  <b>${opp.gap_bps.toFixed(1)} bps</b> (${(opp.gap_bps / 100).toFixed(2)}%)`,
    `Min TVL: $${fmt(opp.min_liquidity_usd)}`,
    `Trade size: $${fmt(opp.trade_size_usd)}`,
    `Est net: <b>$${fmt(opp.est_net_usd)}</b>`,
    ``,
    `<i>DRY_RUN — no execution</i>`,
  ].join('\n');
}

async function info(message) {
  if (!isReady()) return;
  try {
    await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `ℹ️ ${message}`);
  } catch (e) {
    log.error(`[notifier] info send failed: ${e.message}`);
  }
}

async function ping(chatId) {
  if (!bot) return { ok: false, reason: 'no bot attached' };
  try {
    await bot.telegram.sendMessage(chatId, '🏓 pong — Ferreus is alive');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function getCount() {
  return notifCount;
}

function getLastNotifTs() {
  return lastNotifTs;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmt(n) {
  if (n === null || n === undefined) return '?';
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

module.exports = {
  attachBot, opportunityDetected, info, ping,
  getCount, getLastNotifTs, isReady,
};
