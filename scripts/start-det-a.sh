#!/usr/bin/env bash
# Start Ferreus with Detector A only (DEX-DEX gap).
# Most stable config — no 429 spam, ~$5-15/jam expected.
# Logs to /tmp/ferreus-det-a.log
set -e
cd "$(dirname "$0")/.."

# Kill any previous Ferreus instance
pkill -f "node src/index.js" 2>/dev/null || true
sleep 1

# Default to A only (override with ENABLED_DETECTORS env if you want B/C)
export ENABLED_DETECTORS="${ENABLED_DETECTORS:-dex_dex}"

mkdir -p data
nohup node src/index.js > /tmp/ferreus-det-a.log 2>&1 &
PID=$!
disown
echo "Ferreus started PID=$PID — logs: /tmp/ferreus-det-a.log"
echo "Detectors: $ENABLED_DETECTORS"
sleep 2
tail -20 /tmp/ferreus-det-a.log
