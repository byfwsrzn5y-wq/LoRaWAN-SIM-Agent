# LoRaWAN-SIM

本仓库为 **LoRaWAN 网关/设备模拟器** 与 **ChirpStack 联调** 相关代码与文档的集合。

**业务代码与 npm 项目在 `simulator/` 目录**（在仓库根目录执行 `npm install` 会失败，因根目录无 `package.json`）。请：

```bash
cd simulator
npm install
```

- 模拟器说明与运行方式：[`simulator/README.md`](simulator/README.md)
- **OpenClaw Agent 插件**（推荐集成）：[`simulator/openclaw-lorawan-sim/`](simulator/openclaw-lorawan-sim/) · 快速对接 [`docs/OPENCLAW_QUICKSTART.md`](docs/OPENCLAW_QUICKSTART.md)
- 测试使用手册（从配置准备到验证/启动）：[`simulator/README.md#使用手册（配置-验证-ChirpStack-测试）`](simulator/README.md#使用手册（配置-验证-ChirpStack-测试）)
- 配置与联调总览（v2 / 路径 / MQTT / 状态契约）：[`simulator/docs/配置与联调总览.md`](simulator/docs/配置与联调总览.md)
- 文档总索引（UI 架构 / API 绑定 / 验证矩阵 / 发布治理）：[`docs/README.md`](docs/README.md)
- ChirpStack Docker：`chirpstack-docker-multi-region-master/`
- 设备批量写入 ChirpStack：`scripts/chirpstack-provision-otaa-from-config.mjs`（环境变量见根目录 [`.env.example`](.env.example)）

**环境建议：** 勿将 Git 仓库仅放在 iCloud「桌面/文稿」同步路径下开发（易导致 `.git` / `node_modules` 异常）；尽量克隆到本地非同步目录（如 `~/Developer/`）。

**Web 控制台（v1）**：[`ui/`](ui/) — Vite + React，对接控制面 `/sim-state`、`/resources/*`、`/resources/simulation`、`/layout/apply`、`/sync/retry`、`/config-profiles/*`。详见 [`ui/README.md`](ui/README.md)。模拟器仍可独立运行并持续写入 `simulator/sim-state.json` 供调试/排障。

## 当前交付状态（2026-03）

- UI v1 交互方案已冻结（信息架构 / 线框 / API 绑定完成）。
- 编排 API 已落地：`/resources/*`、`/resources/simulation`、`/layout/apply`、`/sync/retry`。
- 配置档（profile）接口已落地：`/config-profiles/*`（同时兼容旧 `/profile/*` 别名）。
- 发布治理资产已齐备：SOP、告警、回滚、里程碑、preflight 脚本。

## 最短使用说明（推荐）

从仓库根目录执行（不是 `simulator/`）：

```bash
# 1) 查看统一 CLI 帮助
node scripts/lorasim-cli.mjs help

# 2) 校验配置（先通过再跑）
node scripts/lorasim-cli.mjs validate -c simulator/configs/example-extends-chirpstack.json -p multigw

# 3) 启动模拟器
node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json

# 4) （可选）同步 ChirpStack 网关/设备
node scripts/lorasim-cli.mjs cs-gw-check -c simulator/config.json --env-file .env
node scripts/lorasim-cli.mjs cs-gw-apply -c simulator/config.json --env-file .env
node scripts/lorasim-cli.mjs cs-dev-dry -c simulator/config.json --env-file .env
node scripts/lorasim-cli.mjs cs-dev-apply -c simulator/config.json --env-file .env
```

启动后状态看这里：`simulator/sim-state.json`（`joined`、`uplinks`、`errors`）。

## 上传 GitHub 前检查清单

建议在仓库根目录执行：

```bash
# 1) 基础语法与模块冒烟
node scripts/ci-module-smoke.js
node scripts/ci-openclaw-resolve-smoke.mjs

# 2) UI 构建冒烟
cd ui && npm run build

# 3) 模拟器编排测试
cd ../simulator && npm test
```

提交前请确认：

- `.env`、token、私密配置未被纳入提交（仅保留 `.env.example` 模板）。
- `README`、`PROJECT.md` 与 `docs/` 中的状态描述一致。
- 默认演示路径可复现：`simulator/index.js` + `ui` 控制台 + `sim-state` 输出。
