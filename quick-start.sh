#!/bin/bash
#
# LoRaWAN-SIM v1.0 快速启动脚本
# 一键启动 Colima、ChirpStack 和模拟器
#

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 项目路径
PROJECT_DIR="/Users/natsuifufei/Library/Mobile Documents/com~apple~CloudDocs/LoRaWAN-SIM"
SIMULATOR_DIR="$PROJECT_DIR/simulator"
CHIRPSTACK_DIR="$PROJECT_DIR/chirpstack-docker-multi-region-master"

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 打印信息
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 启动 Colima
start_colima() {
    info "检查 Colima 状态..."
    
    if command_exists colima; then
        if colima status 2>/dev/null | grep -q "Running"; then
            success "Colima 已在运行"
        else
            info "启动 Colima..."
            colima start
            success "Colima 启动完成"
        fi
    else
        warning "Colima 未安装，跳过容器环境启动"
        warning "如需测试 ChirpStack 集成，请安装 Colima: https://github.com/abiosoft/colima"
    fi
}

# 启动 ChirpStack
start_chirpstack() {
    info "检查 ChirpStack 状态..."
    
    if command_exists docker; then
        cd "$CHIRPSTACK_DIR"
        
        if docker compose ps 2>/dev/null | grep -q "chirpstack"; then
            success "ChirpStack 已在运行"
        else
            info "启动 ChirpStack..."
            docker compose up -d
            success "ChirpStack 启动完成"
            info "ChirpStack Web UI: http://localhost:8080"
            info "默认账号: admin / admin"
        fi
    else
        warning "Docker 未安装，跳过 ChirpStack 启动"
    fi
}

# 启动模拟器
start_simulator() {
    info "启动 LoRaWAN 模拟器..."
    
    cd "$SIMULATOR_DIR"
    
    # 检查 Node.js
    if ! command_exists node; then
        error "Node.js 未安装，请先安装 Node.js >= 14"
        exit 1
    fi
    
    # 获取配置参数
    CONFIG_FILE="${1:-configs/config.json}"
    
    if [ ! -f "$CONFIG_FILE" ]; then
        warning "配置文件不存在: $CONFIG_FILE"
        info "使用默认配置: configs/config.json"
        CONFIG_FILE="configs/config.json"
    fi
    
    info "使用配置: $CONFIG_FILE"
    
    # 启动模拟器
    ./start.sh "$CONFIG_FILE" &
    SIM_PID=$!
    
    sleep 2
    
    success "模拟器启动完成"
    info "可视化界面: http://localhost:3030"
    info "状态 API: http://localhost:3030/api/state"
    
    return $SIM_PID
}

# 运行测试场景
run_test() {
    local TEST_TYPE=$1
    
    case $TEST_TYPE in
        "phase1"|"p1")
            info "运行 Phase 1 核心异常测试..."
            start_simulator "test_mic-wrong-key.json" &
            sleep 30
            kill %1 2>/dev/null || true
            start_simulator "test_devnonce-repeat.json" &
            sleep 30
            kill %1 2>/dev/null || true
            start_simulator "test_signal-weak.json" &
            sleep 30
            kill %1 2>/dev/null || true
            success "Phase 1 测试完成"
            ;;
        "mic-wrong-key")
            start_simulator "test_mic-wrong-key.json"
            ;;
        "devnonce-repeat")
            start_simulator "test_devnonce-repeat.json"
            ;;
        "signal-weak")
            start_simulator "test_signal-weak.json"
            ;;
        *)
            start_simulator "$TEST_TYPE"
            ;;
    esac
}

# 显示帮助
show_help() {
    cat << EOF
LoRaWAN-SIM v1.0 快速启动脚本

用法: $0 [命令] [参数]

命令:
    all                     启动完整环境（Colima + ChirpStack + 模拟器）
    env                     仅启动 Colima 和 ChirpStack
    sim [config]            仅启动模拟器（可选配置文件）
    test [type]             运行测试场景
    status                  查看环境状态
    stop                    停止所有服务
    help                    显示帮助

测试场景 (test 命令):
    phase1, p1              Phase 1 核心异常测试（mic-wrong-key, devnonce-repeat, signal-weak）
    mic-wrong-key           错误密钥 MIC 测试
    devnonce-repeat         DevNonce 重复测试
    signal-weak             弱信号测试

示例:
    $0 all                              # 启动完整环境
    $0 sim                              # 仅启动模拟器（默认配置）
    $0 sim configs/100nodes.json        # 使用指定配置启动模拟器
    $0 test phase1                      # 运行 Phase 1 测试
    $0 test mic-wrong-key               # 运行单个异常测试
    $0 status                           # 查看状态
    $0 stop                             # 停止所有服务

文档:
    - 项目文档: docs/
    - 异常响应: docs/ANOMALY_RESPONSE.md
    - 检测规则: docs/DETECTION_RULES.md

EOF
}

# 查看状态
show_status() {
    info "LoRaWAN-SIM 环境状态"
    echo "========================"
    
    if command_exists colima; then
        echo -n "Colima:        "
        if colima status 2>/dev/null | grep -q "Running"; then
            success "运行中"
        else
            warning "未运行"
        fi
    fi
    
    if command_exists docker; then
        echo -n "ChirpStack:    "
        if docker ps 2>/dev/null | grep -q "chirpstack"; then
            success "运行中"
            echo "  - Web UI:    http://localhost:8080"
        else
            warning "未运行"
        fi
    fi
    
    echo -n "模拟器:        "
    if pgrep -f "node.*index.js" > /dev/null; then
        success "运行中"
        echo "  - 可视化:    http://localhost:3030"
    else
        warning "未运行"
    fi
    
    echo ""
    info "项目路径: $PROJECT_DIR"
    info "v1.0 完成度: Phase 1 ✅ (6/18 异常已验证)"
}

# 停止所有服务
stop_all() {
    info "停止所有服务..."
    
    # 停止模拟器
    pkill -f "node.*index.js" 2>/dev/null || true
    pkill -f "node.*server.js" 2>/dev/null || true
    
    # 停止 ChirpStack
    if command_exists docker && [ -d "$CHIRPSTACK_DIR" ]; then
        cd "$CHIRPSTACK_DIR"
        docker compose down 2>/dev/null || true
    fi
    
    success "所有服务已停止"
}

# 主函数
main() {
    case "${1:-help}" in
        "all")
            start_colima
            start_chirpstack
            start_simulator "${2:-}"
            show_status
            ;;
        "env")
            start_colima
            start_chirpstack
            show_status
            ;;
        "sim")
            start_simulator "${2:-}"
            ;;
        "test")
            if [ -z "${2:-}" ]; then
                error "请指定测试类型"
                show_help
                exit 1
            fi
            run_test "$2"
            ;;
        "status")
            show_status
            ;;
        "stop")
            stop_all
            ;;
        "help"|"-h"|"--help")
            show_help
            ;;
        *)
            error "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
