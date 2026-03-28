#!/bin/bash
# LoRaWAN Simulator launcher
# Start simulator core only (no front-end UI).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_ENTRY="$SCRIPT_DIR/index.js"
STATE_FILE="$SCRIPT_DIR/sim-state.json"
SIM_LOG="$SCRIPT_DIR/.run-sim.log"

SIM_PID=""

cleanup() {
  echo ""
  echo "[Shutdown] stopping services..."
  if [ -n "${SIM_PID:-}" ]; then
    kill "$SIM_PID" 2>/dev/null || true
  fi
}

trap cleanup SIGINT SIGTERM EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "[Error] node not found in PATH."
  exit 1
fi

if [ ! -f "$SIM_ENTRY" ]; then
  echo "[Error] simulator entry not found: $SIM_ENTRY"
  exit 1
fi

CONFIG_FILE="${1:-}"
shift $(( $# > 0 ? 1 : 0 ))
EXTRA_ARGS=("$@")

if [ -n "$CONFIG_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$SCRIPT_DIR/$CONFIG_FILE" ]; then
    CONFIG_FILE="$SCRIPT_DIR/$CONFIG_FILE"
  else
    echo "[Error] config not found: $CONFIG_FILE"
    exit 1
  fi
fi

echo "[Start] simulator core"
echo "# (no front-end UI in this repo)"
echo "        state file: $STATE_FILE"
if [ -n "$CONFIG_FILE" ]; then
  echo "        config: $CONFIG_FILE"
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    node "$SIM_ENTRY" -c "$CONFIG_FILE" "${EXTRA_ARGS[@]}" >"$SIM_LOG" 2>&1 &
  else
    node "$SIM_ENTRY" -c "$CONFIG_FILE" >"$SIM_LOG" 2>&1 &
  fi
else
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    node "$SIM_ENTRY" "${EXTRA_ARGS[@]}" >"$SIM_LOG" 2>&1 &
  else
    node "$SIM_ENTRY" >"$SIM_LOG" 2>&1 &
  fi
fi
SIM_PID=$!
sleep 0.8

if ! kill -0 "$SIM_PID" 2>/dev/null; then
  echo "[Error] simulator failed to start. See $SIM_LOG"
  exit 1
fi

echo ""
echo "=== LoRaWAN Simulator Stack ==="
echo "State file     : $STATE_FILE"
echo "Logs:"
echo "  - $SIM_LOG"
echo ""
echo "Press Ctrl+C to stop."
echo ""

# Watch simulator; if it exits, stop.
while true; do
  if ! kill -0 "$SIM_PID" 2>/dev/null; then
    echo "[Exit] simulator stopped. See $SIM_LOG"
    exit 1
  fi
  sleep 1
done
