# LoRaWAN-SIM 配置速查（index.js）

目标：把「想改什么」对应到 JSON 路径，并说明如何用 **preset / extends** 少写字。

## CLI 覆盖（运行时）

在加载 `-c` JSON（含 `preset`/`extends` 合并与 v2 规范化）**之后**，可用命令行再次改任意字段：

```bash
cd simulator
node index.js --help-config
node index.js -c config.json --lns-host 10.0.0.5 --lns-port 1702
node index.js -c configs/presets/chirpstack-as923-udp-v2.json --set lorawan.deviceCount=3
node index.js --set multiGateway.mode=failover --set simulation.autoStart=false
```

- **`--set dot.path=value`**：可重复；`value` 支持 `true`/`false`/`null`、整数/小数、或 JSON 字面量（对象/数组）。键值只按**第一个** `=` 分割。
- **具名参数**：见 `node index.js --help-config`（与常见 JSON 路径一一对应，例如 `--lns-host` 会同时写 `lnsHost` 与 `simulation.gateway.address`，避免 v2 扁平字段挡在 `simulation.gateway` 前面）。
- **遗留**：`--frequency N` 仍表示上行间隔 **N 秒**（写入 `uplink.interval` 为 `N*1000` 毫秒）。

实现：[`simulator/src/config/cli-overrides.js`](../simulator/src/config/cli-overrides.js)。

## 统一短命令（脚本封装）

入口：[`scripts/lorasim-cli.mjs`](../scripts/lorasim-cli.mjs)

```bash
node scripts/lorasim-cli.mjs help
```

命令映射：

| 新命令 | 封装的原命令 |
|--------|---------------|
| `node scripts/lorasim-cli.mjs run -c <cfg>` | `node simulator/index.js -c <cfg>` |
| `node scripts/lorasim-cli.mjs validate -c <cfg> -p multigw` | `node scripts/lorasim-config-validate.mjs -c <cfg> --profile multigw` |
| `node scripts/lorasim-cli.mjs cs-gw-check -c <cfg> --env-file .env` | `node scripts/chirpstack-ensure-gateways-from-config.mjs --check-only --env-file .env <cfg>` |
| `node scripts/lorasim-cli.mjs cs-gw-apply -c <cfg> --env-file .env` | `node scripts/chirpstack-ensure-gateways-from-config.mjs --env-file .env <cfg>` |
| `node scripts/lorasim-cli.mjs cs-dev-dry -c <cfg> --env-file .env` | `node scripts/chirpstack-provision-otaa-from-config.mjs --dry-run --env-file .env <cfg>` |
| `node scripts/lorasim-cli.mjs cs-dev-apply -c <cfg> --env-file .env` | `node scripts/chirpstack-provision-otaa-from-config.mjs --env-file .env <cfg>` |

说明：

- `run` 支持 `--` 后透传给 `simulator/index.js`，例如 `-- --lns-host 10.0.0.5`。
- `validate` 默认 profile 为 `v20-udp`。
- 保留旧脚本命令；短命令只是封装层。

## 入口与校验

| 动作 | 命令 |
|------|------|
| 运行 | `cd simulator && node index.js -c <file.json>`（默认 `-c config.json`） |
| 校验 | `cd simulator && npm run validate-config` 或 `node ../scripts/lorasim-config-validate.mjs -c <file> --profile v20-udp` |
| 多网关场景校验 | `--profile multigw` |

Schema 提示（编辑器自动完成）：仓库根 [`schemas/lorasim-config.schema.json`](../schemas/lorasim-config.schema.json)。

## 分层配置：`preset` 与 `extends`

在**任意**入口 JSON 顶层可选：

| 字段 | 含义 |
|------|------|
| **`preset`** | 字符串，无路径：加载 `simulator/configs/presets/<name>.json`（可写 `chirpstack-as923-udp-v2` 或 `chirpstack-as923-udp-v2.json`）。在 `extends` 之前合并。 |
| **`extends`** | 字符串或字符串数组：每个路径先递归解析（该文件自己的 `preset`/`extends` 会先展开），再按顺序深度合并；**越靠后的文件优先级越高**；**当前文件除元数据外的字段最后合并，优先级最高**。 |

解析顺序（每个文件内部）：先处理该文件的 `preset`，再按顺序处理 `extends`，最后合并该文件自身字段（不含 `preset` / `extends` / `$comment`）。

路径查找（单条 `extends`）：相对**当前配置文件所在目录** → 不存在则 `configs/presets/<basename>` → `configs/<path>`（相对 simulator 根）。

内置预设：

| 预设文件 | 用途 |
|----------|------|
| [`simulator/configs/presets/chirpstack-as923-udp-v2.json`](../simulator/configs/presets/chirpstack-as923-udp-v2.json) | v2.0、AS923、UDP 1702、三台网关、OTAA×5、控制面与 signalModel |
| [`simulator/configs/presets/minimal-otaa-udp.json`](../simulator/configs/presets/minimal-otaa-udp.json) | 单网关等价场景（`multiGateway.enabled: false`）、1 台 OTAA |

