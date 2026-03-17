# OpenClaw 插件：LoRaWAN 模拟器 + ChirpStack v4

通过 OpenClaw Bot 管理 LoRaWAN 网关模拟器，并在 **ChirpStack v4** 中管理网关、设备与下行。**一个插件**同时提供模拟器能力与 ChirpStack API 能力，共用同一套 ChirpStack 配置。

---

## 功能清单

### 模拟器工具（需配置 projectPath）

| 工具名 | 说明 | 可选 |
|--------|------|------|
| `lorawan_sim_status` | 查看运行状态；不传 configPath 列出所有实例（多 channel），传则查该配置 | 否（只读） |
| `lorawan_sim_start` | 在后台启动模拟器；可指定 configPath，不同配置可同时跑多实例 | 是 |
| `lorawan_sim_stop` | 停止模拟器；传 configPath 只停该实例，不传则停全部 | 是 |
| `lorawan_sim_config_get` | 读取指定配置文件内容 | 否（只读） |
| `lorawan_sim_config_list` | 列出 configs 目录下所有 JSON 配置 | 否（只读） |
| `lorawan_sim_config_set` | 按点号路径或 merge 对象更新配置 | 是 |
| `lorawan_sim_uplink_payload_set` | 设置/恢复上行自定义负载；可选 device_name/device_index 只改某设备（需 config.devices） | 是 |
| `lorawan_sim_reset_device` | 调用控制接口重置设备（需开启 controlServer） | 是 |
| `lorawan_sim_sync_from_chirpstack` | 从 ChirpStack 拉取设备列表并写入模拟器 CSV/配置 | 是 |

### ChirpStack v4 工具（需配置 ChirpStack API）

| 工具名 | 说明 | 可选 |
|--------|------|------|
| `chirpstack_gateway_list` | 列出某租户下的网关 | 否 |
| `chirpstack_gateway_create` | 注册一个网关（Gateway ID = 16 位十六进制 EUI64） | 是 |
| `chirpstack_gateway_delete` | 删除指定网关 | 是 |
| `chirpstack_device_list` | 列出某应用下的设备 | 否 |
| `chirpstack_device_create` | 注册一个 OTAA 设备并设置 AppKey | 是 |
| `chirpstack_device_delete` | 删除指定设备 | 是 |
| `chirpstack_downlink_send` | 向设备下行队列入队一条数据 | 是 |

### 能力摘要

- **单实例**：一个配置文件、一个网关 EUI、一个 ChirpStack，启停与配置读写。
- **多节点不同负载**：通过 config.devices + `lorawan_sim_uplink_payload_set` 的 device_name/device_index，或 `lorawan_sim_config_set` merge 为每设备设置不同上行 payload。
- **多 channel / 多 ChirpStack**：不同 configPath 启动多实例（不同 gatewayEui、MQTT），status 列出全部、stop 可停单实例或全部；对多套 ChirpStack API 可配置多个插件条目。

仅用 ChirpStack 工具时可不配置 `projectPath`；仅用模拟器工具时可不配置 ChirpStack（同步设备除外）。

---

## 在 OpenClaw Channel 中使用本插件

### 是否直接对话就可以？

**可以。** 在任意已连接的聊天渠道（Channel）里直接和 Bot 对话即可，例如：

- 在 Telegram / 钉钉 / WebChat 等里发：「模拟器现在在跑吗？」「用默认配置启动模拟器」
- Bot 会根据你的话调用本插件提供的工具（如 `lorawan_sim_status`、`lorawan_sim_start`），并把结果用自然语言回复给你。

无需在对话里写命令或工具名，正常用自然语言描述需求即可。

### 是否需要把插件和 Channel 关联？

**不需要把「插件」和「Channel」直接关联。** OpenClaw 的机制是：

1. **Channel（渠道）**：用户发消息的入口（Telegram、钉钉、WebChat 等）。
2. **路由**：每条消息会按配置**路由到某一个 Agent**（默认或通过 `bindings` 按渠道/群组等匹配）。
3. **Agent（智能体）**：每个 Agent 有自己的 `tools.allow` 列表，决定该 Agent **能调用哪些工具**。
4. **插件**：在 `plugins.entries` 里加载后，会向 OpenClaw **注册工具**（如 `lorawan_sim_start`、`chirpstack_device_list`）。这些工具是否可用，取决于**当前消息被路由到的那个 Agent** 是否在 `tools.allow` 里启用了它们。

因此：

- **插件** ↔ **Channel** 没有单独“关联”配置。
- 需要做的是：**让「会处理你在 Channel 里发的那类消息」的 Agent，启用本插件的工具**。

