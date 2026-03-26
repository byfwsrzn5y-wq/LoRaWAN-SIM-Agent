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
- ChirpStack Docker：`chirpstack-docker-multi-region-master/`
- 设备批量写入 ChirpStack：`scripts/chirpstack-provision-otaa-from-config.mjs`（环境变量见根目录 [`.env.example`](.env.example)）

**环境建议：** 勿将 Git 仓库仅放在 iCloud「桌面/文稿」同步路径下开发（易导致 `.git` / `node_modules` 异常）；尽量克隆到本地非同步目录（如 `~/Developer/`）。

本仓库已移除前端可视化 UI（不再提供浏览器可视化服务）。模拟器仍会持续写入 `simulator/sim-state.json` 供调试/排障。

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
