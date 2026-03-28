// ===============================
// 异常场景注入模块 - Anomaly Injection Module
// 单一事实来源（SSOT）：simulator/index.js 通过 require 使用 injectAnomaly。
// ===============================

const ANOMALY_SCENARIOS = {
  // FCnt重复: 发送相同的FCnt，测试NS防重放
  'fcnt-duplicate': {
    description: 'Send duplicate FCnt to test replay protection',
    inject: (device, payload, fCnt, params) => {
      // 不递增FCnt，下次发送相同值
      if (device.fCntUp > 0) {
        device.fCntUp--; // 回退FCnt
        console.log(`[ANOMALY] FCnt duplicate injected for ${device.name}: FCnt=${fCnt}`);
      }
      return payload;
    }
  },
  
  // FCnt跳变: 大幅度跳变FCnt，测试NS容错
  'fcnt-jump': {
    description: 'Jump FCnt by large value to test session recovery',
    inject: (device, payload, fCnt, params) => {
      const jump = params.jump || 1000;
      device.fCntUp += jump;
      console.log(`[ANOMALY] FCnt jump injected for ${device.name}: +${jump}`);
      return payload;
    }
  },
  
  // MIC损坏: 翻转MIC字节，测试完整性验证
  'mic-corrupt': {
    description: 'Corrupt MIC bytes to test integrity check',
    inject: (device, payload, fCnt, params) => {
      const flipBits = params.flipBits || 2;
      const micStart = payload.length - 4;
      for (let i = 0; i < flipBits; i++) {
        const byteIdx = micStart + (i % 4);
        const bitIdx = Math.floor(Math.random() * 8);
        payload[byteIdx] ^= (1 << bitIdx);
      }
      console.log(`[ANOMALY] MIC corrupted for ${device.name}: ${flipBits} bits flipped`);
      return payload;
    }
  },
  
  // Payload损坏: 随机翻转应用层数据
  'payload-corrupt': {
    description: 'Corrupt FRMPayload to test data integrity',
    inject: (device, payload, fCnt, params) => {
      // 假设payload是MHDR+FHDR+FCnt+FOpts+Port+Payload+MIC
      // 我们只损坏中间部分(应用数据)
      const corruptStart = 8; // 跳过MHDR+FHDR
      const corruptEnd = payload.length - 4; // 跳过MIC
      if (corruptEnd > corruptStart) {
        const pos = corruptStart + Math.floor(Math.random() * (corruptEnd - corruptStart));
        payload[pos] ^= (1 << Math.floor(Math.random() * 8));
        console.log(`[ANOMALY] Payload corrupted for ${device.name} at byte ${pos}`);
      }
      return payload;
    }
  },
  
  // 弱信号: 强制设置极低RSSI/SNR
  'signal-weak': {
    description: 'Force weak signal to test ADR behavior',
    inject: (device, payload, fCnt, params) => {
      // 返回覆盖值，由调用方处理
      device._anomalyOverride = {
        rssi: params.rssi != null && Number.isFinite(Number(params.rssi)) ? Number(params.rssi) : -145,
        snr: params.snr != null && Number.isFinite(Number(params.snr)) ? Number(params.snr) : -25
      };
      const o = device._anomalyOverride;
      console.log(`[ANOMALY] Weak signal for ${device.name}: RSSI=${o.rssi}, SNR=${o.snr}`);
      return payload;
    }
  },
  
  // 信号突变: 随机大幅度信号变化
  'signal-spike': {
    description: 'Random signal spikes to test stability',
    inject: (device, payload, fCnt, params) => {
      device._anomalyOverride = {
        rssi: -30 - Math.random() * 100, // -30 to -130
        snr: -20 + Math.random() * 35     // -20 to +15
      };
      console.log(`[ANOMALY] Signal spike for ${device.name}`);
      return payload;
    }
  },
  
  // 快速Join: 短时间内多次Join
  'rapid-join': {
    description: 'Force rejoin shortly after join accept',
    inject: (device, payload, fCnt, params) => {
      const maxAttempts = Number.isFinite(Number(params.maxAttempts)) ? Number(params.maxAttempts) : 0;
      if (device._rapidJoinDisabled) return payload;
      if (device.joined && !device._rapidJoinScheduled) {
        device._rapidJoinScheduled = true;
        const delay = params.delayMs || 2000;
        
        setTimeout(() => {
          device.joined = false;
          device.fCntUp = 0;
          device.devAddr = null;
          console.log(`[ANOMALY] Rapid join triggered for ${device.name}`);
          
          // 递增计数器
          device._rapidJoinCount = (device._rapidJoinCount || 0) + 1;
          // Always clear scheduling lock so next joined uplink can schedule again.
          device._rapidJoinScheduled = false;
          // maxAttempts <= 0 means unlimited rapid-join cycles.
          if (maxAttempts > 0 && device._rapidJoinCount >= maxAttempts) {
            device._rapidJoinDisabled = true;
            console.log(`[ANOMALY] Rapid join stopped for ${device.name}: reached maxAttempts=${maxAttempts}`);
          }
        }, delay);
      }
      return payload;
    }
  },
  
  // DevNonce重复: 重复使用相同的DevNonce
  'devnonce-repeat': {
    description: 'Reuse DevNonce to test join rejection',
    inject: (device, payload, fCnt, params) => {
      if (!device.joined) {
        device._forceDevNonce = 0; // 强制使用DevNonce=0
        console.log(`[ANOMALY] DevNonce repeat for ${device.name}: forcing DevNonce=0`);
      }
      return payload;
    }
  },
  
  // Confirmed不ACK: 模拟ACK丢失
  'confirmed-noack': {
    description: 'Simulate missing ACK for confirmed uplink',
    inject: (device, payload, fCnt, params) => {
      device._skipNextAck = true;
      console.log(`[ANOMALY] Confirmed no-ACK for ${device.name}`);
      return payload;
    }
  },
  
  // 随机丢包: 模拟空中丢包
  'random-drop': {
    description: 'Randomly drop uplinks to simulate packet loss',
    inject: (device, payload, fCnt, params) => {
      const dropRate = params.dropRate || 0.3;
      if (Math.random() < dropRate) {
        device._dropThisUplink = true;
        console.log(`[ANOMALY] Uplink dropped for ${device.name}`);
      }
      return payload;
    }
  },

  // ========== 新增异常场景 (v3.0 补全) ==========

  // 下行损坏: 损坏下行数据包的MIC或Payload
  'downlink-corrupt': {
    description: 'Corrupt downlink packets to test device resilience',
    inject: (device, payload, fCnt, params) => {
      // 标记设备应在处理下行时损坏数据
      device._corruptDownlink = true;
      device._downlinkCorruptParams = {
        bitFlip: params.bitFlip || 4,
        target: params.target || 'mic' // 'mic' | 'payload' | 'both'
      };
      console.log(`[ANOMALY] Downlink corrupt enabled for ${device.name}: ${params.target || 'mic'}`);
      return payload;
    }
  },

  // 设备地址冲突: 模拟DevAddr重用/冲突
  'devaddr-reuse': {
    description: 'Simulate DevAddr reuse/conflict between devices',
    inject: (device, payload, fCnt, params) => {
      const clean = (params.conflictAddr || '0A0B0C0D').replace(/[^a-fA-F0-9]/g, '').slice(-8).padStart(8, '0');
      device._forceDevAddr = clean;
      device.devAddrHex = clean;
      device.devAddr = Buffer.from(clean, 'hex').reverse();
      console.log(`[ANOMALY] DevAddr reuse for ${device.name}: forced to ${clean}`);
      return payload;
    }
  },

  // 上行突发: 短时间内发送大量上行包
  'rapid-uplink': {
    description: 'Rapid burst of uplinks to test rate limiting',
    inject: (device, payload, fCnt, params) => {
      if (!device._rapidUplinkActive) {
        device._rapidUplinkActive = true;
        device._burstCount = params.burstCount || 10;
        device._burstInterval = params.burstInterval || 100; // ms
        device._burstSent = 0;
        console.log(`[ANOMALY] Rapid uplink burst for ${device.name}: ${device._burstCount} packets at ${device._burstInterval}ms interval`);
      }
      return payload;
    }
  },

  // 网络延迟: 模拟下行延迟或高延迟响应
  'network-delay': {
    description: 'Simulate network delay for downlinks',
    inject: (device, payload, fCnt, params) => {
      device._downlinkDelay = params.delayMs || 5000;
      console.log(`[ANOMALY] Network delay for ${device.name}: ${device._downlinkDelay}ms`);
      return payload;
    }
  },

  // 网关离线: 模拟网关临时不可用
  'gateway-offline': {
    description: 'Simulate gateway going offline',
    inject: (device, payload, fCnt, params) => {
      if (!device._gatewayOfflineScheduled) {
        device._gatewayOfflineScheduled = true;
        const offlineDuration = params.offlineDuration || 300; // seconds
        const delayBeforeOffline = params.delayBefore || 0;

        setTimeout(() => {
          device._gatewayOffline = true;
          device._gatewayOfflineUntil = Date.now() + (offlineDuration * 1000);
          console.log(`[ANOMALY] Gateway offline for ${device.name}: ${offlineDuration}s`);

          setTimeout(() => {
            device._gatewayOffline = false;
            device._gatewayOfflineScheduled = false;
            console.log(`[ANOMALY] Gateway back online for ${device.name}`);
          }, offlineDuration * 1000);
        }, delayBeforeOffline * 1000);
      }
      return payload;
    }
  },

  // 信号质量持续降级: 模拟信号逐渐恶化
  'signal-degrade': {
    description: 'Gradual signal quality degradation over time',
    inject: (device, payload, fCnt, params) => {
      if (!device._signalDegradeActive) {
        device._signalDegradeActive = true;
        device._degradeRate = params.degradeRate || -2; // dB per uplink
        device._currentRssiOffset = 0;
        device._currentSnrOffset = 0;
        console.log(`[ANOMALY] Signal degrade for ${device.name}: ${device._degradeRate}dB per uplink`);
      }
      // 更新偏移量
      device._currentRssiOffset += device._degradeRate;
      device._currentSnrOffset += (device._degradeRate * 0.5);
      device._anomalyOverride = {
        rssiOffset: device._currentRssiOffset,
        snrOffset: device._currentSnrOffset
      };
      console.log(`[ANOMALY] Signal degrade progress for ${device.name}: RSSI offset ${device._currentRssiOffset}dB`);
      return payload;
    }
  },

  // 异常频率跳变: 不正常的信道切换
  'freq-hop-abnormal': {
    description: 'Abnormal frequency hopping pattern',
    inject: (device, payload, fCnt, params) => {
      const hopPattern = params.hopPattern || 'random';
      device._abnormalFreqHop = true;
      device._freqHopPattern = hopPattern;
      // 强制使用特定异常频点或跳变模式
      device._forcedFrequencies = params.forcedFreqs || [
        923300000, // AS923 频点范围外
        922000000, // 非标准频点
        924500000  // 可能冲突的频点
      ];
      console.log(`[ANOMALY] Abnormal freq hop for ${device.name}: pattern=${hopPattern}`);
      return payload;
    }
  },

  // 异常SF切换: 不正常的数据率/扩频因子变化
  'sf-switch-abnormal': {
    description: 'Abnormal spreading factor switching',
    inject: (device, payload, fCnt, params) => {
      const sfPattern = params.sfPattern || 'erratic';
      device._abnormalSfSwitch = true;
      device._sfPattern = sfPattern;
      // 定义异常SF序列 (正常应该是逐渐变化)
      device._forcedSfSequence = params.forcedSfs || [7, 12, 7, 12, 10]; // 剧烈跳变
      device._sfSequenceIndex = 0;
      console.log(`[ANOMALY] Abnormal SF switch for ${device.name}: pattern=${sfPattern}`);
      return payload;
    }
  },

  // 设备时间不同步: 模拟时间漂移
  'time-desync': {
    description: 'Device time desynchronization with network',
    inject: (device, payload, fCnt, params) => {
      const driftPpm = params.driftPpm || 100; // 100 ppm drift
      device._timeDrift = true;
      device._timeDriftRate = driftPpm;
      device._timeDriftStart = Date.now();
      console.log(`[ANOMALY] Time desync for ${device.name}: drift=${driftPpm}ppm`);
      return payload;
    }
  },

  // ACK抑制: 选择性丢弃ACK
  'ack-suppress': {
    description: 'Selectively suppress ACKs to test confirmed retry',
    inject: (device, payload, fCnt, params) => {
      const suppressRate = params.suppressRate || 0.5;
      device._ackSuppress = true;
      device._ackSuppressRate = suppressRate;
      // 随机决定是否抑制本次ACK
      device._suppressThisAck = Math.random() < suppressRate;
      console.log(`[ANOMALY] ACK suppress for ${device.name}: rate=${suppressRate}, this=${device._suppressThisAck}`);
      return payload;
    }
  },

  // MAC命令损坏: 损坏MAC层命令
  'mac-corrupt': {
    description: 'Corrupt MAC commands in FOpts',
    inject: (device, payload, fCnt, params) => {
      const macBitFlip = params.macBitFlip || 2;
      device._macCorrupt = true;
      device._macCorruptBits = macBitFlip;
      // MAC命令通常在FOpts字段 (MHDR之后)
      const fhdrEnd = 8; // MHDR(1) + DevAddr(4) + FCtrl(1) + FCnt(2)
      if (payload.length > fhdrEnd + 4) {
        for (let i = 0; i < macBitFlip; i++) {
          const byteIdx = fhdrEnd + (i % 4);
          const bitIdx = Math.floor(Math.random() * 8);
          payload[byteIdx] ^= (1 << bitIdx);
        }
      }
      console.log(`[ANOMALY] MAC corrupt for ${device.name}: ${macBitFlip} bits in FOpts`);
      return payload;
    }
  }
};

