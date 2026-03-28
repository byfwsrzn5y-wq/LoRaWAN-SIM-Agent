# 自定义 ADR 插件

## 文件

| 文件 | 算法 `id()`（在 Device Profile 中选择） |
|------|----------------------------------------|
| `lorawan_sim_adr.js` | `lorawan_sim_adr_v1` |

## 生效步骤

1. 本目录已通过 `chirpstack.toml` 的 `[network].adr_plugins` 挂载进容器路径 `/etc/chirpstack/adr_plugins/`。
2. **重启** `chirpstack` 服务，例如：  
   `docker compose restart chirpstack`（在 `chirpstack-docker-multi-region-master` 目录下）。
3. ChirpStack Web UI → **Device profiles** → 编辑目标模板 → **LoRaWAN MAC** → **ADR algorithm** 选 **LoRaWAN-SIM ADR (fast ramp)**（或列表中对应 `lorawan_sim_adr_v1`）。
4. 已激活设备可继续用原 Profile 时，需**换绑**带新算法的 Profile 或重建设备会话后观察下行 `LinkADRReq`。

## 可选设备变量（Device variables）

在设备详情里添加变量名（值须为数字字符串也可被解析）：

| 变量名 | 含义 | 默认 |
|--------|------|------|
| `adr_step_divisor` | SNR 余量除以该值再取整得到步数 | `3` |
| `adr_neg_min_samples` | 余量为负（要更保守）时，要求 `uplinkHistory` 中与当前 `txPowerIndex` 相同的样本数下限 | `5` |

## 说明

- 插件在 **QuickJS** 环境运行，勿使用 Node 专有 API。
- 与内置 `default` 并存；未改 Profile 的设备仍走原算法。
