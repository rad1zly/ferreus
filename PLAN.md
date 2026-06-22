# Ferreus — Solana Arbitrage Bot (Implementation Plan)

**Date**: 2026-06-22
**Status**: Draft v1 (Solana-only, multi-phase)
**Project name**: `Ferreus` (Latin: "iron/forge" — selected 06-22)
**Reference**: Twitter thread "Arbitrage from Zero" (`@uyar121`, 2026-05)
**Local path**: `/mnt/c/Users/Prism/Ferreus/`
**GitHub**: `github.com/rad1zly/ferreus` (TBD — pending auth)

---

## Goal

Build a Solana-native arbitrage bot that:

1. **Detects** price gaps across Solana DEXes (and later: CEX, cross-chain bridges)
2. **Filters** by liquidity to avoid slippage death
3. **Pre-simulates** every opportunity (kill reverts before paying gas)
4. **Executes** via Jupiter when net PnL > threshold
5. **Notifies** via Telegram at every step

## Scope decisions (locked from chat)

- **Chain focus**: Solana only (v1)
- **DRY_RUN first, real money last** — per snipetrenchbot pattern #1
- **Phase-by-phase, user review between each** — per user's "AI-writes-code/user-runs-locally" preference
- **CEX leg**: deferred to Phase 1 (requires user API keys)
- **Bridge leg (Wormhole/Mayan/deBridge)**: deferred to Phase 5 — highest risk + capital lockup

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Dex         │───▶│  Price       │───▶│  Liquidity   │
│  Monitor     │    │  Discovery   │    │  Filter      │
│  Raydium     │    │  Jupiter     │    │  Defillama   │
│  Orca        │    │  Birdeye     │    │  TVL > 50x   │
│  Meteora     │    │  + CEX (P1)  │    │  trade size  │
│  Phoenix     │    │  + Bridge    │    │              │
│  (P0)        │    │  (P5)        │    │              │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │ gap > threshold
                                               ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Pre-Exec    │◀───│  Arbit Calc  │◀───│  Decision    │
│  Sim         │    │  gross - gas │    │  Engine      │
│  (P2)        │    │  - slippage  │    │  size + route│
│              │    │  - fees      │    │              │
└──────┬───────┘    └──────────────┘    └──────────────┘
       │ OK
       ▼
