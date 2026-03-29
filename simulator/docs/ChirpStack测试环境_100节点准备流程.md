# ChirpStack 测试环境：100 节点模拟器准备流程（含 Agent 协作）

目标：在**测试用 ChirpStack** 上，与 [`configs/config-100nodes-10types.json`](../configs/config-100nodes-10types.json) 对齐，完成「清点现网 → 决策 →（可选）清空 → 建网关/应用/设备 → 跑模拟器」。

---

## 1. 模拟器侧现成配置（无需先动 ChirpStack）

| 文件 | 说明 |
|------|------|
| [`configs/config-100nodes-10types.json`](../configs/config-100nodes-10types.json) | 100 台 OTAA、10 种行为模板随机、`deviceCount` 可调 |
| [`configs/behavior-templates.json`](../configs/behavior-templates.json) | 行为模板定义（由上项 `behaviorTemplatesFile` 引用） |
| [`configs/100节点正常与异常配置.md`](100节点正常与异常配置.md) | 100 节点场景说明 |

**必须先与 NS 对齐的字段**（见 [ChirpStack联调配置核对清单](ChirpStack联调配置核对清单.md)）：

- `gatewayEui`：ChirpStack 里要有**同一网关 ID**。
- `lnsHost` / `lnsPort` 或 MQTT：`mqtt.server`、`mqtt.mqttTopicPrefix`、`marshaler` 与本机 Bridge/Broker 一致。
- 100 个 `devEui` / `appKey` / `joinEui`：与 ChirpStack Application 中设备一致（模拟器由 `devEuiStart` / `appKey` 等批量生成规则推导，NS 侧必须按同一规则建设备，或改用「从 ChirpStack 同步」生成的 CSV）。

---

## 2. 与用户（或产品经理）确认的三句话

在改 NS 之前，把下面三句问清楚并留档：

1. **现网有什么？** — 运行清点脚本（下一节），列出租户、应用、Profile、网关、各应用设备数。
2. **沿用还是重建？** — 若已有应用 + 设备与模拟器密钥/数量一致 → **沿用**，只核对 JSON；否则测试机可 **清空该应用下设备** 后按模拟器规则重建。
3. **网关是否保留？** — 清空设备不等于删网关；若 `gatewayEui` 不变，一般**保留网关**即可。

---

## 3. Agent / 自动化：清点（只读）

在仓库根目录配置环境变量（勿提交 Token）：

```bash
export CHIRPSTACK_API_URL=http://127.0.0.1:8090
export CHIRPSTACK_API_TOKEN='<你的 JWT>'
# 若返回 401，可尝试：
# export CHIRPSTACK_AUTH_HEADER=Authorization
```

执行：

```bash
node scripts/chirpstack-inventory.mjs
# 或机器可读：
node scripts/chirpstack-inventory.mjs --json > /tmp/cs-inventory.json
```

**输出用途**：把「租户数、应用列表、每应用设备数、网关列表」贴进工单或 `LOCAL_TEST_LOG.md`，作为与用户确认的依据。

若 REST 路径报错：确认 compose 里 **chirpstack-rest-api** 已启动，且 URL **不含**路径里的重复 `/api`（脚本会规范化 `.../api` 后缀）。

---

## 4. Agent / 自动化：清空某一应用下所有设备（危险，仅测试机）

仅当用户明确同意「删除该 Application 下全部设备」时使用：

```bash
node scripts/chirpstack-wipe-application-devices.mjs \
  --application-id '<Application UUID>' \
  --confirm DELETE_ALL_DEVICES
```

不传正确 `--confirm` 时为**干跑**，只打印将删除的数量。

**不会删除**：应用本身、Device Profile、网关（仅设备）。删网关需另行在控制台或扩展脚本中处理。

---

## 5. 重建设备时的两条路

| 方式 | 适用 |
|------|------|
| **仓库脚本（推荐 100 台）** | 先运行生成命令得到 CSV（文件路径：`simulator/configs/generated/chirpstack-100nodes-otaa.csv`，列：`join_eui,dev_eui,app_key,device_name`）。也可用 REST 批量注册：`CHIRPSTACK_APPLICATION_ID`、`CHIRPSTACK_DEVICE_PROFILE_ID` 就绪后执行 `node scripts/chirpstack-provision-otaa-from-config.mjs`（仓库根 `scripts/`，自动读 `.env`；`--replace-all` 先清空应用内全部设备再按 JSON 重建）。完整参数与注意事项见 [ChirpStack 联调配置核对清单](ChirpStack联调配置核对清单.md) **§3.3**。 |
| **OpenClaw 插件** | 已配置 `CHIRPSTACK_*` 与 `chirpstack_device_create` 等工具时，由 Agent 按 DevEUI 列表循环创建。 |
| **ChirpStack Web UI / CSV 导入** | 使用（生成后得到的）`generated/chirpstack-100nodes-otaa.csv` 或控制台按行录入。 |

**JoinEUI 说明**：本模拟器对第 `i` 台设备使用 `appEuiStart + i`（与 `devEuiStart + i` 同理），故 **每台设备的 Join EUI 不同**。ChirpStack 中必须为每台设备填写**各自**的 Join EUI / DevEUI / AppKey，与 CSV 一致，OTAA 才能成功。

重新生成 CSV（修改了 `config-100nodes-10types.json` 后）：

```bash
node scripts/generate-otaa-manifest-from-config.mjs --out simulator/configs/generated/chirpstack-100nodes-otaa.csv
```

---

## 6. 跑模拟器

```bash
cd simulator
npm install
node index.js -c configs/config-100nodes-10types.json
```

观察日志中 `Join Accept OK`、上行统计；并与 ChirpStack Application 中设备激活状态对照。

---

## 7. 给 Cursor / OpenClaw Agent 的固定指令模板

可将下面整段贴给 Agent（替换占位符）：

```text
1) 读取仓库 simulator/docs/ChirpStack测试环境_100节点准备流程.md。
2) 在用户已 export CHIRPSTACK_API_URL 与 CHIRPSTACK_API_TOKEN 的前提下，运行：
   node scripts/chirpstack-inventory.mjs
   把输出的租户/应用/设备数/网关摘要写入回复。
3) 询问用户：沿用现有应用还是清空某 application 下设备后重建；若清空，取得 application-id 与用户书面确认后运行：
   node scripts/chirpstack-wipe-application-devices.mjs --application-id <UUID> --confirm DELETE_ALL_DEVICES
4) 对照 configs/config-100nodes-10types.json 列出必须在 NS 中存在的 gatewayEui 与 OTAA 密钥规则；不要猜测用户 Token。
```

---

## 8. 相关链接

- [ChirpStack 联调配置核对清单](ChirpStack联调配置核对清单.md)（UDP/MQTT/REST 分工）
- [使用指南](使用指南.md)（端到端推荐顺序）
- [OpenClaw 快速对接](../../docs/OPENCLAW_QUICKSTART.md)