薄配置示例：[`simulator/configs/example-extends-chirpstack.json`](../simulator/configs/example-extends-chirpstack.json)。

等价写法示例：

```json
{
  "preset": "minimal-otaa-udp",
  "simulation": { "gateway": { "address": "10.0.0.5" } }
}
```

## 任务 → 配置路径

| 你想… | 配置位置（v2.0 常用） |
|--------|------------------------|
| 改 LNS / Gateway Bridge 地址与端口 | `simulation.gateway.address`、`simulation.gateway.port`；或根级覆盖 `lnsHost`、`lnsPort`；环境变量 `LORAWAN_SIM_LNS_HOST` |
| 改上报用的主网关 EUI | `simulation.gateway.gatewayEui`（需与 ChirpStack 中网关一致） |
| 多网关位置与接收灵敏度 | `multiGateway.enabled`、`multiGateway.gateways[]`（`eui`、`name`、`position`、`rxGain`、`rxSensitivity`、`cableLoss`） |
| OTAA 批量设备数量与密钥 | `lorawan.deviceCount`、`lorawan.appEuiStart`、`lorawan.devEuiStart`、`lorawan.appKey`（与 `index.js` 批量 OTAA 分支一致） |
| 从 CSV 加载设备 | `lorawan.csvImportPath`（会优先于批量 OTAA；路径相对 `cwd`） |
| 逐台 OTAA（显式 DevEUI 等） | `devices[]`（每项 `lorawan.devEui`、`appKey`、`appEui` 等）；见 `index.js` 设备装载 |
| 上行周期、payload、fPort | `uplink.intervalMs`（或 `interval`，均按毫秒调度）、`uplink.payloadLength`、`uplink.lorawan.fPort`、`uplink.codec` |
| 路径损耗 / 发射功率 / 衰落 | `signalModel.*`（`nodePosition` 为批量节点螺旋中心；多网关时用 `gateways[].position` 算距） |
| 运动轨迹 / 环境分区 / 衍生异常（原 v2） | `devices[].movement`、`environment`（`zones`/`events`）、`derivedAnomalies`；或 `v2DerivedAnomalies: true` 启用默认衍生规则；实现见 [`simulator/src/runtime/motion-environment.js`](../simulator/src/runtime/motion-environment.js) |
| HTTP 控制 API（OpenClaw 等） | `controlServer.enabled`、`host`、`port` |
| MQTT 接 Gateway Bridge | `mqtt.enabled`、`server`/`host`+`port`、`topicPrefix` 等（与 UDP 二选一或并存取决于你的 `index.js` 路径） |

## 与校验 profile 的对应关系

| Profile | 额外检查 |
|---------|-----------|
| `v20-udp` | 网关 EUI、LNS host/port（默认） |
| `multigw` | `multiGateway.enabled` 与 `gateways[]` 非空 |
| `mqtt` | `mqtt.enabled` |
| `openclaw` | 建议 `controlServer.enabled` |

校验器在检查前会**先展开** `preset`/`extends`，再对合并结果做 Schema 与规则校验。

## ChirpStack 网关与节点脚本

如果你要把配置同步到 ChirpStack，优先用脚本而不是手工 UI：

- 网关：[`scripts/chirpstack-ensure-gateways-from-config.mjs`](../scripts/chirpstack-ensure-gateways-from-config.mjs)
- OTAA 设备：[`scripts/chirpstack-provision-otaa-from-config.mjs`](../scripts/chirpstack-provision-otaa-from-config.mjs)

推荐顺序（仓库根目录执行）：

```bash
# 网关检查（不写入）
node scripts/chirpstack-ensure-gateways-from-config.mjs --check-only simulator/configs/your-config.json
# 网关创建缺失项
node scripts/chirpstack-ensure-gateways-from-config.mjs simulator/configs/your-config.json

# 设备预演（不写入）
node scripts/chirpstack-provision-otaa-from-config.mjs --dry-run simulator/configs/your-config.json
# 设备写入
node scripts/chirpstack-provision-otaa-from-config.mjs simulator/configs/your-config.json
```

必需环境变量（可写 `.env`）：

- `CHIRPSTACK_API_URL`
- `CHIRPSTACK_API_TOKEN`
- `CHIRPSTACK_APPLICATION_ID`
- `CHIRPSTACK_DEVICE_PROFILE_ID`

谨慎参数：

- `--replace-all` 会删光应用下设备再重建，不要默认使用。

## 实现位置（代码索引）

- 合并与 v2 扁平化：[`simulator/src/config/v20-normalize.js`](../simulator/src/config/v20-normalize.js)（`resolveMergedConfigSync`、`readConfig`、`normalizeV20ConfigForLegacyIndex`）
- CLI 覆盖：[`simulator/src/config/cli-overrides.js`](../simulator/src/config/cli-overrides.js)
- 结构化校验：[`simulator/src/config/validate-config.js`](../simulator/src/config/validate-config.js)
- 运行时设备与上行：[`simulator/index.js`](../simulator/index.js)
- 可选运动/环境/衍生异常：[`simulator/src/runtime/motion-environment.js`](../simulator/src/runtime/motion-environment.js)