┌──────────────┐
│  Executor    │ → Jupiter swap → sign → send → confirm
│  + Safety    │ → Telegram notif, daily kill-switch, PnL log
│  (P3+)       │
└──────────────┘
```

## Phase-by-phase plan

### Phase 0 — Solana DEX-DEX detector (paper mode, no real money)

**Why first**: cheapest way to validate detector logic. No bridge latency, no CEX account, no execution. If the detector can't find Solana-internal gaps profitably, it won't find them across chains.

**Scope**:
- Poll Raydium, Orca, Meteora, Phoenix for top token pairs (top 50 by 24h volume)
- For each pair, compare prices across DEXes
- Calculate gross gap (bps), filter by TVL > $50k on both sides
- Log to SQLite + Telegram
- NO execution. Pure detector.

**Files created**:
```
/mnt/c/Users/Prism/SolArbitBot/
├── index.js
├── package.json
├── .env.example
├── README.md
├── CHANGELOG.md
├── data/arb.db                    # SQLite (WAL mode)
├── src/
│   ├── config.js                  # B64 secrets, .env loader
│   ├── db.js                      # initSchema + arb_log table
│   ├── dexMonitor.js              # Raydium/Orca/Meteora/Phoenix poller
│   ├── jupiterClient.js           # quote API
│   ├── birdeye.js                 # token price + TVL fallback
│   ├── defillama.js               # TVL lookup
│   ├── gapCalc.js                 # gas + slippage + threshold
│   ├── filters.js                 # TVL + min-gap filters
│   ├── safety.js                  # DRY_RUN gate (always true P0)
│   ├── notifier.js                # Telegram
│   └── telegramBot.js             # /status /settings /pause /resume
└── scripts/smoke-test.js          # config + jupiterClient sanity
```

**Reuse from snipetrenchbot**:
- `safety.js` (DRY_RUN gate, daily loss cap pattern)
- `notifier.js` (Telegraf + 409-retry)
- `telegramBot.js` (inline keyboard pattern)
- `db.js` (idempotent migrations)
- `config.js` (B64 secrets)

**Tests**:
- `node scripts/smoke-test.js` — config loads, jupiterClient returns valid quote for SOL/USDC at $1k size
- Detector run for 24h in DRY_RUN
- Count opportunities, manual spot-check 5 against DexScreener

**User review checkpoint**:
> Phase 0 detector logged N opportunities in 24h. ≥80% are real gaps (not stale data, not LP changes)? Proceed to Phase 1?

**Estimated time**: 1-2 days

---

### Phase 1 — Add CEX leg (paper mode)

**Requires** (user supplies):
- Gate.io API key + secret (read-only)
- KuCoin API key + secret (read-only)

**Scope**:
- Add `cexMonitor.js`: poll Gate.io + KuCoin for top token tickers
- Match CEX pairs → Solana mints via CoinGecko symbol map
- Compute CEX-DEX gap (bps)
- Add orderbook depth check (per tweet: thin books = false signals)
- Filter: gap > 50 bps AND orderbook depth > 10× trade size

**Files added**:
- `src/cexMonitor.js`
- `src/orderbook.js` (depth + bid/ask imbalance)
- `src/coinGecko.js` (symbol → mint mapping)

**User review checkpoint**:
> Phase 1 found M CEX-DEX opportunities in 24h. Average gap X bps. Orderbook filter rejected N thin-book signals. Proceed to Phase 2?

**Estimated time**: 1-2 days

---

### Phase 2 — Pre-execution simulation (paper mode)

**Note on Oku Trade**: tweet mentioned Oku, but it's an EVM tool. Solana equivalent:
- **Jupiter swap API** `/simulate` endpoint (if available)
- **Solana RPC** `simulateTransaction` (works for any tx)

**Scope**:
- For every opportunity passing the gap+liquidity filter: build candidate swap tx
- Call `simulateTransaction` (no signing, no sending)
- Track simulation result (success / revert / compute exceeded)
- Only log opportunities that pass sim
- Track revert rate per (DEX, token, size) → blacklist high-revert pairs

**Files added**:
- `src/simulator.js` (Jupiter sim + raw RPC sim)

**User review checkpoint**:
> Phase 2 simulated N opportunities, X% passed. Top revert causes: [list]. Adjust filters?

**Estimated time**: 1 day

---

### Phase 3 — Single live trade (micro-capital: $10-20)

**Goal**: validate entire pipeline end-to-end with real SOL.

**Scope**:
- Add `executor.js` (Jupiter swap tx builder + signer + sender)
- Add `walletManager.js` (encrypted key storage, like snipetrench v0.7.5)
- Safety: trade size cap = $20, daily loss cap = $20, **manual Telegram approval per trade**
- User picks ONE opportunity from Phase 2 logs
- Execute: simulate → sign → send → wait for confirmation
- Verify: settlement, slippage, net PnL

**Files added**:
- `src/executor.js`
- `src/walletManager.js`

**User review checkpoint**:
> Phase 3 live trade: 0.5 SOL → 1.05M $TOKEN at X bps gap. Gas = Y. Net PnL = Z. Proceed to Phase 4?

**Estimated time**: 1-2 days

---

### Phase 4 — Scale (auto-execute with risk controls)

**Goal**: full auto-execution with proper risk management.

**Scope**:
- Auto-execute opportunities passing ALL gates (detect → liquidity → sim → PnL)
- Position sizing: scale trade size to opportunity size (10% of available gap)
- Daily loss kill-switch: pause after $X daily loss
- Per-trade cap: max $Y per trade
- Telegram notif: every opportunity + every execution + every reject (with reason)
- Daily PnL summary

**Files added**:
- `src/risk.js` (caps + kill-switch)
- `src/pnl.js` (daily PnL accumulator)
- `src/scheduler.js` (opportunity → trade sizing)

**Tests**:
- 7-day DRY_RUN+AUTO-EXEC paper run
- Then 7-day LIVE with $50 capital
- Then scale capital based on observed hit rate

**User review checkpoint**:
> Phase 4 7-day paper: N trades, X% win rate, Y avg PnL. Ready to flip LIVE?

**Estimated time**: 2-3 days

---

### Phase 5 (optional) — Cross-chain via bridges

**Goal**: extend to cross-chain via Wormhole / Mayan / deBridge.

**Why this is Phase 5, not Phase 2**:
- Bridge latency 5-15 min — capital locked
- Bridge fee 0.1-1% — eats margin
- Partial-fill risk — tx succeeds on one side, fails on the other
- Much higher complexity for marginal gain

Skip this phase unless Phase 0-4 prove profitable. Recommend **don't** add this until you have months of stable Solana-only operation.

**Estimated time**: 5-7 days (if pursued)

---

## Files likely to change (cumulative)

```
/mnt/c/Users/Prism/SolArbitBot/
├── index.js
├── package.json
├── .env / .env.example
├── README.md
├── ARCHITECTURE.md
├── RISK.md
├── CHANGELOG.md
├── data/arb.db
├── src/
│   ├── config.js
│   ├── db.js
│   ├── safety.js
│   ├── dexMonitor.js        # P0
│   ├── cexMonitor.js        # P1
│   ├── bridgeMonitor.js     # P5
│   ├── jupiterClient.js
│   ├── birdeye.js
│   ├── defillama.js
│   ├── simulator.js         # P2
│   ├── executor.js          # P3
│   ├── risk.js              # P4
│   ├── pnl.js               # P4
│   ├── walletManager.js     # P3
│   ├── notifier.js
│   ├── telegramBot.js
│   ├── settings.js
│   ├── settingsMenu.js
│   ├── filters.js
│   ├── gapCalc.js
│   ├── orderbook.js         # P1
│   └── coinGecko.js         # P1
└── scripts/
    ├── smoke-test.js
    └── generate-wallet.js
