// ===============================
// 物理层信号模型 - Physical Layer Signal Model
// ===============================

// 信号模型配置
const DEFAULT_SIGNAL_MODEL = {
  enabled: true,
  nodePosition: { x: 0, y: 0, z: 2 },      // 节点位置 (米)
  gatewayPosition: { x: 500, y: 0, z: 30 }, // 网关位置 (米)
  environment: 'urban',                     // urban/suburban/rural/indoor
  txPower: 16,                              // dBm
  txGain: 2.15,                             // dBi
  rxGain: 5.0,                              // dBi
  cableLoss: 0.5,                           // dB
  noiseFloor: -120,                         // dBm
  shadowFadingStd: 8,                       // 阴影衰落标准差 (dB)
  fastFadingEnabled: true,                  // 快衰落
  timeVariation: true                       // 时间变化
};

// 环境路径损耗指数
const PATH_LOSS_EXPONENT = {
  'free-space': 2.0,
  'suburban': 2.7,
  'urban': 3.5,
  'dense-urban': 4.0,
  'indoor': 4.0
};

// 计算两点间距离 (米)
function calculateDistance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// 自由空间路径损耗 (dB)
function calculateFSPL(distance, frequency) {
  // FSPL = 20*log10(d) + 20*log10(f) + 20*log10(4π/c)
  // 简化: FSPL = 20*log10(d) + 20*log10(f) + 32.44 (d=km, f=MHz)
  const d_km = distance / 1000;
  const f_mhz = frequency / 1000000;
  return 20 * Math.log10(d_km) + 20 * Math.log10(f_mhz) + 32.44;
}

// 生成高斯随机数 (Box-Muller变换)
function gaussianRandom(mean = 0, std = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * std + mean;
}

// 生成瑞利衰落 (快衰落)
function rayleighFading() {
  const u1 = Math.random();
  const u2 = Math.random();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return r * Math.cos(theta);  // 返回衰落系数 (dB范围)
}

// 计算真实信号参数
function calculateRealisticSignal(deviceConfig, globalConfig, timestamp = Date.now()) {
  const model = { ...DEFAULT_SIGNAL_MODEL, ...globalConfig.signalModel };
  
  if (!model.enabled) {
    return { rssi: -50, snr: 10, rssiStd: 0 }; // 默认固定值
  }

  // 使用设备特定位置或全局位置
  const nodePos = deviceConfig.position || model.nodePosition;
  const gwPos = model.gatewayPosition;
  
  // 计算距离
  const distance = calculateDistance(nodePos, gwPos);
  
  // 获取频率 (Hz转MHz)
  const frequency = deviceConfig.frequency || 923200000; // AS923默认
  
  // 基础路径损耗
  const fspl = calculateFSPL(distance, frequency);
  
  // 环境额外损耗
  const plExponent = PATH_LOSS_EXPONENT[model.environment] || 3.5;
  const envLoss = (plExponent - 2.0) * 10 * Math.log10(distance / 1000);
  
  // 阴影衰落 (对数正态分布)
  const shadowFading = gaussianRandom(0, model.shadowFadingStd);
  
  // 快衰落 (瑞利分布，可选)
  let fastFading = 0;
  if (model.fastFadingEnabled) {
    // 基于时间变化
    const timeVar = model.timeVariation ? (timestamp / 1000) % 100 : 0;
    fastFading = rayleighFading() * 2; // 范围约 ±6dB
  }
  
  // 总路径损耗
  const totalLoss = fspl + envLoss + shadowFading + fastFading + model.cableLoss;
  
  // 计算RSSI
  const rssi = model.txPower + model.txGain + model.rxGain - totalLoss;
  
  // 计算SNR
  // SNR = RSSI - NoiseFloor - 噪声系数(约6dB)
  const noiseFigure = 6;
  const snr = rssi - model.noiseFloor - noiseFigure;
  
  // 限制合理范围
  const clampedRssi = Math.max(-140, Math.min(-30, rssi));
  const clampedSnr = Math.max(-25, Math.min(15, snr));
  
  // 计算RSSI标准差 (用于ADR算法)
  const rssiStd = Math.sqrt(Math.pow(model.shadowFadingStd, 2) + 
                            (model.fastFadingEnabled ? 4 : 0));
  
  return {
    rssi: Math.round(clampedRssi * 10) / 10,      // 保留1位小数
    snr: Math.round(clampedSnr * 10) / 10,
    rssiStd: Math.round(rssiStd * 10) / 10,
    distance: Math.round(distance),
    pathLoss: Math.round(totalLoss * 10) / 10,
    environment: model.environment,
    txPower: model.txPower
  };
}

// 信号模型配置加载
function loadSignalModelConfig(config) {
  if (!config.signalModel) {
    console.log('[Signal Model] 使用默认配置');
    return DEFAULT_SIGNAL_MODEL;
  }
  return { ...DEFAULT_SIGNAL_MODEL, ...config.signalModel };
}

// 生成设备特定位置 (网格分布)
function generateDevicePosition(index, totalDevices, basePosition, spread = 1000) {
  // 使用螺旋分布
  const angle = index * 2.4; // 黄金角
  const radius = spread * Math.sqrt(index / totalDevices);
  
  return {
    x: basePosition.x + radius * Math.cos(angle),
    y: basePosition.y + radius * Math.sin(angle),
    z: basePosition.z + Math.random() * 5 // 高度随机
  };
}

// 导出函数
module.exports = {
  calculateRealisticSignal,
  loadSignalModelConfig,
  generateDevicePosition,
  DEFAULT_SIGNAL_MODEL,
  calculateDistance,
  calculateFSPL
};
