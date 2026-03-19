/**
 * LoRaWAN 物理层模型 - Advanced Propagation Models
 *
 * 支持多种传播模型、天线方向图、地形影响
 */

// ==================== 传播模型 ====================

const PROPAGATION_MODELS = {
  // 自由空间路径损耗
  'free-space': {
    name: 'Free Space',
    exponent: 2.0,
    description: '理想自由空间，无障碍物'
  },

  // Okumura-Hata (城市)
  'okumura-urban': {
    name: 'Okumura-Hata Urban',
    exponent: 3.5,
    correction: (freqMHz, htx, hrx, distance) => {
      // 城市环境修正因子
      const ahrx = (1.1 * Math.log10(freqMHz) - 0.7) * hrx - (1.56 * Math.log10(freqMHz) - 0.8);
      return 69.55 + 26.16 * Math.log10(freqMHz) - 13.82 * Math.log10(htx) - ahrx + (44.9 - 6.55 * Math.log10(htx)) * Math.log10(distance / 1000);
    }
  },

  // Okumura-Hata (郊区)
  'okumura-suburban': {
    name: 'Okumura-Hata Suburban',
    exponent: 3.0,
    correction: (freqMHz, htx, hrx, distance) => {
      const urbanLoss = PROPAGATION_MODELS['okumura-urban'].correction(freqMHz, htx, hrx, distance);
      return urbanLoss - 2 * Math.pow(Math.log10(freqMHz / 28), 2) - 5.4;
    }
  },

  // COST-231 Hata (扩展到2GHz)
  'cost231': {
    name: 'COST-231 Hata',
    exponent: 3.5,
    correction: (freqMHz, htx, hrx, distance) => {
      const ahrx = (1.1 * Math.log10(freqMHz) - 0.7) * hrx - (1.56 * Math.log10(freqMHz) - 0.8);
      const cm = 3; // 大城市修正
      return 46.3 + 33.9 * Math.log10(freqMHz) - 13.82 * Math.log10(htx) - ahrx + (44.9 - 6.55 * Math.log10(htx)) * Math.log10(distance / 1000) + cm;
    }
  },

  // 室内传播
  'indoor': {
    name: 'Indoor Office',
    exponent: 4.0,
    description: '室内办公环境'
  },

  // 密集城市
  'dense-urban': {
    name: 'Dense Urban',
    exponent: 4.2,
    description: '密集城区，高层建筑'
  }
};

// ==================== 天线方向图 ====================

const ANTENNA_PATTERNS = {
  // 全向天线
  'omnidirectional': {
    name: 'Omnidirectional',
    gain: (azimuth, elevation, peakGain) => peakGain,
    description: '360° 水平覆盖'
  },

  // 定向天线（扇区）
  'directional-90': {
    name: 'Directional 90°',
    halfPowerBeamwidth: 90,
    gain: (azimuth, elevation, peakGain, mainDirection = 0) => {
      // 使用余弦模型
      const azDiff = Math.abs(azimuth - mainDirection);
      const normalized = Math.min(azDiff, 360 - azDiff) / 45; // 归一化到半功率角
      if (normalized > 2) return peakGain - 20; // 后瓣衰减
      return peakGain - 3 * (normalized ** 2);
    }
  },

  'directional-60': {
    name: 'Directional 60°',
    halfPowerBeamwidth: 60,
    gain: (azimuth, elevation, peakGain, mainDirection = 0) => {
      const azDiff = Math.abs(azimuth - mainDirection);
      const normalized = Math.min(azDiff, 360 - azDiff) / 30;
      if (normalized > 2) return peakGain - 20;
      return peakGain - 3 * (normalized ** 2);
    }
  },

  // 八木天线
  'yagi': {
    name: 'Yagi-Uda',
    halfPowerBeamwidth: 45,
    frontToBackRatio: 15, // dB
    gain: (azimuth, elevation, peakGain, mainDirection = 0) => {
      const azDiff = Math.abs(azimuth - mainDirection);
      const normalized = Math.min(azDiff, 360 - azDiff) / 22.5;
      if (normalized > 2) return peakGain - 15; // 后瓣
      return peakGain - 3 * (normalized ** 2);
    }
  }
};

// ==================== 衰落模型 ====================

// 瑞利衰落（NLOS）
function rayleighFading() {
  const u1 = Math.random();
  const u2 = Math.random();
  const r = Math.sqrt(-2 * Math.log(Math.max(0.0001, u1)));
  const theta = 2 * Math.PI * u2;
  return r * Math.cos(theta);
}

// 莱斯衰落（LOS + NLOS）
function ricianFading(kFactor = 10) {
  // K因子：直射路径功率 / 散射路径功率
  const losComponent = Math.sqrt(2 * kFactor / (kFactor + 1));
  const nlosComponent = rayleighFading() * Math.sqrt(2 / (kFactor + 1));
  return losComponent + nlosComponent;
}

// Nakagami-m 衰落（通用模型）
function nakagamiFading(m = 1, omega = 1) {
  // m=1 等价于瑞利衰落
  // m>1 衰落较轻
  // m<1 衰落较重
  const gamma = require('crypto').randomBytes(4).readUInt32LE(0) / 0xFFFFFFFF;
  // 使用Gamma分布近似
  const u = Math.random();
  const v = Math.random();
  const chi2 = -2 * Math.log(Math.max(0.0001, u));
  return Math.sqrt(omega / m) * Math.sqrt(chi2);
}

// ==================== 核心计算函数 ====================

/**
 * 计算完整路径损耗
 */
