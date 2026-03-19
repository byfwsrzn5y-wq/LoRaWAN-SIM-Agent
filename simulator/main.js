#!/usr/bin/env node
/**
 * LoRaWAN Simulator - Modular Entry Point
 * 
 * A refactored, modular implementation of the LoRaWAN gateway simulator.
 * This replaces the monolithic index.js with a clean, maintainable architecture.
 */

const path = require('path');

// Core modules
const { REGIONS, loadConfig, parseCliArgs, applyCliOverrides } = require('./src/config');
const { DeviceManager } = require('./src/device');
const { UdpTransport, MqttTransport } = require('./src/transport');
const { StateManager } = require('./src/state');
const { loadBehaviorTemplates, applyBehaviorTemplate, initNodeState } = require('./src/behavior');
const { parseMacCommands, generateMacResponses } = require('./src/mac');
const { buildJoinRequest, deriveSessionKeys, buildLorawanUplinkAbp } = require('./src/packet');
const { lorawanEncrypt, lorawanDecrypt } = require('./src/crypto');
const { calculateRealisticSignal } = require('./src/physical');
const { hexToBuffer, bufToHexUpper, sfBwString, clamp } = require('./src/utils');
const anomalyModule = require('./anomaly_module');
const multigwModule = require('./multigw_module');

class LorawanSimulator {
  constructor(config) {
    this.config = config;
    this.deviceManager = new DeviceManager();
    this.stateManager = new StateManager(config.visualizer?.stateFile);
    this.transport = null;
    this.running = false;
    this.uplinkTimers = [];
    this.stats = { uplinks: 0, joins: 0, errors: 0 };
    this.macResponseQueues = {};
    
    // Load behavior templates
    this.behaviorTemplates = loadBehaviorTemplates(config.lorawan, process.cwd());
  }

  async initialize() {
    console.log('[LoRaWAN-SIM] Initializing...');
    
    // Initialize transport
    if (this.config.mqtt?.enabled) {
      // TODO: Implement MQTT transport initialization
      console.log('[Transport] MQTT mode not yet fully implemented in modular version');
      console.log('[Transport] Falling back to UDP mode');
    }
    
    this.transport = new UdpTransport(this.config.udpBindPort);
    await this.transport.createSocket();
    console.log('[Transport] UDP socket created');
    
    // Register devices
    if (this.config.devices) {
      this.config.devices.forEach((deviceConfig, index) => {
        // Apply behavior template if specified
        let finalConfig = { ...deviceConfig };
        if (deviceConfig.behaviorTemplate && this.behaviorTemplates?.templates) {
          const template = this.behaviorTemplates.templates[deviceConfig.behaviorTemplate];
          if (template) {
            const applied = applyBehaviorTemplate(template, this.behaviorTemplates.baseline);
            finalConfig = { ...finalConfig, ...applied };
          }
        }
        
        const device = this.deviceManager.registerDevice({
          name: finalConfig.name || `device-${index}`,
          devEui: finalConfig.devEui,
          joinEui: finalConfig.joinEui || '0000000000000000',
          appKey: finalConfig.appKey,
          nwkKey: finalConfig.nwkKey || finalConfig.appKey,
          activationMode: finalConfig.activationMode || 'otaa',
          devAddr: finalConfig.devAddr ? hexToBuffer(finalConfig.devAddr) : null,
          nwkSKey: finalConfig.nwkSKey ? hexToBuffer(finalConfig.nwkSKey) : null,
          appSKey: finalConfig.appSKey ? hexToBuffer(finalConfig.appSKey) : null,
          ...finalConfig
        });
        
        // Initialize node state
        initNodeState(
          index,
          device,
          this.config.lorawan,
          this.config.uplink,
          this.config.channels,
          finalConfig.nodeState
        );
        
        console.log(`[Device] Registered: ${device.name} (${device.devEui})`);
      });
    }
    
    console.log(`[LoRaWAN-SIM] ${this.deviceManager.getAllDevices().length} devices ready`);
    
    // Setup transport handlers
    this.setupTransportHandlers();
    
    // Start state exporter
    this.stateManager.startExporter(this.config.visualizer?.stateIntervalMs || 1000);
    this.stateManager.update({
      running: true,
      gateways: [{ eui: this.config.gatewayEui, name: 'default-gateway' }],
      config: {
        signalModel: this.config.signalModel,
        region: this.config.region
      }
    });
    
    console.log('[LoRaWAN-SIM] Initialization complete');
  }

