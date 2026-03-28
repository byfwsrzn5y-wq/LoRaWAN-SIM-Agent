# LoRaWAN 异常检测规则

本文档提供 LoRaWAN-SIM 项目中 18 种异常类型的检测规则草稿，用于网络监控和告警系统设计。

**配套**：异常 ID、空口契约与 ChirpStack 响应速查见 [`ANOMALY_RESPONSE.md`](ANOMALY_RESPONSE.md)。

---

## 已验证异常的检测规则

### 1. mic-corrupt (MIC 损坏)

**异常描述**: 修改数据包的 Message Integrity Check (MIC) 字段，导致完整性校验失败

**ChirpStack 响应**: 丢弃数据包，记录 MIC 验证错误

**检测规则**:
```yaml
rule_id: ANOMALY-001
name: MIC Corruption Detected
severity: high
description: |
  检测到 MIC 验证失败的数据包，可能是密钥不匹配、
  中间人攻击或强干扰导致。

triggers:
  - condition: mic_validation_failed
    threshold: 5  # 5分钟内失败次数
    window: 5m

detection_logic: |
  监控 ChirpStack 日志中的以下关键词：
  - "MIC mismatch"
  - "invalid MIC"
  - "mic verification failed"
  
  匹配模式:
  - device_eui: 设备唯一标识
  - timestamp: 发生时间
  - error_count: 错误次数

alert_conditions:
  - level: warning
    condition: mic_errors > 3 in 5m
    action: notify_ops
  - level: critical
    condition: mic_errors > 10 in 5m
    action: notify_security_team + capture_logs

mitigation:
  - 检查设备密钥配置
  - 验证网络会话完整性
  - 监控是否为定向攻击
```

**测试验证**:
- 测试场景: 单节点持续发送 MIC 损坏包
- 发送数量: 41 包
- ChirpStack 响应: 全部丢弃，日志记录 MIC 错误
- 验证状态: ✅ 已验证 (2026-03-19)

---

### 2. payload-corrupt (载荷损坏)

**异常描述**: 保持 MIC 正确但修改应用层载荷数据

**ChirpStack 响应**: 接受数据包（MIC 验证通过），应用层数据损坏

**检测规则**:
```yaml
rule_id: ANOMALY-002
name: Payload Corruption Detected
severity: medium
description: |
  检测到 MIC 正确但应用层数据异常的情况，
  表明物理层存在干扰或信号质量问题。

triggers:
  - condition: payload_crc_mismatch
    threshold: 10
    window: 10m
  - condition: payload_anomaly_score > 0.8
    window: 5m

detection_logic: |
  由于 ChirpStack 不解析应用层数据，需要通过以下方式检测：
  
  1. 应用层校验:
     - 检查应用层 CRC/校验和
     - 验证数据格式有效性
     - 检测数值范围异常
  
  2. 信号质量关联:
     - rssi < -120 dBm
     - lsnr < -5 dB
     - 结合 payload 异常判断

  匹配字段:
  - dev_eui: 设备标识
  - f_cnt: 帧计数器
  - payload_hash: 载荷特征
  - rssi/lsnr: 信号质量

alert_conditions:
  - level: info
    condition: corruption_rate > 5%
    action: log_only
  - level: warning
    condition: corruption_rate > 15%
    action: notify_ops + suggest_adr
  - level: critical
    condition: corruption_rate > 30%
    action: investigate_device

mitigation:
  - 启用应用层 CRC 校验
  - 启用 Confirmed Uplink
  - 优化 ADR 参数
  - 检查设备天线/位置
```

**测试验证**:
- 测试场景: 单节点发送载荷损坏但 MIC 正确的包
- 发送数量: 41 包
- ChirpStack 响应: 全部接受（MIC 正确）
- 验证状态: ✅ 已验证 (2026-03-19)

---

### 3. fcnt-duplicate (帧计数器重复)

**异常描述**: 重复使用相同的帧计数器值（重放攻击模拟）

**ChirpStack 响应**: 拒绝重复 FCnt 的数据包

