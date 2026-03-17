# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

---

## LoRaWAN-SIM 环境

### SSH

| 别名 | 主机 | 用户 | 说明 |
|------|------|------|------|
| lorawan-host | 10.5.40.109 | rak | 仿真器运行主机 |

```bash
ssh -o StrictHostKeyChecking=no rak@10.5.40.109
```

### ChirpStack

| 组件 | 地址 | 说明 |
|------|------|------|
| API | http://10.5.40.109:8090/api | 需 Bearer Token |
| Gateway Bridge | 127.0.0.1:1702 (UDP) | AS923 区域 |
| 应用 ID | a9bede28-bb45-421e-9cfa-5824d27a4133 | 测试应用 |
| Device Profile | 85387f55-b6ec-48b8-90c6-aa0fa0f73c0e | LoRaWAN 1.0.3 OTAA |

### 常用命令

```bash
# 仿真器
cd simulator && node index.js -c <config.json>

# 迁移远程代码到本地（需 SSH 可达）
bash simulator/migrate-from-remote.sh

# ChirpStack 日志
docker logs chirpstack-docker-chirpstack-1 --since 5m

# 设备诊断（远程主机）
node /tmp/device_diagnosis.js <dev_eui>

# 清除所有激活
node /tmp/clear_all_activations.js
```

### 注册新设备 (ChirpStack API)

```bash
curl -X POST http://10.5.40.109:8090/api/devices \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "device": {
      "applicationId": "a9bede28-bb45-421e-9cfa-5824d27a4133",
      "deviceProfileId": "85387f55-b6ec-48b8-90c6-aa0fa0f73c0e",
      "name": "test-node-XX",
      "devEui": "69AE9F1F000100XX",
      "joinEui": "0000000000000000"
    },
    "deviceKeys": {
      "appKey": "00112233445566778899AABBCCDDEEFF",
      "nwkKey": "00112233445566778899AABBCCDDEEFF"
    }
  }'
```

### 网关 EUI / 区域

- Gateway EUI: 0203040506070809
- Region: AS923-1
- 统一密钥: 00112233445566778899AABBCCDDEEFF

---

## 其他环境

（可添加 Camera、TTS、Speaker 等）
