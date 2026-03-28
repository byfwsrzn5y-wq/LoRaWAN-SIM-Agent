# LoRaWAN-SIM 文档索引

仓库级文档入口：与根目录 [`README.md`](../README.md)、[`PROJECT.md`](../PROJECT.md) 并列；模拟器实操与中文说明见 [`simulator/docs/README.md`](../simulator/docs/README.md)。

---

## 版本控制与 CI

| 资源 | 说明 |
|------|------|
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | 向 `main` / `master` 的 push 与 PR：语法检查、模块冒烟、OpenClaw 路径解析冒烟、`ui` 安装与构建 |
| [`.gitignore`](../.gitignore) | 忽略 `.env`、`.cursor/`、`memory/`、`.openclaw/` 与本地运行产物等（详见文件内注释） |
| 根 [`README.md`](../README.md) §「Git 与持续集成」 | 分支约定、与本地「上传前检查」命令对齐 |

---

## 项目与架构

| 文档 | 说明 |
|------|------|
| [`PROJECT.md`](../PROJECT.md) | 路线图、里程碑、文件结构、Agent 集成 |
| [`PROJECT_ANALYSIS.md`](PROJECT_ANALYSIS.md) | 架构深化：sim-state 写入路径、异常与源码映射、可选运动/环境/衍生异常并入 `index.js` |
| [`CONFIG_MAP.md`](CONFIG_MAP.md) | 配置 JSON 路径速查、`preset` / `extends`、`lorasim-cli` 与校验命令 |

## 模拟器联调与 Agent

| 文档 | 说明 |
|------|------|
| [`OPENCLAW_QUICKSTART.md`](OPENCLAW_QUICKSTART.md) | OpenClaw 插件路径、`projectPath`、`LORAWAN_SIM_PROJECT_PATH` |
| [`openclaw.plugins.entries.example.json`](openclaw.plugins.entries.example.json) | `plugins.entries` 片段示例 |
| [`LORAWAN_SIM_CHIRPSTACK_INTEGRATION_RUNBOOK.md`](LORAWAN_SIM_CHIRPSTACK_INTEGRATION_RUNBOOK.md) | ChirpStack 联调 Runbook |

## 异常与监测设计

| 文档 | 说明 |
|------|------|
| [`ANOMALY_RESPONSE.md`](ANOMALY_RESPONSE.md) | 空口元数据契约、`signalOverride`、异常 vs ChirpStack 响应速查与分项说明 |
| [`DETECTION_RULES.md`](DETECTION_RULES.md) | 18 类异常的监测/告警规则草稿（YAML 风格），与上表配合使用 |

## UI v1（信息架构、契约与发布）

| 文档 | 说明 |
|------|------|
| [`LORAWAN_SIM_UI_INFORMATION_ARCHITECTURE.md`](LORAWAN_SIM_UI_INFORMATION_ARCHITECTURE.md) | 信息架构 |
| [`LORAWAN_SIM_UI_WIREFRAME_V1.md`](LORAWAN_SIM_UI_WIREFRAME_V1.md) | 线框 v1 |
| [`LORAWAN_SIM_INSPECTOR_CONFIG_SCOPE.md`](LORAWAN_SIM_INSPECTOR_CONFIG_SCOPE.md) | Inspector 配置范围 |
| [`LORAWAN_SIM_UI_API_BINDING_SPEC.md`](LORAWAN_SIM_UI_API_BINDING_SPEC.md) | 前端 API 绑定 |
| [`LORAWAN_SIM_CHIRPSTACK_UI_CONTRACT.md`](LORAWAN_SIM_CHIRPSTACK_UI_CONTRACT.md) | ChirpStack 侧 UI 契约 |
| [`LORAWAN_SIM_CHIRPSTACK_UI_ORCHESTRATION.md`](LORAWAN_SIM_CHIRPSTACK_UI_ORCHESTRATION.md) | 编排流程 |
| [`LORAWAN_SIM_CHIRPSTACK_UI_STATE_MACHINE.md`](LORAWAN_SIM_CHIRPSTACK_UI_STATE_MACHINE.md) | 编排状态机；含 **ChirpStack 真实拓扑**（REST 清单 + MQTT `rxInfo`、Web UI 入口） |
| [`LORAWAN_SIM_CHIRPSTACK_UI_VALIDATION_MATRIX.md`](LORAWAN_SIM_CHIRPSTACK_UI_VALIDATION_MATRIX.md) | 验证矩阵 |
| [`LORAWAN_SIM_UI_V1_FREEZE_CHECKLIST.md`](LORAWAN_SIM_UI_V1_FREEZE_CHECKLIST.md) | v1 冻结检查单 |

## 发布治理

| 文档 | 说明 |
|------|------|
| [`LORAWAN_SIM_UI_RELEASE_SOP.md`](LORAWAN_SIM_UI_RELEASE_SOP.md) | 发布 SOP |
| [`LORAWAN_SIM_UI_RELEASE_MILESTONES.md`](LORAWAN_SIM_UI_RELEASE_MILESTONES.md) | 里程碑模板 |
| [`LORAWAN_SIM_UI_ALERTING_SPEC.md`](LORAWAN_SIM_UI_ALERTING_SPEC.md) | 告警规范 |
| [`LORAWAN_SIM_UI_ROLLBACK_PLAYBOOK.md`](LORAWAN_SIM_UI_ROLLBACK_PLAYBOOK.md) | 回滚手册 |
