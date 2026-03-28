# ChirpStack 联调配置核对清单

**ChirpStack 是依赖/对端系统，不是本模拟器的一部分。** 你可选用：本仓库自带的 Docker Compose 示例、自托管部署、厂商一体机或**任意第三方/云端 ChirpStack**（只要与模拟器在 **Gateway Bridge（UDP 或 MQTT）及设备/网关数据模型** 上兼容，常见为 **v4**）。无需绑定某一供应商；**把两边配置对齐**即可跑通。

本文说明：**模拟器（`simulator/index.js`）与对端 NS 对接时，哪些字段必须与网络服务器侧一致**。文中「本仓库 Compose」仅作**端口/主题前缀的举例**；你使用第三方环境时，用自己的控制台或文档替换对应值。

> 从零跑通流程仍以 [使用指南](使用指南.md)、[OpenClaw 快速对接](../../docs/OPENCLAW_QUICKSTART.md) 为主；本文是**可勾选的核对表**。

---

## 1. 两条独立路径（不要混用）

| 路径 | 作用 | 是否用 REST API Token |
|------|------|------------------------|
| **A. 流量路径** | 模拟器当作「网关」向 **Gateway Bridge** 发 Semtech UDP 或向 **MQTT Broker** 发网关事件，最终进 ChirpStack NS | **否** |
| **B. 管理/诊断路径** | `diagnose.js`、OpenClaw 插件在 NS 上查网关/设备、注册资源、下发等 | **是**（+ 常需 Application/Tenant/Device Profile 等 ID） |

**仅配置 IP + 端口 + API Token 不够**：Token 只服务路径 B；路径 A 必须单独满足网关 EUI、Bridge 端口或 MQTT 主题前缀、设备密钥等与 NS 一致。

---

## 2. 路径 A：模拟器 JSON（`*.json`，`node index.js -c …`）

配置文件为**任意路径**的 JSON，习惯放在 [`simulator/configs/`](../configs/README.md)。与 ChirpStack 相关的字段如下。

### 2.1 通用（UDP 与 MQTT 都要对齐）

| 字段 | 说明 | 与 ChirpStack 对齐方式 |
|------|------|------------------------|
| `gatewayEui` | 8 字节十六进制字符串（如 `0102030405060708`） | NS 中**网关 ID**必须相同 |
| `region` | 如 `AS923-1`、`EU868` 等 | 与 NS **启用区域**、空中参数一致；影响模拟器侧信道列表 |
| `devices[]` / `lorawan.*` | 每台 `devEui`、OTAA 的 `appKey`/`nwkKey`/`joinEui`，或 ABP 的 `devAddr`/会话密钥 | 与 Application 中**设备定义逐字段一致** |
| `multiGateway`（若启用） | 每台网关 `eui` | NS 中**每个网关**均需存在且 EUI 一致 |

### 2.2 UDP → Gateway Bridge（`mqtt.enabled` 为 `false` 或未启用 MQTT 逻辑时）

| 字段 | 说明 | 核对 |
|------|------|------|
| `lnsHost` | Bridge 所在 IP（本机 `127.0.0.1` 或远端） | 网络可达（防火墙/安全组） |
| `lnsPort` | Semtech UDP **监听端口** | 与 Bridge 映射端口一致（本仓库 AS923 示例常为 **1702**，见 `chirpstack-docker-multi-region-master/docker-compose.yml`） |
| `udpBindPort` | 模拟器本地绑定端口，`0` 表示由系统分配 | 一般可不改；多实例时注意冲突 |

### 2.3 MQTT → Broker（`mqtt.enabled: true`）

| 字段 | 说明 | 核对 |
|------|------|------|
| `mqtt.server` | 如 `tcp://127.0.0.1:1883` | 与 ChirpStack 使用的 **同一 MQTT Broker**（第三方部署时填对方提供的地址） |
| `mqtt.marshaler` | `json` 或 `protobuf` | 与 Gateway Bridge / ChirpStack 该区域配置一致 |
| `mqtt.mqttTopicPrefix` | 区域主题前缀，如 `as923` | 必须与 ChirpStack **`region_*.toml` 中 `topic_prefix`** 以及 Bridge 环境变量里的前缀**一致** |
| `mqtt.username` / `mqtt.password` | 可选 | Broker 要求认证时必须填写 |
| `mqtt.clientId` / `clean` / `qos` | 可选 | 与 Broker 策略冲突时再调 |

