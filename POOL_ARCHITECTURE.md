# Ferreus — Dead-Pool MEV Architecture

> A pragmatic take on Solana MEV arbitrage for the small operator: act like a MEV bot, but hunt where the big bots don't.

**Status**: v0.5.0 (5 IDLs acquired, doc complete, Phase Pool-1 in design).
**Author**: Ferreus project. Reference: rust-mev-bot.solboxs.com (Ch: 套利交易机器人).

---

## 1. Background & Thesis

### The problem with top-200 arbitrage

Polling DexScreener for cross-DEX gaps on top-200 tokens yields ~$5–15/jam on a good day. Why so little:

| Factor | Why we lose |
|---|---|
| **Top-200 = efficient market** | MEV bots run there with WSS push + Rust + multi-IP + 2-key atomic — we can't compete on latency |
| **HTTP polling** | DexScreener public API has 5 RPS cap, public Solana RPC has 10 RPS burst — both rate-limited |
| **DexScreener is downstream** | All bots read it; by the time we parse, the gap is closed |
| **No execution layer** | Even with a gap, we can't win the Jito tip war against $5k-tip MEV bots |

### The thesis: dead-pool = blue ocean

MEV bots like `rust-mev-bot` likely set `min_pool_tvl` somewhere in the $20k–$100k range `[HYPOTHESIS — not published, needs empirical test]`. Reasoning:

- Jito tip alone = $0.001–0.10 per tx
- Trade size on a $5k pool = $50 (1% of pool)
- Gas + tip ratio = 0.2–2% of profit (eats the edge)

**Below their threshold, they don't even subscribe.** We estimate the dead zone is < $10k. That's where we go.

| Pool tier | TVL | MEV bot interest | Why |
|---|---|---|---|
| Whale | $1M+ | Heavy | High profit, all-in |
| Mid | $100k–$1M | Heavy | Worth the gas |
| **Small** | **$10k–$100k** | **Light** | **Tip eats margin, but not zero** |
| **Dead** | **< $10k** | **Very low** | **Below MEV's min threshold (snipetrench-class bots may still play)** |

We compete in **Small + Dead** — where the only competitor is other small operators and lucky retail.

---

## 2. Reference: rust-mev-bot architecture

The `rust-mev-bot.solboxs.com` docs (Chinese, 2025) document a working Solana MEV bot. Architecture (inferred from docs + sitemap):

```
┌─────────────────────────────────────────────────────────────────┐
│                     rust-mev-bot (Rust)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Solana Yellowstone gRPC  ──►  programSubscribe                 │
│  (paid: Triton/Helius ~$50-200/mo)                              │
│         │                                                       │
│         ▼                                                       │
│  Borsh decode pool account (per AMM type)                       │
│         │                                                       │
│         ▼                                                       │
│  Local price calc (x*y=k, sqrt_price, bin math)                 │
│         │                                                       │
│         ▼                                                       │
│  Cross-DEX comparison  ──►  gap detection                       │
│         │                                                       │
│         ▼                                                       │
│  Jupiter Aggregator quote  ──►  atomic 2-leg route              │
│         │                                                       │
│         ▼                                                       │
│  Jito bundle submit  +  tip  (via 16+ IPs)                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Infra cost (their setup)**: $100–400/mo for gRPC + multi-IP VPS + 8-core box.

---

## 3. Ferreus dead-pool architecture (pragmatic)

What we copy, what we cut:

| Component | rust-mev-bot | Ferreus (dead-pool) | Why |
|---|---|---|---|
| **Pool subscription** | Yellowstone gRPC (paid) | Public Solana RPC WSS (free) | Dead pools = low event volume, public WSS works |
| **Pool decode** | Borsh from IDL | Borsh from IDL | Same |
| **Price calc** | Local AMM formulas | Local AMM formulas | Same |
| **Gap detection** | Cross-DEX compare | Cross-DEX compare | Same |
| **Trade execution** | Jupiter aggregator route | Jupiter aggregator route | Same |
| **Tx submission** | Jito bundle via 16 IPs | Jito bundle via 1 IP (start); multi-IP P5+ | No competition in dead pool, single IP fine for v0 |
| **Bot language** | Rust | Node.js | ~1-2ms slower, irrelevant vs 400ms Solana slot time |
| **Private key** | Multi-key (redundancy) | Single key (P3+) | No competition in dead pool, redundancy = nice-to-have |
| **Min pool TVL** | ~$50k `[HYPOTHESIS]` | **$5k** | **The whole point: scoop the dead pools** |
| **Min profit** | ~$0.50 | $0.50+ (≥ gas + Jito tip × 2 safety) | Tighter threshold |
| **WSS infra** | Paid Yellowstone | Public RPC | Free |
| **VPS** | 8c/8GB + 16 IPs | 4c/4GB + 1 IP | Cheaper box, single IP |

**Total infra cost: $0/mo** (uses free Helius + public Solana RPC).

---

## 4. Pipeline (concrete)

### Phase Pool-1: WSS subscription + pool decode

```
[Solana RPC WSS] ──► programSubscribe([RAYDIUM_CPMM, RAYDIUM_CLMM, ORCA_WHIRLPOOL, METEORA_DLMM, METEORA_DAMM])
        │
        ▼
