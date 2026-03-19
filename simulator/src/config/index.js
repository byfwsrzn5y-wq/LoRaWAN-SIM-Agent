//**
 * Config Loader Module
 * Configuration loading, validation and normalization
 */

const fs = require('fs');
const path = require('path');

const REGIONS = {
  'AS923-1': {
    channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6],
  },
  'AS923-2': {
    channels: [921.4, 921.6, 921.8, 922.0, 922.2, 922.4, 922.6, 922.8],
  },
  'EU868': {
    channels: [868.1, 868.3, 868.5, 867.1, 867.3, 867.5, 867.7, 867.9],
  },
  'US915': {
    channels: Array.from({ length: 64 }, (_, i) => 902.3 + i * 0.2),
  },
  'CN470': {
    channels: Array.from({ length: 48 }, (_, i) => 470.3 + i * 0.2),
  }
};

/**
 * Load and parse config file
 * @param {string} configPath - Path to config file
 * @returns {Object} Parsed config
 */
function loadConfig(configPath) {
  const absolute = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  const config = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return normalizeConfig(config);
}

/**
 * Normalize and validate config
 * @param {Object} config - Raw config
 * @returns {Object} Normalized config
 */
function normalizeConfig(config) {
  const normalized = { ...config };
  
  // Default values
  normalized.gatewayEui = config.gatewayEui || '0102030405060708';
  normalized.lnsHost = config.lnsHost || '127.0.0.1';
  normalized.lnsPort = Number(config.lnsPort || 1700);
  normalized.udpBindPort = Number(config.udpBindPort || 0);
  normalized.region = config.region || 'AS923-1';
  
  // Region channels
  if (!normalized.channels) {
    normalized.channels = REGIONS[normalized.region]?.channels || REGIONS['AS923-1'].channels;
  }
  
  // MQTT config
  normalized.mqtt = {
    enabled: false,
    host: 'localhost',
    port: 1883,
    marshaler: 'json',
    topicPrefix: 'gateway',
    qos: 0,
    ...config.mqtt
  };
  
  // Uplink config
  normalized.uplink = {
    interval: 10000,
    payloadFormat: 'simple',
    payloadLength: 12,
    fPort: 1,
    confirmed: false,
    ...config.uplink
  };
  
  // LoRaWAN config
  normalized.lorawan = {
    deviceCount: config.devices?.length || 1,
    spreadingFactor: 7,
    bandwidth: 125000,
    codingRate: '4/5',
    ...config.lorawan
  };
  
  // Signal model
  normalized.signalModel = {
    enabled: false,
    environment: 'urban',
    txPower: 16,
    txGain: 2.15,
    rxGain: 5.0,
    ...config.signalModel
  };
  
  // Visualizer
  normalized.visualizer = {
    enabled: true,
    stateIntervalMs: 1000,
    ...config.visualizer
  };
  
  return normalized;
}

/**
 * Parse CLI arguments
 * @param {Array} args - process.argv.slice(2)
 * @returns {Object} Parsed args
 */
function parseCliArgs(args) {
  const result = { 
    config: 'config.json', 
    deviceCount: null, 
    frequency: null,
    legacy: false
  };
  
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-c' || a === '--config') && args[i + 1]) {
      result.config = args[++i];
    } else if (a === '--device-count' && args[i + 1]) {
      result.deviceCount = parseInt(args[++i]);
    } else if (a === '--frequency' && args[i + 1]) {
      result.frequency = parseInt(args[i + 1]);
    } else if (a === '--legacy' || a === '-l') {
      result.legacy = true;
    }
  }
  
  return result;
}

/**
 * Apply CLI overrides to config
 * @param {Object} config - Config object
 * @param {Object} cliArgs - Parsed CLI args
 */
function applyCliOverrides(config, cliArgs) {
  if (cliArgs.deviceCount !== null) {
    config.lorawan.deviceCount = cliArgs.deviceCount;
  }
  if (cliArgs.frequency !== null) {
    config.uplink.interval = cliArgs.frequency * 1000;
  }
}

module.exports = {
  REGIONS,
  loadConfig,
  normalizeConfig,
  parseCliArgs,
  applyCliOverrides
};
