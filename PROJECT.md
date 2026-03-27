# LoRaWAN World Simulator - 项目计划

> 最后更新: 2026-03-27

## 项目定位

**开源 LoRaWAN 网络模拟器** — 用于测试、诊断、教学。

目标用户：
- LoRaWAN 网络运维人员
- 物联网开发者
- 协议学习者

### Agent 集成目标（OpenClaw 插件为一等公民）

模拟器在架构上**面向 OpenClaw Agent**：官方封装是仓库内 **[`simulator/openclaw-lorawan-sim/`](simulator/openclaw-lorawan-sim/)** 插件包——由宿主 OpenClaw 加载后向 Agent **注册工具**（启停 `node index.js`、读写配置、ChirpStack v4 资源与下行等），模拟器核心仍停留在本仓库、不并入 Agent 代码树。对话侧可选 Skill（`~/.openclaw/skills/lorawan-sim/`）只负责策略；**能力以插件为准**。Discord Bot（`simulator/discord-bot/`）是并行通道，不是替代插件。

### 默认运行路径

- **生产与 ChirpStack 联调**：在 `simulator/` 下使用 **`node index.js -c <config>`**、`npm start` 或 **`./start.sh`**（仅启动模拟器核心）。状态文件默认为 `simulator/sim-state.json`。
- **`main.js`（v2 模块化）**：实验用途；MQTT 不完整、状态/节点导出策略与 `index.js` 未必一致。详见 [`simulator/README.md`](simulator/README.md) 入口表与 [`docs/PROJECT_ANALYSIS.md`](docs/PROJECT_ANALYSIS.md)。

### `main.js` 与 `index.js` 双轨策略（已决策）

| 线路 | 角色 | 规则 |
|------|------|------|
| **`index.js`** | 生产与 ChirpStack 联调**唯一主线** | 新功能与 bugfix 优先在此，或通过被 `require` 的模块（如 [`simulator/anomaly_module.js`](simulator/anomaly_module.js)、[`simulator/signal_model.js`](simulator/signal_model.js)）扩展。 |
| **`main.js`** | **实验室线（冻结为结构/运动/环境验证）** | 不承诺 MQTT 全路径、多网关与 `nodes[]` 输出一致；**不作为**对外发布默认入口。 |

若未来要以 `main.js` **替代**主线，须按 [`docs/PROJECT_ANALYSIS.md`](docs/PROJECT_ANALYSIS.md) §7.1 逐项补齐缺口（含 MQTT 多网关、`recordVisualizerAfterUplink` 级状态导出、下行 parity），并改写本段与 README。

---

## 当前状态

| 模块 | 完成度 | 说明 |
|------|--------|------|
| LoRaWAN 协议栈 | ✅ 100% | OTAA/ABP、密钥派生、MAC 命令 |
| 异常注入引擎 | ✅ 100% | 18 种异常场景 |
| 信号传播模型 | ✅ 100% | Okumura-Hata、COST-231、衰落模型 |
| 多网关支持 | ✅ 100% | 网关管理、切换、负载均衡 |
| 调试状态 | ✅ 100% | `simulator/sim-state.json` 持续写盘供读取（含 `schemaVersion`；见 `schemas/sim-state-v1.schema.json`） |
| 文档 | ✅ 80% | README + 项目计划 + 配置示例 |
| Agent 集成 | ✅ 100% | OpenClaw skill + 诊断工具 |

**最后更新**: 2026-03-27 19:30
**状态**: v1.0 候选版本（核心功能已完成，进入 GitHub 发布整理阶段）

---

## 里程碑

### v0.1 - 代码整理 (当前) ✅
- [x] 核心代码完成
- [x] 18 种异常场景
- [x] 主 README 完善
- [x] 项目计划文档
- [x] 示例配置文件
- **状态**: 完成 ✅

### v0.2 - 调试状态（可独立于 UI 运行）✅
- [x] `simulator/sim-state.json` 持续写盘（UI 与脚本均可读取）
- [x] 可被本地脚本读取/解析
- **状态**: 完成 ✅

### v0.3 - Agent 集成 ✅
- [x] OpenClaw skill 封装 (`~/.openclaw/skills/lorawan-sim/`)
- [x] 自动化诊断脚本 (`diagnose.js`)
- [x] 网络健康检查 API
- **状态**: 完成 ✅

### v1.0 - 发布 🔄
- [ ] GitHub 开源
- [x] 完整文档（README / Runbook / UI 交付 / 发布治理）
- [ ] 示例场景
- [ ] 发布到 ClawHub
- [x] 最小 CI（语法检查 + 模块加载冒烟，见 `.github/workflows/ci.yml`）
- [x] UI 控制面编排 API（`/resources/*`、`/layout/apply`、`/sync/retry`）
- [x] 双写编排（`chirpstack_first`）、`partial_success` 与重试队列（内存版）
- [x] 上线治理文档（SOP / 告警 / 回滚 / 里程碑）
- [x] M3 扩大范围关键回归（创建/更新/拖拽/冲突/重试 + 旧接口回归）
- [x] UI profile 管理链路联调（`/config-profiles/*`）
- [x] UI 启动稳定性排障（Vite 依赖重建与端口治理）
- **状态**: 进行中（发布前整理与仓库清理）

