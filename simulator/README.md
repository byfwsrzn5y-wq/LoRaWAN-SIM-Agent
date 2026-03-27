# LoRaWAN Gateway Simulator

一个功能完整的 LoRaWAN 网关模拟器，支持物理层仿真、多网关场景、18 种异常注入。

## 运行入口（必读）

| 入口 | 命令 | 说明 |
|------|------|------|
| **生产 / 联调（默认）** | `node index.js`、`npm start`、`./start.sh` | 全功能：UDP + MQTT/Protobuf、多网关、写入 `simulator/sim-state.json` 供调试、完整异常矩阵（定义见 [`anomaly_module.js`](anomaly_module.js)） |
| **实验性 v2** | `node main.js` | 模块化（`src/`）、运动与环境区、`derived-anomalies`；MQTT 未完整实现（回退 UDP）；默认不保证与任何可视化输出对齐 |

`main.js --legacy` 会转调本目录下的 `index.js`。

**与 `main.js` 的能力差集（摘要）**：完整 MQTT 多网关路径、README 文档化的异常触发与 `index.js` 联调路径仅在 **`index.js`**；`main.js` 侧重运动/环境/结构验证。

## OpenClaw Agent（插件集成）

本模拟器的**一等 Agent 集成方式**是仓库内 **[`openclaw-lorawan-sim/`](openclaw-lorawan-sim/)**：OpenClaw 在 `plugins.entries` 中把 `path` 指到该目录后，插件通过 `api.registerTool` 向当前路由到的 Agent 暴露启停模拟器、配置校验/写入、ChirpStack v4 网关与设备管理及下行等能力；模拟器进程仍由本目录的 `node index.js` 拉起，逻辑不搬进 OpenClaw 仓库。

- **最短路径（路径别配反）**：[OpenClaw 插件快速对接](../docs/OPENCLAW_QUICKSTART.md)
- **工具列表、`tools.allow`、排障**：[`openclaw-lorawan-sim/README.md`](openclaw-lorawan-sim/README.md)

可选：`~/.openclaw/skills/lorawan-sim/SKILL.md` 仅补充「怎么说」；**实际控制面以插件工具为准**。另见并行通道：`discord-bot/`（非插件替代品）。

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

另有 **v3 扩展场景**（如 `gateway-offline`、`time-desync`、`downlink-corrupt` 等）定义在 [`anomaly_module.js`](anomaly_module.js)，与 `index.js` 共用同一实现。

## 快速开始

### 用户最短流程（5 步）

以下命令在**仓库根目录**执行（统一 CLI），适合首次使用：

```bash
# 0) 看帮助
node scripts/lorasim-cli.mjs help

# 1) 校验配置
node scripts/lorasim-cli.mjs validate -c simulator/configs/example-extends-chirpstack.json -p multigw

# 2) （可选）先检查 ChirpStack 网关是否齐全
node scripts/lorasim-cli.mjs cs-gw-check -c simulator/config.json --env-file .env

# 3) 启动模拟器
node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json

# 4) 观察状态
# 查看 simulator/sim-state.json：nodes、joined、stats.uplinks、stats.errors
```

如果你更习惯在 `simulator/` 目录运行，可用 npm 别名（见下文 `sim:help` / `sim:run` / `sim:validate`）。

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

# 薄配置：继承预设，只覆盖 LNS / 密钥等（见 docs/CONFIG_MAP.md）
node index.js -c configs/example-extends-chirpstack.json

