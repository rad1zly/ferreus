# Ferreus — Solana Arbitrage Bot (Revised)

**Date**: 2026-06-22 (revised after @uyar121 "Arbitrage from Zero #2" thread)
**Status**: P0 in progress
**Repo**: https://github.com/rad1zly/ferreus

---

## Pivot from v1 plan

The user's Twitter thread revealed **"New Liquidity" detection** as the highest-alpha source (gap 100× bigger than DEX-DEX), with specific methods: Telegram trackers, Solscan filter, Birdeye "Find Trades" Direction=Add Liquidity.

Pivoting P0 from "DEX-DEX gap detector only" → **dual-detector**:

| Source | Implementation | Signal size | Latency | API key |
|---|---|---|---|---|
| **A. DEX-DEX gap** | Round-robin top-200 SPL tokens via DexScreener | 50–500 bps | 5–30s | None |
| **B. New-pool monitor** | `getSignaturesForAddress` on 5 DEX programs via Solana RPC | 1000–10000+ bps | <1 slot (400ms) | None |
| **C. Pumpfun migration** (P0.5) | Same RPC technique, decode migration txs | 5000+ bps | <1 slot | None |

Free API aggregator endpoints (DexScreener, GeckoTerminal, Birdeye public, Raydium API) all returned **HTTP 403** from this network on 2026-06-22. **Solana public RPC (`https://api.mainnet-beta.solana.com/`) works** — that's the path forward. Per snipetrench pattern #12, this is consistent with that session's discovery.

---

## Goal

Build a Solana-native arbitrage bot that:

1. **Detects** new pool creations (event-driven, sub-second) + DEX-DEX price gaps (polled)
2. **Filters** by liquidity (TVL > 50× trade size, per tweet wisdom)
3. **Pre-simulates** every opportunity (kill reverts before paying gas)
4. **Executes** via Jupiter with Jito tip (mandatory for new-pool events per tweet: "MEV bot = musuh utama")
5. **Notifies** via Telegram at every step

## Phase plan

### P0 (revised) — Dual-detector, paper mode

**Detector A**: DEX-DEX gap
- Already built in P0 v1
- Polls DexScreener for SOL pairs, compares prices across DEXes
- Threshold: 50 bps

**Detector B**: New-pool monitor (NEW PRIORITY)
- Poll `getSignaturesForAddress` on 5 DEX programs every 5s
- For each new signature: fetch tx, filter logs for "Initialize"/"create_pool" patterns
- Decode pool address + token mints when found
- Log to `new_pools` table
- (Decode complexity deferred to P1)

**Detector C (P0.5)**: Pumpfun migration
- Poll Pumpfun program for migration txs
- New token → Meteora/Raydium = high-alpha event

**Files (P0)**:
```
src/
├── config.js                # B64 secrets, env loader
├── db.js                    # SQLite WAL, arb_log + new_pools + settings + runtime_stats
├── safety.js                # DRY_RUN gate, daily cap, pause/resume
├── notifier.js              # Telegram (Telegraf, 409-retry per pattern)
├── telegramBot.js           # /status /pause /resume /settings
├── logger.js                # timestamped log levels
├── jupiterClient.js         # quote + token list (Solana Labs fallback)
├── dexscreener.js           # DEX pair lookup
├── solanaRpc.js             # ← NEW: Solana public RPC client
├── newPoolMonitor.js        # ← NEW: event-driven new-pool detector
├── pumpfunMonitor.js        # ← NEW: Pumpfun migration monitor
├── detector.js              # existing DEX-DEX gap detector
├── gapCalc.js               # threshold filter
└── filters.js               # TVL + min-gap filters

scripts/
└── smoke-test.js
```

**Tests**:
- `npm run smoke` — all detectors return data without error
- 30-min paper run — at least one new-pool event detected per minute on active programs
- 24h paper run — log enough opportunities for manual spot-check vs DexScreener UI