```

## Key technical decisions (locked unless user objects)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Node.js (plain JS, not TS) | Matches snipetrench stack |
| DEX aggregator | Jupiter v6 (`api.jup.ag/swap/v1`) | Best Solana coverage, free tier sufficient |
| RPC | Helius free 10 rps | Already used in snipetrench |
| Price feed | Jupiter quote + Birdeye fallback | Birdeye = more history, Jupiter = fresher |
| TVL | Defillama (free, no key) | Already in tweet workflow |
| CEX | Gate.io + KuCoin (per tweet) | Both list Solana pairs + have API |
| Storage | SQLite WAL | Same as snipetrench |
| Notifier | Telegram (Telegraf) | Same as snipetrench |
| Supervision | systemd | Per snipetrench v0.7.4 |
| Polling | Every 5s for DEX, 10s for CEX | Conservative defaults |
| Default mode | `DRY_RUN=true` for P0-P2 | Per snipetrench pattern #1 |

## Open questions for user

1. **CEX API keys** — ready to supply when we hit Phase 1? (Gate.io + KuCoin, read-only)
2. **Initial capital** — $50? $500? $5000? (affects min viable trade size)
3. **Per-trade risk limit** — default suggestion: 1% of capital per trade, 5% daily loss kill-switch. OK?
4. **TypeScript vs plain JS** — recommend plain JS for snipetrench consistency. Override?
5. **Project name** — `SolArbitBot` placeholder. Want something else?

## Risks (be honest)

1. **Solana-internal DEX arb is hyper-competitive** — MEV searchers, sandwich bots, validator-extracted value everywhere. Small bot may rarely win races. **Mitigation**: focus on less-popular pairs (smaller DEXes, longer-tail tokens) where competition is thinner. This is the realistic path for a small operator, not "front-run Jupiter aggregator on SOL/USDC".

2. **CEX withdrawal latency** — CEX-DEX requires CEX already funded. Most CEXs: 5-30 min SOL withdrawal. **Mitigation**: keep CEX balance topped up; accept slow exit.

3. **Slippage death** — small pool + large trade = catastrophic loss. **Filter**: TVL > 50× trade size MINIMUM. Re-verify on every trade.

4. **Compute budget** — complex swaps can exceed compute limit. **Mitigation**: simulate first, set priority fee dynamically per opportunity.

5. **Real money losses** — Phase 3+ involve real SOL. **Mitigation**: per-trade cap + daily loss cap + manual Telegram approval for first 10 trades.

6. **Bridge arb is hardest** (if Phase 5) — bridge can fail, take too long, eat margin in fees. **Mitigation**: don't pursue unless Phase 0-4 prove profitable for months.

## What this plan is NOT

- **Not guaranteed profit.** Arb is competitive; the bot can and will lose money, especially early.
- **Not a fully autonomous AI agent.** Deterministic bot with human review checkpoints at every phase boundary.
- **Not a copy of snipetrenchbot.** Different domain (arb vs copy-trade), different signal sources, different execution paths. Patterns transfer (B64 secrets, SQLite, Telegram notifier, systemd); code does not.

## Workflow

Per user's preference (memory: phase-by-phase > batch):
1. User reviews THIS plan
2. User answers 5 open questions
3. I write Phase 0 code in chunks (Phase 0.1: scaffold + config, 0.2: jupiterClient, 0.3: dexMonitor, 0.4: Telegram)
4. User reviews each chunk
5. 24h paper run at end of Phase 0
6. User review checkpoint → proceed to Phase 1

## Next action

User: review plan, answer 5 open questions, confirm project name + initial capital.