**字段名注意**：`index.js` 主路径读取的是 **`mqtt.mqttTopicPrefix`**。仓库内部分示例仍使用 `mqtt.topicPrefix`；若 MQTT 已开启但 NS 无上行，请改为 **`mqttTopicPrefix`** 并与 NS `topic_prefix` 对齐。

### 2.4 路径 A 不需要的配置

- **REST API Token**、**Application ID** 等：不参与 `index.js` 发包。
- 除非使用 **HTTP 控制**（`controlServer`）等，否则与 ChirpStack 无直接耦合。

---

## 3. 路径 B：REST API / OpenClaw / 诊断

### 3.1 `diagnose.js`（仓库内脚本）

| 项 | 说明 |
|----|------|
| `--api` | ChirpStack REST API 根，如 `http://127.0.0.1:8090/api`（端口以实际为准） |
| `--token` | API Key / JWT，与 ChirpStack 中生成的 Token 一致 |

### 3.2 OpenClaw 插件（[`simulator/openclaw-lorawan-sim/openclaw.config.example.json`](../openclaw-lorawan-sim/openclaw.config.example.json)）

| 字段 | 说明 |
|------|------|
| `projectPath` | **推荐**指向本仓库的 `simulator` 目录（与 `index.js` 同目录） |
| `chirpstackBaseUrl` | REST 服务地址（通常不含 `/api` 后缀时按插件 README 约定） |
| `chirpstackApiToken` | 与 NS 一致 |
| `chirpstackApplicationId` / `chirpstackTenantId` / `chirpstackDeviceProfileId` | 使用「在 NS 创建设备/同步」等工具时**必填**（UUID） |

环境变量模板见仓库根目录 [`.env.example`](../../.env.example)。

### 3.3 批量注册脚本 `scripts/chirpstack-provision-otaa-from-config.mjs`

在 **ChirpStack v4 REST API**（如 `chirpstack-rest-api` 暴露的端口，常见 `8090`）上，按 JSON **创建 OTAA 设备**并设置 **AppKey / NwkKey**（与模拟器 `devices[]` 或 `lorawan.*` 一致）。

| 环境变量 | 说明 |
|----------|------|
| `CHIRPSTACK_API_URL` | REST 根，如 `http://127.0.0.1:8090`（**不要**带 `/api` 后缀；脚本会拼 `/api/...`） |
| `CHIRPSTACK_API_TOKEN` | UI 生成的 API Key / JWT |
| `CHIRPSTACK_APPLICATION_ID` | 目标应用 UUID |
| `CHIRPSTACK_DEVICE_PROFILE_ID` | OTAA、区域与模拟器一致的 Device Profile UUID（须与 UI 中真实条目一致） |
| `CHIRPSTACK_AUTH_HEADER` | 可选；若 401 可试 `Authorization`（默认 `Grpc-Metadata-Authorization`） |

**`.env` 加载**：在仓库根执行脚本时，若存在 **`.env`**，会**自动读取**并写入 `process.env`；**已在 shell 中 `export` 的变量不会被覆盖。也可用 **`--env-file /path/.env`** 指定文件。

**配置 JSON 两种形态**：

| 形态 | 说明 |
|------|------|
| 顶层 **`devices[]`** | 与 `index.js` 单设备列表一致；按每台 `name` / `devEui` / `appKey` 注册（`mode: otaa` 且 `enabled !== false`） |
| **`lorawan.*` 批量** | `activation: OTAA`、`deviceCount`、`devEuiStart`、`appKey` 等；与旧版 `config-100nodes-10types.json` 一致 |

**常用参数**（在仓库根目录）：

