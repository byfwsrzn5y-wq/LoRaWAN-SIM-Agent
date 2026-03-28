# OpenClaw + LoRaWAN-SIM 快速对接

面向本仓库 **LoRaWAN-SIM** 的最短路径：从克隆到在对话里启停模拟器。

## 1. 两条路径（不要搞反）

| 用途 | 路径 |
|------|------|
| **OpenClaw 插件 `path`** | `<克隆>/simulator/openclaw-lorawan-sim` |
| **`projectPath` / `LORAWAN_SIM_PROJECT_PATH`** | **推荐** `<克隆>/simulator`（与 `index.js` 同目录）；**或** `<克隆>` Git 仓库根（插件 **自动解析** 到 `simulator/`，降低配错率） |

`configs/*.json` 等参数里的 `configPath` 均相对于**解析后的模拟器目录**（即 `simulator/`）。

**`plugins.entries` 片段**：见 [openclaw.plugins.entries.example.json](./openclaw.plugins.entries.example.json)（插件目录 `path` + 可选 `configFile`）。

## 2. 本机准备

```bash
cd simulator && npm install
```

OpenClaw 通过子进程启动 `node index.js`，依赖必须在 `simulator/` 安装。

## 3. ChirpStack（若要用插件里的 NS 工具）

- 部署 ChirpStack v4 + **REST API**（插件请求 `chirpstackBaseUrl`）。
- 敏感项建议用环境变量，见仓库根目录 [`.env.example`](../.env.example)。

## 4. OpenClaw 配置片段

可复制 [simulator/openclaw-lorawan-sim/openclaw.config.example.json](../simulator/openclaw-lorawan-sim/openclaw.config.example.json)，把路径改成你的本机绝对路径；或将同内容放到 `configFile` 所指 JSON，避免把 token 写进 `openclaw.json`。

在 **Agent** 的 `tools.allow` 中启用需要的工具（只读 + 有副作用的启停/改配置），详见 [simulator/openclaw-lorawan-sim/README.md](../simulator/openclaw-lorawan-sim/README.md)。

## 5. 验收对话示例

- 「模拟器现在在跑吗？」→ `lorawan_sim_status`
- 「用默认配置启动模拟器」→ `lorawan_sim_start`

## 6. 更多

- 完整流程（注册网关 → 设备 → 同步 → 启动）：[simulator/docs/使用指南.md](../simulator/docs/使用指南.md) 第四节  
- 工具列表与排障：[simulator/openclaw-lorawan-sim/README.md](../simulator/openclaw-lorawan-sim/README.md)