[account notification: pubkey, owner, data, lamports]
        │
        ▼
[Borsh decode per owner program] ──► discriminated by program owner
        │                                     │
        │                                     ├── Raydium CPMM:  reserve0/1 from vaults (or pool account)
        │                                     ├── Raydium CLMM:  sqrt_price_x64, liquidity, tick_current
        │                                     ├── Orca Whirlpool: skip 8-byte discriminator, then sqrt_price, liquidity
        │                                     ├── Meteora DLMM:  active_id, bin_step
        │                                     └── Meteora DAMM v2: sqrt_min_price/max_price, liquidity
        ▼
[Local price calc per AMM type] ──► { price_native = ... }  (see "Price formulas" sub-section below)
        │
        ▼
[USD price reference] ──► if pair has USDC side: price = direct. Else: lookup SOL price, then convert.
        │
        ▼
[Save to pool_state table]
   pubkey, dex, mint_a, mint_b, vault_a, vault_b,
   reserve_a_native, reserve_b_native, tvl_usd, price_usd,
   fee_bps, lp_supply, sqrt_price_x64, liquidity, tick_current, bin_step, ts
```

**Pool discovery**: 2 strategies
- **A. Boot-time** (recommended for dead-pool): use `getProgramAccounts` filter `dataSize` to fetch all pool addresses once, then WSS subscribe to those specific pubkeys via `onAccountChange`. Lower ongoing RPC cost.
- **B. Catch-all** (simpler): `onProgramAccountChange` to get all account updates. Higher RPC volume but no upfront discovery.

Status: design only. Implementation requires:
- 5 IDL files (DONE — see Section 5)
- Borsh decoder (use `@coral-xyz/borsh` in Node)
- WSS client (use `@solana/web3.js` `connection.onProgramAccountChange()` or `onAccountChange()`)
- Storage: SQLite table `pool_state`

**Price formulas** (per AMM type, not one-size-fits-all):
- **CPMM (Raydium CPMM, DAMM v2)**: `price = quote_reserve / base_reserve` (in raw units; divide by 10^decimals_diff for display)
- **CLMM (Raydium CLMM, Orca Whirlpool)**: `price = (sqrt_price_x64 / 2^64)²` (Q64.64 fixed-point)
- **DLMM (Meteora DLMM)**: `price = (1 + bin_step/10000) ^ active_id` (bin-based)

**USD price reference**:
- If token A is USDC/USDT: `price_usd = price_native (B/A)`
- Else if token A is SOL: `price_usd = price_native × sol_price_usd` (lookup SOL/USDC pool)
- Else (BONK/SHIB etc): need 2-hop via SOL or USDC. Use Jupiter price API as fallback.

### Phase Pool-2: Cross-DEX price comparison

```
[pool_state table] ──► group by mint_pair (sorted mints)
        │
        ▼
[For each pair: list prices per DEX]
        │
        ▼
[Compute gap_bps = (max_price - min_price) / min_price × 10000]
        │
        ▼
[Filter: gap > MIN_GAP_BPS=200, min_tvl > 5000]
        │
        ▼