### 具体要做的配置

1. **加载插件**（在 `openclaw.json` 或 `agents.json5` 的 `plugins.entries` 里配置本插件路径与 config，见下文「使用指南」）。
2. **在 Agent 上启用工具**：在会收到你对话的那个 Agent 的 **`tools.allow`** 里，加入本插件要用的工具名，例如：
   - 按工具名逐个写：`lorawan_sim_start`、`lorawan_sim_stop`、`lorawan_sim_config_set`、`chirpstack_gateway_create`、…
   - 或按插件 id 一次启用该插件所有工具：若插件 id 为 `lorawan_sim`，可写 **`lorawan_sim`**（具体以你配置的插件 id 为准）。
3. **（可选）指定某 Channel 用某 Agent**：若你希望「只有某个渠道或某个群用 LoRaWAN 功能」，可配置 **`bindings`**，把该渠道/群路由到启用了本插件工具的 Agent；其他渠道可路由到未启用这些工具的 Agent。

总结：**在 Channel 里直接对话即可使用本插件功能；关联关系是「Agent 启用插件的工具」，不是「插件和 Channel 关联」。** 配置好插件加载与 Agent 的 `tools.allow` 后，该 Agent 处理到的会话（来自任意 Channel）都能在对话中调用 LoRaWAN 模拟器与 ChirpStack 能力。

---

## 使用指南

### 1. 安装 OpenClaw

```bash
npm install -g openclaw
# 或中文版
npm install -g openclaw-cn@latest --registry=https://registry.npmmirror.com
openclaw onboard
```

### 2. 安装本插件

**方式 A：本地目录加载（推荐）**  
在 OpenClaw 配置中指定插件路径为项目根目录下的 `openclaw-lorawan-sim`。

**方式 B：npm link**

```bash
cd openclaw-lorawan-sim
npm link
```

在 OpenClaw 的插件目录中执行：`npm link openclaw-lorawan-sim`。

### 3. 配置插件

| 配置项 | 说明 | 环境变量 |
|--------|------|----------|
| `projectPath` | 模拟器项目根目录绝对路径（模拟器工具必填；仅用 ChirpStack 可不填） | `LORAWAN_SIM_PROJECT_PATH` |
| `chirpstackBaseUrl` | ChirpStack REST 代理地址，如 `http://127.0.0.1:8090` | `CHIRPSTACK_API_URL` |
| `chirpstackApiToken` | ChirpStack API 密钥 | `CHIRPSTACK_API_TOKEN` |
| `chirpstackApplicationId` | 默认应用 ID（同步/列设备/创建设备） | `CHIRPSTACK_APPLICATION_ID` |
| `chirpstackTenantId` | 默认租户 ID（创建网关） | `CHIRPSTACK_TENANT_ID` |
| `chirpstackDeviceProfileId` | 默认设备档案 ID（创建设备） | `CHIRPSTACK_DEVICE_PROFILE_ID` |

示例（`openclaw.json` 或 `agents.json5`）：

```json
{
  "plugins": {
    "entries": {
      "lorawan_sim": {
        "path": "/path/to/lorawan_gateway_sim/openclaw-lorawan-sim",
        "config": {
          "projectPath": "/path/to/lorawan_gateway_sim",
          "chirpstackBaseUrl": "http://127.0.0.1:8090",
          "chirpstackApiToken": "your-api-key",
          "chirpstackApplicationId": "your-application-uuid",
          "chirpstackTenantId": "your-tenant-uuid",
          "chirpstackDeviceProfileId": "your-device-profile-uuid"
        }
      }
    }
  }
}
```

### 4. ChirpStack v4 与 REST 代理

- 部署 **ChirpStack v4**，并运行 **chirpstack-rest-api**（如 `--server localhost:8080 --bind 0.0.0.0:8090 --insecure`）。
- 插件的 ChirpStack 请求发往 `chirpstackBaseUrl`。

### 5. 启用可选工具

在 agent 的 `tools.allow` 中显式启用带副作用的工具，例如：

```json
"allow": [
  "lorawan_sim_start",
  "lorawan_sim_stop",
  "lorawan_sim_config_set",
  "lorawan_sim_uplink_payload_set",
  "lorawan_sim_reset_device",
  "lorawan_sim_sync_from_chirpstack",
  "chirpstack_gateway_create",
  "chirpstack_gateway_delete",
  "chirpstack_device_create",
  "chirpstack_device_delete",
  "chirpstack_downlink_send"
]
```

### 6. 推荐流程：ChirpStack 网关 + 设备 → 同步 → 模拟器

