/**
 * LoRaWAN Simulator - Modular Entry Point (Work in Progress)
 * 
 * This is the new modular entry point that will gradually replace index.js
 * Current status: Framework created, full migration in progress
 */

const path = require('path');
const fs = require('fs');

// Import modular components
const constants = require('./src/constants');
const crypto = require('./src/crypto');
const packet = require('./src/packet');
const utils = require('./src/utils');

// Re-export for compatibility during migration
module.exports = {
  ...constants,
  crypto,
  packet,
  utils,
  
  // TODO: Migrate remaining modules:
  // - device: Device state management
  // - transport: UDP/MQTT transport layer
  // - physical: Signal model, propagation
  // - anomaly: Anomaly injection
  // - gateway: Multi-gateway support
};

// If run directly, delegate to legacy index.js for now
if (require.main === module) {
  console.log('[INFO] Modular entry point loaded. Using legacy index.js for full functionality.');
  console.log('[INFO] Modular components available:', Object.keys(module.exports).join(', '));
  
  // TODO: Replace with modular implementation
  require('./index.js');
}
