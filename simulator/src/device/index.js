/**
 * Device State Manager Module
 * Manages device state, OTAA/ABP activation, FCnt tracking
 */

class DeviceManager {
  constructor() {
    this.devices = new Map();
    this.pendingOtaaDevices = [];
    this.fCntState = {};
  }

  registerDevice(config) {
    const device = {
      name: config.name,
      devEui: config.devEui,
      joinEui: config.joinEui,
      appKey: config.appKey,
      nwkKey: config.nwkKey,
      activationMode: config.activationMode || 'otaa',
      devAddr: config.devAddr || null,
      nwkSKey: config.nwkSKey || null,
      appSKey: config.appSKey || null,
      fCntUp: 0,
      fCntDown: 0,
      joined: false,
      devNonce: 0,
      nodeState: null,
      _anomalyOverride: null,
      ...config
    };
    this.devices.set(config.devEui, device);
    return device;
  }

  getDevice(devEui) {
    return this.devices.get(devEui);
  }

  getAllDevices() {
    return Array.from(this.devices.values());
  }

  updateFCnt(devEui, fCnt) {
    const device = this.devices.get(devEui);
    if (device) {
      device.fCntUp = fCnt;
      this.fCntState[devEui] = fCnt;
    }
  }

  markJoined(devEui, sessionKeys) {
    const device = this.devices.get(devEui);
    if (device) {
      device.joined = true;
      device.devAddr = sessionKeys.devAddr;
      device.nwkSKey = sessionKeys.nwkSKey;
      device.appSKey = sessionKeys.appSKey;
    }
  }

  resetDevice(devEui) {
    const device = this.devices.get(devEui);
    if (device) {
      device.joined = false;
      device.fCntUp = 0;
      device.fCntDown = 0;
      device.devAddr = null;
      device.devNonce = 0;
      delete this.fCntState[devEui];
    }
  }

  resetAll() {
    this.devices.forEach(device => {
      device.joined = false;
      device.fCntUp = 0;
      device.fCntDown = 0;
      device.devAddr = null;
      device.devNonce = 0;
    });
    this.fCntState = {};
  }

  addPendingOtaa(device, devNonce, appKeyBuf) {
    this.pendingOtaaDevices.push({
      device,
      devNonce,
      appKeyBuf,
      timestamp: Date.now()
    });
  }

  findPendingOtaa(devEui) {
    const idx = this.pendingOtaaDevices.findIndex(p => p.device.devEui === devEui);
    if (idx >= 0) {
      return this.pendingOtaaDevices.splice(idx, 1)[0];
    }
    return null;
  }
}

module.exports = { DeviceManager };
