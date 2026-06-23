# Ferreus — Dead-Pool MEV Architecture

> A pragmatic take on Solana MEV arbitrage for the small operator: act like a MEV bot, but hunt where the big bots don't.

**Status**: v0.4.1 (Detector A running). Phase Pool-1 in design.
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

MEV bots like `rust-mev-bot` set `min_pool_tvl` to ~$50k+ because:

- Jito tip alone = $0.001–0.10 per tx
- Trade size on a $5k pool = $50 (1% of pool)
- Gas + tip ratio = 0.2–2% of profit (eats the edge)

**Below $50k TVL, they don't even subscribe.** That's where we go.

| Pool tier | TVL | MEV bot interest | Why |
|---|---|---|---|
| Whale | $1M+ | Heavy | High profit, all-in |
| Mid | $100k–$1M | Heavy | Worth the gas |
| **Small** | **$10k–$100k** | **Light** | **Tip eats margin, but not zero** |
| **Dead** | **< $10k** | **Zero** | **Below MEV's min threshold** |

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
| **Tx submission** | Jito bundle via 16 IPs | Jito bundle via 1 IP (later) | No competition in dead pool, single IP fine |
| **Bot language** | Rust | Node.js | Latency 10x worse but no competition in dead pool |
| **Private key** | Multi-key (redundancy) | Single key (P3+) | Same |
| **Min pool TVL** | $50k+ | **$5k** | **The whole point: scoop the dead pools** |
| **Min profit** | ~$0.50 | $0.30 | Tighter threshold |
| **WSS infra** | Paid Yellowstone | Public RPC | Free |
| **VPS** | 8c/8GB + 16 IPs | 4c/4GB + 1 IP | Cheaper box, single IP |

**Total infra cost: $0/mo** (uses free Helius + public Solana RPC).

---

## 4. Pipeline (concrete)

### Phase Pool-1: WSS subscription + pool decode

```
[Solana RPC WSS] ──► programSubscribe([RAYDIUM_CPMM, ORCA_WHIRLPOOL, METEORA_DLMM, METEORA_DAMM])
        │
        ▼
[account notification: pubkey, owner, data, lamports]
        │
        ▼
[Borsh decode per owner program] ──► { mint_a, mint_b, reserve_a, reserve_b, fee, ... }
        │
        ▼
[Local price calc] ──► { price_usd = (reserve_b / reserve_a) × oracle_price }
        │
        ▼
[Save to pool_state table]
   pool_id, dex, mint_a, mint_b, reserve_a, reserve_b, 
   tvl_usd, price_usd, lp_supply, ts
```

**Status**: design only. Implementation requires:
- 4 IDL files (Raydium CPMM, Orca Whirlpool, Meteora DLMM, Meteora DAMM)
- Borsh decoder (use `@coral-xyz/borsh` in Node)
- WSS client (use `@solana/web3.js` `connection.onProgramAccountChange()`)
- Storage: SQLite table `pool_state`

### Phase Pool-2: Cross-DEX price comparison

```
[pool_state table] ──► group by mint_pair
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

### Phase Pool-3: Trade execution (Jupiter aggregator)

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
[Sign tx with private key]
        │
        ▼
[Simulate via connection.simulateTransaction()]
        │
        ▼
[Submit via Jito bundle OR raw sendTransaction]
        │
        ▼
[Wait for confirmation, log result]
```