**检测规则**:
```yaml
rule_id: ANOMALY-003
name: Duplicate FCnt Detected
severity: high
description: |
  检测到重复的帧计数器值，可能是设备复位、
  重放攻击或会话恢复问题。

triggers:
  - condition: duplicate_fcnt
    threshold: 1  # 单次即触发
    window: 1m
  - condition: fcnt_rollback
    threshold: 1
    window: 1m

detection_logic: |
  监控 ChirpStack 日志和处理行为：
  
  1. 重复检测:
     - f_cnt 值与已记录值重复
     - device_eui + f_cnt 组合唯一性检查
  
  2. 回滚检测:
     - 新 f_cnt < 上次记录的 f_cnt
     - 超出合理窗口范围（默认 16384）
  
  匹配字段:
  - device_eui
  - f_cnt (当前值)
  - last_f_cnt (上次值)
  - gap (差值计算)

alert_conditions:
  - level: warning
    condition: duplicate_count > 0
    action: notify_ops + log_packet
  - level: critical
    condition: duplicate_count > 5 in 10m from same device
    action: notify_security_team + quarantine_device
  - level: critical
    condition: fcnt_rollback_detected
    action: immediate_alert + session_review

mitigation:
  - 检查设备复位原因
  - 验证设备时钟/存储
  - 启用帧计数器同步机制
  - 考虑重放攻击可能性
```

**测试验证**:
- 测试场景: 单节点发送重复 FCnt 的数据包
- 发送数量: 41 包
- ChirpStack 响应: 拒绝重复 FCnt 包
- 验证状态: ✅ 已验证 (2026-03-19)

---

## Phase 1 已验证异常（v1.0 收尾冲刺）

### 4. mic-wrong-key (错误密钥 MIC)

**异常描述**: 使用错误的 AppKey/NwkKey 计算 MIC，模拟密钥不匹配或会话派生错误

**ChirpStack 响应**: 丢弃数据包，记录 MIC 验证失败

**检测规则**:
```yaml
rule_id: ANOMALY-004
name: Wrong Key MIC Detected
severity: critical
description: |
  检测到使用错误密钥计算的 MIC，可能是密钥配置错误、
  会话派生失败或密钥泄露/轮换问题。

triggers:
  - condition: mic_validation_failed
    threshold: 1
    window: 1m
    scope: single_device

detection_logic: |
  区分 mic-corrupt 与 mic-wrong-key:
  
  1. mic-wrong-key 特征:
     - 特定设备所有包 MIC 失败（100% 失败率）
     - 其他设备正常
     - Join 阶段可能成功（如果 Join 密钥正确）
  
  2. 日志匹配:
     - "MIC mismatch"
     - "invalid MIC"
     - 设备 EUI 可识别
  
  匹配字段:
  - device_eui: 设备唯一标识
  - mic_failure_rate: 失败率（应接近 100%）
  - first_seen: 首次失败时间

alert_conditions:
  - level: warning
    condition: mic_failure_rate > 50% for device in 5m
    action: notify_ops + check_device_config
  - level: critical
    condition: mic_failure_rate = 100% for device in 5m
    action: notify_security_team + session_reset

mitigation:
  - 检查设备密钥配置（AppKey/NwkKey）
  - 重新执行 OTAA Join 恢复会话
  - 验证密钥派生链完整性
  - 检查是否有密钥轮换需求
```

**测试验证**:
- 测试场景: 单节点使用错误密钥计算 MIC
- 配置文件: test_mic-wrong-key.json
- ChirpStack 响应: 全部丢弃，MIC 验证失败
- 验证状态: ✅ 已验证 (2026-03-19)

---

### 5. devnonce-repeat (DevNonce 重复)

**异常描述**: OTAA Join 请求中重复使用相同的 DevNonce 值

**ChirpStack 响应**: Join Accept 拒绝，记录 "DevNonce already used"

**检测规则**:
```yaml
rule_id: ANOMALY-005
name: DevNonce Repeat Detected
severity: high
description: |
  检测到重复的 DevNonce 值，可能是设备随机数生成器故障、
  复位后未保存状态或重放攻击。

triggers:
  - condition: devnonce_duplicate
    threshold: 1
    window: 1m
  - condition: join_reject_rate > 80%
    window: 10m

detection_logic: |
  监控 Join 请求和响应：
  
  1. DevNonce 唯一性检查:
     - 每个设备 DevNonce 应全局唯一
     - Join 成功后该 DevNonce 被标记为已使用
  
  2. 日志匹配:
     - "DevNonce already used"
     - "join-request rejected"
     - Join Accept 未下发
  
  匹配字段:
  - device_eui: 设备标识
  - dev_nonce: 重复的 DevNonce 值
  - join_eui: Join EUI
  - reject_reason: 拒绝原因

alert_conditions:
  - level: warning
    condition: devnonce_repeat_count > 0 in 10m
    action: notify_ops + check_device_random
  - level: critical
    condition: join_reject_rate > 90% for device
    action: notify_security_team + investigate_device

mitigation:
  - 检查设备随机数生成器实现
  - 验证非易失性存储是否工作正常
  - 重新烧录设备固件（如果随机数生成器故障）
  - 考虑重放攻击可能性
```

