# OTAA 入网与 MAC 命令测试

说明如何在 ChirpStack 与模拟器侧配置 OTAA、如何验证 MAC 命令。协议与 MAC 交互机制见 [LoRaWAN 1.0.3 与 MAC 交互](LoRaWAN1.0.3与MAC交互.md)。

---

## 一、OTAA 测试

### 1.1 ChirpStack 侧配置

1. **创建应用**（Application）。
2. **添加设备**（Device）：
   - **Activation**: 选择 **OTAA**。
   - **AppEUI**: 与模拟器配置中 `lorawan.appEui` 一致（如 `0000000000000001`）。
   - **DevEUI**: 与模拟器配置中 `lorawan.devEui` 一致（如 `0102030405060701`）。
   - **AppKey**: 与模拟器配置中 `lorawan.appKey` 一致（32 位十六进制，如 `00112233445566778899AABBCCDDEEFF`）。
3. **网关**：确保 Gateway Bridge 已连接，且 Gateway ID 与模拟器 `gatewayEui` 一致（如 `0102030405060708`）。
4. **区域**：设备 Profile 使用 AS923（与模拟器 `region: AS923-1` 一致）。

### 1.2 模拟器侧配置

使用 OTAA + MAC 测试配置：

```bash
node index.js -c configs/config-otaa-mac-test.json
```

或修改 `configs/config.json`：

```json
"lorawan": {
  "enabled": true,
  "activation": "OTAA",
  "appEui": "0000000000000001",
  "devEui": "0102030405060701",
  "appKey": "00112233445566778899AABBCCDDEEFF",
  "otaaName": "otaa-mac-test"
}
```

### 1.3 预期流程

1. 模拟器发送 **Join Request**（AppEUI, DevEUI, DevNonce），控制台输出：`[OTAA] Join Request sent | DevEUI: ... | DevNonce: N`。
2. ChirpStack 经网关下发 **Join Accept**，模拟器解析后输出：`[OTAA] Join Accept OK | DevAddr: xxx | DevEUI: xxx`。
3. 之后模拟器按间隔发送 **Data Up**（与 ABP 行为一致），可携带 FOpts 中的 MAC 响应（LinkADRAns 等）。

若 Join 失败，可检查：AppEUI/DevEUI/AppKey 是否与 ChirpStack 完全一致、网关是否在线、MQTT 主题前缀（如 `as923`）是否与 ChirpStack Gateway Bridge 一致。

---

## 二、MAC 协议支持一览

以下为 LoRaWAN 1.0.x 中**网络侧下发、设备侧应答**的 MAC 命令。模拟器在收到下行 FOpts 或 FPort=0 载荷中的命令后，会在**下一次上行**的 FOpts 中带回对应 Ans。

| CID (hex) | 名称 | 方向 | 模拟器支持 | 说明 |
|-----------|------|------|------------|------|
| 0x02 | LinkCheckReq | 设备→网络 | - | 设备上行请求；网络回复 LinkCheckAns（下行），模拟器不主动发 Req，可扩展 |
| 0x02 | LinkCheckAns | 网络→设备 | - | 下行，设备无需回复 |
| **0x03** | **LinkADRReq** | 网络→设备 | ✅ | 下发 DR/TxPower/ChMask；模拟器回复 **LinkADRAns** 并应用 DR/TxPower/ChMask |
| **0x04** | **DutyCycleReq** | 网络→设备 | ✅ | 下发占空比限制；模拟器回复 **DutyCycleAns**（空载荷） |
| **0x05** | **RXParamSetupReq** | 网络→设备 | ✅ | 下发 RX1 DROffset、RX2 DR/Freq；模拟器回复 **RXParamSetupAns** |
| **0x06** | **DevStatusReq** | 网络→设备 | ✅ | 请求设备状态；模拟器回复 **DevStatusAns**（Battery=200, Margin=5） |
| **0x07** | **NewChannelReq** | 网络→设备 | ✅ | 新增/修改信道；模拟器回复 **NewChannelAns** |
| **0x08** | **RXTimingSetupReq** | 网络→设备 | ✅ | 下发 RX1/RX2 延迟；模拟器回复 **RXTimingSetupAns**（空载荷） |
| **0x09** | **TXParamSetupReq** | 网络→设备 | ✅ | 下发 EIRP/Dwell；模拟器回复 **TXParamSetupAns**（空载荷） |
| **0x0A** | **DLChannelReq** | 网络→设备 | ✅ | 下行信道；模拟器回复 **DLChannelAns**（0x03 接受） |
| 0x0D | DeviceTimeAns | 网络→设备 | 解析 | 网络下发时间；设备无 MAC 回复，模拟器仅解析 |

- **方向**：网络→设备 = ChirpStack 通过下行发送，模拟器在上行中带对应 Ans。
- **支持**：✅ 表示模拟器会解析该命令并在此后上行中带回正确格式的 Ans，且（若适用）更新内部状态（如 ADR 参数）。

---

## 三、在 ChirpStack 中触发 MAC 命令

- **ADR**：设备启用 ADR 且上行 SNR 足够时，ChirpStack 会自动下发 **LinkADRReq**；模拟器上行 FCtrl 中 ADR=1，故会进入 ADR 流程。
- **DevStatusReq**：在 ChirpStack 设备页面或 API 中可主动请求设备状态，网络会下发 **DevStatusReq**，模拟器会回复 **DevStatusAns**。
- **其他 MAC**：部分命令由 ChirpStack 根据策略或配置自动下发（如 RXParamSetup、DutyCycle 等），或通过集成/API 触发。只要下行 FOpts 或 FPort=0 中带有上述 CID，模拟器都会解析并回复对应 Ans。

---

## 四、如何验证“所有 MAC 是否支持”

1. **OTAA 入网**：使用 `config-otaa-mac-test.json` 或上述 OTAA 配置，确认控制台出现 `Join Accept OK`。
2. **上行与 ADR**：入网后观察上行；若 ChirpStack 下发 LinkADRReq，控制台会打印 `Downlink | MAC: [LinkADRReq]`，下一包上行应带 LinkADRAns。
3. **DevStatus**：在 ChirpStack 中对设备执行 “Request device status”，应收到下行 DevStatusReq，模拟器下一包上行带 DevStatusAns（Battery=200, Margin=5）。
4. **其他 MAC**：若 ChirpStack 或测试工具下发 DutyCycleReq、RXParamSetupReq、NewChannelReq、RXTimingSetupReq、TXParamSetupReq、DLChannelReq，控制台会打印对应下行，且下一包上行 FOpts 中会带相应 Ans。

结论：当前模拟器支持 ChirpStack 常用 LoRaWAN 1.0.x MAC 命令（LinkADR、DutyCycle、RXParamSetup、DevStatus、NewChannel、RXTimingSetup、TXParamSetup、DLChannel），并支持 OTAA 入网与后续 Data Up，可用于“OTAA 节点 + 全量 MAC 协议”的联调与测试。