**User review checkpoint**:
> After 24h: Detector B logged X new-pool events, Y% decoded cleanly. Detector A logged M DEX-DEX gaps. Proceed to P1 (decode + simulate)?

---

### P1 — Decode + pre-execution simulation

**Scope**:
- Decode `initialize_pool` / `initialize_pool2` instructions:
  - Pool address
  - Base mint, quote mint
  - Initial LP supply
  - Initial price (derived from amounts)
  - Deployer wallet
- For each decoded pool: fetch Jupiter quote, calculate gap vs CoinGecko/Birdeye reference
- Add `simulator.js`: build candidate swap tx, call `simulateTransaction`
- Track revert rate per (DEX, token size) → blacklist

**User review**: Sim successfully predicts failures for known-bad pairs.

---

### P2 — CEX leg (paper mode)

**Requires**: user-supplied Gate.io + KuCoin read-only API keys

**Scope**:
- Poll CEX tickers for top tokens
- Match CEX pairs → Solana mints via CoinGecko symbol map
- Compute CEX-DEX gap (bps)
- Orderbook depth check (per tweet: thin books = false signals)

---

### P3 — First live trade (micro, with Jito tip)

**Critical**: Per tweet, new-pool events are dominated by MEV bots. Without Jito tip, we lose every race. Examples cited: ANB token bribe 2.3 SOL (~$350), worst case 141 SOL (~$20k).

**Scope**:
- `executor.js`: build + sign + send tx with Jito tip
- `walletManager.js`: encrypted key storage (B64, like snipetrench)
- Manual Telegram approval per trade (first 10 trades)
- Trade cap: $10-20, daily loss cap: $20
- User picks ONE opportunity from P1 logs, executes

---

### P4 — Auto-execute + dynamic Jito tip + risk controls

**Scope**:
- Auto-execute opportunities passing ALL gates (detect → liquidity → sim → PnL)
- Dynamic Jito tip: 0.001 SOL base, scaled by opportunity size
- Position sizing: 10% of available gap
- Daily loss kill-switch
- Telegram notif: every opportunity + every execution + every reject

---

### P5 — Cross-chain via bridges (deferred, only if P0-P4 prove profitable)

Bridge latency 5-15 min + fees 0.1-1% + partial-fill risk. Don't pursue unless Solana-only is proven.

---

## Key risks (per tweet)

1. **MEV bot dominance on new pools**: ANB case showed bribes up to 141 SOL ($20k). Realistic path = small operator plays less-competitive opportunities (mid-tier tokens, not microcaps). Or accept smaller profits from non-new-pool DEX-DEX gaps.

2. **Slippage death**: filter `TVL > 50× trade size` minimum.

3. **Compute budget**: simulate first, set priority fee dynamically.

4. **Real money losses in P3+**: per-trade cap + daily cap + manual approval for first 10 trades.

5. **Hidden Treasure scanning** (per tweet): patience-based, scan dead tokens, manual comparison. Out of scope for automated bot — keep as manual workflow.

## What this plan is NOT

- Not a guaranteed profit. Arb is competitive.
- Not a MEV bundle auction bot (Jito tip only, no bundle construction in P0-P4).
- Not a cross-chain bridge arb (P5 only if profitable).
- Not a "buy-unstake" / "buy-remove liq" specialist (requires deep launchpad knowledge, manual workflow).

## Tech stack (locked)

| Layer | Choice | Reason |
|---|---|---|
| Language | Node.js (plain JS) | Matches snipetrench |
| DEX aggregator | Jupiter v6 | Best coverage, free tier |
| RPC | `https://api.mainnet-beta.solana.com/` (public) | Free, no key, works from this network |
| Price feed | Jupiter quote + DexScreener | Fallback chain |
| TVL | DexScreener + Defillama | |
| CEX | Gate.io + KuCoin (per tweet) | TBD in P2 |
| Storage | SQLite WAL | |
| Notifier | Telegram Telegraf | |
| Supervision | systemd (per snipetrench v0.7.4) | |

## Next action

P0 dual-detector implementation in progress. Build → smoke test → push.