# 一键启动（模拟器核心，可独立于 UI）
./start.sh configs/your-config.json
```

配置字段速查、`preset` / `extends` 合并规则与校验说明：[`docs/CONFIG_MAP.md`](../docs/CONFIG_MAP.md)。合并后的 JSON 可用 `npm run validate-config` 或 `node ../scripts/lorasim-config-validate.mjs -c <file> [--profile v20-udp|multigw|mqtt]` 检查。

**CLI 覆盖配置**（在 JSON 加载之后生效）：`node index.js --help-config`；示例：`node index.js -c config.json --lns-host 10.0.0.2 --set lorawan.deviceCount=2`。

### 统一短命令 CLI（推荐给用户）

为避免记忆长脚本命令，使用统一入口：

```bash
node scripts/lorasim-cli.mjs help
```

常用命令（从仓库根目录执行）：

```bash
# 启动模拟器（支持把额外 simulator 参数放在 -- 之后）
node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json -- --lns-host 127.0.0.1

# 校验配置
node scripts/lorasim-cli.mjs validate -c simulator/configs/example-extends-chirpstack.json -p multigw

# ChirpStack 网关：检查 / 应用
node scripts/lorasim-cli.mjs cs-gw-check -c simulator/configs/example-extends-chirpstack.json --env-file .env
node scripts/lorasim-cli.mjs cs-gw-apply -c simulator/configs/example-extends-chirpstack.json --env-file .env

# ChirpStack 设备：dry-run / 应用
node scripts/lorasim-cli.mjs cs-dev-dry -c simulator/configs/example-extends-chirpstack.json --env-file .env
node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/configs/example-extends-chirpstack.json --env-file .env
```

如果你在 `simulator/` 目录，也可用 npm 别名：

```bash
npm run sim:help
npm run sim:validate -- -c ../simulator/configs/example-extends-chirpstack.json -p multigw
npm run sim:cs:gw:check -- -c ../simulator/configs/example-extends-chirpstack.json --env-file ../.env
```

### 状态输出（模拟器核心独立输出）

模拟器会持续写入 `simulator/sim-state.json`，用于本地脚本解析/排障。Web 控制台（可选）位于仓库根目录 `ui/`。
模拟器会在运行中更新状态字段（如 `joined`、`RSSI`、`FCnt`），便于日志/脚本排障。

### 连接 ChirpStack

1. 确保 ChirpStack v4 运行中
2. 配置 Gateway Bridge (UDP 1702 或 MQTT)
3. 修改配置文件中的 `lnsHost` 和 `gatewayEui`

### ChirpStack 资源脚本（给用户直接使用）

用户可以直接使用仓库内脚本管理 ChirpStack 资源，不必手工点 UI：

- 网关脚本：`scripts/chirpstack-ensure-gateways-from-config.mjs`
- 节点脚本：`scripts/chirpstack-provision-otaa-from-config.mjs`

先准备环境变量（可放在仓库根 `.env`）：

- `CHIRPSTACK_API_URL`
- `CHIRPSTACK_API_TOKEN`
- `CHIRPSTACK_APPLICATION_ID`
- `CHIRPSTACK_DEVICE_PROFILE_ID`
- （可选）`CHIRPSTACK_TENANT_ID`

从仓库根目录执行：

```bash
# 1) 网关：先检查，不改动
node scripts/chirpstack-ensure-gateways-from-config.mjs \
  --check-only \
  simulator/configs/your-config.json

# 2) 网关：实际创建缺失项
node scripts/chirpstack-ensure-gateways-from-config.mjs \
  simulator/configs/your-config.json

# 3) 设备：先 dry-run 查看将创建内容
node scripts/chirpstack-provision-otaa-from-config.mjs \
  --dry-run \
  simulator/configs/your-config.json

# 4) 设备：实际创建
node scripts/chirpstack-provision-otaa-from-config.mjs \
  simulator/configs/your-config.json
```

风险提示：

- `--replace-all` 会先清空应用下设备再重建；只在明确需要全量重置时使用。
- 配置里的 `DevEUI/AppKey/AppEUI` 必须和模拟器一致，否则 OTAA Join 会失败。
- 网关 EUI 必须与 `multiGateway.gateways[].eui` 对齐，否则多网关测试结果不可信。

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
# 默认示例配置
node index.js -c configs/config.json

# 20 节点多异常场景（见 configs/scenarios）
node index.js -c configs/scenarios/20nodes_18anomalies_30min.json
```

