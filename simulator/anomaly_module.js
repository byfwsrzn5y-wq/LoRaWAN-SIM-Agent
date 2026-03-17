// ===============================
// 异常场景注入模块 - Anomaly Injection Module
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
        rssi: params.rssi || -145,
        snr: params.snr || -25
      };
      console.log(`[ANOMALY] Weak signal for ${device.name}: RSSI=${params.rssi}, SNR=${params.snr}`);
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
      if (device.joined && !device._rapidJoinScheduled) {
        device._rapidJoinScheduled = true;
        const delay = params.delayMs || 2000;
        const maxAttempts = params.maxAttempts || 5;
        
        setTimeout(() => {
          device.joined = false;
          device.fCntUp = 0;
          device.devAddr = null;
          console.log(`[ANOMALY] Rapid join triggered for ${device.name}`);
          
          // 递增计数器
          device._rapidJoinCount = (device._rapidJoinCount || 0) + 1;
          if (device._rapidJoinCount >= maxAttempts) {
            device._rapidJoinScheduled = false;
            device._rapidJoinCount = 0;
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
