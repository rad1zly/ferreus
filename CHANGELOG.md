# Changelog

All notable changes to Ferreus are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-06-22

### Added
- Initial scaffold (package.json, config, logger, db, safety)
- `JupiterClient` — strict token list + quote API (verified endpoint per snipetrench pattern #12)
- `DexScreener` — pair data per token, group by DEX (best = highest liquidity pool)
- `Detector` — round-robin token scan, cross-DEX gap filter, trade-size + TVL guards
- `arb_log` SQLite table (WAL mode) — every opportunity logged with full context
- `Notifier` — Telegram notifier with B64-secret-safe patterns from snipetrench
- `TelegramBot` — commands: `/start` `/status` `/ping` `/pause` `/resume` `/recent` `/help`
- `safety.js` — pause + DRY_RUN gate, pattern from snipetrench
- Smoke test (`npm run smoke`) — validates config + DB + APIs + detector end-to-end
- `ARCHITECTURE.md` — component map + filter pipeline
- `RISK.md` — P0 risk register + P3+ planning placeholders

### Filter pipeline (P0)
- Min gap: 50 bps (0.5%)
- Min TVL: $50,000 per pool
- Trade size: min($1000, 1% of smaller pool)
- Min net profit: $0.50

### Out of scope (P0)
- CEX-DEX gap detection (P1)
- Pre-execution simulation (P2)
- Trade execution (P3)
- Risk controls + auto-execute (P4)
- Cross-chain bridge detection (P5, deferred)
