# LoRaWAN-SIM x ChirpStack 联调 Runbook（AS923）

本手册用于把本仓库中的两个项目稳定串起来：

- `simulator/`（LoRaWAN-SIM 运行时与配置）
- `chirpstack-docker-multi-region-master/`（ChirpStack 多区域 Docker 栈）

目标：按固定步骤完成 **配置校验 -> ChirpStack 资源对齐 -> 模拟器启动 -> 联调验证**。

---

## 1. 当前基线（来自仓库现状）

### 1.1 模拟器关键配置（`simulator/config.json`）

- Region: `AS923`
- LNS 地址: `localhost:1702`（UDP）
- 主网关: `19023c6b00000000`
- 多网关启用: `true`（3 个网关）
- OTAA 规则: `deviceCount=5`, `appKey=001122...EEFF`, `devEuiStart=18d3bf0000000000`

### 1.2 ChirpStack Docker 关键配置

`chirpstack-docker-multi-region-master/docker-compose.yml` 中：

- AS923 bridge UDP 端口映射: `1702:1700/udp`
- MQTT 模板前缀: `as923/gateway/...`
- Broker: `tcp://mosquitto:1883`
- REST API 代理暴露: `8090`

`chirpstack-docker-multi-region-master/configuration/chirpstack/region_as923.toml` 中：

- `id="as923"`
- gateway backend: `enabled="mqtt"`
- `topic_prefix="as923"`

结论：**当前默认链路是 UDP 上行到 1702 + ChirpStack 内部通过 MQTT as923 前缀处理网关事件。**

---

## 2. 一致性约束（必须同时满足）

联调前请确保以下绑定关系保持一致：

- Region: `AS923`（模拟器与 ChirpStack 都是 AS923）
- UDP 端口: `1702`（模拟器 `simulation.gateway.port` 对应 AS923 bridge）
- Topic Prefix: `as923`（bridge 模板 + `region_as923.toml`）
- Gateway EUI:
  - `19023c6b00000000`
  - `19023c6b00000001`
  - `19023c6b00000002`
  必须存在于 ChirpStack 租户内
- Device 资源与 OTAA keys 必须存在于目标 Application 内

---

## 3. 环境准备

### 3.1 安装 simulator 依赖

```bash
cd simulator
npm install
```

### 3.2 复制并填写环境变量

从仓库根 `.env.example` 复制为 `.env`，至少填写：

- `CHIRPSTACK_API_URL`（默认 `http://127.0.0.1:8090`）
- `CHIRPSTACK_API_TOKEN`
- `CHIRPSTACK_APPLICATION_ID`
- `CHIRPSTACK_DEVICE_PROFILE_ID`
- `CHIRPSTACK_TENANT_ID`（建议显式填，避免自动选错租户）

> 脚本会默认读取仓库根 `.env`，也支持 `--env-file` 指定路径。

---

## 4. 标准执行顺序（建议每次都按此流程）

以下命令均在仓库根目录执行。

### Step 1: 启动 ChirpStack 栈

```bash
docker compose -f chirpstack-docker-multi-region-master/docker-compose.yml up -d
```

### Step 2: 先做静态配置校验

```bash
node scripts/lorasim-cli.mjs validate -c simulator/config.json -p multigw
```

### Step 3: 网关存在性检查（不改动）

```bash
node scripts/lorasim-cli.mjs cs-gw-check -c simulator/config.json --env-file .env
```

若检查失败，再执行创建：

```bash
node scripts/lorasim-cli.mjs cs-gw-apply -c simulator/config.json --env-file .env
```

### Step 4: 设备预演（不改动）

```bash
node scripts/lorasim-cli.mjs cs-dev-dry -c simulator/config.json --env-file .env
```

确认无误后执行落库：

```bash
node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/config.json --env-file .env
```

> 如需清空目标应用后重建（高风险）：
>
> ```bash
> node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/config.json --env-file .env --replace-all
> ```

### Step 5: 启动模拟器

```bash
node scripts/lorasim-cli.mjs run -c simulator/config.json
```

---

## 5. 验收检查清单（最小闭环）

### 5.1 模拟器侧

- `simulator/sim-state.json` 持续更新
- `joined` 持续增加或 > 0
- `uplinks` 持续增加
- `errors` 为 0（或维持可解释的低水平）

### 5.2 ChirpStack 侧

- Application 里能看到对应 DevEUI 上行事件
- Gateway 列表可见 3 个 EUI
- 下行命令路径可通（有下行/ACK 相关事件）

### 5.3 端到端判定

- OTAA Join 成功
- 上行帧进入 ChirpStack
- 下行响应能回到 simulator

---

## 6. 常见问题与定位

### 问题 1：模拟器在跑，但 ChirpStack 没有上行

优先检查：

- `simulation.gateway.port` 是否为 `1702`
- `chirpstack-gateway-bridge-as923` 是否已启动且端口映射存在
- `region_as923.toml` 的 `topic_prefix` 是否是 `as923`

### 问题 2：`cs-gw-check` 报缺失

- `.env` 的 `CHIRPSTACK_API_URL/TOKEN/TENANT_ID` 是否正确
- 先执行 `cs-gw-apply` 自动创建缺失网关

### 问题 3：`cs-dev-apply` 失败

- `CHIRPSTACK_APPLICATION_ID` 与 `CHIRPSTACK_DEVICE_PROFILE_ID` 是否有效
- `lorawan.activation` 是否为 OTAA
- 若使用 `devices[]`，每台设备必须有有效 `devEui + appKey`

### 问题 4：配置改了但行为没变

- 确认实际 run 时加载的是同一个 `-c` 配置文件
- 重新跑 `validate -> cs-gw-check -> cs-dev-dry`

---

## 7. 推荐操作规范（防漂移）

- 固定一个“主配置文件”（建议 `simulator/config.json` 或指定 preset 文件）作为唯一真源
- 任何 region/port/topic 变更都同时更新：
  - simulator config
  - compose bridge 模板
  - `region_*.toml`
- 每次联调前都执行一次：
  - `validate`
  - `cs-gw-check`
  - `cs-dev-dry`

---

## 8. 一组可直接复制的最短命令

```bash
docker compose -f chirpstack-docker-multi-region-master/docker-compose.yml up -d && \
node scripts/lorasim-cli.mjs validate -c simulator/config.json -p multigw && \
node scripts/lorasim-cli.mjs cs-gw-check -c simulator/config.json --env-file .env || \
node scripts/lorasim-cli.mjs cs-gw-apply -c simulator/config.json --env-file .env
```

```bash
node scripts/lorasim-cli.mjs cs-dev-dry -c simulator/config.json --env-file .env && \
node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/config.json --env-file .env && \
node scripts/lorasim-cli.mjs run -c simulator/config.json
```
