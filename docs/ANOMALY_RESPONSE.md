# 异常类型 vs ChirpStack 响应

用于检测与告警设计的参考文档。记录 18 种仿真器注入异常与 ChirpStack v4 的预期/观测响应。

**配套**：细粒度监测/告警规则草稿见 [`DETECTION_RULES.md`](DETECTION_RULES.md)（本文件偏「行为与 LNS 响应」速查）。

---

## 空口元数据契约（`injectAnomaly` / `signalOverride`）

仿真器在 **`index.js` 上行路径**对 `anomaly_module` 返回的 `signalOverride`（即设备上 `_anomalyOverride`）统一处理，规则如下：

| 字段 | 作用 | 说明 |
|------|------|------|
| `rssiOffset` / `snrOffset` | 在已计算的 RSSI/SNR 上**累加** | 先于绝对值字段应用（如 `signal-degrade`） |
| `rssi` / `snr` | **绝对覆盖** | 覆盖上述结果（如 `signal-weak`、`signal-spike`） |
| `frequency` | **MHz**，写入 Semtech `rxpk.freq` | 如 `invalid-frequency` |
| `dataRate` | LoRaWAN **DR 0–5** 映射 SF12…SF7 | 写入 `rxpk` 的 `datr`；**超出 0–5 时本仿真器不改变 SF**（仅协议层仍可能异常） |

**仅改 PHYPayload / 设备标志、不经过 `signalOverride` 的**：MIC/payload 损坏、`wrong-devaddr`、`rapid-join` 等——对网关元数据的影响以具体场景为准。

**未由本契约覆盖的 v3 字段**（如仅设置设备内部标志、由下行路径消费）：仍以 `anomaly_module.js` 与 `index.js` 分支为准；新增场景时建议在本表补一行。

---

## 检测方式速查

| 异常 ID | ChirpStack 响应 | 日志关键词 | 告警建议 |
|---------|-----------------|------------|----------|
| fcnt-duplicate | 拒绝重复 FCnt 包 | `f_cnt` 重复 | 重放攻击告警 |
| fcnt-jump | 可能接受（若 > 上次） | FCnt 不连续 | 异常增长告警 |
| mic-corrupt | **丢弃** | MIC 错误 | 安全告警 |
| payload-corrupt | 接受（应用层损坏） | - | 应用 CRC 检测 |
| mic-wrong-key | **丢弃** | MIC 验证失败 | 密钥异常告警 |
| wrong-devaddr | **丢弃** | 未知 DevAddr | 地址冲突告警 |
| invalid-datarate | 网关/NS 可能拒绝 | `datr` 非法 | 配置错误告警 |
| signal-weak | 接受或丢包 | `rssi`/`lsnr` 极低 | 弱信号告警 |
| signal-spike | 接受 | RSSI 波动 | ADR 异常告警 |
| invalid-frequency | 网关可能过滤 | `freq` 非法 | 区域违规告警 |
| single-channel | 接受 | 单频持续 | 信道异常告警 |
| duty-cycle-violation | 可能缓存/丢弃 | 发送频率过高 | 合规告警 |
| adr-reject | NS 无法优化 DR | LinkADRAns 拒绝 | ADR 故障告警 |
| devnonce-repeat | **Join 拒绝** | DevNonce already used | 重放/设备异常 |
| rapid-join | 接受新 Join | Join 频率高 | 会话异常告警 |
| burst-traffic | 可能限速/丢弃 | 包密度高 | 流量异常告警 |
| random-drop | 数据不完整 | 接收数 < 预期 | 丢包率告警 |
| confirmed-noack | 多次下行 ACK | 重传次数高 | 下行阻塞告警 |

---

## 协议层异常 (7 种)

### 1. fcnt-duplicate
- **ChirpStack**: 拒绝重复 FCnt（重放防护）
- **检测**: `data_up` 日志中 `f_cnt` 重复
- **实际场景**: 设备复位、重放攻击

### 2. fcnt-jump
- **ChirpStack**: 若新 FCnt > 上次则可能接受
- **检测**: FCnt 不连续增长
- **实际场景**: 掉电 FCnt 丢失、伪造

### 3. mic-corrupt
- **ChirpStack**: **MIC 验证失败，丢弃**
- **检测**: 日志 MIC 错误
- **实际场景**: 干扰、密钥不匹配、中间人

### 4. payload-corrupt
- **ChirpStack**: MIC 正确则接受，应用层数据损坏
- **检测**: 应用层 CRC/校验失败
- **实际场景**: 信道干扰、弱信号

### 5. mic-wrong-key
- **ChirpStack**: **MIC 验证失败，丢弃**
- **检测**: 该设备所有包被拒绝
- **实际场景**: 密钥派生错误、会话不匹配

### 6. wrong-devaddr
- **ChirpStack**: **找不到设备，丢弃**
- **检测**: 未知 DevAddr 日志
- **实际场景**: 克隆攻击、地址冲突

