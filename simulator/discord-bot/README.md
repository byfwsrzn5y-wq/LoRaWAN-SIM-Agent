# LoRaWAN Simulator Discord Bot

通过 Discord 用**自然语言**控制 LoRaWAN 模拟器。

## 使用方式

**直接说人话：**

```
!lora 启动模拟器
!lora 启动10个节点
!lora 注入 MIC 损坏异常
!lora 给第3个节点注入弱信号
!lora 查看状态
```

**或者 @提及：**

```
@LoRaWAN Bot 帮我诊断一下网络
@LoRaWAN Bot 停止模拟器
```

## 自然语言示例

| 你说 | Bot 理解 |
|------|----------|
| 启动模拟器 | `/sim-start` |
| 启动10个节点 | `/sim-start nodes:10` |
| 查看状态 | `/sim-status` |
| 列出所有节点 | `/sim-nodes` |
| 注入 MIC 损坏异常 | `/sim-anomaly type:mic-corrupt` |
| 给第3个节点注入弱信号 | `/sim-anomaly node:node-03 type:signal-weak` |
| 诊断网络 | `/sim-diagnose` |
| 停止模拟器 | `/sim-stop` |
| 帮助 | `/sim-help` |

## 支持的自然语言

### 控制模拟器

```
启动 / 开始 / 运行 / start / run
停止 / 结束 / 关闭 / stop
状态 / 怎么样 / 情况 / status
```

### 异常注入

```
注入 MIC 损坏 / MIC 错误 / 完整性
注入弱信号 / 信号弱 / RSSI 低
注入 FCnt 重复 / 重复帧
注入丢包 / 丢帧 / packet loss
注入快速 Join / 频繁入网
...
```

### 其他

```
节点 / 设备 / 列出
诊断 / 检查 / 网络健康
配置 / 选项
帮助 / 怎么用
重置 / 清除
```

## 斜杠命令（备用）

```
/lora command:启动模拟器
/lora command:查看状态
```

## 对话示例

## 安装

1. 访问 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击 "New Application"，命名如 "LoRaWAN Simulator"
3. 进入 **Bot** 页面，点击 "Add Bot"
4. 复制 **Token**（只显示一次）
5. 开启以下 Privileged Gateway Intents：
   - Message Content Intent
   - Server Members Intent（可选）
6. 进入 **OAuth2 > URL Generator**
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Use Slash Commands`, `Embed Links`
7. 复制生成的链接，在浏览器中打开，邀请 Bot 到服务器

### 2. 安装依赖

```bash
cd discord-bot
npm install
```

### 3. 配置环境变量

```bash
# 必需
export DISCORD_TOKEN="your-bot-token"

# 可选
export SIMULATOR_PATH="/path/to/LoRaWAN-SIM/simulator"
export CHIRPSTACK_API="http://127.0.0.1:8090/api"
export CHIRPSTACK_TOKEN="your-api-token"
export CONTROL_PORT="9999"
```

或创建 `.env` 文件：

```env
DISCORD_TOKEN=your-bot-token
SIMULATOR_PATH=/path/to/LoRaWAN-SIM/simulator
CHIRPSTACK_API=http://127.0.0.1:8090/api
```

### 4. 启动 Bot

```bash
npm start

# 开发模式（自动重载）
npm run dev
```

## 对话示例

**用户:** `!lora 启动模拟器`

**Bot:**
```
📡 模拟器已启动

• 配置: example-multi-gateway.json（相对 simulator/configs/）
• 节点: 配置文件定义
```

---

**用户:** `!lora 查看状态`

**Bot:**
```
🟢 模拟器状态

• 状态: 运行中
• 配置: example-multi-gateway.json（相对 simulator/configs/）
• 运行时长: 120秒
• 节点数: 5
• 上行计数: 45
```

---

**用户:** `!lora 给第2个节点注入 MIC 损坏`

**Bot:**
```
⚠️ 异常已注入

• 节点: node-02
• 类型: mic-corrupt
```

---

**用户:** `!lora 列出节点`

**Bot:**
```
📋 节点列表 (5个)

`1` node-01 (-85dBm)
`2` node-02 ⚠️mic-corrupt (-92dBm)
`3` node-03 (-78dBm)
`4` node-04 (-88dBm)
`5` node-05 (-95dBm)
```

---

**用户:** `!lora 停止`

**Bot:**
```
🛑 模拟器已停止

• 运行时长: 300秒
• 上行总数: 156
```

## 支持的异常类型（自然语言）

| 说 | 类型 |
|------|------|
| MIC 损坏 / MIC 错误 / 完整性 | mic-corrupt |
| FCnt 重复 / 重复帧 | fcnt-duplicate |
| FCnt 跳变 / 帧计数跳 | fcnt-jump |
| 弱信号 / 信号弱 / RSSI 低 | signal-weak |
| 信号突变 / 信号波动 | signal-spike |
| 丢包 / 丢帧 | random-drop |
| 快速 Join / 频繁入网 | rapid-join |
| DevNonce 重复 / 随机数重复 | devnonce-repeat |
| 错误地址 / DevAddr 错误 | wrong-devaddr |
| 非法频率 / 频率错误 | invalid-frequency |
| 占空比 / 发送过于频繁 | duty-cycle-violation |
| ADR 拒绝 | adr-reject |
| 单信道 / 锁定信道 | single-channel |
| 突发流量 / 流量突增 | burst-traffic |
| 无确认 / 无 ACK | confirmed-noack |
| Payload 损坏 / 数据损坏 | payload-corrupt |

## 架构

```
Discord Bot
    │
    ├── /sim-start ──────► 启动 simulator/index.js
    │
    ├── /sim-status ─────► 读取 simulator/sim-state.json
    │
    ├── /sim-anomaly ────► POST http://localhost:9999/anomaly
    │
    └── /sim-diagnose ───► 执行 diagnose.js
```

## 托管建议

### 使用 PM2

```bash
npm install -g pm2
pm2 start index.js --name lorawan-bot
pm2 save
pm2 startup
```

### 使用 Systemd

创建 `/etc/systemd/system/lorawan-bot.service`：

```ini
[Unit]
Description=LoRaWAN Simulator Discord Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/discord-bot
ExecStart=/usr/bin/node index.js
Restart=always
Environment=DISCORD_TOKEN=your-token

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable lorawan-bot
sudo systemctl start lorawan-bot
```

## 故障排除

### Bot 无法连接

- 检查 DISCORD_TOKEN 是否正确
- 检查网络连接
- 查看 Discord Developer Portal 中 Bot 是否在线

### 命令不显示

- 确认已注册命令（Bot 启动时会自动注册）
- 等待 Discord 同步（可能需要几分钟）
- 尝试重新邀请 Bot

### 模拟器启动失败

- 检查 SIMULATOR_PATH 是否正确
- 检查配置文件是否存在
- 查看 Bot 控制台错误日志
