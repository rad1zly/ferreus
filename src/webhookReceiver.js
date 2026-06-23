'use strict';

// Helius webhook receiver. Listens for transaction events on monitored
// programs and runs the IDL-based decoder on each.
//
// Setup:
// 1. Run this server locally: PORT=3000 node src/webhookReceiver.js
// 2. Expose via ngrok/cloudflared: cloudflared tunnel --url http://localhost:3000
// 3. Register webhook with Helius API (program: Enhanced Webhook, address: DEX programs)
// 4. Helius pushes parsed tx events to https://<tunnel>/webhook

const http = require('http');
const axios = require('axios');
const db = require('./db');
const log = require('./logger');
const config = require('./config');
const idl = require('./idlRegistry');
const decoder = require('./decoder');
const priceOracle = require('./priceOracle');
const safety = require('./safety');
const notifier = require('./notifier');

const PORT = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10);
const HOST = process.env.WEBHOOK_HOST || '0.0.0.0';

let database = null;
let stats = {
  received: 0,
  filtered: 0,        // events skipped based on description
  decoded: 0,
  newPools: 0,
  falsePositives: 0,
  errors: 0,
  startTime: Date.now(),
};

const recentSamples = []; // last 20 events for inspection
const MAX_SAMPLES = 20;

// Throttle: 1 decoder fetch per 250ms = 4 RPS, well under Helius limits
let lastDecodeTs = 0;
const MIN_DECODE_INTERVAL_MS = 250;

// Event types we KNOW are NOT new pool creations
const SKIP_EVENT_TYPES = new Set([
  'SWAP', 'SWAP_WITH_PRICE_IMPACT', 'TRANSFER', 'CLOSE_ACCOUNT',
  'NFT_SALE', 'NFT_MINT', 'NFT_BID', 'NFT_LIST', 'NFT_CANCEL_LIST',
  'COMPRESSED_NFT_MINT', 'COMPRESSED_NFT_TRANSFER', 'COMPRESSED_NFT_BURN',
  'BURN', 'MINT', 'STAKE', 'UNSTAKE', 'VOTE',
  'INITIALIZE_POSITION',           // Orca/Whirlpool — open position (add liq)
  'INCREASE_POSITION',             // add to existing position
  'DECREASE_POSITION',
  'CLOSE_POSITION',
  'ADD_LIQUIDITY', 'REMOVE_LIQUIDITY',
  'INITIALIZE_BIN',                // Meteora DLMM — bin expansion (not new pool)
  'CLAIM_FEE', 'CLAIM_REWARD',
]);

// Description-based filter — only fetch full tx for events that look promising
function isPromisingEvent(evt) {
  // Skip known non-pool types
  if (evt.type && SKIP_EVENT_TYPES.has(evt.type)) return false;

  // If events.swap is set, it's a swap
  if (evt.events && evt.events.swap) return false;

  // If events.nft is set, it's NFT
  if (evt.events && evt.events.nft) return false;

  return true;
}

/**
 * Process a single Helius enhanced webhook event.
 * Helius sends an array of transaction objects, each with parsed data.
 */
async function processEvent(evt) {
  stats.received += 1;

  let sig = evt.signature;
  if (!sig) return;

  // Sample first 20 events for /samples endpoint
  if (recentSamples.length < MAX_SAMPLES) {
    recentSamples.push({
      sig: sig.slice(0, 20),
      desc: (evt.description || '').slice(0, 150),
      type: evt.type || null,
      hasEvents: !!evt.events,
    });
  }

  // Quick filter: skip known non-pool event types (saves RPC calls)
  if (!isPromisingEvent(evt)) {
    stats.filtered += 1;
    return; // Skip — SWAP/TRANSFER/etc.
  }
  // Throttle to stay under RPC rate limit
  const now = Date.now();
  const elapsed = now - lastDecodeTs;
  if (elapsed < MIN_DECODE_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_DECODE_INTERVAL_MS - elapsed));
  }
  lastDecodeTs = Date.now();

  try {
    const result = await decoder.decodeNewPool(sig);
    if (result.decoded) {
      stats.decoded += 1;
      stats.newPools += 1;
      log.info(
        `[webhook] NEW POOL: ${result.instructionType} | ` +
        `kind=${result.kind} | base=${result.baseMint?.slice(0, 8) || '?'}...`
      );

      database.stmts.insertNewPool.run({
        signature: sig,
        program: result.program || 'unknown',
        program_address: 'webhook',
        kind: result.kind,
        pattern: result.instructionType,
        slot: result.slot,
        block_time: result.timestamp,
        err: null,
        fee: null,
        log_count: null,
        detected_at: Date.now(),
      });

      if (notifier.isReady()) {
        await notifier.info(
          `🆕 New pool detected!\n` +
          `  ${result.instructionType} on ${result.program || 'unknown'}\n` +
          `  base: ${result.baseMint?.slice(0, 12) || '?'}...\n` +
          `  initial price: ${result.initialPrice?.toExponential(4) || 'n/a'}\n` +
          `  sig: ${sig.slice(0, 16)}...`
        );
      }
    } else {
      stats.decoded += 1;
      stats.falsePositives += 1;
      // Log discriminator info for debugging
      if (result.discriminator) {
        log.debug(`[webhook] ${sig.slice(0, 16)}... disc=${result.discriminator} reason=${result.reason}`);
      } else if (result.reason && !result.reason.startsWith('no-pool-instruction')) {
        log.debug(`[webhook] ${sig.slice(0, 16)}... ${result.reason}`);
      }
    }
  } catch (e) {
    stats.errors += 1;
    log.error(`[webhook] processEvent failed: ${e.message}`);
  }
}

/**
 * Handle incoming POST request from Helius.
 */
async function handleWebhook(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const events = JSON.parse(body);
      if (!Array.isArray(events)) {
        log.warn('[webhook] payload is not an array');
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      log.info(`[webhook] received ${events.length} events`);

      // Process events in parallel (small concurrency)
      const concurrency = 5;
      for (let i = 0; i < events.length; i += concurrency) {
        const batch = events.slice(i, i + concurrency);
        await Promise.all(batch.map(processEvent));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, processed: events.length }));
    } catch (e) {
      stats.errors += 1;
      log.error(`[webhook] parse error: ${e.message}`);
      res.writeHead(400);
      res.end('Bad request');
    }
  });
}

function start() {
  // Load IDLs first
  idl.load();
  database = db.init();

  // Initialize notifier (no-op if no Telegram token)
  if (config.TELEGRAM_BOT_TOKEN) {
    try {
      const { Telegraf } = require('telegraf');
      const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
      notifier.attachBot(bot);
      log.info('[webhook] notifier attached');
    } catch (e) {
      log.warn(`[webhook] notifier init failed: ${e.message}`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/webhook' || req.url === '/') {
      handleWebhook(req, res);
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        uptime_seconds: Math.round((Date.now() - stats.startTime) / 1000),
        stats: {
          received: stats.received,
          filtered: stats.filtered,
          decoded: stats.decoded,
          newPools: stats.newPools,
          falsePositives: stats.falsePositives,
          errors: stats.errors,
        },
        registered_programs: [...idl.programNames.keys()],
      }));
    } else if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } else if (req.url === '/samples') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ samples: recentSamples }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, HOST, () => {
    log.info(`[webhook] server listening on ${HOST}:${PORT}`);
    log.info(`[webhook] POST to /webhook for transaction events`);
    log.info(`[webhook] GET /health for status`);
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start, processEvent, stats };
