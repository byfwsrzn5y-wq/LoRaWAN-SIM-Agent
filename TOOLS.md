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
| Gateway Bridge | 10.0.0.3:1702 (UDP) | AS923 区域（Semtech UDP → Bridge） |
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

## OpenClaw Discord Bot

配置位于 `~/.openclaw/openclaw.json`。

### 1. 获取 Guild ID

Discord 设置 → 高级 → 开发者模式（开）→ 右键你的服务器 → 复制服务器 ID

### 2. 写入配置

编辑 `~/.openclaw/openclaw.json`，将 `channels.discord.guilds` 中的 `REPLACE_WITH_GUILD_ID` 替换为你的服务器 ID。

### 3. Token

```bash
export DISCORD_BOT_TOKEN="你的Bot Token"
```

或写入 `~/.bash_profile` 后 `source ~/.bash_profile`。

### 4. 前置（若未完成）

1. [Discord Developer Portal](https://discord.com/developers/applications) 创建应用并添加 Bot
2. 开启 **Server Members Intent** 和 **Message Content Intent**
3. 邀请 Bot 到服务器（需消息权限）

### 启动

```bash
openclaw gateway
```

### DM 配对（首次私聊需批准）

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

### 配置说明

| 选项 | 说明 |
|------|------|
| `requireMention: true` | 需 @ 提及 Bot 才回复 |
| `requireMention: false` | 回复所有消息 |

---

## 其他环境

（可添加 Camera、TTS、Speaker 等）