## 使用手册（配置-验证-ChirpStack-测试）

下面以“测试 10 个节点、3 个网关（multiGateway）”作为可复现示例。你可以只改 `active-count`（节点数）或修改 `multiGateway` 模式（overlapping/handover/failover）来复用流程。

### 0. 前置条件

1. 依赖安装

```bash
cd simulator
npm install
```

2. ChirpStack 环境变量准备

本流程涉及 ChirpStack REST API（用于网关登记、设备入库）。请基于根目录 `.env.example` 准备 `.env`，至少包含：

- `CHIRPSTACK_API_URL`
- `CHIRPSTACK_API_TOKEN`
- `CHIRPSTACK_APPLICATION_ID`
- `CHIRPSTACK_DEVICE_PROFILE_ID`
- （可选）`CHIRPSTACK_TENANT_ID`、`CHIRPSTACK_AUTH_HEADER`

3. ChirpStack Gateway Bridge（用于上行/UDP 转发）

你必须保证 ChirpStack 的 Gateway Bridge（UDP 1702 或与你配置一致的端口）可用，否则模拟器启动后可能没有上行被接收。

### 1. 输入测试场景（你决定什么）

- 节点数：使用生成器参数 `--active-count <N>`，本手册使用 `10`。
- 网关数与模式：本手册的“3 个网关”来自 `simulator/config.json` 内置的 `multiGateway.gateways[]`；生成器不会覆盖这个部分，而是把生成的 `devices[]` 注入到同一份 multiGateway 拓扑里。

### 2. 准备测试配置文件（生成 10 nodes + 3GW）

从仓库根目录执行（生成到 `simulator/configs/`）：

```bash
node scripts/generate-simulator-config-explicit-devices.mjs \
  --active-count 10 \
  --out simulator/configs/config-explicit-active-10.json
```

生成后你会得到一个显式配置，包含：

- `devices[]`：10 台 OTAA 设备（其余由 generator 标记为 enabled=false 或不生成）
- `multiGateway.enabled=true`：3 个网关（来自 `simulator/config.json` 的 base config）

#### 2.1 调整节点位置、参数、异常（生成后编辑 config）

生成完成后，你可以直接编辑 `simulator/configs/config-explicit-active-10.json` 来改变测试场景。
先说清楚一个常见误区：**生成器（`generate-simulator-config-explicit-devices.mjs`）只控制 active 节点数量与其在 `devices[]` 内的内容**（enabled、devEui/appEui、坐标与 `anomaly`），而 **顶层的 `multiGateway`、`signalModel`、`uplink` 等块来自 base config（`simulator/config.json`）**，生成时不会因为“数量化”而被你重置覆盖掉。
因此：调网关/信号模型改顶层；调节点/异常改 `devices[i]`。

三类最常改的字段如下：

1. 调整节点位置（影响覆盖/距离/可视化拓扑）

在 `devices[i]` 中修改：

- `devices[i].nodeState.x`
- `devices[i].nodeState.y`
- `devices[i].nodeState.z`

提示：显式设备生成器会给 active 节点按规则生成一组默认坐标（网格分布）。你只要改坐标即可复现“靠近/远离/重叠区域”的差异。

2. 调整节点参数（影响上行节奏、链路强弱、信道选择）

常见两层覆盖关系：

- 全局上行配置（所有节点共享默认节奏/编码等）位于顶层 `uplink`：
  - `uplink.intervalMs`：上行周期（ms）
  - `uplink.interval`：部分配置会用它（调度逻辑兼容 intervalMs/interval）
  - `uplink.payloadLength`：上行载荷长度（simple codec 时常用）
  - `uplink.codec / uplink.payload / uplink.payloadFormat`（影响 payload 生成与编码方式）
  - `uplink.uplinkDropRatio`：按概率“跳过本次上行”（用于根本不发 rxpk 的丢包）