```bash
# 仅校验将处理多少台、抽样首尾（不访问 NS 写接口时仍可能为列出应用内设备而读 API）
node scripts/chirpstack-provision-otaa-from-config.mjs --dry-run path/to/config.json

# 已存在则跳过创建；密钥 POST 若报重复则自动 PUT 更新
node scripts/chirpstack-provision-otaa-from-config.mjs path/to/config.json

# 先删除 CHIRPSTACK_APPLICATION_ID 下【全部】设备，再按 JSON 重建（会删掉应用中不在此 JSON 里的设备）
node scripts/chirpstack-provision-otaa-from-config.mjs --replace-all path/to/config.json
```

**`--replace-all` 注意**：清空的是**整个应用**下的设备列表，不是「仅 JSON 里出现的 DevEUI」。任一删除失败会中止，不执行后续创建。

**与本仓库示例的对应关系**：根目录 [`configs/50-device-test-config.json`](../../configs/50-device-test-config.json) 为 `devices[]` + `simulation.gateway`（AS923 Bridge 常见 **UDP 1702**，见下节 Compose）；批量规则示例见 [`simulator/configs/config-100nodes-10types.json`](../configs/config-100nodes-10types.json)。

### 3.4 本仓库自带 ChirpStack 的**文件位置**（仅作参考，改的是 NS 侧）

| 位置 | 用途 |
|------|------|
| [`chirpstack-docker-multi-region-master/docker-compose.yml`](../../chirpstack-docker-multi-region-master/docker-compose.yml) | 端口映射、Bridge 的 `INTEGRATION__MQTT__*_TOPIC_TEMPLATE` |
| `chirpstack-docker-multi-region-master/configuration/chirpstack/chirpstack.toml` | `enabled_regions` 等 |
| `…/configuration/chirpstack/region_*.toml` | 各区域 **`topic_prefix`**（与模拟器 `mqttTopicPrefix` 对齐） |
| `…/configuration/chirpstack-gateway-bridge/*.toml` | Bridge 行为；UDP 监听在 compose 端口映射中体现 |

使用**第三方 ChirpStack** 时，你通常拿不到上述文件，但必须在对方控制台或文档中确认：**Bridge UDP 端口或 MQTT Broker 地址、区域 topic 前缀、REST 地址与 Token**。

---

## 4. 核对表：本地 Compose vs 第三方

在启动 `node index.js -c <配置>` 前，建议逐项打勾。  
**清单 ID** 与本地 JSON 校验输出中的 `checklistId` 一致，可用 `node scripts/lorasim-config-validate.mjs -c …` 做静态核对（部分项仍需人工对照 NS）。

### 4.0 静态校验命令（模拟器 JSON）

```bash
# 仓库根目录
node scripts/lorasim-config-validate.mjs -c simulator/config.json --profile v20-udp
```

详见：[配置场景与校验.md](配置场景与校验.md)。

### 4.1 ChirpStack / Bridge 侧

| ID | 核对项 |
|----|--------|
| **CS-CHK-NS-RUN** | [ ] NS 与 Gateway Bridge 已运行，版本与模拟器文档假设一致（建议 **v4**）。 |
| **CS-CHK-GW-EUI** | [ ] **网关**已在 NS 创建，`Gateway ID` = 模拟器 `gatewayEui`（多网关则每个 `eui` 均有对应网关）。校验器：`ERR_GATEWAY_EUI` / `ERR_GATEWAY_EUI_FORMAT`。 |
| **CS-CHK-DEV-KEYS** | [ ] **应用与设备**已创建，密钥与模拟器 `devices[]`（或 `lorawan` 批量字段）一致。 |
| **CS-CHK-DEV-SOURCE** | [ ] JSON 中已配置设备来源（`devices[]` / CSV / 批量 OTAA / 行为模板等）；缺省时校验器警告 `W_NO_DEVICE_SOURCE`。 |
| **CS-CHK-REGION** | [ ] **区域**与 `region`、ChirpStack 启用区域一致。 |
| **CS-CHK-LNS-UDP** | [ ] **UDP**：`lnsHost`:`lnsPort` 指向**正在监听 Semtech UDP 的 Bridge**（本仓库需对照 compose 中映射，如 1702）。校验器：`ERR_LNS_HOST` / `ERR_LNS_PORT`。 |
| **CS-CHK-MQTT-BROKER** | [ ] **MQTT**：Broker 可达；若 JSON 未写 `mqtt.host`，校验器可能警告 `W_MQTT_HOST`。 |
| **CS-CHK-MQTT-TOPIC** | [ ] `mqtt.mqttTopicPrefix` = ChirpStack 该区域 `topic_prefix`；`marshaler` 与 Bridge 一致。 |
| **CS-CHK-MQTT-ENABLED** | [ ] 选用 `--profile mqtt` 时 `mqtt.enabled === true`。校验器：`ERR_MQTT_DISABLED`。 |
| **CS-CHK-MGW-PRIMARY** | [ ] 多网关 `mode=failover` 时 `primaryGateway` 与某 `gateways[].eui` 一致。校验器：`W_MULTIGW_PRIMARY`。 |

