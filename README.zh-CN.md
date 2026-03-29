# LoRaWAN-SIM

> **语言 / Languages:** [English（默认仓库首页）](README.md) · **简体中文（本文档）**

开源 **LoRaWAN 设备与网关模拟器**（LoRaWAN 1.0.3），用于联调测试、异常复现与教学。可选对接 **ChirpStack v4**（UDP / MQTT Gateway Bridge），并可选使用仓库根目录 **Web 控制台（`ui/`）** 编排节点与网关。

**运行时与 npm 依赖在 [`simulator/`](simulator/)**：根目录没有 `package.json`，请勿在仓库根执行 `npm install` 作为模拟器安装步骤。

---

## 前置条件

- **Node.js**：建议 ≥ 18（CI 使用 Node 20）。
- **安装依赖**
  - 模拟器：`cd simulator && npm install`
  - Web 控制台（可选）：`cd ui && npm install`
- **ChirpStack / MQTT**：仅在「真实 LNS 联调」场景需要；纯本地跑模拟器可不装。
- **环境建议**：尽量不要把仓库只放在 iCloud「桌面 / 文稿」等同步目录下开发（易出现 `.git` / `node_modules` 异常）；可克隆到本地非同步路径（例如 `~/Developer/`）。

---

## 仓库地图

| 路径 | 说明 |
|------|------|
| [`simulator/`](simulator/) | 主程序：`index.js`；默认配置 `config.json`；运行中写入本地 `sim-state.json`（不提交，见 `.gitignore`） |
| [`simulator/start.sh`](simulator/start.sh) | 仅启动模拟器核心（后台进程 + `.run-sim.log`，无前端） |
| [`scripts/`](scripts/) | 统一 CLI [`lorasim-cli.mjs`](scripts/lorasim-cli.mjs)、配置校验、ChirpStack 网关/设备脚本 |
| [`ui/`](ui/) | Web 控制台（Vite + React）；依赖模拟器控制面 HTTP API |
| [`chirpstack-docker-multi-region-master/`](chirpstack-docker-multi-region-master/) | ChirpStack 多区域 Docker 参考栈 |
| [`docs/`](docs/) | 仓库级文档索引、联调 Runbook、配置速查等 |
| [`schemas/`](schemas/) | `lorasim-config`、`sim-state` 的 JSON Schema |
| [`simulator/docs/`](simulator/docs/) | 模拟器侧中文说明与联调笔记 |

仓库内示例 JSON / `.env.example` 中的 **IP、端口、UUID** 均为占位；联调时请改为你本机或 ChirpStack 控制台中的真实值。

---

## 快速开始：按你的目标选一条路径

### A. 只跑模拟器（不接 LNS）

在仓库**根目录**（推荐，命令统一）：

```bash
cd simulator && npm install && cd ..
node scripts/lorasim-cli.mjs help
node scripts/lorasim-cli.mjs validate -c simulator/configs/example-extends-chirpstack.json -p multigw
node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json
```

更小、偏单网关 UDP 的示例：[`simulator/configs/presets/minimal-otaa-udp.json`](simulator/configs/presets/minimal-otaa-udp.json)。

或在 `simulator/` 内直接启动：

```bash
cd simulator
npm install
node index.js -c configs/example-extends-chirpstack.json
# 或：./start.sh configs/example-extends-chirpstack.json
```

`node main.js` 已弃用，仅转发到 `index.js`，请改用 `index.js` 或根目录 `lorasim-cli.mjs run`。

### B. 与 ChirpStack 联调

1. **起栈**：按 [`chirpstack-docker-multi-region-master/README.md`](chirpstack-docker-multi-region-master/README.md) 启动 ChirpStack 与 Gateway Bridge。
2. **对齐网络**：配置里的 `lnsHost`、`lnsPort`（或 MQTT 相关字段）须与 Gateway Bridge 可达地址一致。
3. **API 凭证**：复制根目录 [`.env.example`](.env.example) 为 `.env`，填写 `CHIRPSTACK_API_URL`、`CHIRPSTACK_API_TOKEN`、`CHIRPSTACK_APPLICATION_ID`、`CHIRPSTACK_DEVICE_PROFILE_ID` 等（脚本与插件会读取）。
4. **（可选）登记网关 / 设备**：可用根目录 CLI 或底层脚本。

根目录 CLI 示例（将 `-c` 换成你的配置文件）：

```bash
node scripts/lorasim-cli.mjs cs-gw-check  -c simulator/configs/example-extends-chirpstack.json --env-file .env
node scripts/lorasim-cli.mjs cs-gw-apply  -c simulator/configs/example-extends-chirpstack.json --env-file .env
node scripts/lorasim-cli.mjs cs-dev-dry   -c simulator/configs/example-extends-chirpstack.json --env-file .env
node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/configs/example-extends-chirpstack.json --env-file .env
```

亦可直接使用：[`scripts/chirpstack-ensure-gateways-from-config.mjs`](scripts/chirpstack-ensure-gateways-from-config.mjs)、[`scripts/chirpstack-provision-otaa-from-config.mjs`](scripts/chirpstack-provision-otaa-from-config.mjs)（参数与风险见 [`simulator/README.md`](simulator/README.md)）。

**分步手册（生成配置 → 校验 → 起 ChirpStack → 运行）**：[`simulator/README.md`](simulator/README.md) 内「使用手册（配置-验证-ChirpStack-测试）」；联调 Runbook：[`docs/LORAWAN_SIM_CHIRPSTACK_INTEGRATION_RUNBOOK.md`](docs/LORAWAN_SIM_CHIRPSTACK_INTEGRATION_RUNBOOK.md)。

