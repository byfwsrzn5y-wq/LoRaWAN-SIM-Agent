/**
 * LoRaWAN Simulator - Modular Entry Point
 * 
 * Gradually replacing index.js with modular architecture
 */

const path = require('path');
const fs = require('fs');

// Modular components
const constants = require('./src/constants');
const crypto = require('./src/crypto');
const packet = require('./src/packet');
const utils = require('./src/utils');
const { DeviceManager } = require('./src/device');
const { UdpTransport, MqttTransport } = require('./src/transport');
const physical = require('./src/physical');
const { StateManager } = require('./src/state');

// Legacy modules (will be migrated)
const anomalyModule = require('./anomaly_module');
const multigwModule = require('./multigw_module');

// Re-export for compatibility
module.exports = {
  ...constants,
  crypto,
  packet,
  utils,
  DeviceManager,
  UdpTransport,
  MqttTransport,
  physical,
  StateManager,
  anomalyModule,
  multigwModule
};

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  const configPath = args[0] || path.join(__dirname, 'config.json');
  
  console.log('[LoRaWAN-SIM] Modular entry point loaded');
  console.log('[LoRaWAN-SIM] Loading config:', configPath);
  
  // Load configuration
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  // Initialize state manager
  const stateManager = new StateManager(
    config.visualizer?.stateFile || path.join(__dirname, 'sim-state.json')
  );
  
  // Initialize device manager
  const deviceManager = new DeviceManager();
  
  // Register devices from config
  if (config.devices) {
    config.devices.forEach((deviceConfig, index) => {
      const device = deviceManager.registerDevice({
        name: deviceConfig.name || `device-${index}`,
        devEui: deviceConfig.devEui,
        joinEui: deviceConfig.joinEui || '0000000000000000',
        appKey: deviceConfig.appKey,
        nwkKey: deviceConfig.nwkKey || deviceConfig.appKey,
        activationMode: deviceConfig.activationMode || 'otaa',
        devAddr: deviceConfig.devAddr,
        nwkSKey: deviceConfig.nwkSKey,
        appSKey: deviceConfig.appSKey,
        ...deviceConfig
      });
      console.log(`[Device] Registered: ${device.name} (${device.devEui})`);
    });
  }
  
  console.log(`[LoRaWAN-SIM] ${deviceManager.getAllDevices().length} devices registered`);
  
  // Initialize transport
  let transport;
  if (config.mqtt && config.mqtt.enabled) {
    // MQTT transport would be initialized here
    console.log('[Transport] MQTT mode (not fully implemented in modular version)');
  } else {
    transport = new UdpTransport(config.udp?.bindPort);
    await transport.createSocket();
    console.log('[Transport] UDP socket created');
  }
  
  // Start state exporter
  stateManager.startExporter(config.visualizer?.stateIntervalMs || 1000);
  console.log('[State] State exporter started');
  
  // TODO: Implement full simulation loop
  // This is a placeholder - full implementation requires porting the rest of index.js
  console.log('\n[LoRaWAN-SIM] Modular framework initialized');
  console.log('[LoRaWAN-SIM] Note: Full simulation logic still uses legacy index.js');
  console.log('[LoRaWAN-SIM] Run with --legacy flag to use original implementation\n');
  
  // Keep running
  return new Promise((resolve) => {
    process.on('SIGINT', () => {
      console.log('\n[LoRaWAN-SIM] Shutting down...');
      stateManager.stopExporter();
      if (transport) transport.close().then(resolve);
      else resolve();
    });
  });
}

// If run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  // Check for legacy flag
  if (args.includes('--legacy') || args.includes('-l')) {
    console.log('[LoRaWAN-SIM] Using legacy implementation (index.js)');
    require('./index.js');
  } else {
    main().catch(err => {
      console.error('[LoRaWAN-SIM] Fatal error:', err);
      process.exit(1);
    });
  }
}
