# LoRaWAN Gateway Simulator

LoRaWAN 网关模拟器：在无真实网关与终端时，模拟「一台网关 + 多台 LoRa 设备」，向 [ChirpStack](https://www.chirpstack.io/) 发送上行、接收下行。支持 OTAA/ABP、MAC 命令与行为模板；可选通过 [OpenClaw](https://openclawlab.com/) Bot 管理模拟器与 ChirpStack v4 网关/设备。

- **协议**：LoRaWAN **1.0.3**（16-bit FCnt、OTAA Join、NwkSKey/AppSKey 派生）
- **激活方式**：**OTAA** 或 **ABP**（配置或 CSV 混合）
- **MAC**：下行 MAC 解析并回 Ans；上行可选 LinkCheckReq（见 `uplink.linkCheckInterval`）
- **输出**：MQTT（ChirpStack Gateway Bridge）或 UDP Semtech Packet Forwarder

## 快速开始

```bash
git clone <repository-url> && cd lorawan_gateway_sim
npm install
cp configs/config.json configs/my-config.json   # 按需修改 gatewayEui、mqtt.server、lorawan 等
node index.js -c configs/my-config.json
# 或 100 节点（OTAA + 行为模板）：npm run start:100
```

发布到 GitHub 后，请将上述 `<repository-url>` 替换为实际克隆地址（如 `https://github.com/username/lorawan_gateway_sim.git`）。

ChirpStack 侧需先创建与 `gatewayEui` 一致的网关及对应设备（建议 ChirpStack v4 + chirpstack-rest-api）。通过 OpenClaw 可完成网关/设备注册与模拟器启停、配置同步，见 [OpenClaw 接入](#openclaw-接入)。

## 功能

- **多节点 ABP/OTAA**：按配置或 CSV 生成多设备；ABP 每设备独立 DevAddr/NwkSKey/AppSKey；OTAA 支持 deviceCount + appEuiStart/devEuiStart/appKey 或 CSV
- **上行**：按间隔发送 LoRaWAN 上行（Gateway Bridge 协议）；应用负载支持 **simple**（2–20 字节可配）或 **custom**（`codec: "custom"` + `payload` 十六进制/Base64，0–222 字节），可选 LinkCheckReq
- **下行**：订阅 ChirpStack 下行，解析 MAC（LinkADRReq、DevStatusReq 等）并回复 LinkADRAns 等
- **行为模板**：支持正常/异常行为模板与随机分配，用于压力与行为测试（见 [docs/行为模型与随机节点.md](docs/行为模型与随机节点.md)、[docs/100节点正常与异常配置.md](docs/100节点正常与异常配置.md)）

## 依赖

- **Node.js ≥ 14**
- **MQTT 模式**（推荐）：`npm install` 会安装 optionalDependencies `mqtt`、`protobufjs`；未安装时启用 MQTT 会报错退出
- **UDP 模式**：仅需 Node.js

## 配置

- 主配置：`configs/config.json`
- 启动：`node index.js -c configs/config.json` 或 `npm run start:config`

### 主要字段

| 字段 | 说明 |
|------|------|
| `gatewayEui` | 网关 EUI（8 字节十六进制），须与 ChirpStack 中网关 ID 一致 |
| `mqtt.enabled` / `mqtt.server` / `mqtt.topicPrefix` | MQTT 与 ChirpStack Gateway Bridge 一致 |
| `lorawan.deviceCount` / `lorawan.activation` | 设备数、ABP/OTAA |
| `lorawan.devAddrStart` / `devEuiStart` / `nwkSKey` / `appSKey` / `appKey` | 与 ChirpStack 中设备一致 |
| `lorawan.csvImportPath` | 可选 CSV（10 列：JoinMode,Group,Name,Profile,AppEUI,DevEUI,AppKey,DevAddr,AppSKey,NwkSKey） |
| `uplink.interval` / `uplink.region` / `uplink.payloadLength` | 上行间隔、区域、负载长度（simple 时有效） |
| `uplink.codec` | `"simple"`（默认）或 `"custom"`；为 `"custom"` 时用 `uplink.payload` + `uplink.payloadFormat`（`hex`/`base64`）作为上行 FRMPayload，最长 222 字节 |
| `controlServer.enabled` / `controlServer.port` | 可选 HTTP 控制接口（设备重置），见 [docs/设备重置与重新入网.md](docs/设备重置与重新入网.md) |

## 目录结构

```
lorawan_gateway_sim/
├── index.js              # 主程序
├── package.json
├── gw.proto, common/     # ChirpStack Gateway Bridge Protobuf
├── configs/              # 配置与行为模板
├── docs/                 # 协议说明与使用指南
├── scripts/              # 示例脚本
├── openclaw-lorawan-sim/ # OpenClaw 插件（模拟器 + ChirpStack v4）
└── README.md
```

## ChirpStack 侧（建议 v4）

1. 部署 **ChirpStack v4**，可选 **chirpstack-rest-api** 提供 REST（供 OpenClaw 插件调用）。
2. 在 ChirpStack 中创建**网关**，Gateway ID 与配置里 `gatewayEui` 一致（8 字节 hex）。
3. 创建**应用**与**设备**（OTAA 或 ABP）：密钥与配置或 CSV 一致。
4. Gateway Bridge 使用 MQTT 时，与模拟器连同一 Broker；订阅 `{topicPrefix}/gateway/{gatewayId}/event/+`。

## OpenClaw 接入

通过 [OpenClaw](https://openclawlab.com/) 用 Bot 管理模拟器并在 ChirpStack v4 中管理网关/设备与下行。

**插件**：仅需 **openclaw-lorawan-sim** 一个插件，提供：

- **模拟器**：启动/停止、读写配置、设备重置、从 ChirpStack 同步设备
- **ChirpStack v4**：网关与设备的 list/create/delete、下行入队

详见 [openclaw-lorawan-sim/README.md](openclaw-lorawan-sim/README.md)。

**推荐流程**：ChirpStack v4 + chirpstack-rest-api → 插件 `chirpstack_gateway_create` 注册网关（ID = `gatewayEui`）→ `chirpstack_device_create` 创建设备 → `lorawan_sim_sync_from_chirpstack` 同步到模拟器 → `lorawan_sim_start` 启动。

插件需配置 `projectPath`（本项目根目录）及 ChirpStack 的 `chirpstackBaseUrl`、`chirpstackApiToken` 等；在 agent 的 `tools.allow` 中启用所需可选工具。

## 文档

完整文档索引见 **[docs/README.md](docs/README.md)**。常用文档：

| 主题 | 文档 |
|------|------|
| **使用指南** | [docs/使用指南.md](docs/使用指南.md) |
| **项目目标与范围** | [docs/PROJECT_GOALS.md](docs/PROJECT_GOALS.md) |
| **协议与 MAC** | [docs/LoRaWAN1.0.3与MAC交互.md](docs/LoRaWAN1.0.3与MAC交互.md)、[docs/MAC协议支持与OTAA测试.md](docs/MAC协议支持与OTAA测试.md) |
| **行为与 100 节点** | [docs/行为模型与随机节点.md](docs/行为模型与随机节点.md)、[docs/100节点正常与异常配置.md](docs/100节点正常与异常配置.md) |
| **设备重置** | [docs/设备重置与重新入网.md](docs/设备重置与重新入网.md) |
| **异常行为模板参考** | [docs/异常行为模板参考.md](docs/异常行为模板参考.md) |

## License

MIT. See [LICENSE](LICENSE). 贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
