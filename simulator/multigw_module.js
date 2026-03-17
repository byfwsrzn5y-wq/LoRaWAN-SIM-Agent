// ===============================
// 多网关支持模块 - Multi-Gateway Support Module
// ===============================

// 默认网关配置
const DEFAULT_GATEWAY_CONFIG = {
  enabled: false,
  mode: 'overlapping', // overlapping / handover / failover
  gateways: []
};

// 计算网关接收信号
function calculateGatewayReception(device, devicePosition, gateway, globalConfig) {
  const distance = calculateDistance(
    devicePosition,
    gateway.position || { x: 0, y: 0, z: 30 }
  );
  
  const frequency = device.frequency || 923200000;
  const fspl = calculateFSPL(distance, frequency);
  
  // 环境损耗
  const env = globalConfig.signalModel?.environment || 'urban';
  const plExponent = PATH_LOSS_EXPONENT[env] || 3.5;
  const envLoss = Math.max(0, (plExponent - 2.0) * 10 * Math.log10(Math.max(0.1, distance / 1000)));
  
  // 阴影衰落
  const shadowStd = globalConfig.signalModel?.shadowFadingStd || 8;
  const shadowFading = gaussianRandom(0, shadowStd);
  
  // 快衰落
  let fastFading = 0;
  if (globalConfig.signalModel?.fastFadingEnabled) {
    fastFading = rayleighFading() * 2;
  }
  
  // 总损耗
  const totalLoss = fspl + envLoss + shadowFading + fastFading + (gateway.cableLoss || 0.5);
  
  // 计算RSSI
  const txPower = globalConfig.signalModel?.txPower || 16;
  const txGain = globalConfig.signalModel?.txGain || 2.15;
  const rxGain = gateway.rxGain || 5.0;
  
  const rssi = txPower + txGain + rxGain - totalLoss;
  const noiseFloor = globalConfig.signalModel?.noiseFloor || -120;
  const snr = rssi - noiseFloor - 6; // 6dB噪声系数
  
  return {
    rssi: Math.round(Math.max(-140, Math.min(-30, rssi)) * 10) / 10,
    snr: Math.round(Math.max(-25, Math.min(15, snr)) * 10) / 10,
    distance: Math.round(distance),
    canReceive: rssi > (gateway.rxSensitivity || -137)
  };
}

// 选择目标网关
function selectGateways(device, deviceIndex, totalDevices, config) {
  const multiGwConfig = config.multiGateway || DEFAULT_GATEWAY_CONFIG;
  
  if (!multiGwConfig.enabled || !multiGwConfig.gateways || multiGwConfig.gateways.length === 0) {
    // 单网关模式
    return [{
      eui: config.gatewayEui,
      ...calculateGatewayReception(device, config.signalModel?.nodePosition, 
        { position: config.signalModel?.gatewayPosition }, config)
    }];
  }
  
  const devicePosition = device.position || generateDevicePosition(
    deviceIndex, totalDevices, config.signalModel?.nodePosition, 2000
  );
  
  // 计算所有网关的接收情况
  const receptions = multiGwConfig.gateways.map(gw => {
    const signal = calculateGatewayReception(device, devicePosition, gw, config);
    return {
      eui: gw.eui,
      name: gw.name,
      ...signal
    };
  }).filter(r => r.canReceive);
  
  // 根据模式选择
  switch (multiGwConfig.mode) {
    case 'overlapping':
      // 所有能收到的网关都发送
      return receptions;
      
    case 'handover':
      // 选择信号最强的
      return receptions.length > 0 ? [receptions.reduce((a, b) => a.rssi > b.rssi ? a : b)] : [];
      
    case 'failover':
      // 优先主网关，失败后备用
      const primary = receptions.find(r => r.eui === multiGwConfig.primaryGateway);
      return primary ? [primary] : (receptions.length > 0 ? [receptions[0]] : []);
      
    default:
      return receptions;
  }
}

// 构建多网关上行帧
function buildMultiGatewayUplinkFrames(phyPayload, device, deviceIndex, totalDevices, config, mqttHandlers) {
  const receptions = selectGateways(device, deviceIndex, totalDevices, config);
  
  if (receptions.length === 0) {
    console.log(`[Multi-GW] No gateway can receive from device ${device.name || deviceIndex}`);
    return [];
  }
  
  // 构建每个网关的帧
  const frames = receptions.map(rx => {
    const rxpk = buildRxpk({
      freq: config.uplink?.rf?.frequency || 923200000,
      sf: config.uplink?.rf?.spreadingFactor || 7,
      bw: config.uplink?.rf?.bandwidth || 125,
      codr: config.uplink?.rf?.codeRate || '4/5',
      rssi: rx.rssi,
      lsnr: rx.snr,
      data: phyPayload.toString('base64'),
      tmst: Date.now() * 1000,
      time: new Date().toISOString()
    });
    
    return {
      gatewayEui: rx.eui,
      rxpk,
      signal: { rssi: rx.rssi, snr: rx.snr, distance: rx.distance }
    };
  });
  
  console.log(`[Multi-GW] Device ${device.name || deviceIndex} will be received by ${frames.length} gateway(s)`);
  return frames;
}

// 发送多网关上行
async function sendMultiGatewayUplink(frames, config, mqttClient, mqttHandlers) {
  const sendPromises = frames.map(frame => {
    const topic = `${config.mqtt?.topicPrefix || 'as923'}/gateway/${frame.gatewayEui}/event/up`;
    const payload = JSON.stringify({ rxpk: [frame.rxpk] });
    
    return new Promise((resolve, reject) => {
      mqttClient.publish(topic, payload, { qos: 0 }, (err) => {
        if (err) reject(err);
        else {
          console.log(`[Multi-GW] Sent to ${frame.gatewayEui}: RSSI=${frame.signal.rssi}, SNR=${frame.signal.snr}`);
          resolve();
        }
      });
    });
  });
  
  await Promise.all(sendPromises);
}

// 多网关配置示例
const MULTI_GATEWAY_EXAMPLE = {
  multiGateway: {
    enabled: true,
    mode: 'overlapping', // overlapping / handover / failover
    primaryGateway: 'ac1f09fffe1c55d3',
    gateways: [
      {
        eui: 'ac1f09fffe1c55d3',
        name: 'main-gateway',
        position: { x: 0, y: 0, z: 30 },
        rxGain: 5,
        rxSensitivity: -137
      },
      {
        eui: 'ac1f09fffe1c55d4',
        name: 'suburban-gateway',
        position: { x: 2000, y: 500, z: 15 },
        rxGain: 3,
        rxSensitivity: -134
      },
      {
        eui: 'ac1f09fffe1c55d5',
        name: 'indoor-gateway',
        position: { x: 500, y: -300, z: 3 },
        rxGain: 2,
        rxSensitivity: -130
      }
    ]
  }
};

// 导出
module.exports = {
  selectGateways,
  buildMultiGatewayUplinkFrames,
  sendMultiGatewayUplink,
  MULTI_GATEWAY_EXAMPLE
};