  setupTransportHandlers() {
    // Handle incoming messages (PULL_RESP, etc.)
    this.transport.onMessage((msg, rinfo) => {
      // TODO: Implement downlink handling
      console.log('[Transport] Received message from', rinfo.address);
    });
  }

  async start() {
    this.running = true;
    console.log('\n[LoRaWAN-SIM] Starting simulation...\n');
    
    const devices = this.deviceManager.getAllDevices();
    const gatewayEuiBuf = hexToBuffer(this.config.gatewayEui);
    
    // Start uplink loops for each device
    devices.forEach((device, index) => {
      const timer = this.createUplinkLoop(device, index, devices.length, gatewayEuiBuf);
      this.uplinkTimers.push(timer);
    });
    
    // Setup shutdown handlers
    this.setupShutdownHandlers();
    
    // Keep running
    return new Promise((resolve) => {
      this.shutdownResolve = resolve;
    });
  }

  createUplinkLoop(device, deviceIndex, totalDevices, gatewayEuiBuf) {
    const interval = this.config.uplink?.interval || 10000;
    
    const sendUplink = async () => {
      if (!this.running) return;
      
      try {
        // Check if device needs to join
        if (device.activationMode === 'otaa' && !device.joined) {
          await this.sendJoinRequest(device, gatewayEuiBuf);
        } else if (device.joined || device.activationMode === 'abp') {
          await this.sendDataUplink(device, deviceIndex, totalDevices, gatewayEuiBuf);
        }
      } catch (error) {
        console.error(`[Error] Device ${device.name}:`, error.message);
        this.stats.errors++;
      }
      
      // Schedule next uplink
      if (this.running) {
        setTimeout(sendUplink, interval);
      }
    };
    
    // Start the loop
    setTimeout(sendUplink, Math.random() * interval);
    
    return { clear: () => { /* TODO: Clear timer */ } };
  }

  async sendJoinRequest(device, gatewayEuiBuf) {
    const devNonce = Math.floor(Math.random() * 65536);
    const appEuiBuf = hexToBuffer(device.joinEui);
    const devEuiBuf = hexToBuffer(device.devEui);
    const nwkKeyBuf = hexToBuffer(device.nwkKey || device.appKey);
    
    const joinRequest = buildJoinRequest(appEuiBuf, devEuiBuf, devNonce, nwkKeyBuf);
    
    // Store pending OTAA info
    device._pendingOtaa = {
      devNonce,
      nwkKeyBuf,
      appKeyBuf: hexToBuffer(device.appKey),
      timestamp: Date.now()
    };
    
    // Build and send packet
    const rxpk = this.buildRxpk({
      freq: device.nodeState?.channels?.[0] || 923.2,
      sf: this.config.lorawan?.spreadingFactor || 7,
      bw: this.config.lorawan?.bandwidth || 125000,
      rssi: device.nodeState?.rssi || -85,
      lsnr: device.nodeState?.snr || 5,
      base64Payload: joinRequest.toString('base64')
    });
    
    const packet = this.transport.createPushDataPacket(gatewayEuiBuf, [rxpk]);
    await this.transport.send(packet, this.config.lnsPort, this.config.lnsHost);
    
    console.log(`[⬆ Join] ${device.name} | DevEUI: ${device.devEui} | DevNonce: ${devNonce}`);
    this.stats.joins++;
  }

