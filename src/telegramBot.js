'use strict';

const { Telegraf } = require('telegraf');
const config = require('./config');
const log = require('./logger');
const safety = require('./safety');
const notifier = require('./notifier');

let bot = null;
let db = null;

function create(database) {
  // Accept either the new shape {db, stmts} or the old shape (just db).
  db = database.db || database;
  dbStmts = database.stmts || null;
  if (!config.TELEGRAM_BOT_TOKEN) {
    log.warn('[telegram] no TELEGRAM_BOT_TOKEN, telegram bot disabled');
    return null;
  }
  bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

  // CRITICAL: attach notifier BEFORE launch (per snipetrench pattern #9).
  // bot.telegram.sendMessage uses the Bot API directly and does NOT need
  // an active long-poll. By attaching early, every notification sends
  // successfully even if launch is stuck in 409-retry hell.
  notifier.attachBot(bot);

  registerCommands();
  return bot;
}

let dbStmts = null;

function registerCommands() {
  bot.start(async (ctx) => {
    const txt = [
      `🔥 <b>Ferreus</b> — Solana Arbitrage Detector`,
      ``,
      `Mode: ${config.DRY_RUN ? '🧪 DRY_RUN' : '🔴 LIVE'}`,
      `Detector: ${safety.isPaused() ? '⏸️ PAUSED' : '▶️ RUNNING'}`,
      ``,
      `Commands:`,
      `/status — show detector status`,
      `/ping — verify bot can reach you`,
      `/pause — pause detector (no more notifs)`,
      `/resume — resume detector`,
      `/recent — show last 5 detected gaps`,
      `/help — show help`,
    ].join('\n');
    await ctx.reply(txt, { parse_mode: 'HTML' });
  });

  bot.command('ping', async (ctx) => {
    const r = await notifier.ping(ctx.chat.id);
    await ctx.reply(r.ok ? '🏓 pong' : `❌ ${r.reason}`);
  });

  bot.command('status', async (ctx) => {
    let arbStats = '?', npStats = '?';
    try {
      const arbRow = db.prepare('SELECT COUNT(*) AS c FROM arb_log').get();
      const sinceMs = Date.now() - 24 * 3600 * 1000;
      const arbRecent = db.prepare('SELECT COUNT(*) AS c FROM arb_log WHERE ts >= ?').get(sinceMs);
      arbStats = `${arbRow.c} total / ${arbRecent.c} in last 24h`;
      const npRow = db.prepare('SELECT COUNT(*) AS c FROM new_pools').get();
      const npRecent = db.prepare('SELECT COUNT(*) AS c FROM new_pools WHERE detected_at >= ?').get(sinceMs);
      npStats = `${npRow.c} total / ${npRecent.c} in last 24h`;
    } catch (e) {
      arbStats = `(error: ${e.message})`;
    }
    const txt = [
      `📊 <b>Ferreus Status</b>`,
      ``,
      `Mode: ${config.DRY_RUN ? '🧪 DRY_RUN' : '🔴 LIVE'}`,
      `Detector: ${safety.isPaused() ? '⏸️ PAUSED' : '▶️ RUNNING'}`,
      `Notifs sent: ${notifier.getCount()}`,
      `DEX-DEX opps logged: ${arbStats}`,
      `New-pool events logged: ${npStats}`,
      `Poll: ${config.POLL_INTERVAL_MS}ms`,
      `Min gap: ${config.MIN_GAP_BPS} bps`,
      `Min TVL: $${config.MIN_TVL_USD.toLocaleString()}`,
      `Trade size: $${config.TRADE_SIZE_USD.toLocaleString()}`,
    ].join('\n');
    await ctx.reply(txt, { parse_mode: 'HTML' });
  });

  bot.command('pause', async (ctx) => {
    safety.pause('telegram /pause');
    await ctx.reply('⏸️ Detector paused');
  });

  bot.command('resume', async (ctx) => {
    safety.resume();
    await ctx.reply('▶️ Detector resumed');
  });

  bot.command('recent', async (ctx) => {
    try {
      const rows = db.prepare(`
        SELECT token_symbol, buy_dex, sell_dex, gap_bps, est_net_usd, ts
        FROM arb_log ORDER BY ts DESC LIMIT 5
      `).all();
      if (rows.length === 0) {
        await ctx.reply('No opportunities logged yet.');
        return;
      }
      const lines = rows.map(r => {
        const ago = Math.floor((Date.now() - r.ts) / 60000);
        return `${ago}m ago — <b>${escapeHtml(r.token_symbol || '?')}</b> ` +
          `${r.buy_dex}→${r.sell_dex} ` +
          `${r.gap_bps.toFixed(1)}bps ~$${r.est_net_usd.toFixed(2)}`;
      });
      await ctx.reply(['🕐 <b>Last 5 opportunities:</b>', '', ...lines].join('\n'),
        { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  bot.command('newpools', async (ctx) => {
    try {
      const rows = db.prepare(`
        SELECT program, pattern, signature, slot, detected_at
        FROM new_pools ORDER BY detected_at DESC LIMIT 5
      `).all();
      if (rows.length === 0) {
        await ctx.reply('No new-pool events logged yet.');
        return;
      }
      const lines = rows.map(r => {
        const ago = Math.floor((Date.now() - r.detected_at) / 60000);
        return `${ago}m ago — <b>${r.program}</b> pattern=${r.pattern} sig=${r.signature.slice(0,12)}…`;
      });
      await ctx.reply(['🆕 <b>Last 5 new-pool events:</b>', '', ...lines].join('\n'),
        { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(`❌ ${e.message}`);
    }
  });

  bot.command('help', async (ctx) => {
    await ctx.reply([
      `🔥 <b>Ferreus — help</b>`,
      ``,
      `/start — main menu + status`,
      `/status — detector status + DB stats (arb + new-pool)`,
      `/ping — verify bot can reach you`,
      `/pause — pause detector`,
      `/resume — resume detector`,
      `/recent — show last 5 detected gaps`,
      `/newpools — show last 5 new-pool events`,
      `/help — this help`,
    ].join('\n'), { parse_mode: 'HTML' });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function launch() {
  if (!bot) return;
  try {
    await bot.launch();
    log.info('[telegram] bot launched');
  } catch (e) {
    log.error(`[telegram] launch failed: ${e.message}`);
  }

  // Graceful shutdown
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

function getBot() {
  return bot;
}

module.exports = { create, launch, getBot };
