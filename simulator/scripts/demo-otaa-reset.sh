#!/usr/bin/env bash
# 在模拟器运行期间，等待若干秒后调用重置接口，触发 OTAA 重新入网。
# 用法: ./scripts/demo-otaa-reset.sh [等待秒数] [DevEUI]
# 示例: ./scripts/demo-otaa-reset.sh 60
#       ./scripts/demo-otaa-reset.sh 90 0102030405060701

WAIT="${1:-60}"
DEV_EUI="${2:-0102030405060701}"
HOST="${3:-127.0.0.1}"
PORT="${4:-9999}"

echo "[demo] Waiting ${WAIT}s, then resetting OTAA device ${DEV_EUI}..."
sleep "$WAIT"
curl -s -X POST "http://${HOST}:${PORT}/reset" \
  -H "Content-Type: application/json" \
  -d "{\"devEui\":\"$DEV_EUI\"}"
echo ""
echo "[demo] Done. Check simulator console for re-join and data."