function calculatePathLoss(config) {
  const {
    distance,          // 距离 (米)
    frequency,         // 频率 (Hz)
    model = 'okumura-urban',
    txHeight = 30,     // 发射天线高度 (米)
    rxHeight = 2,      // 接收天线高度 (米)
    environment = 'urban'
  } = config;

  const freqMHz = frequency / 1e6;
  const propModel = PROPAGATION_MODELS[model] || PROPAGATION_MODELS['okumura-urban'];

  // 基础路径损耗
  let pathLoss;

  if (propModel.correction) {
    // 使用特定模型的修正公式
    pathLoss = propModel.correction(freqMHz, txHeight, rxHeight, distance);
  } else {
    // 使用简化的指数模型
    const fspl = 20 * Math.log10(distance) + 20 * Math.log10(freqMHz) + 32.44;
    const envLoss = (propModel.exponent - 2) * 10 * Math.log10(Math.max(0.1, distance / 1000));
    pathLoss = fspl + envLoss;
  }

  return Math.max(0, pathLoss);
}

/**
 * 计算天线增益（考虑方向图）
 */
function calculateAntennaGain(config) {
  const {
    pattern = 'omnidirectional',
    azimuth = 0,        // 方位角 (度)
    elevation = 0,      // 仰角 (度)
    peakGain = 5,       // 峰值增益 (dBi)
    mainDirection = 0   // 主方向 (度)
  } = config;

  const antenna = ANTENNA_PATTERNS[pattern] || ANTENNA_PATTERNS['omnidirectional'];

  if (typeof antenna.gain === 'function') {
    return antenna.gain(azimuth, elevation, peakGain, mainDirection);
  }

  return peakGain;
}

/**
 * 计算节点到网关的角度
 */
function calculateAngles(nodePos, gatewayPos) {
  const dx = nodePos.x - gatewayPos.x;
  const dy = nodePos.y - gatewayPos.y;
  const dz = nodePos.z - gatewayPos.z;

  // 方位角 (从正北顺时针)
  let azimuth = Math.atan2(dx, dy) * 180 / Math.PI;
  if (azimuth < 0) azimuth += 360;

  // 仰角
  const horizontalDist = Math.sqrt(dx * dx + dy * dy);
  const elevation = Math.atan2(dz, horizontalDist) * 180 / Math.PI;

  return { azimuth, elevation };
}

/**
 * 完整信号计算
 */
function calculateSignal(nodePos, gatewayPos, config) {
  const {
    frequency = 923200000,
    txPower = 16,
    txAntenna = { pattern: 'omnidirectional', gain: 2.15 },
    rxAntenna = { pattern: 'omnidirectional', gain: 5 },
    propagationModel = 'okumura-urban',
    environment = 'urban',
    shadowFadingStd = 8,
    fadingType = 'rayleigh',
    ricianK = 10
  } = config;

  // 距离
  const dx = nodePos.x - gatewayPos.x;
  const dy = nodePos.y - gatewayPos.y;
  const dz = nodePos.z - gatewayPos.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // 角度
  const angles = calculateAngles(nodePos, gatewayPos);

  // 路径损耗
  const pathLoss = calculatePathLoss({
    distance,
    frequency,
    model: propagationModel,
    txHeight: gatewayPos.z,
    rxHeight: nodePos.z,
    environment
  });

  // 阴影衰落
  const shadowFading = gaussianRandom(0, shadowFadingStd);

  // 快衰落
  let fastFading = 0;
  switch (fadingType) {
    case 'rician':
      fastFading = ricianFading(ricianK) * 2;
      break;
    case 'nakagami':
      fastFading = nakagamiFading(1.5) * 2;
      break;
    default:
      fastFading = rayleighFading() * 2;
  }

  // 天线增益
  const txGain = calculateAntennaGain({
    pattern: txAntenna.pattern,
    azimuth: angles.azimuth + 180, // 反方向
    elevation: angles.elevation + 180,
    peakGain: txAntenna.gain
  });

  const rxGain = calculateAntennaGain({
    pattern: rxAntenna.pattern,
    azimuth: angles.azimuth,
    elevation: angles.elevation,
    peakGain: rxAntenna.gain,
    mainDirection: rxAntenna.mainDirection || 0
  });

  // 总链路预算
  const totalLoss = pathLoss + shadowFading + fastFading - txGain - rxGain;
  const rssi = txPower - totalLoss;

  // SNR 计算
  const noiseFloor = config.noiseFloor || -120;
  const noiseFigure = config.noiseFigure || 6;
  const snr = rssi - noiseFloor - noiseFigure;

  return {
    distance: Math.round(distance),
    pathLoss: Math.round(pathLoss * 10) / 10,
    rssi: Math.round(Math.max(-140, Math.min(-30, rssi)) * 10) / 10,
    snr: Math.round(Math.max(-25, Math.min(15, snr)) * 10) / 10,
    txGain: Math.round(txGain * 10) / 10,
    rxGain: Math.round(rxGain * 10) / 10,
    azimuth: Math.round(angles.azimuth),
    elevation: Math.round(angles.elevation * 10) / 10,
    canReceive: rssi > (config.rxSensitivity || -137)
  };
}

// 辅助函数：高斯随机数
function gaussianRandom(mean = 0, std = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(Math.max(0.0001, u1))) * Math.cos(2 * Math.PI * u2);
  return z0 * std + mean;
}

// ==================== 导出 ====================

module.exports = {
  PROPAGATION_MODELS,
  ANTENNA_PATTERNS,
  calculatePathLoss,
  calculateAntennaGain,
  calculateAngles,
  calculateSignal,
  rayleighFading,
  ricianFading,
  nakagamiFading
};