- 单节点覆盖（该节点独立节奏/参数）位于 `devices[i].uplink`：存在时会与全局 `uplink` 合并（`mergeUplinkCfg(globalUplink, devices[i].uplink)`）。

链路强弱（RSSI/SNR、发射功率索引、信道集合）可在 `devices[i].nodeState` 中通过这些字段显式指定（`initNodeState` 会读取并写入设备的初始 RF 参数）：

- `devices[i].nodeState.rssi`
- `devices[i].nodeState.snr`
- `devices[i].nodeState.txPowerIndex`
- `devices[i].nodeState.channels`（或使用 `channelSubset` / `channelCount` 做切片，见 `simulator/index.js` 的 `initNodeState`）
- `devices[i].nodeState.rssiJitter`（抖动幅度，影响每次发射时 RSSI 的随机扰动）
- `devices[i].nodeState.snrJitter`（抖动幅度，影响每次发射时 SNR 的随机扰动）
- `devices[i].nodeState.rssiRange / snrRange / txPowerIndexRange`（只有在走“随机范围”分支时才会用到；若你显式写了 rssi/snr/txPowerIndex，通常会走确定值分支）

3. 调整异常注入（影响 payload / FCnt / MIC / 信号覆盖行为等）

异常注入位于 `devices[i].anomaly`，结构为：

- `devices[i].anomaly.enabled`：是否启用
- `devices[i].anomaly.scenario`：异常场景 key（来自 `simulator/anomaly_module.js` 的 `ANOMALY_SCENARIOS`）
- `devices[i].anomaly.trigger`：触发器（来自 `shouldTriggerAnomaly`）
- `devices[i].anomaly.params`：场景参数（scenario 决定需要哪些 params）

触发器（`anomaly.trigger`）支持值（需严格匹配）：

- `always`
- `every-2nd-uplink`
- `every-3rd-uplink`
- `every-5th-uplink`
- `random-10-percent`
- `random-30-percent`
- `once`
- `on-join-accept`

部分场景的 params 例子（不想猜字段名时就照抄）：

- `mic-corrupt`：`params.flipBits`（默认 2）
- `fcnt-jump`：`params.jump`（默认 1000）
- `signal-weak`：`params.rssi` 与 `params.snr`
- `random-drop`：`params.dropRate`（默认 0.3）

如果你想“只测试位置/参数，不测试异常”，对所有节点：

- 直接删除 `devices[i].anomaly`，或
- 设置 `devices[i].anomaly.enabled=false`。

注意：显式设备生成器会在你重新运行 `generate-simulator-config-explicit-devices.mjs` 时覆盖异常字段；因此推荐做法是“先生成 -> 再手工编辑 anomalies/coords -> 再做 provision（若需要）-> 再启动测试”。

4. 调整网关与信号模型（影响“哪些网关能收到”以及 multiGateway 下最终 rxpk 的 rssi/snr）

网关相关的配置主要在顶层 `multiGateway` 与 `signalModel`：

- `multiGateway.enabled`：开启多网关逻辑
- `multiGateway.mode`：决定最终“发给哪些 gateway”
  - `overlapping`：所有 `canReceive` 的网关都接收
  - `handover`：只选 rssi 最大的那一台
  - `failover`：优先选 `primaryGateway`（按 eui 匹配），否则退化为接收列表的第一台
  - `random_subset`：每次随机选 1..N 个接收网关
- `multiGateway.primaryGateway`：仅在 `mode=failover` 时重要（用于 eui 精确匹配）
- `multiGateway.gateways[]`：每台网关的条目
  - `eui`：网关 EUI（必填）
  - `name`：网关名称（可选）
  - `position: {x,y,z}`：网关坐标（用于距离计算）
  - `rxGain`：接收增益（用于 rssi 计算）
  - `rxSensitivity`：接收灵敏度阈值（`canReceive` 条件：`rssi > rxSensitivity`）
  - `cableLoss`：链路损耗项（计入总损耗）

