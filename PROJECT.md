# LoRaWAN World Simulator - 项目计划

> 最后更新: 2026-03-17

## 项目定位

**开源 LoRaWAN 网络模拟器** — 用于测试、诊断、教学。

目标用户：
- LoRaWAN 网络运维人员
- 物联网开发者
- 协议学习者

---

## 当前状态

| 模块 | 完成度 | 说明 |
|------|--------|------|
| LoRaWAN 协议栈 | ✅ 100% | OTAA/ABP、密钥派生、MAC 命令 |
| 异常注入引擎 | ✅ 100% | 18 种异常场景 |
| 信号传播模型 | ✅ 100% | Okumura-Hata、COST-231、衰落模型 |
| 多网关支持 | ✅ 100% | 网关管理、切换、负载均衡 |
| 可视化 | ✅ 80% | HTML 地图 + 实时数据集成 |
| 文档 | ✅ 80% | README + 项目计划 + 配置示例 |
| Agent 集成 | ✅ 100% | OpenClaw skill + 诊断工具 |

**最后更新**: 2026-03-17 22:10
**状态**: v1.0 候选版本

---

## 里程碑

### v0.1 - 代码整理 (当前) ✅
- [x] 核心代码完成
- [x] 18 种异常场景
- [x] 主 README 完善
- [x] 项目计划文档
- [x] 示例配置文件
- **状态**: 完成 ✅

### v0.2 - 可视化 ✅
- [x] HTML 地图展示节点/网关位置
- [x] 实时信号强度显示
- [x] 异常注入状态指示
- [x] 实时数据 API (HTTP 轮询)
- **状态**: 完成 ✅

### v0.3 - Agent 集成 ✅
- [x] OpenClaw skill 封装 (`~/.openclaw/skills/lorawan-sim/`)
- [x] 自动化诊断脚本 (`diagnose.js`)
- [x] 网络健康检查 API
- **状态**: 完成 ✅

### v1.0 - 发布 🔄
- [ ] GitHub 开源
- [ ] 完整文档
- [ ] 示例场景
- [ ] 发布到 ClawHub
- **状态**: 进行中

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

- Node.js >= 14
- LoRaWAN 1.0.3
- ChirpStack v4
- MQTT / UDP (Gateway Bridge)
- OpenClaw (Agent 集成)

---

## 文件结构

```
LoRaWAN-SIM/
├── simulator/
│   ├── index.js                   # 核心代码 (3100+ 行)
│   ├── physical_layer.js          # 物理层模型 (传播、天线、衰落)
│   ├── multi_gateway_advanced.js  # 多网关管理 (切换、负载均衡)
│   ├── anomaly_module.js          # 异常注入模块
│   ├── diagnose.js                # 网络诊断工具
│   ├── package.json
│   ├── start.sh                   # 启动脚本 (含可视化)
│   ├── configs/                   # 配置文件
│   │   └── example-multi-gateway.json
│   ├── docs/                      # 文档
│   ├── visualizer/                # 可视化
│   │   ├── index.html             # 前端页面
│   │   └── server.js              # 状态服务器
│   └── discord-bot/               # Discord Bot
│       ├── index.js               # Bot 主程序
│       ├── package.json
│       └── README.md
├── docs/
│   └── ANOMALY_RESPONSE.md        # 异常响应对照表
├── PROJECT.md                     # 项目计划
├── AGENTS.md / SOUL.md / USER.md  # OpenClaw 配置
└── TOOLS.md                       # 环境配置
```

## Agent 集成

### OpenClaw Skill

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