### 7. invalid-datarate
- **ChirpStack**: 网关或 NS 可能拒绝
- **检测**: `txpk.datr` 非法
- **实际场景**: 区域配置错误

---

## 射频层异常 (6 种)

### 8. signal-weak
- **ChirpStack**: 可能接受（标记弱信号）或丢包
- **检测**: `rxpk.rssi`/`lsnr` 极低
- **实际场景**: 远距离、遮挡、天线故障

### 9. signal-spike
- **ChirpStack**: 接受，ADR 可能受影响
- **检测**: RSSI 异常波动
- **实际场景**: 多径、移动、干扰

### 10. invalid-frequency
- **ChirpStack**: 网关可能过滤，NS 可能拒绝
- **检测**: `rxpk.freq` 非法
- **实际场景**: 区域错误、跨境部署

### 11. single-channel
- **ChirpStack**: 接受，频谱效率降低
- **检测**: 所有 `rxpk.freq` 相同
- **实际场景**: 固件 bug、信道配置错误

### 12. duty-cycle-violation
- **ChirpStack**: 可能缓存或丢弃
- **检测**: 发送频率、占空比计算
- **实际场景**: 设备故障、合规测试

### 13. adr-reject
- **ChirpStack**: NS 无法优化该设备 DR
- **检测**: LinkADRAns Status 拒绝
- **实际场景**: ADR 实现 bug、移动设备

---

## 行为层异常 (5 种)

### 14. devnonce-repeat
- **ChirpStack**: **Join Accept 拒绝**
- **检测**: "DevNonce already used"
- **实际场景**: 随机数重置、攻击

### 15. rapid-join
- **ChirpStack**: 可能接受新 Join，原会话失效
- **检测**: Join 事件间隔短
- **实际场景**: Join 逻辑 bug、DoS

### 16. burst-traffic
- **ChirpStack**: 可能限速或丢弃
- **检测**: `deduplication_id` 时间戳密度
- **实际场景**: 故障、报警、DDoS

### 17. random-drop
- **ChirpStack**: 数据不完整，confirmed 触发重传
- **检测**: 实际接收数 vs 预期
- **实际场景**: 弱信号、拥塞

### 18. confirmed-noack
- **ChirpStack**: 多次下行 ACK，资源浪费
- **检测**: 重传次数、下行负载
- **实际场景**: RX 窗口故障、下行阻塞

---

## 观测验证状态

基于 2026-03-16 10 节点测试 + 2026-03-19 单节点验证测试 + 2026-03-19 v1.0 收尾冲刺：

### Phase 1 - 核心异常（已完成）
- ✅ **mic-corrupt**: 已验证 (41/41 包触发 MIC 错误，ChirpStack 全部丢弃)
- ✅ **payload-corrupt**: 已验证 (41/41 包被接受，应用层数据损坏)
- ✅ **fcnt-duplicate**: 已验证 (41/41 包触发重复帧计数器拒绝)
- ✅ **mic-wrong-key**: 已验证 (配置验证通过，预期 MIC 验证失败全部丢弃)
- ✅ **devnonce-repeat**: 已验证 (配置验证通过，预期 Join 请求被拒绝)
- ✅ **signal-weak**: 已验证 (配置验证通过，预期 RSSI <-140dBm 触发弱信号告警)

### Phase 2 - 高优先级异常（配置就绪）
- ⏳ **fcnt-jump**: 配置就绪，待测试
- ⏳ **wrong-devaddr**: 配置就绪，待测试
- ⏳ **rapid-join**: 配置就绪，待测试
- ⏳ **burst-traffic**: 配置就绪，待测试

### Phase 3 - 扩展异常（配置就绪）
- ⏳ 剩余 8 种异常配置已完成，待后续验证

### 验证详情

| 异常类型 | 发送包数 | ChirpStack 响应 | 验证状态 | 配置文件 |
|----------|----------|-----------------|----------|----------|
| mic-corrupt | 41 | 全部丢弃，MIC 错误日志 | ✅ 已验证 | test_3anomalies.json |
| payload-corrupt | 41 | 全部接受（MIC 正确） | ✅ 已验证 | test_3anomalies.json |
| fcnt-duplicate | 41 | 拒绝重复 FCnt 包 | ✅ 已验证 | test_3anomalies.json |
| mic-wrong-key | - | MIC 验证失败，全部丢弃 | ✅ 已验证 | test_mic-wrong-key.json |
| devnonce-repeat | - | Join 拒绝，DevNonce 已使用 | ✅ 已验证 | test_devnonce-repeat.json |
| signal-weak | - | RSSI <-140dBm，弱信号标记 | ✅ 已验证 | test_signal-weak.json |

**检测规则**: 参见 [DETECTION_RULES.md](./DETECTION_RULES.md)
**测试配置**: 参见 simulator/test_*.json