### 4.2 网络与安全（第三方尤其重要）

| ID | 核对项 |
|----|--------|
| **CS-CHK-NET** | [ ] 本机到 Broker / Bridge / REST 的 **防火墙、VPN、TLS** 已放行（若用 `tcps://` 等，与 `mqtt.server` 写法一致）。 |
| **CS-CHK-API-PERM** | [ ] API Token **权限**足够（读网关/设备、写设备等，视你使用的工具而定）。 |

### 4.3 仅在使用 OpenClaw / diagnose 时

| ID | 核对项 |
|----|--------|
| **CS-CHK-API-URL** | [ ] `chirpstackBaseUrl`、`chirpstackApiToken` 正确。 |
| **CS-CHK-API-IDS** | [ ] 插件创建设备类工具：`ApplicationId`、`TenantId`、`DeviceProfileId` 已在 NS 存在且为正确 UUID。 |
| **CS-CHK-CONTROL-HTTP** | [ ] 若需 `lorawan_sim_reset_device`：模拟器 JSON 中 `controlServer.enabled`。未启用时校验器（`--profile openclaw`）：`W_OPENCLAW_CONTROL`。 |

### 4.4 纯模拟器语义（非 NS 独占）

| ID | 说明 |
|----|------|
| **SIM-CHK-UPLINK-INTERVAL** | `uplink.interval` 在 `index.js` 中为**毫秒**；过小可能是误用秒。校验器：`W_INTERVAL_MS`。 |

---

## 5. 相关文档索引

| 文档 | 内容 |
|------|------|
| [配置场景与校验](配置场景与校验.md) | Profile、CLI/OpenClaw 校验、`CS-CHK-*` / `SIM-CHK-*` 与校验器输出对齐 |
| [ChirpStack 测试环境 · 100 节点准备流程](ChirpStack测试环境_100节点准备流程.md) | 测试服务器：清点现网（`scripts/chirpstack-inventory.mjs`）、清空应用设备、与用户确认沿用/重建、Agent 指令模板；批量注册详见本文 **§3.3** |
| [使用指南](使用指南.md) | 安装、默认配置、ChirpStack 侧准备步骤 |
| [MAC协议支持与OTAA测试](MAC协议支持与OTAA测试.md) | OTAA/MAC 与 NS 联调验证 |
| [设备重置与重新入网](设备重置与重新入网.md) | `controlServer` /reset 与重入网语义 |
| [OpenClaw 快速对接](../../docs/OPENCLAW_QUICKSTART.md) | `projectPath`、插件 `path`、环境变量 |
| [PROJECT_GOALS](PROJECT_GOALS.md) | 范围边界（非 ChirpStack NS、1.1 等不在范围内） |

---

## 6. 配置文件记录建议（团队/回归）

建议在版本库或私有笔记中**固定记录**（勿提交真实 Token）：

1. 使用的模拟器 JSON **文件名**与 **commit**。
2. **UDP 或 MQTT** 模式及关键字段：`lnsHost`/`lnsPort` 或 `mqtt.server` + `mqtt.mqttTopicPrefix` + `marshaler`。
3. `gatewayEui` 与 NS 网关名/ID 对照表。
4. 第三方环境下的 **Broker/Bridge/API 端点**（hostname、端口、是否 TLS）。
5. OpenClaw `configFile` 路径与 **脱敏后的** `chirpstackBaseUrl`（不含 token）。

仓库内可用于联调记录的示例见 [`LOCAL_TEST_LOG.md`](../../LOCAL_TEST_LOG.md)（若存在）。
