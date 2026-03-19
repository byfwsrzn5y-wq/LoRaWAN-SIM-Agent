#!/usr/bin/env node
/**
 * LoRaWAN Simulator v2.0 - Modular Entry Point with Movement & Environment
 * 
 * Features:
 * - Device movement simulation (linear, random, preset)
 * - Environment zones with transitions
 * - Derived anomalies from physical conditions
 * - Full OTAA/ABP support
 * - State visualization
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

// v2.0 modules
const { MovementEngine } = require('./src/movement');
const { EnvironmentManager } = require('./src/environment');
const { DerivedAnomalyEngine, DEFAULT_ANOMALIES } = require('./src/derived-anomalies');

// Legacy modules
const anomalyModule = require('./anomaly_module');
const multigwModule = require('./multigw_module');

class LorawanSimulator {
  constructor(config) {
    this.config = config;
    this.deviceManager = new DeviceManager();
    this.stateManager = new StateManager(config.visualizer?.stateFile);
    this.environmentManager = new EnvironmentManager(config.environment);
    this.derivedAnomalyEngine = new DerivedAnomalyEngine({ 
      anomalies: { ...DEFAULT_ANOMALIES, ...config.derivedAnomalies }
    });
    
    this.transport = null;
    this.running = false;
    this.uplinkTimers = [];
    this.stats = { uplinks: 0, joins: 0, errors: 0, handovers: 0 };
    this.macResponseQueues = {};
    this.movementEngines = new Map(); // deviceId -> MovementEngine
    
    // Load behavior templates
    this.behaviorTemplates = loadBehaviorTemplates(config.lorawan, process.cwd());
  }

  async initialize() {
    console.log('[LoRaWAN-SIM v2.0] Initializing...');
    
    // Initialize environment manager
    this.environmentManager.initialize();
    console.log(`[Environment] ${this.environmentManager.zones.length} zones configured`);
    
    // Initialize transport
    if (this.config.mqtt?.enabled) {
      console.log('[Transport] MQTT mode not yet fully implemented, falling back to UDP');
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
        
        // Initialize movement engine if movement config exists
        if (finalConfig.movement) {
          const movementEngine = new MovementEngine(finalConfig.movement);
          this.movementEngines.set(device.devEui, movementEngine);
          device.currentPosition = movementEngine.currentPosition;
          console.log(`[Movement] ${device.name}: ${finalConfig.movement.type} movement initialized`);
        }
        
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
    console.log(`[LoRaWAN-SIM] ${this.movementEngines.size} devices with movement`);
    
    // Setup transport handlers
    this.setupTransportHandlers();
    
    // Start state exporter
    this.stateManager.startExporter(this.config.visualizer?.stateIntervalMs || 1000);
    this.stateManager.update({
      running: true,
      gateways: [{ eui: this.config.gatewayEui, name: 'default-gateway' }],
      config: {
        signalModel: this.config.signalModel,
        environment: this.environmentManager.zones.map(z => ({ id: z.id, type: z.type }))
      }
    });
    
    console.log('[LoRaWAN-SIM] Initialization complete');
  }

  setupTransportHandlers() {
    this.transport.onMessage((msg, rinfo) => {
      // Handle downlink messages (PULL_RESP, etc.)
      console.log('[Transport] Message from', rinfo.address);
    });
  }

  async start() {
    this.running = true;
    console.log('\n[LoRaWAN-SIM v2.0] Simulation started\n');
    
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
    const movementEngine = this.movementEngines.get(device.devEui);
    
    const sendUplink = async () => {
      if (!this.running) return;
      
      try {
        // Update position if movement is enabled
        let currentPosition = device.currentPosition;
        let velocity = { x: 0, y: 0, z: 0 };
        
        if (movementEngine) {
          currentPosition = movementEngine.update();
          device.currentPosition = currentPosition;
          velocity = movementEngine.getVelocity();
        }
        
        // Check environment
        const envInfo = this.environmentManager.getBlendedEnvironment(device.devEui, currentPosition);
        
        // Check for environment events
        const events = this.environmentManager.checkEvents(
          device.devEui,
          currentPosition,
          Date.now()
        );
        
        // Process environment events
        events.forEach(event => {
          if (event.effect?.environment) {
            this.environmentManager.startTransition(
              device.devEui,
              envInfo.type,
              event.effect.environment,
              event.effect.transitionDuration || 10
            );
            console.log(`[Environment] ${device.name}: ${event.type} triggered`);
          }
        });
        
        // Evaluate derived anomalies
        const signalParams = this.calculateSignal(device, deviceIndex, totalDevices, currentPosition, envInfo);
        
        const derivedAnomalies = this.derivedAnomalyEngine.evaluate(device.devEui, device, {
          signal: signalParams,
          position: currentPosition,
          environment: envInfo,
          movement: { velocity }
        });
        
        // Log derived anomalies
        derivedAnomalies.forEach(anomaly => {
          console.log(`[Derived Anomaly] ${device.name}: ${anomaly.type} (${anomaly.reason})`);
          this.derivedAnomalyEngine.recordEvent(device.devEui, 'anomaly-triggered', { type: anomaly.type });
        });
        
        // Check if device needs to join
        if (device.activationMode === 'otaa' && !device.joined) {
          await this.sendJoinRequest(device, gatewayEuiBuf, signalParams);
        } else if (device.joined || device.activationMode === 'abp') {
          await this.sendDataUplink(device, deviceIndex, totalDevices, gatewayEuiBuf, signalParams, derivedAnomalies);
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
    
    // Start the loop with random initial delay
    setTimeout(sendUplink, Math.random() * interval);
    
    return { clear: () => {} };
  }

  calculateSignal(device, deviceIndex, totalDevices, position, envInfo) {
    // Get signal modifiers from environment
    const modifiers = this.environmentManager.getSignalModifiers(envInfo.type);
    
    // Calculate base signal
    let signalParams;
    if (this.config.signalModel?.enabled) {
      signalParams = calculateRealisticSignal(
        deviceIndex,
        totalDevices,
        { frequency: this.config.channels[0] * 1e6 },
        {
          ...this.config,
          signalModel: {
            ...this.config.signalModel,
            environment: envInfo.type,
            nodePosition: position
          }
        },
        Date.now()
      );
    } else {
      // Fallback to node state
      signalParams = {
        rssi: device.nodeState?.rssi || -85,
        snr: device.nodeState?.snr || 5
      };
    }
    
    // Apply environment modifiers
    if (envInfo.transitioning) {
      // Blend between old and new environment
      const blend = envInfo.blend;
      const fromModifiers = this.environmentManager.getSignalModifiers(envInfo.from);
      signalParams.rssi -= (fromModifiers.pathLossFactor * (1 - blend) + 
                            modifiers.pathLossFactor * blend) * 5;
    } else {
      signalParams.rssi -= modifiers.pathLossFactor * 5;
    }
    
    return signalParams;
  }

  async sendJoinRequest(device, gatewayEuiBuf, signalParams) {
    const devNonce = Math.floor(Math.random() * 65536);
    const appEuiBuf = hexToBuffer(device.joinEui);
    const devEuiBuf = hexToBuffer(device.devEui);
    const nwkKeyBuf = hexToBuffer(device.nwkKey || device.appKey);
    
    const joinRequest = buildJoinRequest(appEuiBuf, devEuiBuf, devNonce, nwkKeyBuf);
    
    device._pendingOtaa = {
      devNonce,
      nwkKeyBuf,
      appKeyBuf: hexToBuffer(device.appKey),
      timestamp: Date.now()
    };
    
    const rxpk = this.buildRxpk({
      freq: device.nodeState?.channels?.[0] || this.config.channels?.[0] || 923.2,
      sf: this.config.lorawan?.spreadingFactor || 7,
      bw: this.config.lorawan?.bandwidth || 125000,
      rssi: signalParams?.rssi || -85,
      lsnr: signalParams?.snr || 5,
      base64Payload: joinRequest.toString('base64')
    });
    
    const packet = this.transport.createPushDataPacket(gatewayEuiBuf, [rxpk]);
    await this.transport.send(packet, this.config.lnsPort, this.config.lnsHost);
    
    console.log(`[⬆ Join] ${device.name} | DevNonce: ${devNonce} | RSSI: ${Math.round(signalParams?.rssi || -85)}`);
    this.stats.joins++;
    this.stateManager.incrementStat('joins');
  }

  async sendDataUplink(device, deviceIndex, totalDevices, gatewayEuiBuf, signalParams, derivedAnomalies) {
    // Generate payload
    const payload = Buffer.alloc(this.config.uplink?.payloadLength || 12);
    payload[0] = (device.fCntUp >> 8) & 0xff;
    payload[1] = device.fCntUp & 0xff;
    
    // Build LoRaWAN uplink
    const devAddrBuf = device.devAddr || hexToBuffer('00000000');
    const nwkSKeyBuf = device.nwkSKey || hexToBuffer('00000000000000000000000000000000');
    const appSKeyBuf = device.appSKey || hexToBuffer('00000000000000000000000000000000');
    
    // Get MAC responses
    const macResponses = this.macResponseQueues[bufToHexUpper(devAddrBuf)] || [];
    
    // Apply derived anomaly MAC commands
    derivedAnomalies.forEach(anomaly => {
      if (anomaly.macCommand) {
        macResponses.push(anomaly.macCommand);
      }
    });
    
    const phyPayload = buildLorawanUplinkAbp({
      nwkSKey: nwkSKeyBuf,
      appSKey: appSKeyBuf,
      devAddr: devAddrBuf,
      fCntUp: device.fCntUp,
      fPort: this.config.uplink?.fPort || 1,
      confirmed: this.config.uplink?.confirmed || false,
      payload,
      macCommands: macResponses
    });
    
    // Check for packet loss from derived anomalies
    const dropAnomaly = derivedAnomalies.find(a => a.type === 'random-drop');
    if (dropAnomaly && Math.random() < (dropAnomaly.dropProbability || 1.0)) {
      console.log(`[✗ Drop] ${device.name} | FCnt: ${device.fCntUp} | Signal too weak`);
      device.fCntUp++;
      return;
    }
    
    const rxpk = this.buildRxpk({
      freq: device.nodeState?.channels?.[0] || this.config.channels?.[0] || 923.2,
      sf: this.config.lorawan?.spreadingFactor || 7,
      bw: this.config.lorawan?.bandwidth || 125000,
      rssi: signalParams?.rssi || -85,
      lsnr: signalParams?.snr || 5,
      base64Payload: phyPayload.toString('base64')
    });
    
    const packet = this.transport.createPushDataPacket(gatewayEuiBuf, [rxpk]);
    await this.transport.send(packet, this.config.lnsPort, this.config.lnsHost);
    
    device.fCntUp++;
    this.stats.uplinks++;
    this.stateManager.incrementStat('uplinks');
    
    const position = device.currentPosition;
    console.log(`[⬆ Data] ${device.name} | FCnt: ${device.fCntUp} | RSSI: ${Math.round(signalParams?.rssi || -85)} | Pos: (${Math.round(position?.x || 0)}, ${Math.round(position?.y || 0)})`);
  }

  buildRxpk({ freq, sf, bw, codr, rssi, lsnr, base64Payload }) {
    const payloadBytes = Buffer.from(base64Payload, 'base64');
    return {
      time: new Date().toISOString(),
      tmst: (Date.now() * 1000) >>> 0,
      freq: Number(freq),
      chan: 0,
      rfch: 0,
      stat: 1,
      modu: 'LORA',
      datr: sfBwString(Number(sf), Number(bw)),
      codr: codr || '4/5',
      rssi: Math.round(clamp(Number(rssi ?? -42), -140, 10)),
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
  
  if (cliArgs.legacy) {
    console.log('[LoRaWAN-SIM] Running in legacy mode (index.js)');
    require('./index.js');
    return;
  }
  
  console.log('[LoRaWAN-SIM v2.0] Modular simulator with movement & environment');
  console.log('[LoRaWAN-SIM] Config:', cliArgs.config);
  
  try {
    const config = loadConfig(cliArgs.config);
    applyCliOverrides(config, cliArgs);
    
    const simulator = new LorawanSimulator(config);
    await simulator.initialize();
    await simulator.start();
    
  } catch (error) {
    console.error('[LoRaWAN-SIM] Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { LorawanSimulator, main };
