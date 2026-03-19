# LoRaWAN Gateway Simulator

一个功能完整的 LoRaWAN 网关模拟器，支持物理层仿真、多网关场景、18 种异常注入。

## 特性

### 核心功能
- **LoRaWAN 1.0.3 协议** — OTAA/ABP 激活、密钥派生、MAC 命令
- **物理层仿真** — 信号传播模型、RSSI/SNR 计算、距离衰减
- **多网关支持** — overlapping/handover/failover 三种模式
- **异常注入** — 18 种异常场景，覆盖协议/射频/行为三层

### 异常场景 (18 种)

| 类别 | 异常类型 |
|------|----------|
| **协议层** | fcnt-duplicate, fcnt-jump, mic-corrupt, payload-corrupt, wrong-devaddr, mic-wrong-key, invalid-datarate |
| **射频层** | signal-weak, signal-spike, invalid-frequency, single-channel, duty-cycle-violation, adr-reject |
| **行为层** | rapid-join, devnonce-repeat, burst-traffic, random-drop, confirmed-noack |

## 快速开始

### 安装依赖

```bash
cd simulator
npm install
```

### 基本运行

```bash
# 默认配置
node index.js

# 指定配置文件
node index.js -c configs/your-config.json

# 带可视化界面
./start.sh configs/your-config.json
```

### 可视化界面

启动模拟器时同时启动可视化服务器：

```bash
./start.sh configs/example-multi-gateway.json
```

然后打开浏览器访问：http://localhost:3030

**可视化功能：**
- 实时显示节点/网关位置
- 信号强度 (RSSI/SNR) 指示
- 异常节点标记
- 覆盖范围可视化

### 连接 ChirpStack

1. 确保 ChirpStack v4 运行中
2. 配置 Gateway Bridge (UDP 1702 或 MQTT)
3. 修改配置文件中的 `lnsHost` 和 `gatewayEui`

## 配置示例

### 单节点正常行为

```json
{
  "gatewayEui": "0203040506070809",
  "lnsHost": "127.0.0.1",
  "lnsPort": 1702,
  "region": "AS923-1",
  "devices": [{
    "name": "node-01",
    "devEui": "69AE9F1F00010001",
    "joinEui": "0000000000000000",
    "appKey": "00112233445566778899AABBCCDDEEFF",
    "nwkKey": "00112233445566778899AABBCCDDEEFF",
    "activationMode": "otaa",
    "uplinkInterval": 10000
  }]
}
```

### 异常注入

```json
{
  "devices": [{
    "name": "node-anomaly-mic",
    "devEui": "69AE9F1F00010002",
    "anomaly": {
      "enabled": true,
      "scenario": "mic-corrupt",
      "trigger": "every-2nd-uplink",
      "params": { "flipBits": 4 }
    }
  }]
}
```

### 多网关场景

```json
{
  "multiGateway": {
    "enabled": true,
    "mode": "overlapping",
    "gateways": [
      {
        "eui": "ac1f09fffe1c55d3",
        "name": "main-gateway",
        "position": { "x": 0, "y": 0, "z": 30 },
        "rxGain": 5,
        "rxSensitivity": -137
      },
      {
        "eui": "ac1f09fffe1c55d4",
        "name": "suburban-gateway",
        "position": { "x": 2000, "y": 500, "z": 15 }
      }
    ]
  }
}
```

### 信号模型

```json
{
  "signalModel": {
    "enabled": true,
    "nodePosition": { "x": 0, "y": 0, "z": 2 },
    "gatewayPosition": { "x": 500, "y": 0, "z": 30 },
    "environment": "urban",
    "txPower": 16,
    "txGain": 2.15,
    "rxGain": 5.0,
    "shadowFadingStd": 8,
    "fastFadingEnabled": true
  }
}
```

## 触发类型

| 触发器 | 说明 |
|--------|------|
| `always` | 每次都触发 |
| `every-Nth-uplink` | 每 N 个上行触发 |
| `random-X-percent` | X% 概率触发 |
| `on-join-accept` | Join 成功后触发 |
| `once` | 仅触发一次 |

## API

### 配置设备

每个设备支持以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 设备名称 |
| `devEui` | string | 16 位十六进制 |
| `joinEui` | string | Join EUI |
| `appKey` | string | App Key (32 位十六进制) |
| `nwkKey` | string | Network Key |
| `activationMode` | string | `otaa` 或 `abp` |
| `uplinkInterval` | number | 上行间隔 (ms) |
| `position` | object | `{x, y, z}` 坐标 |
| `anomaly` | object | 异常配置 |

## 测试

```bash
# 运行 10 节点异常测试
node index.js -c test_single_fresh.json

# 运行 20 节点 18 种异常测试
node index.js -c 20nodes_18anomalies_30min.json
```

## 依赖

- Node.js >= 14
- ChirpStack v4 (可选，用于实际网络测试)
- mqtt (可选，用于 MQTT 模式)
- protobufjs (可选，用于 Protobuf 编码)

## Discord Bot

通过 Discord 控制模拟器：

```bash
cd discord-bot
npm install
export DISCORD_TOKEN="your-bot-token"
npm start
```

**Discord 命令：**
- `/sim-start` - 启动模拟器
- `/sim-stop` - 停止模拟器
- `/sim-status` - 查看状态
- `/sim-anomaly` - 注入异常
- `/sim-nodes` - 列出节点
- `/sim-diagnose` - 诊断网络

详见 [discord-bot/README.md](discord-bot/README.md)。

## 文档

- [异常响应对照表](../docs/ANOMALY_RESPONSE.md)
- [项目计划](../PROJECT.md)

## 许可证

MIT
