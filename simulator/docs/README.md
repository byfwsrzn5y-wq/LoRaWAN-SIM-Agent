# 文档索引

本目录为 LoRaWAN 网关模拟器的说明文档，按用途分类如下。

---

## 入门

| 文档 | 说明 |
|------|------|
| [使用指南](使用指南.md) | 从零到跑通：环境、命令行运行、OpenClaw 配置与推荐流程（ChirpStack → 同步 → 模拟器） |

---

## 协议与 MAC

| 文档 | 说明 |
|------|------|
| [LoRaWAN 1.0.3 与 MAC 交互](LoRaWAN1.0.3与MAC交互.md) | 协议版本（FCnt/FOpts/OTAA）、OTAA/ABP 配置方式、与 ChirpStack 的上下行 MAC 交互 |
| [OTAA 入网与 MAC 命令测试](MAC协议支持与OTAA测试.md) | ChirpStack 与模拟器侧 OTAA 配置、MAC 命令一览（CID 表）、如何验证 MAC 与 OTAA |

---

## 配置与行为

| 文档 | 说明 |
|------|------|
| [行为模型与随机节点](行为模型与随机节点.md) | 正常行为基线、行为模板（baseline/extends）、随机节点生成（randomBehaviors、behaviorTemplateList） |
| [100 节点配置指南](100节点正常与异常配置.md) | 现成 100 节点预设、从 config 改为 100 节点 OTAA、正常/异常比例、ChirpStack 配合 |
| [异常行为模板参考](异常行为模板参考.md) | 异常模板与基线偏离维度、与问题维度对应表、配置说明（devStatus、uplinkDropRatio、突发静默等） |

---

## 控制与运维

| 文档 | 说明 |
|------|------|
| [设备重置与重新入网](设备重置与重新入网.md) | OTAA/ABP 重置语义、HTTP 控制接口（POST /reset）、curl 示例 |

---

## 项目说明

| 文档 | 说明 |
|------|------|
| [项目目标与范围](PROJECT_GOALS.md) | 目标、在范围内/不在范围内、使用场景 |
| [功能清单](功能清单.md) | 基于代码梳理的完整功能列表（核心模拟器、LoRaWAN/MAC、行为、控制、OpenClaw 工具、配置预设） |

---

根目录 [README.md](../README.md) 提供快速开始、配置要点与 OpenClaw 接入概要。
