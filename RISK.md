# Risk — Ferreus v0.1.0

## P0: paper-trade detector — no real money

The detector phase does not execute any on-chain transaction. `DRY_RUN` is enforced via `safety.guardTrade()`. Risk is operational (false-positive alerts, missed opportunities, API rate limits) — not financial.

### Operational risks (P0)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| DexScreener rate-limit (429) | Medium | Detector throttles | 5s poll × 5 tokens/tick = 60 rpm; within limit but no margin. P2 will add explicit backoff. |
| Jupiter API outage | Low | Token list stale 1h | Cached; detector continues with old list |
| False-positive gap | High | Spam notifications | Tightened via MIN_GAP_BPS + MIN_TVL_USD + net profit floor |
| Missed real opportunity | Medium | Lost profit | Round-robin is uniform; long-tail tokens may need more time per tick. Tunable via SCAN_BATCH_SIZE. |
| DB corruption | Low | Lost history | SQLite WAL mode + daily backup (manual) |
| Bot token leak | Low | Spam, fake commands | Store in `.env` (B64 prefix), never commit |

### What P0 does NOT protect against

- **Stale prices** — the gap is real at DexScreener's snapshot but may be gone by the time a human reviews the alert. Acceptable in P0 (alerts are informational).
- **Sandwich attacks** — Phase 3+ execution must use private RPC (Helius priority fee, optional Jito bundle) to avoid front-running.
- **Slippage death** — even with `1% of pool` sizing, large trades still move the pool. Phase 2 adds pre-execution simulation.
- **Bridge finality** — out of scope until Phase 5.
- **Rug-pulls / LP-pulls** — Phase 1+ can add token safety scoring (RugCheck, Birdeye). P0 logs all gaps without safety filter.

## P3+ (live trade) — risk planning placeholder

The following controls ship in Phase 3+:

| Control | Default | Tunable via |
|---------|---------|-------------|
| Per-trade SOL cap | TBD | `MAX_SOL_PER_TRADE` env |
| Daily loss kill-switch | TBD | `DAILY_LOSS_LIMIT_SOL` env |
| Min profit threshold | TBD | `MIN_NET_USD` env |
| Slippage cap | 100 bps | `MAX_SLIPPAGE_BPS` env |
| Token blocklist | empty | `BLOCKLIST_MINTS` env (comma-separated) |
| Per-token cooldown | 60s | `TOKEN_COOLDOWN_MS` env |
| Manual approval mode | ON for first 10 trades | `/settings` |

These are NOT implemented in P0. P0 has no execution path. Any PR adding execution must include these guards.