信号模型（决定 rssi/snr 计算里的环境与发射功率等）在顶层 `signalModel`：

- `signalModel.environment`：环境类型（决定路径损耗指数）
- `signalModel.txPower`：发射功率（参与 rssi 计算）
- `signalModel.txGain`：发射增益（参与 rssi 计算）
- `signalModel.noiseFloor`：噪声底（用于 snr 计算）
- `signalModel.shadowFadingStd`：阴影衰落标准差
- `signalModel.fastFadingEnabled`：是否启用快衰落

多网关优先级提醒（避免你以为没生效）：
- 当 `multiGateway.enabled=true` 时，模拟器先为每台网关按 `signalModel + gateway.position/rxGain/rxSensitivity/cableLoss` 计算接收质量（rssi/snr），再按 `multiGateway.mode` 选择目标网关。
- UDP/MQTT 会把“选中网关的接收质量”写入最终 rxpk（因此开启 multiGateway 后，`signal-weak/signal-spike` 这类异常对最终 rxpk 的 rssi/snr 覆盖优先级会更靠后：最终仍以网关接收计算为准）。

### 3. 配置验证（先验证配置能被模拟器正确接受）

运行静态校验（只做校验，不启动模拟器）：

```bash
node scripts/lorasim-config-validate.mjs \
  -c simulator/configs/config-explicit-active-10.json \
  --profile multigw
```

`--profile multigw` 会要求配置中存在 `multiGateway.enabled + gateways[]`。

如果返回 `ok: true`，再继续下一步。

### 4. ChirpStack 对齐：网关登记（先确认网关存在）

先 dry-run 看缺了哪些网关（不会创建）：

```bash
node scripts/chirpstack-ensure-gateways-from-config.mjs \
  --env-file .env \
  --dry-run \
  simulator/configs/config-explicit-active-10.json
```

然后执行检查（缺失会报错退出码非 0，不会创建）：

```bash
node scripts/chirpstack-ensure-gateways-from-config.mjs \
  --env-file .env \
  --check-only \
  simulator/configs/config-explicit-active-10.json
```

最后需要“自动创建缺失网关”时，直接去掉 `--dry-run/--check-only`：

```bash
node scripts/chirpstack-ensure-gateways-from-config.mjs \
  --env-file .env \
  simulator/configs/config-explicit-active-10.json
```

### 5. ChirpStack 对齐：设备入库（关键坑：device 里缺 `lorawan.appKey`）

这里你必须直面一个现实：`generate-simulator-config-explicit-devices.mjs` 生成的 `devices[]` 每台设备只包含 `devEui/appEui/activation`，不会把顶层 `lorawan.appKey` 复制到每个 device 的 `devices[i].lorawan.appKey`。

而 `scripts/chirpstack-provision-otaa-from-config.mjs` 在 `devices[]` 非空时，会从每个 device 的 `d.lorawan.appKey` 读取 appKey；因此你需要先把顶层 `lorawan.appKey` 注入到每个 device。

生成 provision 用配置（输出到 `config-explicit-active-10-provision.json`）：

```bash
node -e '
  const fs = require("fs");
  const inPath = "simulator/configs/config-explicit-active-10.json";
  const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const appKey = raw?.lorawan?.appKey;
  if (!appKey) throw new Error("Missing top-level lorawan.appKey");
  for (const d of raw.devices || []) {
    if (d.enabled === false) continue;
    d.lorawan = d.lorawan || {};
    d.lorawan.appKey = appKey;
  }
  const outPath = inPath.replace(/\.json$/, "-provision.json");
  fs.writeFileSync(outPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
  console.log("[ok] Wrote:", outPath);
'
```

（建议）先 dry-run 看将写入多少设备：

```bash
node scripts/chirpstack-provision-otaa-from-config.mjs \
  --env-file .env \
  --dry-run \
  simulator/configs/config-explicit-active-10-provision.json
```

实际写入设备（需要彻底重建时加 `--replace-all`）：

