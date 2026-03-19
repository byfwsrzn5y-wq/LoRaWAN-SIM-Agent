/**
 * Physical Layer Module
 * Signal model, path loss, fading
 */

const PATH_LOSS_EXPONENT = {
  'free-space': 2.0,
  'suburban': 2.7,
  'urban': 3.5,
  'dense-urban': 4.0,
  'indoor': 4.0
};

const DEFAULT_SIGNAL_MODEL = {
  enabled: false,
  nodePosition: { x: 0, y: 0, z: 2 },
  gatewayPosition: { x: 500, y: 0, z: 30 },
  environment: 'urban',
  txPower: 16,
  txGain: 2.15,
  rxGain: 5.0,
  cableLoss: 0.5,
  noiseFloor: -120,
  shadowFadingStd: 8,
  fastFadingEnabled: true,
  timeVariation: true
};

function calculateDistance(pos1, pos2) {
  const dx = (pos1.x || 0) - (pos2.x || 0);
  const dy = (pos1.y || 0) - (pos2.y || 0);
  const dz = (pos1.z || 0) - (pos2.z || 0);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function calculateFSPL(distance, frequencyHz) {
  const d_km = distance / 1000;
  const f_mhz = frequencyHz / 1000000;
  if (d_km <= 0 || f_mhz <= 0) return 0;
  return 20 * Math.log10(d_km) + 20 * Math.log10(f_mhz) + 32.44;
}

function gaussianRandom(mean = 0, std = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * std + mean;
}

function rayleighFading() {
  const u1 = Math.random();
  const u2 = Math.random();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return r * Math.cos(theta);
}

function generateDevicePosition(index, totalDevices, basePosition, spread = 1000) {
  const angle = index * 2.4;
  const radius = spread * Math.sqrt((index + 1) / totalDevices);
  return {
    x: (basePosition.x || 0) + radius * Math.cos(angle),
    y: (basePosition.y || 0) + radius * Math.sin(angle),
    z: (basePosition.z || 2) + Math.random() * 3
  };
}

function calculateRealisticSignal(deviceIdx, totalDevices, deviceConfig, globalConfig, timestamp = Date.now()) {
  const signalCfg = globalConfig.signalModel || {};
  const model = { ...DEFAULT_SIGNAL_MODEL, ...signalCfg };
  
  if (!model.enabled) {
    return { 
      rssi: -70 + Math.random() * 20, 
      snr: 5 + Math.random() * 5,
      rssiStd: 2 
    };
  }

  const nodePos = generateDevicePosition(
    deviceIdx, 
    totalDevices, 
    model.nodePosition, 
    2000
  );
  const gwPos = model.gatewayPosition;
  const distance = calculateDistance(nodePos, gwPos);
  
  const frequency = deviceConfig.frequency || 923200000;
  const fspl = calculateFSPL(distance, frequency);
  const plExponent = PATH_LOSS_EXPONENT[model.environment] || 3.5;
  const envLoss = Math.max(0, (plExponent - 2.0) * 10 * Math.log10(Math.max(0.1, distance / 1000)));
  const shadowFading = gaussianRandom(0, model.shadowFadingStd);
  
  let fastFading = 0;
  if (model.fastFadingEnabled && model.timeVariation) {
    const timeVar = (timestamp / 1000) % 100;
    fastFading = rayleighFading() * 2 * Math.sin(timeVar);
  }
  
  const totalLoss = fspl + envLoss + shadowFading + fastFading + model.cableLoss;
  const rssi = model.txPower + model.txGain + model.rxGain - totalLoss;
  const noiseFigure = 6;
  const snr = rssi - model.noiseFloor - noiseFigure;
  
  return {
    rssi: Math.round(Math.max(-140, Math.min(-30, rssi)) * 10) / 10,
    snr: Math.round(Math.max(-25, Math.min(15, snr)) * 10) / 10,
    rssiStd: Math.round(Math.sqrt(Math.pow(model.shadowFadingStd, 2) + (model.fastFadingEnabled ? 4 : 0)) * 10) / 10,
    distance: Math.round(distance),
    pathLoss: Math.round(totalLoss * 10) / 10
  };
}

module.exports = {
  PATH_LOSS_EXPONENT,
  DEFAULT_SIGNAL_MODEL,
  calculateDistance,
  calculateFSPL,
  gaussianRandom,
  rayleighFading,
  generateDevicePosition,
  calculateRealisticSignal
};