**Why Jupiter aggregator instead of 2 manual swaps**:
- Atomic (both legs in 1 tx, can't fail mid-way)
- Auto-routes across 2+ DEXes if direct pair has no liquidity
- Free (no rate limit, public endpoint)
- Pre-built transaction → we just sign + send

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

Borsh decoding requires the IDL (Interface Description Language) for each program. We need:

| Program | IDL source | Status |
|---|---|---|
| **Raydium CPMM** | https://github.com/raydium-io/raydium-cpmm (anchor project) | TBD |
| **Raydium CLMM** | https://github.com/raydium-io/raydium-clmm | TBD |
| **Orca Whirlpool** | https://github.com/orca-so/whirlpools | TBD |
| **Meteora DLMM** | https://github.com/MeteoraAg/dlmm-sdk | TBD |
| **Meteora DAMM** | https://github.com/MeteoraAg/damm-sdk | TBD |

Each IDL is a JSON file (or TypeScript const) that describes the on-chain account structure. Once we have them, borsh can decode pool accounts in milliseconds.

---

## 6. What we already have (reuse from Detector A)

| Module | Reuse for | Effort |
|---|---|---|
| `src/db.js` | New tables: `pool_state`, `arb_candidates`, `trade_log` | Minor schema additions |
| `src/safety.js` | Pause/resume/guardDetect for live mode | Reuse |
| `src/notifier.js` | Log + DB fallback (Telegram when token set) | Reuse |
| `src/config.js` | Add WSS RPC URL, Jito tip min, min pool TVL | Add 4 env vars |
| `src/jupiterClient.js` | Jupiter Quote + Swap API for execution | Already has token list logic |
| `src/dexScreener.js` | Drop or keep for fallback? | Decision: keep for hybrid mode |

---

## 7. Open questions

1. **Public RPC WSS limits** — public Solana RPC has WSS but rate-limited. Need to test if 50-100 pool subscriptions stay under cap. (Plan: subscribe to a manageable subset first.)
2. **Dead pool coverage** — how many pools have $5k–$50k TVL? Estimate 5,000–20,000. Subscribe to all = need many RPCs. Plan: roll out by DEX, monitor.
3. **Trade size economics** — $50 trade on $5k pool = 1% of pool. Is that small enough to avoid slippage death? Need paper-trading data.
4. **Jito tip floor** — rust-mev-bot docs reference tip floor; is dead-pool trade $0.30–10 worth a $0.001–0.01 tip? Yes, easily. Will plan tip calc in Phase Pool-4.
5. **Birdeye vs local price** — rust-mev-bot config has `birdeye_api_key`. Do we need it for cross-validation? Plan: compute locally first, add Birdeye only if local calc shows edge cases.

---

## 8. Phase roadmap

| Phase | Deliverable | Effort | Yield target |
|---|---|---|---|
| Done | Detector A (DexScreener polling) | — | $5–15/jam |
| **Pool-1** | WSS subscribe + borsh decode 4 DEXs | 2–3h | $5–15/jam (infra only) |
| **Pool-2** | Cross-DEX price compare + arb_candidates | 1–2h | $20–50/jam (detection) |
| **Trade-1** | Jupiter aggregator atomic 2-leg (paper) | 2–3h | $20–50/jam (detection only) |
| **Trade-2** | Jito tip + submit (paper) | 1–2h | $50–200/jam (paper trades) |
| **P3-live** | First live trade $10–20 (manual approval) | 1h | $50–200/jam (real) |
| **P4** | Auto-execute + risk controls | 1h | $50–200/jam scaled |

**Total: 8–13h focused work** to live mode. After Pool-1 we have the foundation; subsequent phases are incremental.

---

## 9. Risks & unknowns

| Risk | Mitigation |
|---|---|
| Public WSS rate limit | Start with 10–20 pool subs, scale carefully. Upgrade to Helius $49/mo if needed. |
| IDL drift (programs update) | Pin IDL version, monitor program upgrade tx |
| Borsh decode bugs (wrong account layout) | Smoke test against known pool accounts |
| Trade loses money (slippage > gap) | Paper-trade 1 week, win rate > 30% gate before live |
| SOL price drops (bankroll erosion) | Convert trade profits to USDC, not hold SOL |
| Jito bundle rejected (low tip) | Use rust-mev-bot's tip floor API (it's public) |
| Bot competes with itself (multi-instance) | One bot per wallet, simple lock |

---

## 10. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-06-23 | WSS via public RPC for Pool-1 | Free, sufficient for dead-pool volume |
| 2026-06-23 | Min pool TVL = $5k | Below MEV bot threshold = no competition |
| 2026-06-23 | Jupiter aggregator for execution | Atomic, free, mature |
| 2026-06-23 | Node.js (not Rust) | Latency OK for dead-pool, reuse snipetrench infra |
| 2026-06-23 | Single wallet (not 2-key) | No competition in dead pool, redundancy = nice-to-have |

---

*Last updated: 2026-06-23, by Ferreus project*