  async sendDataUplink(device, deviceIndex, totalDevices, gatewayEuiBuf) {
    // Calculate realistic signal if enabled
    let signalParams = {};
    if (this.config.signalModel?.enabled) {
      signalParams = calculateRealisticSignal(
        deviceIndex,
        totalDevices,
        { frequency: this.config.channels[0] * 1e6 },
        this.config,
        Date.now()
      );
    } else {
      signalParams = {
        rssi: device.nodeState?.rssi || -85,
        snr: device.nodeState?.snr || 5
      };
    }
    
    // Generate payload
    const payload = Buffer.alloc(this.config.uplink?.payloadLength || 12);
    payload[0] = (device.fCntUp >> 8) & 0xff;
    payload[1] = device.fCntUp & 0xff;
    
    // Build LoRaWAN uplink
    const devAddrBuf = device.devAddr || hexToBuffer('00000000');
    const nwkSKeyBuf = device.nwkSKey || hexToBuffer('00000000000000000000000000000000');
    const appSKeyBuf = device.appSKey || hexToBuffer('00000000000000000000000000000000');
    
    const phyPayload = buildLorawanUplinkAbp({
      nwkSKey: nwkSKeyBuf,
      appSKey: appSKeyBuf,
      devAddr: devAddrBuf,
      fCntUp: device.fCntUp,
      fPort: this.config.uplink?.fPort || 1,
      confirmed: this.config.uplink?.confirmed || false,
      payload,
      macCommands: this.macResponseQueues[bufToHexUpper(devAddrBuf)] || []
    });
    
    // Build and send packet
    const rxpk = this.buildRxpk({
      freq: device.nodeState?.channels?.[0] || 923.2,
      sf: this.config.lorawan?.spreadingFactor || 7,
      bw: this.config.lorawan?.bandwidth || 125000,
      rssi: signalParams.rssi,
      lsnr: signalParams.snr,
      base64Payload: phyPayload.toString('base64')
    });
    
    const packet = this.transport.createPushDataPacket(gatewayEuiBuf, [rxpk]);
    await this.transport.send(packet, this.config.lnsPort, this.config.lnsHost);
    
    // Update counters
    device.fCntUp++;
    this.stats.uplinks++;
    this.stateManager.incrementStat('uplinks');
    
    console.log(`[⬆ Data] ${device.name} | FCnt: ${device.fCntUp} | RSSI: ${Math.round(signalParams.rssi)}`);
  }

  buildRxpk({ freq, sf, bw, codr, rssi, lsnr, base64Payload, chan }) {
    const payloadBytes = Buffer.from(base64Payload, 'base64');
    return {
      time: new Date().toISOString(),
      tmst: (Date.now() * 1000) >>> 0,
      freq: Number(freq),
      chan: Number(chan ?? 0),
      rfch: 0,
      stat: 1,
      modu: 'LORA',
      datr: sfBwString(Number(sf), Number(bw)),
      codr: codr || '4/5',
      rssi: Math.round(clamp(Number(rssi ?? -42), -120, 10)),
      lsnr: Number(lsnr ?? 5.5),
      size: payloadBytes.length,
      data: base64Payload
    };
  }

  setupShutdownHandlers() {
    const shutdown = async () => {
      console.log('\n[🛑] Stopping simulator...\n');
      this.running = false;
      
      this.uplinkTimers.forEach(t => {
        if (t && typeof t.clear === 'function') t.clear();
      });
      
      this.stateManager.stopExporter();
      await this.transport.close();
      
      if (this.shutdownResolve) this.shutdownResolve();
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Main entry point
async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  
  // Check for legacy mode
  if (cliArgs.legacy) {
    console.log('[LoRaWAN-SIM] Running in legacy mode (index.js)');
    require('./index.js');
    return;
  }
  
  console.log('[LoRaWAN-SIM] Modular simulator v2.0');
  console.log('[LoRaWAN-SIM] Config:', cliArgs.config);
  
  try {
    // Load and normalize config
    const config = loadConfig(cliArgs.config);
    applyCliOverrides(config, cliArgs);
    
    // Create and run simulator
    const simulator = new LorawanSimulator(config);
    await simulator.initialize();
    await simulator.start();
    
  } catch (error) {
    console.error('[LoRaWAN-SIM] Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { LorawanSimulator, main };
