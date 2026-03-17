# 多网关测试模型说明

## 三种工作模式

### 1. Overlapping 模式 (`multi_gateway_overlapping.json`)

**用途**: 测试ChirpStack去重机制

**逻辑**: 
- 所有能收到信号的网关都上报
- 同一帧会被多个网关转发到NS
- NS根据`deduplication_id`去重

**测试场景**:
- `near-main-gw`: 仅主网关能收到
- `overlap-zone`: 主网关+室内网关都能收到
- `far-suburban`: 仅郊区网关能收到

**验证点**:
```
ChirpStack日志应显示:
- "Uplink received" 次数 = 实际网关接收数
- "deduplication_id" 相同
```

---

### 2. Handover 模式 (`multi_gateway_handover.json`)

**用途**: 模拟移动设备切换基站

**逻辑**:
- 只选择信号最强的网关上报
- 设备移动时自动切换到最近的网关

**测试场景**:
- `mobile-device-1`: 靠近网关A (RSSI强)
- `mobile-device-2`: 中间位置 (选择信号更强的一方)
- `mobile-device-3`: 靠近网关B (RSSI强)

**验证点**:
```
每个设备只由一个网关上报
RSSI最优的网关负责转发
```

---

### 3. Failover 模式 (`multi_gateway_failover.json`)

**用途**: 模拟主网关故障时的容灾

**逻辑**:
- 优先使用主网关
- 主网关无法接收时切换到备用网关

**测试场景**:
- `critical-sensor-1`: 主网关覆盖范围内
- `critical-sensor-2`: 主网关收不到，切换到备用1
- `critical-sensor-3`: 主网关收不到，切换到备用2

**验证点**:
```
主网关能收到 → 主网关转发
主网关收不到 → 可用备用网关转发
```

---

## 运行测试

```bash
# Overlapping 测试
cd /tmp/lorawan_gateway_sim
node index.js -c multi_gateway_overlapping.json

# Handover 测试
node index.js -c multi_gateway_handover.json

# Failover 测试
node index.js -c multi_gateway_failover.json
```

## 预期输出

```
[Multi-GW] Device near-main-gw will be received by 1 gateway(s)
[Multi-GW] Device overlap-zone will be received by 2 gateway(s)
[Multi-GW] Device far-suburban will be received by 1 gateway(s)
[Multi-GW] Device edge-device will be received by 0 gateway(s)
```

---

## 配置参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `multiGateway.enabled` | boolean | 是否启用多网关 |
| `multiGateway.mode` | string | 模式: overlapping/handover/failover |
| `multiGateway.primaryGateway` | string | 主网关EUI (failover模式需要) |
| `gateways[].eui` | string | 网关EUI |
| `gateways[].position` | object | 网关位置 {x,y,z} |
| `gateways[].rxGain` | number | 接收天线增益 (dBi) |
| `gateways[].rxSensitivity` | number | 接收灵敏度 (dBm) |
