# Ferreus — Architecture

## High-level

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Token List  │───▶│  Detector    │───▶│  Notifier    │──▶ Telegram
│  (Jupiter    │    │  (DexScreen  │    │  (Telegraf)  │
│   strict)    │    │   + filter)  │    │              │
└──────────────┘    └──────┬───────┘    └──────────────┘
                          │ log
                          ▼
                   ┌──────────────┐
                   │  SQLite      │
                   │  arb_log     │
                   └──────────────┘
```

## Components

| Module | Purpose | Notes |
|--------|---------|-------|
| `src/config.js` | .env loader, B64 secret decode | Pattern from snipetrench v0.2.0 |
| `src/logger.js` | Leveled console logger | Simple, no deps |
| `src/db.js` | SQLite WAL schema | `arb_log`, `settings`, `runtime_stats` |
| `src/safety.js` | Pause / DRY_RUN gate | Enforced for P0 |
| `src/jupiterClient.js` | Token list + quote API | Uses verified endpoints only |
| `src/dexScreener.js` | Pair data per token | Filters Solana-only, dust pools |
| `src/detector.js` | Main detection loop | Round-robin token scan, gap filter |
| `src/notifier.js` | Telegram notifier | `attachBot()` BEFORE launch |
| `src/telegramBot.js` | Commands: /status /pause /resume /recent | Inline keyboard ready (P0.5) |
| `src/index.js` | Orchestrator | Main loop, token list refresh |

## Detector flow (P0)

1. Pull Jupiter strict token list (cached 1h)
2. For each tick (every 5s):
   - Round-robin through top 200 tokens
   - Batch of 5 tokens per tick
   - For each token:
     - Fetch DexScreener pairs
     - Group by DEX (best = highest liquidity pool per DEX)
     - Find min/max price across DEXes
     - If gap > `MIN_GAP_BPS` (50 bps default):
       - Check min TVL > `MIN_TVL_USD` ($50k default)
       - Compute trade size = min(`$TRADE_SIZE_USD`, 1% of min pool)
       - Compute est net = (gap × size) - gas
       - If net > $0.50 → log + notify

3. Log every opportunity to `arb_log` (notified flag tracks Telegram delivery)

## P0 filter pipeline (cost-ordered, cheap first)

| Filter | Where | Cost | Pass condition |
|--------|-------|------|----------------|
| Pair count | `groupByDex` | Free (in-memory) | ≥ 2 pairs |
| DEX count | `groupByDex` | Free | ≥ 2 DEXes |
| Min gap | `scanToken` | Free | gap_bps ≥ `MIN_GAP_BPS` |
| Min TVL | `scanToken` | Free (already in data) | min(liq_buy, liq_sell) ≥ `MIN_TVL_USD` |
| Trade size | `scanToken` | Free | size ≤ 1% of smaller pool |
| Net profit | `scanToken` | Free | est_net ≥ $0.50 |

## Safety invariants

- `DRY_RUN=true` is enforced for P0-P2. Trade execution code is NOT shipped.
- `safety.guardTrade()` returns `dryRun: true, allowed: true` for any opp in P0.
- `safety.pause()` halts the detector (no DB writes, no notifs) without killing the process.
- Per-trade cap + daily loss cap ship in P3 (P0 has no real money exposure).

## Why these endpoints

- **Jupiter strict list** (`token.jup.ag/strict`): curated, free, no key, 1000+ mints. The reference Solana token list.
- **Jupiter quote** (`api.jup.ag/swap/v1/quote`): verified working from this network (per snipetrench pattern #12). `quote-api.jup.ag/v6` is ENOTFOUND.
- **DexScreener** (`api.dexscreener.com/latest/dex/...`): free, no key, gives per-pool price + liquidity across all Solana DEXes. The detector's primary signal source.
- **Defillama** (reserved for P1+): TVL history per protocol, useful for ranking by depth over time.

## What this is NOT

- Not a CEX-DEX detector (Phase 1 will add Gate.io + KuCoin legs)
- Not a bridge detector (Phase 5, only if Phase 0-4 prove profitable)
- Not an MEV bot (out of scope — requires Jito bundle auction, validator relationships)
- Not auto-execution (Phase 3+)
- Not production-hardened (Phase 4+)

## Out-of-scope risks

1. **DexScreener rate limits** — public endpoint, ~60 rpm. Detector's 5s × 5 tokens/tick = 60 req/min is right at the limit. Will need backoff or key for P2+.
2. **Stale prices** — pool prices move between DexScreener snapshot and Jupiter quote. By the time P3 fires, the gap may be gone. Acceptable for P0 detection.
3. **AMM math vs pool price** — DexScreener reports `priceUsd` per pool (derived from reserves). For trade execution, Jupiter's actual quote is the truth. P2 will add the simulation step.
4. **Bridge-free only** — Phase 0 sees only Solana-native gaps. Cross-DEX-arbitrage within Solana is thin; cross-chain is where most real opportunities are. Bridge detection is Phase 5.