### 发布治理（2026-03-26 新增） ✅
- [x] 发布门禁脚本：`scripts/release-preflight.mjs`
- [x] 灰度开关：`ENABLE_ORCHESTRATOR_API` / `ENABLE_CHIRPSTACK_SYNC`
- [x] 上线 SOP：`docs/LORAWAN_SIM_UI_RELEASE_SOP.md`
- [x] 告警规范：`docs/LORAWAN_SIM_UI_ALERTING_SPEC.md`
- [x] 回滚手册：`docs/LORAWAN_SIM_UI_ROLLBACK_PLAYBOOK.md`
- [x] 里程碑模板：`docs/LORAWAN_SIM_UI_RELEASE_MILESTONES.md`
- **状态**: 完成 ✅

---

## 核心功能

### 1. 节点模拟器
- 坐标位置 (x, y, z)
- 发射功率 (14-22 dBm)
- 天线增益
- 信道选择
- Data Rate 自适应

### 2. 网关模拟器
- 多网关配置
- 位置与高度
- 天线增益
- 接收灵敏度
- 三种覆盖模式

### 3. 异常注入
18 种异常场景，覆盖：
- 协议层 (FCnt、MIC、DevAddr)
- 射频层 (信号、频率、DataRate)
- 行为层 (Join 模式、流量模式)

### 4. 信号模型
- 自由空间路径损耗
- 环境损耗 (suburban/urban/indoor)
- 阴影衰落 (对数正态分布)
- 快衰落 (瑞利分布)

---

## 技术栈

- Node.js >= 18（CI 语法检查使用 Node 20）
- LoRaWAN 1.0.3
- ChirpStack v4
- MQTT / UDP (Gateway Bridge)
- OpenClaw (Agent 集成)

---

## 文件结构

```
LoRaWAN-SIM/
├── simulator/
│   ├── index.js                   # 核心代码（生产/ChirpStack 联调入口）
│   ├── main.js                    # 实验室线入口（结构/运动/环境验证，不承诺对齐）
│   ├── signal_model.js            # 简化路径损耗/RSSI 模型
│   ├── physical_layer.js          # 高阶物理层模型
│   ├── multi_gateway_advanced.js  # 多网关管理（切换、负载均衡）
│   ├── anomaly_module.js          # 异常注入（被 index.js require）
│   ├── diagnose.js                # 网络诊断工具
│   ├── sim-state.json            # 调试状态持久化输出（持续写盘）
│   ├── config.json               # 默认运行配置
│   ├── start.sh                   # 启动脚本（模拟器核心，可独立于 UI）
│   ├── start-explicit-active.sh  # 显式激活模式启动脚本
│   ├── configs/                   # 配置/场景预设（含 example-multi-gateway.json）
│   ├── src/                        # 协议/物理/状态模块实现
│   ├── openclaw-lorawan-sim/      # OpenClaw 插件（registerTool；Agent 集成主路径）
│   ├── docs/                      # 文档（simulator 内部）
│   ├── visualizer-ui/            # 前端可视化（可选）
│   └── discord-bot/               # Discord Bot（可选；与插件并行）
│       ├── index.js               # Bot 主程序
│       ├── package.json
│       └── README.md
├── configs/
│   └── README.md                  # 根目录配置说明
├── docs/
│   ├── PROJECT_ANALYSIS.md        # 全项目架构与深化分析（sim-state/异常/main 差集）
│   ├── OPENCLAW_QUICKSTART.md     # OpenClaw 插件路径与最短对接
│   ├── DETECTION_RULES.md         # 异常检测/规则文档
│   ├── ANOMALY_RESPONSE.md        # 异常响应对照表
│   └── openclaw.plugins.entries.example.json
├── schemas/
│   ├── sim-state-v1.schema.json
│   └── lorasim-config.schema.json
├── scripts/
├── chirpstack-docker-multi-region-master/  # ChirpStack 测试环境（资源）
├── PROJECT.md                     # 项目计划
├── AGENTS.md / SOUL.md / USER.md  # OpenClaw 配置
└── TOOLS.md                       # 环境配置
```

## Agent 集成

### OpenClaw 插件（推荐：工具能力）

- 目录：[simulator/openclaw-lorawan-sim/](simulator/openclaw-lorawan-sim/)（在 OpenClaw 里把 `plugins.entries.*.path` 指到此目录）。
- **开箱路径**：[`docs/OPENCLAW_QUICKSTART.md`](docs/OPENCLAW_QUICKSTART.md)（`projectPath` / 插件 `path` / `LORAWAN_SIM_PROJECT_PATH`）。
- 环境变量模板：仓库根 [`.env.example`](.env.example)；插件侧 `config` 示例：[simulator/openclaw-lorawan-sim/openclaw.config.example.json](simulator/openclaw-lorawan-sim/openclaw.config.example.json)；`plugins.entries` 片段：[docs/openclaw.plugins.entries.example.json](docs/openclaw.plugins.entries.example.json)。

### OpenClaw Skill（可选：对话策略）

位置: `~/.openclaw/skills/lorawan-sim/SKILL.md`

使用方式：
- 直接对话: "启动 LoRaWAN 模拟器测试..."
- 诊断网络: "检查 ChirpStack 网关状态..."
- 注入异常: "模拟 MIC 损坏场景..."

### Discord Bot

位置: `simulator/discord-bot/`

命令：
- `/sim-start` - 启动模拟器
- `/sim-stop` - 停止模拟器
- `/sim-status` - 查看状态
- `/sim-anomaly` - 注入异常
- `/sim-nodes` - 列出节点
- `/sim-diagnose` - 诊断网络

---

## 贡献者

- 主要开发: @natsuifufei
- 项目指导: Strategic Orchestrator (OpenClaw)

---

## 许可证

MIT
