# 仿真器配置（权威目录）

**本目录 `simulator/configs/` 为模拟器配置的单一权威来源**（示例、场景、ADR 与异常测试）。仓库根目录下的 [`configs/`](../../configs/README.md) 仅作部分场景的补充或历史路径；新配置请加在此目录并在下文列出。

配置 JSON 亦可由 `migrate-from-remote.sh` 从远程同步。

**分层配置**：顶层 `preset` / `extends` 在运行时由 [`simulator/src/config/v20-normalize.js`](../src/config/v20-normalize.js) 合并。内置预设见 **`presets/`**，薄表示例见 `example-extends-chirpstack.json`；说明见 [`docs/CONFIG_MAP.md`](../../docs/CONFIG_MAP.md)。

常用配置：
- `config-100nodes-10types.json` - 100 节点 OTAA + 10 种行为模板随机；与 NS 对齐清单见 `generated/chirpstack-100nodes-otaa.csv`（由 `node ../scripts/generate-otaa-manifest-from-config.mjs --out simulator/configs/generated/chirpstack-100nodes-otaa.csv` 生成后在本地使用）
- `20nodes_18anomalies_30min.json` - 20 设备 18 种异常 30 分钟测试
- `anomaly_test_10nodes.json` - 10 节点异常测试
- `adr_test_5nodes_v2.json` - ADR 混合场景测试