1. **chirpstack_gateway_create** 注册网关，Gateway ID 与模拟器配置中的 `gatewayEui` 一致（如 `0102030405060708`）。
2. **chirpstack_device_create** 创建若干 OTAA 设备，统一 AppKey。
3. 模拟器配置中设置 `lorawan.appKey` 为同一 AppKey（或同步时传入 `app_key`）。
4. **lorawan_sim_sync_from_chirpstack**：从 ChirpStack 拉取该应用设备列表，生成 CSV 并更新模拟器配置。
5. **lorawan_sim_start** 启动模拟器，使用已注册网关 EUI 与设备进行 OTAA 入网并发送上行。

这样 ChirpStack 中的网关与设备与模拟器使用的网关与节点一致。

### 7. 通过对话可模拟的场景（配置修改能力）

Bot 通过 **lorawan_sim_config_set**（点号 path/value 或 merge 对象）和 **lorawan_sim_uplink_payload_set** 修改配置；**多数配置改动需先停再启模拟器**（用同一 configPath）后才生效；仅 **lorawan_sim_reset_device** 对已运行实例立即生效。

| 场景类别 | 可模拟内容 | 对话示例 | 配置/工具 | 需重启 |
|----------|------------|----------|-----------|--------|
| **上行节奏** | 改上行间隔、分散方式、抖动 | 「上行间隔改成 30 秒」「首包后 5 秒再发一包」 | path: `uplink.interval` / `uplink.intervalAfterFirstDataMs`，`uplink.scatterMode`（uniform/random），`uplink.jitterRatio` | 是 |
| **上行丢包** | 模拟一定比例上行丢失 | 「模拟 10% 上行丢包」 | path: `uplink.uplinkDropRatio`, value: 0.1 | 是 |
| **突发与静默** | 连续几包后长时间静默 | 「每发 5 包停 60 秒再发」 | merge: `uplink: { burstCount: 5, burstIntervalMs: 1000, silenceAfterBurstMs: 60000 }` | 是 |
| **上行负载** | 全局/单设备自定义 payload、恢复 simple | 「上行负载设成 0102A3B4」「设备 node-1 的负载改成 AABB」「恢复默认负载」 | `lorawan_sim_uplink_payload_set`（payload/format，可选 device_name/device_index，或 use_simple: true） | 是 |
| **Confirmed/ FPort** | 上行改为 confirmed、改 FPort | 「上行改成 confirmed」「应用端口改成 10」 | path: `uplink.lorawan.confirmed` / `uplink.lorawan.fPort`；或 merge `uplink.lorawan` | 是 |
| **LinkCheck** | 每隔 N 包带 LinkCheckReq | 「每 5 包发一次 LinkCheck」 | path: `uplink.linkCheckInterval`, value: 5 | 是 |
| **设备规模与模式** | 设备数量、ABP/OTAA、AppKey、CSV 路径 | 「改成 20 个设备」「改成 OTAA」「AppKey 改成 xxx」「从 CSV configs/devices.csv 导入」 | path: `lorawan.deviceCount` / `lorawan.activation` / `lorawan.appKey` / `lorawan.csvImportPath` | 是 |
| **网关与 MQTT** | 网关 EUI、Broker、topic 前缀 | 「网关 EUI 改成 0203040506070809」「MQTT 主题前缀改成 eu868」 | path: `gatewayEui` / `mqtt.server` / `mqtt.topicPrefix`；或 merge `mqtt` | 是 |
| **统计** | 开关/间隔网关统计 | 「关掉网关统计」「统计间隔改成 2 分钟」 | path: `stats.enabled` / `stats.intervalMs` | 是 |
| **控制接口** | 开启 HTTP 重置接口 | 「开启设备重置接口，端口 9999」 | merge: `controlServer: { enabled: true, port: 9999 }` | 是 |
| **多设备不同负载** | 为每个设备设不同 payload | 「给 device-1 设 0102，device-2 设 AABB」 | 多次 `lorawan_sim_uplink_payload_set`（device_name/device_index）或 config_set merge `devices[].uplink` | 是 |
| **设备重置/重入网** | 单设备或全部 OTAA 清会话、ABP 重置 FCnt | 「重置设备 0102030405060701」「重置所有 OTAA 设备」 | `lorawan_sim_reset_device`（可选 devEui） | 否（已运行且已开 controlServer） |
| **多实例（多 channel）** | 用另一配置再起一个模拟器 | 「用 configs/gw2.json 再起一个模拟器」「停掉 gw2 那个」 | `lorawan_sim_start`（configPath: configs/gw2.json）/ `lorawan_sim_stop`（configPath） | — |
| **ChirpStack 联动** | 从 NS 拉设备、写 CSV、更新配置后启动 | 「把 ChirpStack 当前应用的设备同步过来再启动」 | `lorawan_sim_sync_from_chirpstack` → `lorawan_sim_start` | 同步后启动即生效 |