[Save to arb_candidates table]
```

**Key insight**: dead pool gap detection works without external API. We compute everything locally from on-chain state.

**arb_candidates schema**:
```sql
CREATE TABLE arb_candidates (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  mint_a TEXT NOT NULL,
  mint_b TEXT NOT NULL,
  buy_dex TEXT NOT NULL,    -- DEX with lower price (where we buy)
  sell_dex TEXT NOT NULL,   -- DEX with higher price (where we sell)
  buy_pool TEXT NOT NULL,   -- pool address
  sell_pool TEXT NOT NULL,
  buy_price_usd REAL,
  sell_price_usd REAL,
  gap_bps REAL,
  min_tvl_usd REAL,
  est_gross_usd REAL,       -- if we trade 1% of smaller pool
  est_net_usd REAL,         -- minus gas + Jito tip
  notified INTEGER DEFAULT 0,
  INDEX idx_ts (ts),
  INDEX idx_pair (mint_a, mint_b)
);
```

### Phase Pool-3: Trade execution (Jupiter aggregator)

**Execution path options** (pick one):

1. **Jupiter aggregator round-trip** (recommended for v0):
   - Route: A → SOL → A (or A → USDC → A) via Jupiter
   - Single signed transaction, atomic
   - Works on Jupiter's existing infrastructure
   - Best for: simple 2-DEX arb where A has SOL/USDC liquidity

2. **Jupiter Ultra / Pro** (newer):
   - Direct 2-leg arb support (buy A on DEX1, sell A on DEX2, atomic)
   - Requires Pro API key
   - Best for: complex multi-hop

3. **Manual 2-tx** (no atomic):
   - Tx1: swap A→B on DEX1
   - Tx2: swap B→A on DEX2
   - Not atomic — sandwich risk
   - Last resort only

```
[arb_candidates] ──► pick top opportunity
        │
        ▼
[Jupiter Quote API: getQuote({inputMint, outputMint, amount, slippageBps: 50})]
        │
        ▼
[Jupiter Swap API: getSwapTransaction({quote, userPublicKey, priorityFee})]
        │
        ▼
[Sign tx with private key (PRIVATE_KEY env var)]
        │
        ▼
[Simulate via connection.simulateTransaction()]
        │
        ▼
[Submit via Jito bundle OR raw sendTransaction]
        │
        ▼
[Wait for confirmation, log result to trade_log]
```

**Why Jupiter aggregator (round-trip)**:
- Atomic (both legs in 1 tx, can't fail mid-way)
- Auto-routes across 2+ DEXes if direct pair has no liquidity
- Free (no rate limit, public endpoint)
- Pre-built transaction → we just sign + send
- Works without atomic-arb-specific API

### Phase Pool-4: Jito bundle + tip

```
[Built tx] ──► wrap in Jito bundle
        │
        ▼
[Calculate tip = max(MIN_TIP, expected_profit × 0.1)]
        │
        ▼
[Submit to Jito block engine (Amsterdam/NY/Frankfurt)]
        │
        ▼
[Wait for bundle landing (max 30s)]
        │
        ▼