### C. Web 控制台（可选）

1. 在模拟器所用 JSON 中启用控制面，例如 `controlServer.enabled: true`、`controlServer.port`（默认 `9999`）。
2. 编排相关能力依赖环境变量（见 [`.env.example`](.env.example)）：如 `ENABLE_ORCHESTRATOR_API`（默认开启）、与 ChirpStack 双写相关的 `ENABLE_CHIRPSTACK_SYNC` 等。
3. 启动模拟器后，另开终端：

```bash
cd ui
npm install
npm run dev
```

Vite 将 API 代理到 `VITE_CONTROL_PROXY_TARGET`（默认 `http://127.0.0.1:9999`）。完整说明见 [`ui/README.md`](ui/README.md)。

**ChirpStack 真实拓扑（可选）**：在配置 `chirpstack.topologyEnabled: true`（或环境变量 `ENABLE_CHIRPSTACK_TOPOLOGY=true`）且具备 REST API Token 时，控制面会把 ChirpStack 中的设备/网关与模拟器资源合并进 `GET /sim-state`，并用应用集成 MQTT 的 `rxInfo` 在画布上画节点—网关边。可在 Web UI 的 **Scenario** 面板勾选拓扑相关项并保存（`PATCH /resources/simulation`），左侧栏 **刷新** 可立即拉取清单；详见 [`simulator/docs/使用指南.md`](simulator/docs/使用指南.md) §5.1 与 [`docs/LORAWAN_SIM_CHIRPSTACK_UI_STATE_MACHINE.md`](docs/LORAWAN_SIM_CHIRPSTACK_UI_STATE_MACHINE.md)。

### D. OpenClaw Agent / Discord（可选）

- **OpenClaw 插件（推荐）**：[`simulator/openclaw-lorawan-sim/`](simulator/openclaw-lorawan-sim/) · 最短对接 [`docs/OPENCLAW_QUICKSTART.md`](docs/OPENCLAW_QUICKSTART.md)
- **Discord Bot**：[`simulator/discord-bot/README.md`](simulator/discord-bot/README.md)

---

## 运行后如何确认

- **状态快照**：运行时在 `simulator/sim-state.json` 持续更新（默认不提交 Git，见 [`simulator/.gitignore`](simulator/.gitignore)），可看 `joined`、节点列表、`stats.uplinks` / `stats.errors` 等（契约见 [`schemas/sim-state-v1.schema.json`](schemas/sim-state-v1.schema.json)）。
- **日志**：使用 [`simulator/start.sh`](simulator/start.sh) 时，标准输出写入 `simulator/.run-sim.log`；直接用 `node index.js` 时日志在终端。

---

## 配置与校验

- **先校验再运行**：`node scripts/lorasim-cli.mjs validate -c <配置.json> [-p v20-udp|multigw|mqtt|openclaw]`（默认 `v20-udp`）
- **字段说明与 `extends` / `preset` 合并规则**：[`docs/CONFIG_MAP.md`](docs/CONFIG_MAP.md)
- **配置 JSON Schema**：[`schemas/lorasim-config.schema.json`](schemas/lorasim-config.schema.json)
- **中文联调总览**（路径、MQTT、状态契约）：[`simulator/docs/配置与联调总览.md`](simulator/docs/配置与联调总览.md)

---

## 深入阅读

| 文档 | 说明 |
|------|------|
| [`simulator/README.md`](simulator/README.md) | 模拟器完整说明、异常列表、ChirpStack 长流程与脚本细节 |
| [`simulator/docs/README.md`](simulator/docs/README.md) | 模拟器文档目录索引 |
| [`docs/README.md`](docs/README.md) | 仓库级文档索引（UI 契约、发布治理等） |
| [`PROJECT.md`](PROJECT.md) | 路线图、里程碑、文件结构、Agent 集成说明 |

---

## 项目状态与发布

UI v1 与编排 API（`/resources/*`、`/layout/apply`、`/sync/retry`、`/config-profiles/*`）已落地；ChirpStack 拓扑导入时另提供 `POST /chirpstack/refresh-inventory`（见 [`ui/README.md`](ui/README.md)）。发布治理与 preflight 见 `docs/` 内 SOP / 回滚等文档。详细里程碑见 [`PROJECT.md`](PROJECT.md)。

---

## Git 与持续集成

- **默认分支**：`main`（若仓库仍使用 `master`，CI 对二者均生效）。
- **CI 工作流**：[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在指向 `main` / `master` 的 **push** 与 **pull_request** 上运行：关键文件的 `node --check`、`scripts/ci-module-smoke.js`、`scripts/ci-openclaw-resolve-smoke.mjs`，以及 `ui/` 下的 `npm ci` 与 `npm run build`。
- **本地忽略**：根目录 [`.gitignore`](.gitignore) 忽略 `.env`、`.cursor/`、`memory/`、`.openclaw/` 等；勿把密钥或 Token 提交进版本库。

## 上传 GitHub 前检查（建议）

在仓库根目录：

```bash
node scripts/ci-module-smoke.js
node scripts/ci-openclaw-resolve-smoke.mjs
cd ui && npm run build
cd ../simulator && npm test
```

提交前请确认：`.env` 与 token 未入库；演示路径可复现（`simulator/index.js` + 可选 `ui` + `sim-state` 输出）。

---

## 许可证

MIT
