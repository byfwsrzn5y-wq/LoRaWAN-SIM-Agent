#!/usr/bin/env bash
# Restart LoRaWAN-SIM dev stack: control server (default :9999) + Vite UI (default :5173).
# Usage (from repo root):
#   ./scripts/restart-dev-services.sh
# Env overrides:
#   SIM_CONFIG   path to main JSON (default: simulator/configs/example-extends-chirpstack.json)
#   CONTROL_PORT (default: 9999)
#   VITE_PORT    (default: 5173)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM_CONFIG="${SIM_CONFIG:-simulator/configs/example-extends-chirpstack.json}"
CONTROL_PORT="${CONTROL_PORT:-9999}"
VITE_PORT="${VITE_PORT:-5173}"
LOG_DIR="${ROOT}/.dev-logs"

mkdir -p "$LOG_DIR"

kill_port() {
  local port="$1"
  local label="${2:-port $port}"
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "Stopping ${label} (port ${port})..."
    lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
  else
    echo "No process on port ${port} (${label})."
  fi
}

kill_port "$CONTROL_PORT" "simulator control"
kill_port "$VITE_PORT" "Vite dev server"
sleep 1

echo "Starting simulator → http://127.0.0.1:${CONTROL_PORT}/ (logs: ${LOG_DIR}/simulator.log)"
cd "$ROOT"
nohup node scripts/lorasim-cli.mjs run -c "$SIM_CONFIG" >>"${LOG_DIR}/simulator.log" 2>&1 &
SIM_PID=$!
echo "$SIM_PID" >"${LOG_DIR}/simulator.pid"
echo "  simulator PID ${SIM_PID}"

echo "Starting Vite UI → http://127.0.0.1:${VITE_PORT}/ (logs: ${LOG_DIR}/vite.log)"
cd "$ROOT/ui"
nohup npm run dev -- --host 127.0.0.1 --port "$VITE_PORT" --strictPort >>"${LOG_DIR}/vite.log" 2>&1 &
VITE_PID=$!
echo "$VITE_PID" >"${LOG_DIR}/vite.pid"
echo "  vite PID ${VITE_PID}"

sleep 2
if curl -sf -o /dev/null "http://127.0.0.1:${CONTROL_PORT}/sim-state"; then
  echo "OK: GET /sim-state on ${CONTROL_PORT}"
else
  echo "Warn: control server not responding yet on ${CONTROL_PORT} (see ${LOG_DIR}/simulator.log)"
fi
if curl -sf -o /dev/null "http://127.0.0.1:${VITE_PORT}/"; then
  echo "OK: Vite on ${VITE_PORT}"
else
  echo "Warn: Vite not responding yet on ${VITE_PORT} (see ${LOG_DIR}/vite.log)"
fi

echo "Done. Tail logs: tail -f ${LOG_DIR}/simulator.log ${LOG_DIR}/vite.log"
