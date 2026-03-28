# 仿真器配置（权威目录）

**本目录 `simulator/configs/` 为模拟器配置的单一权威来源**（示例、场景、ADR 与异常测试）。仓库根目录下的 [`configs/`](../../configs/README.md) 仅作部分场景的补充或历史路径；新配置请加在此目录并在下文列出。

配置 JSON 亦可由 `migrate-from-remote.sh` 从远程同步。

**分层配置**：顶层 `preset` / `extends` 在运行时由 [`simulator/src/config/v20-normalize.js`](../src/config/v20-normalize.js) 合并。内置预设见 **`presets/`**；**入门默认**薄表示例见根目录 [`example-extends-chirpstack.json`](example-extends-chirpstack.json)（与 `node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json` 一致）。**进阶多场景**见子目录 `scenarios/`、`gateway/`、`special/`、`adr/`、`single-node/` 等。字段说明见 [`docs/CONFIG_MAP.md`](../../docs/CONFIG_MAP.md)。

**UI 配置档快照**：统一放在本目录下的 **`profiles/`**（每个 profile 一个 `*.json`）。主配置文件在 `simulator/config.json` 时，默认 profile 目录也是这里的 `profiles/`（相对路径在各自 JSON 里写 `configs/profiles`）；主配置文件在本目录内（如 `example-extends-chirpstack.json`）时，请在 `profileConfig.profilesDir` 使用 **`profiles`**（同级目录），**不要**再写 `configs/profiles`（否则会错误地生成已废弃的 `configs/configs/profiles/`）。

常用配置：
- `config-100nodes-10types.json` - 100 节点 OTAA + 10 种行为模板随机（依赖同目录 `behavior-templates.json`）；与 NS 对齐清单见 `generated/chirpstack-100nodes-otaa.csv`（由 `node ../scripts/generate-otaa-manifest-from-config.mjs --out simulator/configs/generated/chirpstack-100nodes-otaa.csv` 生成后在本地使用）
- `scenarios/20nodes_18anomalies_30min.json` - 20 设备 18 种异常 30 分钟测试
- `special/anomaly_test_10nodes.json` - 10 节点异常测试
- `adr/adr_test_5nodes_v2.json` - ADR 混合场景测试
- `config.json` / `config-otaa-demo-flow.json` / `config-otaa-mac-test.json` - 与 `npm run start:config`、`start:otaa` 及 OTAA/MAC 文档对应
- `example-multi-gateway.json` - 多网关示例（根 `configs/README.md` 亦引用）
