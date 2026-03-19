#!/bin/bash
# LoRaWAN Simulator 启动器
# 同时启动模拟器和可视化服务器

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/sim-state.json"

# 清理函数
cleanup() {
    echo ""
    echo "Stopping services..."
    [ ! -z "$SIM_PID" ] && kill $SIM_PID 2>/dev/null
    [ ! -z "$VIS_PID" ] && kill $VIS_PID 2>/dev/null
    rm -f "$STATE_FILE"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 启动可视化服务器
echo "Starting visualizer server on http://localhost:3030"
node "$SCRIPT_DIR/visualizer/server.js" &
VIS_PID=$!

# 等待服务器启动
sleep 1

# 启动模拟器 (带状态输出)
echo "Starting LoRaWAN simulator..."
echo "State file: $STATE_FILE"
echo ""

# 模拟器参数
CONFIG_FILE="${1:-}"
EXTRA_ARGS="${@:2}"

if [ -n "$CONFIG_FILE" ]; then
    node "$SCRIPT_DIR/index.js" -c "$CONFIG_FILE" $EXTRA_ARGS &
else
    node "$SCRIPT_DIR/index.js" $EXTRA_ARGS &
fi
SIM_PID=$!

# 监控状态
echo ""
echo "=== LoRaWAN World Simulator ==="
echo "Visualizer: http://localhost:3030"
echo "State API:  http://localhost:3030/api/state"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# 等待子进程
wait $SIM_PID $VIS_PID
