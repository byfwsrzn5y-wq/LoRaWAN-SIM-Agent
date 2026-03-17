# LoRaWAN 1.0.3 与 MAC 交互

说明协议版本、OTAA/ABP 配置方式及与 ChirpStack 的上下行 MAC 交互。OTAA 配置与测试步骤见 [OTAA 入网与 MAC 命令测试](MAC协议支持与OTAA测试.md)。

---

## 一、协议版本：LoRaWAN 1.0.3

本模拟器按 **LoRaWAN 1.0.3** 实现，与 ChirpStack 的默认 LoRaWAN 1.0.x 兼容。

| 项目 | 说明 |
|------|------|
| **FCnt** | 16 位（仅 FCount 低 16 位），无 32 位 FCount 扩展 |
| **FOpts** | 不加密（1.0.x 中 FOpts 明文） |
| **MIC** | B0 与 NwkSKey 的 AES-CMAC，长度 4 字节 |
| **OTAA** | Join Request / Join Accept，NwkSKey/AppSKey 按 1.0.x 从 AppKey 派生 |
| **ADR** | 支持；LinkADRReq/Ans，DR/TxPower/ChMask 与 1.0.x 一致 |

未实现 LoRaWAN 1.1 特性（如 FOpts 加密、32 位 FCnt、SKey 切换等）。

---

## 二、每节点激活方式：OTAA / ABP

- **ABP**：预配 DevAddr、NwkSKey、AppSKey，直接发 Data Up。
- **OTAA**：先发 Join Request（AppEUI, DevEUI, DevNonce），收到 Join Accept 后派生 NwkSKey/AppSKey、获得 DevAddr，再发 Data Up。

配置方式：

1. **CSV**：列 `JoinMode` 为 `ABP` 或 `OTAA`。  
   - 10 列格式：`JoinMode,Group,Name,Profile,AppEUI,DevEUI,AppKey,DevAddr,AppSKey,NwkSKey`  
   - OTAA 行：必填 AppEUI(4)、DevEUI(5)、AppKey(6)。  
   - ABP 行：必填 DevEUI(5)、DevAddr(7)、AppSKey(8)、NwkSKey(9)；AppEUI 可空。
2. **Config**：  
   - 全 ABP：`lorawan.activation: "ABP"`，`deviceCount` + `devAddrStart`/`devEuiStart`/`nwkSKey`/`appSKey`。  
   - 多 OTAA：`lorawan.activation: "OTAA"`，`deviceCount` + `appEuiStart`/`devEuiStart`/`appKey`（按序号生成多组 AppEUI/DevEUI，共用 AppKey）。  
   - 单 OTAA：`activation: "OTAA"` 且只配 `appEui`/`devEui`/`appKey`（无 deviceCount 或 appEuiStart/devEuiStart）。

多个 OTAA 时，Join Accept 按 **FIFO** 与待处理队列对应：先发出的 Join Request 对应先收到的 Join Accept。

---

## 三、与 ChirpStack 的 MAC 交互（上行 + 下行）

### 3.1 下行 MAC（网络 → 设备）

ChirpStack 通过下行 FOpts 或 FPort=0 载荷下发 MAC 命令；模拟器解析后在下**一包上行**的 FOpts 中带回对应 **Ans**，并更新本地状态（如 ADR）。

| 下行命令 | 模拟器行为 |
|----------|------------|
| LinkADRReq | 校验 DR/TxPower/ChMask，更新 macParams，回 LinkADRAns |
| DutyCycleReq | 回 DutyCycleAns（空） |
| RXParamSetupReq | 校验并更新 RX1/RX2 参数，回 RXParamSetupAns |
| DevStatusReq | 回 DevStatusAns（Battery=200, Margin=5） |
| NewChannelReq | 校验信道，回 NewChannelAns |
| RXTimingSetupReq | 回 RXTimingSetupAns（空） |
| TXParamSetupReq | 更新 EIRP/Dwell，回 TXParamSetupAns（空） |
| DLChannelReq | 回 DLChannelAns |
| DeviceTimeAns | 仅解析，无上行回复 |

### 3.2 上行 MAC（设备 → 网络）

模拟器可在上行 FOpts 中主动携带 MAC **请求**，ChirpStack 会在后续下行中回复对应 **Ans**。

| 上行命令 | 配置 | 说明 |
|----------|------|------|
| LinkCheckReq | 可选 `uplink.linkCheckInterval`（如 10） | 每 N 包上行带一次 LinkCheckReq，ChirpStack 下行回 LinkCheckAns（Margin, GwCnt） |
| LinkADRAns 等 | 由下行触发 | 收到 LinkADRReq 等后，下一包上行自动带对应 Ans |

配置示例：

```json
"uplink": {
  "linkCheckInterval": 10
}
```

表示每 10 包 Data Up 带 1 次 LinkCheckReq，用于测试 ChirpStack 下行 LinkCheckAns。

---

## 四、上行/下行指令支持小结

- **下行**：支持 ChirpStack 下发的上述 MAC 命令，并正确回 Ans、更新状态（ADR、RX 参数等）。  
- **上行**：支持在 FOpts 中携带 LinkCheckReq（可配置周期）、以及所有由下行触发的 MAC Ans（LinkADRAns、DevStatusAns 等）。  

整体满足“与 ChirpStack 的 MAC 协议交互、上行下行指令都支持”的要求，并在实现上限定为 LoRaWAN 1.0.3。
