# Ferreus

> From Latin: *ferreus* — iron, forge. A small sharp tool, built quietly.

Solana-native arbitrage bot. Detects price gaps across DEXes, filters by liquidity, pre-simulates, executes via Jupiter.

**Current state:** planning. See [PLAN.md](./PLAN.md) for the 5-phase build plan (P0-P4 core, P5 optional).

## Project status

| Phase | Status | Description |
|-------|--------|-------------|
| P0 | 🔵 planning | DEX-DEX detector (Raydium/Orca/Meteora/Phoenix) |
| P1 | 🔵 planning | + CEX leg (Gate.io/KuCoin) |
| P2 | 🔵 planning | + Pre-execution simulation |
| P3 | 🔵 planning | + First live trade (micro capital) |
| P4 | 🔵 planning | + Auto-execute with risk controls |
| P5 | ⚪ deferred  | + Cross-chain via bridges (only if P0-P4 prove profitable) |

## Design constraints

- **DRY_RUN first, real money last** — per established bot-building pattern
- **Phase-by-phase, with review checkpoints** between each phase
- **Reuse patterns** from sibling bots (snipetrenchbot, meridian-dlmm-agent): B64 secrets, SQLite WAL, Telegram notifier, systemd supervision
- **No MEV bundle / Geyser stream** — out of scope for small operator

## Why "Ferreus"?

Latin for *iron*. Sharp, simple, industrial. Solidity + finality. The tool that does one thing well.

## License

Private. All rights reserved.