```bash
node scripts/chirpstack-provision-otaa-from-config.mjs \
  --env-file .env \
  --replace-all \
  simulator/configs/config-explicit-active-10-provision.json
```

### 6. 开始测试（启动模拟器）

进入 `simulator/` 目录，用生成的配置启动（不依赖 UI）：

```bash
cd simulator
./start.sh configs/config-explicit-active-10.json
```

模拟器将持续写入：

- `simulator/sim-state.json`（本地状态契约，包含 nodes/join/uplink 统计）
- `simulator/.run-sim.log`（日志输出）

### 7. 测试配置验证与运行结果检查（基于 `sim-state.json`）

当模拟器运行一段时间（至少覆盖一次 join + 一次上行周期）后，你可以直接读 `simulator/sim-state.json` 进行判断。

建议先检查结构版本、joined、uplinks/errors：

```bash
node -e '
  const fs = require("fs");
  const p = "simulator/sim-state.json";
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  const joined = (s.nodes || []).filter(n => n.joined).length;
  const uplinks = s.stats?.uplinks ?? 0;
  const joins = s.stats?.joins ?? 0;
  const errors = s.stats?.errors ?? 0;
  console.log({ schemaVersion: s.schemaVersion, nodes: (s.nodes||[]).length, joined, joins, uplinks, errors, lastUpdate: s.lastUpdate });
'
```

最基本的判定标准（你可以按需要强化）：

- `errors === 0`（无明显运行错误）
- `joined` 接近 `10`（OTAA Join 成功）
- `uplinks > 0`（有上行发生）

### 8. 以“多网关模式差异”复用流程

如果你要做 overlapping/handover/failover 差异测试，做法不是重写整套流程，而是：

1. 编辑 `simulator/config.json` 中 `multiGateway.mode` 和 `multiGateway.gateways[]`（或在生成前先复制 base config）
2. 再执行第 2-7 步（生成、验证、ChirpStack 对齐、启动、检查）

### 快速复现清单

按顺序执行以下命令复现本例（默认在仓库根目录执行，直到第 6 步才 `cd simulator`）：

1. 生成配置：

```bash
node scripts/generate-simulator-config-explicit-devices.mjs --active-count 10 --out simulator/configs/config-explicit-active-10.json
```

2. 配置验证：

```bash
node scripts/lorasim-config-validate.mjs -c simulator/configs/config-explicit-active-10.json --profile multigw
```

3. （可选）网关 dry-run：

```bash
node scripts/chirpstack-ensure-gateways-from-config.mjs --env-file .env --dry-run simulator/configs/config-explicit-active-10.json
```

4. 网关登记/创建：

```bash
node scripts/chirpstack-ensure-gateways-from-config.mjs --env-file .env simulator/configs/config-explicit-active-10.json
```

5. 注入 appKey 并 provision 设备：

```bash
node -e '
  const fs = require("fs");
  const inPath = "simulator/configs/config-explicit-active-10.json";
  const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const appKey = raw?.lorawan?.appKey;
  for (const d of raw.devices || []) { if (d.enabled === false) continue; d.lorawan = d.lorawan || {}; d.lorawan.appKey = appKey; }
  const outPath = inPath.replace(/\.json$/, "-provision.json");
  fs.writeFileSync(outPath, JSON.stringify(raw, null, 2) + "\\n");
  console.log("[ok] Wrote:", outPath);
'
node scripts/chirpstack-provision-otaa-from-config.mjs --env-file .env --replace-all simulator/configs/config-explicit-active-10-provision.json
```

6. 启动测试并观察 `sim-state.json`：

```bash
cd simulator
./start.sh configs/config-explicit-active-10.json
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

- [OpenClaw 插件快速对接](../docs/OPENCLAW_QUICKSTART.md)（路径与 `projectPath`）
- [异常响应对照表](../docs/ANOMALY_RESPONSE.md)
- [项目计划](../PROJECT.md)

## 许可证

MIT
