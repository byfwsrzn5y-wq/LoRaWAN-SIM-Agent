#!/usr/bin/env bash
# Start LoRaWAN-SIM using explicit config.devices[] generation.
#
# Usage:
#   ./start-explicit-active.sh 5
#   ./start-explicit-active.sh --active-count 20
#   ./start-explicit-active.sh 50 --force
#
# Notes:
# - Generates: simulator/configs/config-explicit-active-<N>.json
# - Then runs: simulator/start.sh <generated_config_path>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACTIVE_COUNT=""
FORCE="0"
OUT_PATH=""

usage() {
  cat <<EOF
Usage:
  $0 <active-count> [--force]
  $0 --active-count <active-count> [--out <path>] [--force]

Examples:
  $0 5
  $0 --active-count 20
  $0 50 --force
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --active-count)
      ACTIVE_COUNT="${2:-}"
      shift 2
      ;;
    --out)
      OUT_PATH="${2:-}"
      shift 2
      ;;
    --force)
      FORCE="1"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${ACTIVE_COUNT}" ]]; then
        ACTIVE_COUNT="$1"
        shift 1
      else
        echo "[Error] Unknown arg: $1" >&2
        usage
        exit 2
      fi
      ;;
  esac
done

if [[ -z "${ACTIVE_COUNT}" ]]; then
  echo "[Error] Missing active count." >&2
  usage
  exit 2
fi

if ! [[ "${ACTIVE_COUNT}" =~ ^[0-9]+$ ]]; then
  echo "[Error] --active-count must be an integer, got: ${ACTIVE_COUNT}" >&2
  exit 2
fi

if [[ -z "${OUT_PATH}" ]]; then
  OUT_PATH="${REPO_ROOT}/simulator/configs/config-explicit-active-${ACTIVE_COUNT}.json"
else
  OUT_PATH="$(cd "$(dirname "${OUT_PATH}")" && pwd)/$(basename "${OUT_PATH}")"
fi

if [[ "${FORCE}" == "1" ]]; then
  # Free control port (default in simulator configs).
  # We only kill node processes that listen on these ports.
  for port in 9999; do
    pids="$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      echo "[Force] Killing listeners on TCP:${port}: ${pids}"
      kill ${pids} 2>/dev/null || true
    fi
  done
fi

echo "[Step 1/2] Generating explicit config: ${OUT_PATH}"
node "${REPO_ROOT}/scripts/generate-simulator-config-explicit-devices.mjs" \
  --active-count "${ACTIVE_COUNT}" \
  --out "${OUT_PATH}"

echo "[Step 2/2] Starting simulator stack"
cd "${SCRIPT_DIR}"
./start.sh "${OUT_PATH}"