**说明**：通过 **lorawan_sim_config_set** 的 **merge** 可一次写入任意合法 JSON 片段（如整段 `uplink`、`lorawan`、`devices` 数组），适合复杂场景；**path** + **value** 适合单字段修改。Bot 只需把用户意图映射到上述 path/merge 或专用工具即可。

### 8. 常见对话示例（速查）

| 场景 | 对话示例 | 对应工具/参数 |
|------|----------|----------------|
| 查状态 | 「模拟器现在在跑吗？」 | `lorawan_sim_status` |
| 启动/停止 | 「用默认配置启动模拟器」/「停掉模拟器」 | `lorawan_sim_start` / `lorawan_sim_stop` |
| 改配置 | 「把上行间隔改成 30 秒」 | `lorawan_sim_config_set`（path: `uplink.interval`, value: 30000） |
| 自定义上行负载 | 「把上行负载设成十六进制 0102A3B4」 | `lorawan_sim_uplink_payload_set`（payload: `0102A3B4`, format: `hex`） |
| 恢复默认负载 | 「恢复默认上行负载」 | `lorawan_sim_uplink_payload_set`（use_simple: true） |
| 同步设备 | 「把 ChirpStack 里当前应用的设备同步到模拟器」 | `lorawan_sim_sync_from_chirpstack` |
| 列网关/设备 | 「列出当前租户的网关」/「列出当前应用的设备」 | `chirpstack_gateway_list` / `chirpstack_device_list` |
| 注册网关/设备 | 「注册网关 0102030405060708」/「注册 OTAA 设备 DevEUI … AppKey …」 | `chirpstack_gateway_create` / `chirpstack_device_create` |
| 发下行 | 「给设备 0102030405060701 发下行 0x0102」 | `chirpstack_downlink_send` |

### 9. 上行自定义负载

- **lorawan_sim_uplink_payload_set**：设置上行 FRMPayload 为自定义内容（hex 或 base64，最长 222 字节），或传 `use_simple: true` 恢复默认 simple 码。
- 写入配置中的 `uplink.codec`、`uplink.payload`、`uplink.payloadFormat`；**修改后需用该配置重新启动模拟器**（先 stop 再 start 指定同一 configPath）才生效。

### 10. 多节点不同负载

- 配置中需有 **config.devices**（显式设备列表）。用 **lorawan_sim_uplink_payload_set** 传入 **device_name** 或 **device_index** 可只改该设备的上行负载；或使用 **lorawan_sim_config_set** 的 **merge** 一次性写入多设备不同 `uplink`。
- 若为 CSV 导入或 ABP 批量（无 config.devices），无法按设备单独改负载，需先改为 config.devices 或使用行为模板。

### 11. 多 channel / 发往不同 ChirpStack

- 为每个 channel 准备一份配置（如 `configs/gw1.json`、`configs/gw2.json`），设置不同 `gatewayEui`、`mqtt.topicPrefix`（或不同 `mqtt.server`），在对应 ChirpStack 注册该网关。
- **lorawan_sim_start** 传入不同 **configPath** 可启动多实例；**lorawan_sim_status** 不传参数列出所有运行实例；**lorawan_sim_stop** 传 configPath 停单实例、不传停全部。
- 对多个 ChirpStack 实例分别做 API 操作时，可在 OpenClaw 中配置多个插件条目（如 `lorawan_sim_a`、`lorawan_sim_b`），各自填不同 ChirpStack 配置。

### 12. 设备重置前置条件

- 模拟器配置中开启控制接口：`"controlServer": { "enabled": true, "port": 9999 }`。
- 模拟器已通过 **lorawan_sim_start** 或手动方式运行；再通过 **lorawan_sim_reset_device**（可选 devEui）重置 OTAA 会话或 ABP FCnt。

### 13. 验收与排障

- 运行 `openclaw status --deep` 确认插件与策略已加载；运行 `openclaw doctor` 做健康检查。
- 「未配置模拟器项目路径」：检查 `projectPath` 或 `LORAWAN_SIM_PROJECT_PATH` 是否指向项目根目录。
- ChirpStack 工具报错：检查 `chirpstackBaseUrl`、`chirpstackApiToken` 及各默认 ID 是否正确；确认 chirpstack-rest-api 已启动且可访问。