**测试验证**:
- 测试场景: 单节点使用固定 DevNonce 重复 Join
- 配置文件: test_devnonce-repeat.json
- ChirpStack 响应: Join 拒绝，DevNonce 已使用
- 验证状态: ✅ 已验证 (2026-03-19)

---

### 6. signal-weak (信号弱)

**异常描述**: 模拟设备距离远、遮挡或天线故障导致的极弱信号

**ChirpStack 响应**: 接受数据包但标记极弱 RSSI/LSNR，可能触发 ADR 调整

**检测规则**:
```yaml
rule_id: ANOMALY-006
name: Weak Signal Detected
severity: medium
description: |
  检测到 RSSI 或 LSNR 极低的信号，可能是设备距离网关过远、
  天线故障、遮挡或电池电量低。

triggers:
  - condition: rssi < -130
    threshold: 3
    window: 5m
  - condition: lsnr < -10
    threshold: 3
    window: 5m

detection_logic: |
  监控上行包信号质量指标：
  
  1. RSSI 阈值:
     - 正常: > -100 dBm
     - 弱信号: -100 ~ -120 dBm
     - 极弱: < -130 dBm
  
  2. LSNR 阈值:
     - 正常: > 0 dB
     - 边界: -5 ~ 0 dB
     - 极差: < -10 dB
  
  匹配字段:
  - device_eui: 设备标识
  - rssi: 接收信号强度
  - lsnr: 信噪比
  - gateway_eui: 接收网关
  - datr: 数据速率

alert_conditions:
  - level: info
    condition: rssi < -120 in 10m
    action: log_only
  - level: warning
    condition: rssi < -130 or lsnr < -10
    action: notify_ops + suggest_adr
  - level: critical
    condition: packet_loss_rate > 50% due to weak signal
    action: investigate_device_location

mitigation:
  - 检查设备位置和天线
  - 启用 ADR 自动速率调整
  - 考虑增加网关覆盖
  - 检查设备电池电量
```

**测试验证**:
- 测试场景: 单节点模拟 RSSI=-145dBm, SNR=-25dB 的极弱信号
- 配置文件: test_signal-weak.json
- ChirpStack 响应: 标记极弱信号，可能触发 ADR 调整
- 验证状态: ✅ 已验证 (2026-03-19)

---

## 待验证异常的检测规则（草案）

### 7. fcnt-jump (帧计数器跳跃)

**预期检测规则**:
```yaml
rule_id: ANOMALY-007-draft
name: FCnt Jump Detected
severity: medium
triggers:
  - condition: fcnt_jump > 1000
    window: 5m
```

### 8. wrong-devaddr (错误 DevAddr)

**预期检测规则**:
```yaml
rule_id: ANOMALY-008-draft
name: Unknown DevAddr Detected
severity: high
triggers:
  - condition: unknown_devaddr_count > 5
    window: 5m
```

---

## 检测规则实施建议

### 1. 日志监控

```bash
# ChirpStack 日志监控命令示例
docker logs chirpstack-docker-chirpstack-1 -f | grep -E "(mic|MIC|f_cnt|duplicate)"
```

### 2. 指标收集

建议收集以下指标用于检测：
- `lorawan_mic_errors_total`: MIC 错误总数
- `lorawan_duplicate_fcnt_total`: 重复 FCnt 计数
- `lorawan_payload_corruption_rate`: 载荷损坏率
- `lorawan_unknown_devaddr_total`: 未知 DevAddr 计数

### 3. 告警分级

| 级别 | 响应时间 | 处理方式 |
|------|----------|----------|
| Info | 24h | 记录日志 |
| Warning | 4h | 通知运维 |
| High | 1h | 通知安全团队 |
| Critical | 15min | 立即响应 |

---

## 更新记录

| 日期 | 版本 | 更新内容 |
|------|------|----------|
| 2026-03-19 | v0.1 | 创建检测规则文档，验证 mic-corrupt、payload-corrupt、fcnt-duplicate |
| 2026-03-19 | v0.2 | v1.0 收尾冲刺，新增验证 mic-wrong-key、devnonce-repeat、signal-weak（Phase 1 完成）|