// 检查是否触发异常
function shouldTriggerAnomaly(device, trigger, sentCount) {
  if (!device.anomaly || !device.anomaly.enabled) return false;
  
  switch (trigger) {
    case 'always':
      return true;
    case 'every-2nd-uplink':
      return sentCount > 0 && sentCount % 2 === 0;
    case 'every-3rd-uplink':
      return sentCount > 0 && sentCount % 3 === 0;
    case 'every-5th-uplink':
      return sentCount > 0 && sentCount % 5 === 0;
    case 'random-10-percent':
      return Math.random() < 0.1;
    case 'random-30-percent':
      return Math.random() < 0.3;
    case 'once':
      return sentCount === 1;
    case 'on-join-accept':
      return device._justJoined === true;
    default:
      return false;
  }
}

// 注入异常
function injectAnomaly(device, payload, fCnt, sentCount) {
  if (!device.anomaly || !device.anomaly.enabled) {
    return { payload, modified: false, signalOverride: null };
  }
  
  const scenario = ANOMALY_SCENARIOS[device.anomaly.scenario];
  if (!scenario) {
    console.warn(`[ANOMALY] Unknown scenario: ${device.anomaly.scenario}`);
    return { payload, modified: false, signalOverride: null };
  }
  
  // 清除之前的覆盖
  delete device._anomalyOverride;
  delete device._dropThisUplink;
  
  // 检查触发条件
  if (!shouldTriggerAnomaly(device, device.anomaly.trigger, sentCount)) {
    return { payload, modified: false, signalOverride: null };
  }
  
  // 执行注入
  const modifiedPayload = scenario.inject(device, Buffer.from(payload), fCnt, device.anomaly.params || {});
  
  return {
    payload: modifiedPayload,
    modified: true,
    signalOverride: device._anomalyOverride || null,
    dropUplink: device._dropThisUplink || false
  };
}

// 获取支持的异常场景列表
function getSupportedAnomalies() {
  return Object.entries(ANOMALY_SCENARIOS).map(([key, value]) => ({
    key,
    description: value.description
  }));
}

// 导出
module.exports = {
  injectAnomaly,
  getSupportedAnomalies,
  ANOMALY_SCENARIOS
};