[If landed: log profit. If not: try next region or skip.]
```

Jito regions (from rust-mev-bot docs): Amsterdam, Frankfurt, NY, Salt Lake City, Tokyo.

### Phase Pool-5: Live mode (P3 in our original plan)

- Start with $50 USDC, paper-trade for 1 week
- If win rate > 30%, scale to $500
- Daily stop-loss at -20% of bankroll
- Per-trade cap at 1% of pool liquidity

---

## 5. IDL dependency

Borsh decoding requires the IDL for each program. Status: **all 5 IDLs acquired**.

| Program | IDL file | Source | Size | Pool account |
|---|---|---|---|---|
| **Raydium CPMM** | `src/idls/raydium_cpmm.json` | `raydium-io/raydium-idl/master/raydium_cpmm/raydium_cp_swap.json` | 71KB | `PoolState` (28 fields) |
| **Raydium CLMM** | `src/idls/raydium_clmm.json` | `raydium-io/raydium-idl/master/raydium_clmm/raydium_clmm.json` | 166KB | `PoolState` (34 fields) |
| **Orca Whirlpool** | `src/idls/orca_whirlpool.json` | hand-built from `@orca-so/whirlpools-client` v7 Codama types | 3KB | `Whirlpool` (8-byte discriminator + 19 fields) |
| **Meteora DLMM** | `src/idls/meteora_dlmm.json` | `MeteoraAg/dlmm-sdk/main/idls/dlmm.json` | 211KB | `LbPair` (34 fields, bin-based) |
| **Meteora DAMM v2** | `src/idls/meteora_damm_v2.json` | `MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json` | 165KB | `Pool` (35 fields, CLMM-style) |

**Layout note**: Anchor IDLs (Raydium, Meteora) encode `discriminator` at account level (8 bytes), but the struct starts at offset 0. Orca Whirlpool uses Codama (8-byte discriminator) — must skip 8 bytes before decoding struct.

`scripts/fetch-idls.js` is the helper to re-fetch / refresh IDLs.

---

## 6. What we already have (reuse from Detector A)

| Module | Reuse for | Effort |
|---|---|---|
| `src/db.js` | New tables: `pool_state`, `arb_candidates`, `trade_log` | Add 3 schemas, minor migration |
| `src/safety.js` | Pause/resume/guardDetect for live mode | Reuse |
| `src/notifier.js` | Log + DB fallback (Telegram when token set) | Reuse |
| `src/config.js` | Add WSS RPC URL, Jito tip min, min pool TVL | Add 4 env vars |
| `src/jupiterClient.js` | Jupiter Quote + Swap API for execution | Add `getQuote` + `getSwapTransaction` methods (already has token list) |
| `src/dexScreener.js` | Keep for hybrid mode (DexScreener + WSS) | Reuse as fallback when WSS drops |
| `src/jitoTip.js` | Tip floor + region selection | Reuse |

**New env vars** (added by Phase Pool-1):
- `SOLANA_WSS_RPC_URL` — WSS-capable RPC (default: free Helius WSS, fallback public)
- `MIN_POOL_TVL_USD` — filter threshold for dead-pool strategy (default: `5000`)
- `JITO_TIP_MIN_LAMPORTS` — minimum tip (default: `10000` = 0.00001 SOL)
- `POOL_DISCOVERY_MODE` — `getProgramAccounts` (boot) vs `onProgramAccountChange` (catch-all), default `getProgramAccounts`

**New tables** (added by Phase Pool-1):
- `pool_state` — current state per pool: pubkey, dex, mint_a, mint_b, vault_a, vault_b, reserve_a_native, reserve_b_native, tvl_usd, price_usd, fee_bps, lp_supply, sqrt_price_x64, liquidity, tick_current, bin_step, ts (epoch ms), PRIMARY KEY (pubkey))

**`pool_state` schema**:
```sql
CREATE TABLE pool_state (
  pubkey TEXT PRIMARY KEY,
  dex TEXT NOT NULL,           -- raydium_cpmm, raydium_clmm, orca_whirlpool, meteora_dlmm, meteora_damm_v2
  mint_a TEXT NOT NULL,
  mint_b TEXT NOT NULL,
  vault_a TEXT,
  vault_b TEXT,
  decimals_a INTEGER,
  decimals_b INTEGER,
  reserve_a_native TEXT,       -- raw amount as string (BigInt safe)
  reserve_b_native TEXT,
  tvl_usd REAL,                -- 0 if cannot determine
  price_native REAL,           -- price of B in terms of A (raw units)
  price_usd REAL,              -- 0 if cannot determine (no USDC/SOL reference)
  fee_bps INTEGER,             -- fee in basis points
  lp_supply TEXT,              -- for CPMM
  sqrt_price_x64 TEXT,         -- for CLMM/Whirlpool
  liquidity TEXT,              -- for CLMM/Whirlpool
  tick_current INTEGER,        -- for CLMM/Whirlpool
  bin_step INTEGER,            -- for DLMM
  ts INTEGER NOT NULL,         -- epoch ms of last update
  INDEX idx_pair (mint_a, mint_b),
  INDEX idx_dex (dex)
);
```

---

## 7. Open questions

1. **Public RPC WSS limits** — public Solana RPC has WSS but rate-limited. Need to test if 50-100 pool subscriptions stay under cap. (Plan: subscribe to a manageable subset first.)
2. **Dead pool coverage** — how many pools have $5k–$50k TVL? `[NEEDS DATA]`. We can count via `getProgramAccounts` once and document.
3. **Trade size economics** — $50 trade on $5k pool = 1% of pool. Is that small enough to avoid slippage death? Need paper-trading data.
4. **Jito tip floor** — rust-mev-bot docs reference tip floor; is dead-pool trade $0.30–10 worth a $0.001–0.01 tip? Yes, easily. Will plan tip calc in Phase Pool-4.
5. **Birdeye vs local price** — rust-mev-bot config has `birdeye_api_key`. Do we need it for cross-validation? Plan: compute locally first, add Birdeye only if local calc shows edge cases.
6. **Token-2022 mints** — some pools use Token-2022 with transfer fees. Affects reserve math. Plan: detect Token-2022 mints (look for `token_0_program` / `token_1_program` field in CPMM), skip pools where transfer fee > 0.5%.
7. **MEV protection for our trades** — sandwich attacks possible on dead pool (low volume, slow price). Mitigation: priority fee = 10k-100k microlamports + Jito bundle.
8. **WSS reconnection** — public WSS drops occasionally. Plan: auto-reconnect with exponential backoff (1s → 30s), re-subscribe on reconnect, possibly re-fetch initial state.
9. **Empirical MEV threshold** — to validate dead-pool thesis, log which pools rust-mev-bot subscribes to (if observable). Adjust `MIN_POOL_TVL_USD` accordingly.

---

## 8. Phase roadmap

| Phase | Deliverable | Effort | Yield target |
|---|---|---|---|
| Done | Detector A (DexScreener polling) | — | $5–15/jam |
| **Pool-1** | WSS subscribe + borsh decode 5 DEXs + pool_state table | 4–6h | $5–15/jam (infra only, no yield uplift yet) |
| **Pool-2** | Cross-DEX price compare + arb_candidates | 2–3h | $20–50/jam (real-time detection) |
| **Trade-1** | Jupiter aggregator quote + swap route (paper) | 2–3h | $20–50/jam (detection only, no exec) |
| **Trade-2** | Jito tip + submit + simulate (paper) | 1–2h | $50–200/jam (paper trades) |
| **P3-live** | First live trade $10–20 (manual approval) | 1h | $50–200/jam (real) |
| **P4** | Auto-execute + risk controls | 1h | $50–200/jam scaled |

**Total: 11–16h focused work** to live mode. After Pool-1 we have the foundation; subsequent phases are incremental.

---

## 9. Risks & unknowns

| Risk | Mitigation |
|---|---|
| Public WSS rate limit | Start with 10–20 pool subs, scale carefully. Upgrade to Helius $49/mo if needed. |
| IDL drift (programs update) | Pin IDL version, monitor program upgrade tx |
| Borsh decode bugs (wrong account layout) | Smoke test against known pool addresses; use `dataSize` filter in `getProgramAccounts` to validate size |
| Trade loses money (slippage > gap) | Paper-trade 1 week, win rate > 30% gate before live; use Jupiter simulation, not raw quote |
| SOL price drops (bankroll erosion) | Convert trade profits to USDC, not hold SOL |
| Jito bundle rejected (low tip) | Use rust-mev-bot's tip floor API (it's public); rotate regions (Amsterdam, NY, Frankfurt, Tokyo, SLC) |
| Bot competes with itself (multi-instance) | One bot per wallet, simple in-process lock; future: Redis lock |
| WSS drops mid-stream | Auto-reconnect with exponential backoff (1s → 30s); re-subscribe on reconnect; gap detection on state staleness |
| Token-2022 transfer fees distort reserve math | Detect via `token_0_program` / `token_1_program` field; skip pools with fee > 0.5% |
| Sandwich attack on our trades | Priority fee ≥ 10k microlamports + Jito bundle; small trade size (1% pool) |

---

## 10. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-06-23 | WSS via public RPC for Pool-1 | Free, sufficient for dead-pool volume |
| 2026-06-23 | Min pool TVL = $5k | Below MEV bot threshold = no competition |
| 2026-06-23 | Jupiter aggregator for execution | Atomic, free, mature |
| 2026-06-23 | Node.js (not Rust) | Latency OK for dead-pool, reuse snipetrench infra |
| 2026-06-23 | Single wallet (not 2-key) | No competition in dead pool, redundancy = nice-to-have |
| 2026-06-23 | Public WSS via getProgramAccounts (boot) + onAccountChange (live) | Boot discovery: 1-shot dataSize filter per program. Live: targeted sub per pool pubkey. Lower RPC volume than onProgramAccountChange catch-all. |
| 2026-06-23 | Jupiter round-trip (A→SOL→A) for arb execution | Atomic, free, mature; no need for Pro API or custom arb SDK |
| 2026-06-23 | Skip Token-2022 pools for v0 | Transfer fees distort math; add support in P5+ if profitable |

---

*Last updated: 2026-06-23, by Ferreus project*
