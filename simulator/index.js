#!/usr/bin/env node
/**
 * LoRaWAN Gateway Simulator (standalone, no BACnet).
 * - LoRaWAN 1.0.3: Join (OTAA), Data Up/Down, 16-bit FCnt, NwkSKey/AppSKey derivation.
 * - Per-node activation: ABP or OTAA (config or CSV); multiple OTAA supported.
 * - ChirpStack MAC: uplink MAC (e.g. LinkCheckReq) and downlink MAC (LinkADRReq, DevStatusReq, etc.) with correct Ans in next uplink.
 * - Gateway Bridge (MQTT/Protobuf or UDP) to ChirpStack.
 * Dependencies: Node.js (mqtt, protobufjs optional for MQTT).
 */

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { injectAnomaly } = require('./anomaly_module');
const {
  PATH_LOSS_EXPONENT,
  calculateDistance,
  calculateFSPL,
  gaussianRandom,
  rayleighFading,
  generateDevicePosition,
  calculateRealisticSignal
} = require('./signal_model');
const { resolveLorawanAdrEnabled, linkAdrChannelMaskAck, linkAdrAppliedChannelMask } = require('./src/utils');
const { readConfig, deepMerge } = require('./src/config/v20-normalize');
const { parseCliConfigArgs, applyCliConfigOverrides, HELP_CONFIG_TEXT } = require('./src/config/cli-overrides');
const { OrchestratorService } = require('./src/orchestrator/service');
const { IdempotencyStore } = require('./src/orchestrator/idempotency');
const {
  buildMotionEnvironmentRuntime,
  registerMovementFromConfig,
  applyMotionEnvironmentBeforeSignal,
} = require('./src/runtime/motion-environment');
let mqttLib = null;
let mqttClient = null;
let protobuf = null;
let gwProto = null;

const PROTOCOL_VERSION = 2;

// FCnt 持久化预留（当前为内存态，未写盘）
const FCNT_STATE_FILE = path.join(__dirname, 'fcnt_state.json');
let globalFCntState = {};
const globalDeviceMap = {};

/** Strip NS→device ACK in downlink FCtrl when `confirmed-noack` anomaly is active (device keeps retrying). */
function stripLnsAckForConfirmedNoAck(phyPayload) {
  if (!phyPayload || phyPayload.length < 12) return phyPayload;
  const mType = (phyPayload[0] >> 5) & 0x07;
  if (mType !== 0x03 && mType !== 0x05) return phyPayload;
  const devAddrHex = phyPayload.slice(1, 5).reverse().toString('hex');
  const device = globalDeviceMap[devAddrHex];
  if (!device || !device._skipNextAck) return phyPayload;
  const out = Buffer.from(phyPayload);
  out[5] = out[5] & ~(1 << 5);
  delete device._skipNextAck;
  console.log(`[ANOMALY] confirmed-noack: stripped LNS ACK bit for ${device.name || devAddrHex}`);
  return out;
}

/** Corrupt downlink PHY before MAC parse when `downlink-corrupt` anomaly is active. */
function corruptDownlinkPhyForAnomaly(phyPayload) {
  if (!phyPayload || phyPayload.length < 12) return phyPayload;
  const mType = (phyPayload[0] >> 5) & 0x07;
  if (mType !== 0x03 && mType !== 0x05) return phyPayload;
  const devAddrHex = phyPayload.slice(1, 5).reverse().toString('hex');
  const device = globalDeviceMap[devAddrHex];
  if (!device || !device._corruptDownlink) return phyPayload;
  const p = device._downlinkCorruptParams || { bitFlip: 4, target: 'mic' };
  const out = Buffer.from(phyPayload);
  const flips = Math.max(1, Number(p.bitFlip) || 4);
  const target = p.target || 'mic';
  if (target === 'mic' || target === 'both') {
    const micStart = out.length - 4;
    for (let i = 0; i < flips; i++) {
      const byteIdx = micStart + (i % 4);
      out[byteIdx] ^= 1 << (i % 8);
    }
  }
  if (target === 'payload' || target === 'both') {
    const foptsLen = out[5] & 0x0f;
    const payloadStart = 8 + foptsLen + 1;
    const maxIdx = out.length - 5;
    for (let i = 0; i < flips && payloadStart < maxIdx; i++) {
      const span = Math.max(1, maxIdx - payloadStart);
      const byteIdx = payloadStart + (i % span);
      out[byteIdx] ^= 1 << ((i + 2) % 8);
    }
  }
  delete device._corruptDownlink;
  delete device._downlinkCorruptParams;
  console.log(`[ANOMALY] downlink-corrupt applied for ${device.name || devAddrHex} target=${target}`);
  return out;
}

function applyDownlinkPhyAnomalies(phyPayload) {
  let p = phyPayload;
  p = stripLnsAckForConfirmedNoAck(p);
  p = corruptDownlinkPhyForAnomaly(p);
  return p;
}
// OTAA: devices that sent Join Request, waiting for Join Accept (devNonce, appKeyBuf, otaaDeviceRef)
let pendingOtaaDevices = [];

// Per-device uplink counter for simple codec (devEui -> number), wrap at 65536
const simpleDeviceCounters = {};

const PKT = {
  PUSH_DATA: 0x00,
  PUSH_ACK: 0x01,
  PULL_DATA: 0x02,
  PULL_RESP: 0x03,
  PULL_ACK: 0x04,
  TX_ACK: 0x05,
};

// ===== 状态输出模块 (for Visualizer) =====
const SIM_STATE_FILE = path.join(__dirname, 'sim-state.json');
let simState = {
  running: false,
  gateways: [],
  nodes: [],
  config: {},
  stats: { uplinks: 0, joins: 0, errors: 0 },
  lastUpdate: null,
  packetLog: []
};

function pushSimPacketLog(entry) {
  if (!simState.packetLog) simState.packetLog = [];
  simState.packetLog.push(entry);
  if (simState.packetLog.length > 500) simState.packetLog.shift();
}

function dataRateToSf(dr) {
  const n = Number(dr);
  if (!Number.isFinite(n)) return undefined;
  const drToSf = [12, 11, 10, 9, 8, 7];
  if (n >= 0 && n < drToSf.length) return drToSf[n];
  return undefined;
}

function updateSimState(updates) {
  Object.assign(simState, updates);
  simState.lastUpdate = new Date().toISOString();
}

function writeSimState() {
  try {
    fs.writeFileSync(SIM_STATE_FILE, JSON.stringify(simState, null, 2));
  } catch (e) {
    // 忽略写入错误
  }
}

function startStateExporter(intervalMs = 1000) {
  setInterval(() => {
    writeSimState();
  }, intervalMs);
}
// ===== 状态输出模块结束 =====

const REGIONS = {
  'AS923-1': {
    channels: [
      923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6,
    ],
  },
};

// AS923 typical TX power index -> dBm (for reference; RSSI can be offset by power)
const TX_POWER_DBM_AS923 = [16, 14, 12, 10, 8, 6, 4, 2];

/**
 * 为节点初始化“真实”的初始状态：信道、发射功率、初始信号范围（RSSI/SNR）
 * 支持：显式配置、或按范围随机（每个节点可不同）
 * @param {number} deviceIndex - 设备索引
 * @param {object} device - 设备对象（lorawanDevice），会挂上 nodeState
 * @param {object} lorawanCfg - config.lorawan
 * @param {number[]} regionChannels - 区域信道列表（如 REGIONS['AS923-1'].channels）
 * @param {object} perDeviceOverride - 可选，该节点显式配置（如 config.devices[i].nodeState）
 */
function initNodeState(deviceIndex, device, lorawanCfg, globalUplink, regionChannels, perDeviceOverride) {
  const nodeCfg = perDeviceOverride || lorawanCfg.nodeState || globalUplink.nodeState || {};
  const useRandom = (perDeviceOverride ? false : (nodeCfg.random === true || nodeCfg.mode === 'random'));
  const defaultChannels = regionChannels && regionChannels.length > 0 ? regionChannels : REGIONS['AS923-1'].channels;

  let channels = defaultChannels;
  let txPowerIndex = 0;
  let rssi = -85;
  let snr = 5;

  if (useRandom) {
    const rssiRange = nodeCfg.rssiRange || [-95, -75];
    const snrRange = nodeCfg.snrRange || [2, 9];
    const txRange = nodeCfg.txPowerIndexRange || [0, 5];
    rssi = rssiRange[0] + Math.random() * (rssiRange[1] - rssiRange[0]);
    snr = snrRange[0] + Math.random() * (snrRange[1] - snrRange[0]);
    txPowerIndex = Math.floor(txRange[0] + Math.random() * (Math.min(txRange[1], 7) - txRange[0] + 1));
    if (nodeCfg.channelSubset && Array.isArray(nodeCfg.channelSubset) && nodeCfg.channelSubset.length > 0) {
      channels = nodeCfg.channelSubset;
    } else if (nodeCfg.channelCount && nodeCfg.channelCount < defaultChannels.length) {
      const start = deviceIndex % Math.max(1, defaultChannels.length - nodeCfg.channelCount);
      channels = defaultChannels.slice(start, start + nodeCfg.channelCount);
      if (channels.length < nodeCfg.channelCount) channels = defaultChannels.slice(0, nodeCfg.channelCount);
    }
  } else if (nodeCfg.rssi !== undefined || nodeCfg.snr !== undefined || nodeCfg.txPowerIndex !== undefined || nodeCfg.channels) {
    if (nodeCfg.rssi !== undefined) rssi = Number(nodeCfg.rssi);
    if (nodeCfg.snr !== undefined) snr = Number(nodeCfg.snr);
    if (nodeCfg.txPowerIndex !== undefined) txPowerIndex = Math.max(0, Math.min(7, Number(nodeCfg.txPowerIndex)));
    if (Array.isArray(nodeCfg.channels) && nodeCfg.channels.length > 0) channels = nodeCfg.channels.map(Number);
  }

  device.nodeState = {
    channels: [...channels],
    txPowerIndex,
    rssi,
    snr,
    lastRssi: rssi,
    lastSnr: snr,
    rssiJitter: nodeCfg.rssiJitter !== undefined ? Number(nodeCfg.rssiJitter) : 1.5,
    snrJitter: nodeCfg.snrJitter !== undefined ? Number(nodeCfg.snrJitter) : 0.8,
  };
}

// Map LoRa code rate string to Protobuf CodeRate enum
function mapCodeRateStringToEnum(crStr) {
  const map = {
    '4/5': 1, '4/6': 2, '4/7': 3, '4/8': 4, '3/8': 5,
    '2/6': 6, '1/4': 7, '1/6': 8, '5/6': 9,
  };
  return map[crStr] || 1;
}

// Simple codec: [counterHigh, counterLow, ...random bytes], max 20 bytes total
function generateSimplePayload(devEui, payloadLength) {
  const rawLen = Number(payloadLength);
  const normalizedLen = Number.isFinite(rawLen) ? Math.floor(rawLen) : 4;
  const len = Math.min(Math.max(normalizedLen || 4, 2), 20);
  if (!(devEui in simpleDeviceCounters)) {
    simpleDeviceCounters[devEui] = 0;
  }
  const counter = simpleDeviceCounters[devEui];
  simpleDeviceCounters[devEui] = (counter + 1) % 65536;

  const buf = Buffer.alloc(len);
  buf[0] = (counter >> 8) & 0xff;
  buf[1] = counter & 0xff;
  if (len > 2) {
    crypto.randomFillSync(buf, 2, len - 2);
  }
  return buf;
}

// -----------------------------
// FCnt State Persistence (no-op)
// -----------------------------
function loadFCntState() {
  return {};
}

function saveFCntState(state) {}

function getFCntForDevice(state, devAddr) {
  return 0;
}

function updateFCntForDevice(state, devAddr, fCnt) {}

// -----------------------------
// LoRaWAN ABP (1.0.x) frame builder
// -----------------------------
function aes128EcbEncryptBlock(keyBuf, block16) {
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block16), cipher.final()]);
}

function leftShiftOneBit(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const val = (buf[i] << 1) & 0xff;
    out[i] = val | carry;
    carry = (buf[i] & 0x80) ? 1 : 0;
  }
  return out;
}

function xor16(a, b) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

function aesCmac(keyBuf, messageBuf) {
  const constRb = 0x87;
  const zero16 = Buffer.alloc(16, 0);
  
  // L = AES-128(K, 0^128)
  const L = aes128EcbEncryptBlock(keyBuf, zero16);
  
  // K1 = (L << 1) if MSB(L) = 0 else (L << 1) XOR Rb
  let K1 = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const newCarry = (L[i] & 0x80) ? 1 : 0;
    K1[i] = ((L[i] << 1) & 0xff) | carry;
    carry = newCarry;
  }
  if (L[0] & 0x80) K1[15] ^= constRb;
  
  // K2 = (K1 << 1) if MSB(K1) = 0 else (K1 << 1) XOR Rb
  let K2 = Buffer.alloc(16);
  carry = 0;
  for (let i = 15; i >= 0; i--) {
    const newCarry = (K1[i] & 0x80) ? 1 : 0;
    K2[i] = ((K1[i] << 1) & 0xff) | carry;
    carry = newCarry;
  }
  if (K1[0] & 0x80) K2[15] ^= constRb;

  const n = Math.ceil(messageBuf.length / 16) || 1;
  const lastBlockComplete = (messageBuf.length % 16) === 0 && messageBuf.length !== 0;
  
  let X = Buffer.alloc(16, 0);
  
  // Process complete blocks
  for (let i = 0; i < n - 1; i++) {
    const block = messageBuf.slice(i * 16, (i + 1) * 16);
    X = aes128EcbEncryptBlock(keyBuf, xor16(X, block));
  }
  
  // Process last block
  const lastBlockStart = (n - 1) * 16;
  const lastBlock = messageBuf.slice(lastBlockStart);
  let M_last = Buffer.alloc(16, 0);
  
  if (lastBlockComplete) {
    lastBlock.copy(M_last, 0, 0, 16);
    M_last = xor16(M_last, K1);
  } else {
    lastBlock.copy(M_last, 0, 0, lastBlock.length);
    M_last[lastBlock.length] = 0x80;
    M_last = xor16(M_last, K2);
  }
  
  X = aes128EcbEncryptBlock(keyBuf, xor16(X, M_last));
  return X.slice(0, 4);
}

// -----------------------------
// OTAA: Join Request / Join Accept / Key derivation (LoRaWAN 1.0.x)
// -----------------------------
function buildJoinRequest(appEuiBuf, devEuiBuf, devNonce, nwkKeyBuf) {
  const MHDR = Buffer.from([0x00]);
  const msg = Buffer.concat([
    MHDR,
    Buffer.from(appEuiBuf).reverse(),
    Buffer.from(devEuiBuf).reverse(),
    Buffer.from([devNonce & 0xff, (devNonce >> 8) & 0xff]),
  ]);
  const mic = aesCmac(nwkKeyBuf, msg);  // Use NwkKey for MIC calculation
  return Buffer.concat([msg, mic]);
}

function decryptJoinAccept(encryptedPayload, keyBuf) {
  if (encryptedPayload.length !== 16 && encryptedPayload.length !== 32) return null;
  // ChirpStack uses AES-ECB decrypt to "encrypt" Join Accept
  // So we need to use AES-ECB encrypt to "decrypt"
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(false);
  const dec = Buffer.concat([cipher.update(encryptedPayload), cipher.final()]);
  const appNonce = dec.slice(0, 3);
  const netId = dec.slice(3, 6);
  const devAddr = dec.slice(6, 10);
  const dlSettings = dec[10];
  const rxDelay = dec[11];
  const cfList = dec.length >= 28 ? dec.slice(12, 28) : null;
  return { appNonce, netId, devAddr, dlSettings, rxDelay, cfList };
}

function deriveSessionKeys(nwkKeyBuf, appEuiBuf, appNonce, netId, devNonce) {
  // LoRaWAN 1.0.x 密钥派生 (opt_neg = false)
  // b[0] = type
  // b[1..4] = join_nonce (little-endian)
  // b[4..7] = net_id (little-endian)  
  // b[7..9] = dev_nonce (little-endian)
  
  const block = Buffer.alloc(16, 0);
  
  // NwkSKey - type 0x01
  block[0] = 0x01;
  // AppNonce (JoinNonce) - little-endian, 3 bytes
  block[1] = appNonce[0];
  block[2] = appNonce[1];
  block[3] = appNonce[2];
  // NetID - little-endian, 3 bytes
  block[4] = netId[0];
  block[5] = netId[1];
  block[6] = netId[2];
  // DevNonce - little-endian, 2 bytes
  block[7] = devNonce & 0xff;
  block[8] = (devNonce >> 8) & 0xff;
  
  const nwkSKey = aes128EcbEncryptBlock(nwkKeyBuf, block);

  // AppSKey - type 0x02
  block[0] = 0x02;
  const appSKey = aes128EcbEncryptBlock(nwkKeyBuf, block);
  
  console.log('[DEBUG] Key derivation:', {
    type: '1.0.x',
    appNonce: appNonce.toString('hex'),
    netId: netId.toString('hex'),
    devNonce: devNonce,
    nwkSKey: nwkSKey.toString('hex').substring(0, 16) + '...',
    appSKey: appSKey.toString('hex').substring(0, 16) + '...'
  });
  
  return { nwkSKey, appSKey };
}

function lorawanEncrypt(appSKeyBuf, devAddrBufLE, fCnt, direction, payload) {
  const fCnt16 = fCnt & 0xffff;
  if (!payload || payload.length === 0) return Buffer.alloc(0);
  const blocks = Math.ceil(payload.length / 16);
  const S = Buffer.alloc(blocks * 16);
  for (let i = 1; i <= blocks; i++) {
    const Ai = Buffer.alloc(16, 0);
    Ai[0] = 0x01;
    Ai[5] = direction & 0x01;
    devAddrBufLE.copy(Ai, 6);
    Ai[10] = fCnt16 & 0xff;
    Ai[11] = (fCnt16 >> 8) & 0xff;
    Ai[12] = 0;
    Ai[13] = 0;
    Ai[15] = i & 0xff;
    const Si = aes128EcbEncryptBlock(appSKeyBuf, Ai);
    Si.copy(S, (i - 1) * 16);
  }
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ S[i];
  return out;
}

function lorawanDecrypt(keyBuf, devAddrBufLE, fCnt, direction, encryptedPayload) {
  return lorawanEncrypt(keyBuf, devAddrBufLE, fCnt, direction, encryptedPayload);
}

function buildLorawanUplinkAbp({
  nwkSKey,
  appSKey,
  devAddr,
  fCntUp,
  fPort,
  confirmed,
  payload,
  macCommands,
  ackDownlink,
  adr = true,
}) {
  const MHDR = Buffer.from([confirmed ? 0x80 : 0x40]);

  let FOpts = Buffer.alloc(0);
  if (macCommands && macCommands.length > 0) {
    const macBuffers = macCommands.map(cmd => Buffer.concat([Buffer.from([cmd.cid]), cmd.payload]));
    FOpts = Buffer.concat(macBuffers);
    if (FOpts.length > 15) FOpts = FOpts.slice(0, 15);
  }

  if (process.env.LORASIM_DEBUG_MAC_FOPTS === '1') {
    const macSummary = (macCommands || []).map(cmd => {
      const payloadHex = Buffer.isBuffer(cmd.payload) ? cmd.payload.toString('hex') : '';
      return `cid=0x${cmd.cid.toString(16)} payload=${payloadHex}`;
    }).join(' | ');
    console.log(
      `[LORASIM_DEBUG_MAC_FOPTS] building uplink: FOptsLen=${FOpts.length} FOpts=0x${FOpts.toString('hex')} ` +
      `macCommands=${macSummary}`
    );
  }

  let fctrlByte = FOpts.length & 0x0f;
  if (ackDownlink) fctrlByte |= 0x20;
  if (adr) fctrlByte |= 0x80;
  const FCtrl = Buffer.from([fctrlByte]);
  const fCnt16 = fCntUp & 0xffff;
  const FCnt = Buffer.from([fCnt16 & 0xff, (fCnt16 >> 8) & 0xff]);
  const FHDR = Buffer.concat([devAddr, FCtrl, FCnt, FOpts]);
  const fPortByte = Buffer.from([fPort & 0xff]);
  const appSKeyBuf = Buffer.isBuffer(appSKey) ? appSKey : Buffer.from(appSKey, 'hex');
  const encFRMPayload = lorawanEncrypt(appSKeyBuf, devAddr, fCnt16, 0, payload);
  const msgNoMic = Buffer.concat([MHDR, FHDR, fPortByte, encFRMPayload]);

  const len = msgNoMic.length;
  const B0 = Buffer.alloc(16, 0);
  B0[0] = 0x49;
  B0[5] = 0x00;
  devAddr.copy(B0, 6);
  B0[10] = fCnt16 & 0xff;
  B0[11] = (fCnt16 >> 8) & 0xff;
  B0[12] = 0;
  B0[13] = 0;
  B0[15] = len & 0xff;
  
  console.log('[DEBUG] MIC calc:', {
    devAddr: devAddr.toString('hex'),
    fCnt16,
    B0: B0.toString('hex'),
    nwkSKey: Buffer.isBuffer(nwkSKey) ? nwkSKey.toString('hex').substring(0, 16) : nwkSKey.substring(0, 16),
    msgLen: len
  });
  
  const mic = aesCmac(nwkSKey, Buffer.concat([B0, msgNoMic]));
  return Buffer.concat([msgNoMic, mic]);
}

function hexToBufLen(hexStr, len) {
  const clean = (hexStr || '').replace(/[^a-fA-F0-9]/g, '');
  if (clean.length !== len * 2) {
    throw new Error(`Invalid key length: expected ${len * 2} hex chars, got ${clean.length}`);
  }
  return Buffer.from(clean, 'hex');
}

function genRandomBytes(n) {
  return crypto.randomBytes(n);
}

function genSequentialDevAddr(startHex, index) {
  if (startHex) {
    const v = (BigInt('0x' + startHex) + BigInt(index)) & BigInt(0xffffffff);
    const b = Buffer.alloc(4);
    b[3] = Number(v & 0xffn);
    b[2] = Number((v >> 8n) & 0xffn);
    b[1] = Number((v >> 16n) & 0xffn);
    b[0] = Number((v >> 24n) & 0xffn);
    return b;
  }
  return genRandomBytes(4);
}

function genSequentialDevEui(startHex, index) {
  if (startHex) {
    const v = (BigInt('0x' + startHex) + BigInt(index)) & BigInt('0xffffffffffffffff');
    const b = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
      b[7 - i] = Number((v >> BigInt(i * 8)) & 0xffn);
    }
    return b;
  }
  return genRandomBytes(8);
}

function bufToHexUpper(buf) {
  return Buffer.from(buf).toString('hex').toUpperCase();
}

function devAddrToHexUpperBE(devAddrLE) {
  return Buffer.from(devAddrLE).reverse().toString('hex').toUpperCase();
}

function hexToBuffer(hex) {
  return Buffer.from(hex.replace(/[^a-fA-F0-9]/g, ''), 'hex');
}

function euiStringToBuffer(euiStr) {
  const clean = euiStr.replace(/[^a-fA-F0-9]/g, '');
  if (clean.length !== 16) throw new Error('gatewayEui must be 8 bytes hex');
  return Buffer.from(clean, 'hex');
}

function toBase64FromHexOrBase64(str, format) {
  if (!str) return '';
  if (format === 'hex') return Buffer.from(str.replace(/\s+/g, ''), 'hex').toString('base64');
  if (format === 'base64') return str;
  throw new Error('payloadFormat must be "hex" or "base64"');
}

/** LoRaWAN max FRMPayload length (bytes). */
const MAX_FRM_PAYLOAD_LEN = 222;

/**
 * 解析自定义上行应用层负载（FRMPayload 明文）。
 * 当 uplink.codec === 'custom' 时，根据 payload + payloadFormat 返回 Buffer；
 * 否则返回 null 表示使用 simple codec。
 * 长度限制 0..MAX_FRM_PAYLOAD_LEN。
 */
function getCustomFrmPayload(uplinkCfg) {
  if (!uplinkCfg || String(uplinkCfg.codec || 'simple').toLowerCase() !== 'custom') return null;
  const raw = uplinkCfg.payload;
  const format = String(uplinkCfg.payloadFormat || 'hex').toLowerCase();
  let buf;
  if (raw == null || raw === '') {
    buf = Buffer.alloc(0);
  } else if (format === 'hex') {
    const hex = String(raw).replace(/\s+/g, '').replace(/^0x/i, '');
    if (hex.length % 2) throw new Error('custom payload hex length must be even');
    buf = Buffer.from(hex, 'hex');
  } else if (format === 'base64') {
    buf = Buffer.from(String(raw), 'base64');
  } else {
    throw new Error('custom payload payloadFormat must be "hex" or "base64"');
  }
  if (buf.length > MAX_FRM_PAYLOAD_LEN) {
    buf = buf.slice(0, MAX_FRM_PAYLOAD_LEN);
  }
  return buf;
}

function buildHeader(tokenHi, tokenLo, identifier) {
  const buf = Buffer.alloc(4);
  buf[0] = PROTOCOL_VERSION;
  buf[1] = tokenHi;
  buf[2] = tokenLo;
  buf[3] = identifier;
  return buf;
}

function randToken() {
  return [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
}

function nowIso() {
  // rxpk (uplink) expects ISO 8601 format: "2026-03-23T13:18:46Z"
  return new Date().toISOString();
}

function nowGoTime() {
  // stat (gateway stats) expects Go format: "2006-01-02 15:04:05 MST"
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  // Use UTC timezone abbreviation
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

function sfBwString(sf, bw) {
  return `SF${sf}BW${bw}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1';
}

function sameUdpPeerAddress(expectedHost, actualAddress) {
  const e = String(expectedHost || '').trim().toLowerCase();
  const a = String(actualAddress || '').trim().toLowerCase();
  if (e === a) return true;
  if (isLoopbackHost(e) && isLoopbackHost(a)) return true;
  return false;
}

/**
 * 加载行为模板（从文件或 config 内联）。返回 { baseline, templates }，baseline 可能为 null；无模板时返回 null。
 */
function loadBehaviorTemplates(lorawanCfg, cwd) {
  if (!lorawanCfg) return null;
  if (lorawanCfg.behaviorTemplates && typeof lorawanCfg.behaviorTemplates === 'object' && !Array.isArray(lorawanCfg.behaviorTemplates)) {
    const bt = lorawanCfg.behaviorTemplates;
    const templates = bt.templates || bt;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: bt.baseline || null, templates };
  }
  const filePath = lorawanCfg.behaviorTemplatesFile || lorawanCfg.behaviorTemplatesPath;
  if (!filePath) return null;
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd || process.cwd(), filePath);
    const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const templates = data.templates || data;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: data.baseline || null, templates };
  } catch (e) {
    console.error('[✗] 行为模板加载失败:', e.message);
    return null;
  }
}

/**
 * 从模板对象生成设备配置（不包含 name）。若 template.extends === "baseline" 且 baseline 存在，先应用 baseline 再按 key 合并 template 的差异。
 */
function applyBehaviorTemplate(template, baseline) {
  if (!template || typeof template !== 'object') return {};
  const mergeOne = (base, override) => (override && typeof override === 'object' ? { ...(base || {}), ...override } : (base || {}));
  let out = {};
  if (template.extends === 'baseline' && baseline && typeof baseline === 'object') {
    out.nodeState = mergeOne(baseline.nodeState, template.nodeState);
    out.uplink = mergeOne(baseline.uplink, template.uplink);
    out.lorawan = mergeOne(baseline.lorawan, template.lorawan);
    out.devStatus = template.devStatus ? { ...template.devStatus } : (baseline.devStatus ? { ...baseline.devStatus } : undefined);
    if (template.adrReject !== undefined) out.adrReject = template.adrReject; else if (baseline.adrReject !== undefined) out.adrReject = baseline.adrReject;
    if (template.adr !== undefined) out.adr = template.adr;
    else if (baseline.adr !== undefined) out.adr = baseline.adr;
    if (template.duplicateFirstData !== undefined) out.duplicateFirstData = template.duplicateFirstData; else if (baseline.duplicateFirstData !== undefined) out.duplicateFirstData = baseline.duplicateFirstData;
  } else {
    if (template.nodeState) out.nodeState = { ...template.nodeState };
    if (template.uplink) out.uplink = { ...template.uplink };
    if (template.lorawan) out.lorawan = { ...template.lorawan };
    if (template.devStatus) out.devStatus = { ...template.devStatus };
    if (template.adrReject !== undefined) out.adrReject = template.adrReject;
    if (template.adr !== undefined) out.adr = template.adr;
    if (template.duplicateFirstData !== undefined) out.duplicateFirstData = template.duplicateFirstData;
  }
  return out;
}

/** Fisher-Yates 打乱数组（原地），返回原数组引用 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 多网关：在 canReceive 集合上按 mode 选择本次上行发往哪些网关。
 * random_subset：每次随机选 1..N 个（均匀随机个数，再随机挑网关），用于模拟分集/偶发多路接收。
 */
function pickMultiGwReceivers(receptions, multiGwConfig) {
  if (!receptions || receptions.length === 0) return [];
  const mode = String((multiGwConfig && multiGwConfig.mode) || 'overlapping').toLowerCase();
  switch (mode) {
    case 'overlapping':
      return receptions;
    case 'handover':
      return receptions.length ? [receptions.reduce((a, b) => (a.rssi > b.rssi ? a : b))] : [];
    case 'failover': {
      const primary = receptions.find((r) => r.eui === multiGwConfig.primaryGateway);
      return primary ? [primary] : [receptions[0]];
    }
    case 'random_subset': {
      const copy = [...receptions];
      shuffleArray(copy);
      const k = 1 + Math.floor(Math.random() * copy.length);
      return copy.slice(0, k);
    }
    default:
      return receptions;
  }
}

/** 按权重对象 { id: weight } 随机返回一个 id，weight 会按总和归一化 */
function pickWeighted(weights) {
  const ids = Object.keys(weights);
  const total = ids.reduce((s, id) => s + (Number(weights[id]) || 0), 0);
  if (total <= 0) return ids[0];
  let r = Math.random() * total;
  for (const id of ids) {
    r -= Number(weights[id]) || 0;
    if (r <= 0) return id;
  }
  return ids[ids.length - 1];
}

function createSocket(bindPort) {
  const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(bindPort || 0, () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

function encodeUplinkPayload(rxpk, marshaler, gwProto) {
  console.log('[DEBUG] encodeUplinkPayload called:', { marshaler: marshaler, hasGwProto: !!gwProto });
  if (marshaler === 'protobuf' && gwProto) {
    try {
      const UplinkFrame = gwProto.lookupType('gw.UplinkFrame');
      if (!UplinkFrame) throw new Error('UplinkFrame not found');
      
      const datr = rxpk.datr || 'SF7BW125';
      const sfMatch = datr.match(/SF(\d+)/);
      const sf = sfMatch ? parseInt(sfMatch[1]) : 7;
      const bwMatch = datr.match(/BW(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1]) * 1000 : 125000;
      
      const frame = UplinkFrame.create({
        phyPayload: Buffer.from(rxpk.data, 'base64'),
        txInfo: {
          frequency: Math.round(Number(rxpk.freq || 923.2) * 1000000),
          modulation: {
            lora: {
              bandwidth: bw,
              spreadingFactor: sf,
              codeRate: 'CR_4_5'
            }
          }
        },
        rxInfo: {
          gatewayId: rxpk.gwid || '0203040506070809',
          uplinkId: Math.floor(Math.random() * 0xffffffff),
          rssi: Math.round(rxpk.rssi || -100),
          snr: parseFloat(rxpk.lsnr || 0),
          channel: rxpk.chan || 0,
          rfChain: rxpk.rfch || 0
        }
      });
      
      const encoded = UplinkFrame.encode(frame).finish();
      console.log('[DEBUG] Protobuf encoded length:', encoded.length);
      return encoded;
    } catch (e) {
      console.error('[Encode] Protobuf failed:', e.message);
      return JSON.stringify({ rxpk: [rxpk] });
    }
  }
  return JSON.stringify({ rxpk: [rxpk] });
}

function createPushDataPacket(gatewayEuiBuf, rxpkArray, token) {
  const [tHi, tLo] = token || randToken();
  const header = buildHeader(tHi, tLo, PKT.PUSH_DATA);
  const payload = Buffer.concat([gatewayEuiBuf, Buffer.from(JSON.stringify({ rxpk: rxpkArray }))]);
  return Buffer.concat([header, payload]);
}

function createPushStatPacket(gatewayEuiBuf, statObj, token) {
  const [tHi, tLo] = token || randToken();
  const header = buildHeader(tHi, tLo, PKT.PUSH_DATA);
  const payload = Buffer.concat([gatewayEuiBuf, Buffer.from(JSON.stringify({ stat: statObj }))]);
  return Buffer.concat([header, payload]);
}

function createPullDataPacket(gatewayEuiBuf, token) {
  const [tHi, tLo] = token || randToken();
  const header = buildHeader(tHi, tLo, PKT.PULL_DATA);
  return Buffer.concat([header, gatewayEuiBuf]);
}

function createTxAckPacket(gatewayEuiBuf, referencedToken, error) {
  const [tHi, tLo] = referencedToken || randToken();
  const header = buildHeader(tHi, tLo, PKT.TX_ACK);
  const ack = { txpk_ack: { error: error || 'NONE' } };
  return Buffer.concat([header, gatewayEuiBuf, Buffer.from(JSON.stringify(ack))]);
}

function buildRxpk({ freq, sf, bw, codr, rssi, lsnr, base64Payload, chan }) {
  const payloadBytes = Buffer.from(base64Payload, 'base64');
  const size = payloadBytes.length;
  const tmst = (Date.now() * 1000) >>> 0;
  return {
    time: nowIso(),
    tmst,
    freq: Number(freq),
    chan: Number(chan ?? 0),
    rfch: 0,
    stat: 1,
    modu: 'LORA',
    datr: sfBwString(Number(sf), Number(bw)),
    codr: codr || '4/5',
    rssi: Math.round(clamp(Number(rssi ?? -42), -120, 10)),
    lsnr: Number(lsnr ?? 5.5),
    size,
    data: base64Payload,
  };
}

// -----------------------------
// MAC Command Parser and Handler
// -----------------------------
function parseMacCommands(payload) {
  const commands = [];
  let offset = 0;
  const MAC_COMMANDS = {
    0x02: { name: 'LinkCheckAns', length: 2 },
    0x03: { name: 'LinkADRReq', length: 4 },
    0x04: { name: 'DutyCycleReq', length: 1 },
    0x05: { name: 'RXParamSetupReq', length: 4 },
    0x06: { name: 'DevStatusReq', length: 0 },
    0x07: { name: 'NewChannelReq', length: 5 },
    0x08: { name: 'RXTimingSetupReq', length: 1 },
    0x09: { name: 'TXParamSetupReq', length: 1 },
    0x0A: { name: 'DLChannelReq', length: 4 },
    0x0D: { name: 'DeviceTimeAns', length: 5 }
  };

  while (offset < payload.length) {
    const cid = payload[offset];
    const cmdInfo = MAC_COMMANDS[cid];
    if (!cmdInfo) { offset++; continue; }
    const cmd = {
      cid,
      name: cmdInfo.name,
      payload: payload.slice(offset + 1, offset + 1 + cmdInfo.length)
    };
    switch (cid) {
      case 0x03:
        cmd.params = `DR=${(cmd.payload[0] >> 4) & 0x0F}, TxPower=${cmd.payload[0] & 0x0F}, ChMask=0x${cmd.payload.readUInt16LE(1).toString(16)}`;
        break;
      case 0x05:
        cmd.params = `RX1DROffset=${(cmd.payload[0] >> 4) & 0x07}, RX2DR=${cmd.payload[0] & 0x0F}, Freq=${(cmd.payload[1] | (cmd.payload[2] << 8) | (cmd.payload[3] << 16)) * 100}Hz`;
        break;
      case 0x09:
        cmd.params = `MaxEIRP=${cmd.payload[0] & 0x0F}`;
        break;
    }
    commands.push(cmd);
    offset += 1 + cmdInfo.length;
  }
  return commands;
}

/**
 * MQTT 与 UDP（PULL_RESP）共用的下行 MAC 队列与 LinkADRReq 等处理。
 */
function createMacDownlinkHandlers() {
  const macResponseQueues = {};

  function markNeedsAck(devAddr) {
    if (!macResponseQueues[devAddr]) macResponseQueues[devAddr] = [];
    macResponseQueues[devAddr].needsAck = true;
  }

  function handleMacCommands(devAddr, macCommands) {
    if (!macResponseQueues[devAddr]) macResponseQueues[devAddr] = [];
    const device = globalDeviceMap[devAddr];

    macCommands.forEach(cmd => {
      let response = null;
      switch (cmd.cid) {
        case 0x03: // LinkADRReq -> LinkADRAns
          if (device && device.adrReject) {
            response = { cid: 0x03, name: 'LinkADRAns', payload: Buffer.from([0x00]) };
          } else if (device && device.macParams && cmd.payload && cmd.payload.length >= 4) {
            const dataRate = (cmd.payload[0] >> 4) & 0x0F;
            const txPower = cmd.payload[0] & 0x0F;
            const chMask = cmd.payload.readUInt16LE(1);
            const redundancy = cmd.payload[3];
            const chMaskCntl = (redundancy >> 4) & 0x07;
            const nbTrans = (redundancy & 0x0F) || 1;
            let statusByte = 0x00;
            if (dataRate >= 0 && dataRate <= 5) statusByte |= 0x02;
            if (txPower >= 0 && txPower <= 7) statusByte |= 0x04;
            if (linkAdrChannelMaskAck(chMask, chMaskCntl)) statusByte |= 0x01;

            // Debug aid: without raw hex from NS logs, we still need to verify
            // the parsed chMask/redundancy that drive channel_ack (bit0).
            if (process.env.LORASIM_DEBUG_MAC === '1') {
              const channelAck = (statusByte & 0x01) !== 0;
              const drAck = (statusByte & 0x02) !== 0;
              const txPowerAck = (statusByte & 0x04) !== 0;
              console.log(
                `[LORASIM_DEBUG_MAC] LinkADRReq->LinkADRAns DR=${dataRate} TxPower=${txPower} ` +
                `chMask=0x${chMask.toString(16).padStart(4, '0')} chMaskCntl=${chMaskCntl} ` +
                `redundancy=0x${redundancy.toString(16).padStart(2, '0')} nbTrans=${nbTrans} ` +
                `statusByte=0x${statusByte.toString(16).padStart(2, '0')} ` +
                `channel_ack=${channelAck} dr_offset_ack=${drAck} tx_power_ack=${txPowerAck}`
              );
            }
            if (statusByte === 0x07) {
              device.macParams.dataRate = dataRate;
              device.macParams.txPower = txPower;
              device.macParams.channelMask = linkAdrAppliedChannelMask(chMask, chMaskCntl);
              device.macParams.nbTrans = nbTrans;
            }
            response = { cid: 0x03, name: 'LinkADRAns', payload: Buffer.from([statusByte]) };
          } else {
            response = { cid: 0x03, name: 'LinkADRAns', payload: Buffer.from([0x00]) };
          }
          break;
        case 0x05: // RXParamSetupReq -> RXParamSetupAns
          if (device && device.macParams && cmd.payload && cmd.payload.length >= 4) {
            const rx1DROffset = (cmd.payload[0] >> 4) & 0x07;
            const rx2DataRate = cmd.payload[0] & 0x0F;
            const rx2FrequencyRaw = (cmd.payload[1] | (cmd.payload[2] << 8) | (cmd.payload[3] << 16));
            const rx2Frequency = rx2FrequencyRaw * 100;
            const rx2FrequencyIsDefault = rx2FrequencyRaw === 0;
            let statusByte = 0x00;
            if (rx1DROffset >= 0 && rx1DROffset <= 7) statusByte |= 0x04;
            if (rx2DataRate >= 0 && rx2DataRate <= 7) statusByte |= 0x02;
            if (rx2FrequencyIsDefault || (rx2Frequency >= 915000000 && rx2Frequency <= 928000000)) statusByte |= 0x01;

            if (process.env.LORASIM_DEBUG_MAC === '1') {
              const rx2FreqAck = (statusByte & 0x01) !== 0;
              console.log(
                `[LORASIM_DEBUG_MAC] RXParamSetupReq->RXParamSetupAns rx1DROffset=${rx1DROffset} rx2DataRate=${rx2DataRate} ` +
                `rx2FrequencyRaw=0x${rx2FrequencyRaw.toString(16)} rx2Frequency=${rx2Frequency} statusByte=0x${statusByte.toString(16).padStart(2, '0')} ` +
                `rx2_freq_ack=${rx2FreqAck}`
              );
            }
            if (statusByte === 0x07) {
              device.macParams.rx1DROffset = rx1DROffset;
              device.macParams.rx2DataRate = rx2DataRate;
              // rx2FrequencyRaw==0 means "use default" for ChirpStack tooling;
              // do not overwrite with 0.
              if (!rx2FrequencyIsDefault) device.macParams.rx2Frequency = rx2Frequency;
            }
            response = { cid: 0x05, name: 'RXParamSetupAns', payload: Buffer.from([statusByte]) };
          } else {
            response = { cid: 0x05, name: 'RXParamSetupAns', payload: Buffer.from([0x00]) };
          }
          break;
        case 0x04: // DutyCycleReq -> DutyCycleAns (no payload)
          response = { cid: 0x04, name: 'DutyCycleAns', payload: Buffer.from([]) };
          break;
        case 0x06: // DevStatusReq -> DevStatusAns (Battery 0-255, Margin 6-bit signed -32..31)
          if (device && device.devStatus) {
            const bat = Math.max(0, Math.min(255, Number(device.devStatus.battery) ?? 255));
            const margin = Math.max(-32, Math.min(31, Number(device.devStatus.margin) ?? 5));
            const marginByte = (margin + 32) & 0x3f;
            response = { cid: 0x06, name: 'DevStatusAns', payload: Buffer.from([bat, marginByte]) };
          } else {
            response = { cid: 0x06, name: 'DevStatusAns', payload: Buffer.from([200, 5]) };
          }
          break;
        case 0x07: // NewChannelReq -> NewChannelAns
          if (device && device.macParams && cmd.payload && cmd.payload.length >= 5) {
            const chIndex = cmd.payload[0];
            const freqRaw = cmd.payload[1] | (cmd.payload[2] << 8) | (cmd.payload[3] << 16);
            const freq = freqRaw * 100;
            const drRange = cmd.payload[4];
            const minDR = drRange & 0x0F;
            const maxDR = (drRange >> 4) & 0x0F;
            let statusByte = 0x00;
            if (freqRaw === 0 || (freq >= 915000000 && freq <= 928000000)) statusByte |= 0x01;
            if (minDR <= maxDR && maxDR <= 7) statusByte |= 0x02;
            if (statusByte === 0x03 && chIndex <= 15) {
              if (!device.macParams.customChannels) device.macParams.customChannels = {};
              if (freqRaw === 0) delete device.macParams.customChannels[chIndex];
              else device.macParams.customChannels[chIndex] = { frequency: freq, minDR, maxDR };
            }
            response = { cid: 0x07, name: 'NewChannelAns', payload: Buffer.from([statusByte]) };
          } else {
            response = { cid: 0x07, name: 'NewChannelAns', payload: Buffer.from([0x00]) };
          }
          break;
        case 0x08:
          response = { cid: 0x08, name: 'RXTimingSetupAns', payload: Buffer.from([]) };
          break;
        case 0x09:
          if (device && device.macParams && cmd.payload && cmd.payload.length >= 1) {
            const eirpDwellTime = cmd.payload[0];
            device.macParams.maxEIRP = eirpDwellTime & 0x0F;
            device.macParams.uplinkDwellTime = (eirpDwellTime & 0x10) ? 400 : 0;
            device.macParams.downlinkDwellTime = (eirpDwellTime & 0x20) ? 400 : 0;
          }
          response = { cid: 0x09, name: 'TXParamSetupAns', payload: Buffer.from([]) };
          break;
        case 0x0A:
          response = { cid: 0x0A, name: 'DLChannelAns', payload: Buffer.from([0x03]) };
          break;
        default:
          break;
      }
      if (response) macResponseQueues[devAddr].push(response);
    });
  }

  function getMacResponses(devAddr) {
    const responses = macResponseQueues[devAddr] || [];
    macResponseQueues[devAddr] = [];
    return responses;
  }

  return { handleMacCommands, getMacResponses, markNeedsAck };
}

/** 解析 Unconfirmed/Confirmed Downlink Data，解密 FPort0 MAC，入队 Ans（MQTT 与 UDP PULL_RESP 共用） */
function applyDataDownlinkMacAndQueue(phyPayload, macDl) {
  if (!phyPayload || phyPayload.length < 12) return null;
  const mhdr = phyPayload[0];
  const mType = (mhdr >> 5) & 0x07;
  if (mType !== 0x03 && mType !== 0x05) return null;
  const isConfirmed = mType === 0x05;
  const devAddr = phyPayload.slice(1, 5).reverse().toString('hex');
  const fctrl = phyPayload[5];
  const foptsLen = fctrl & 0x0f;
  const ackBit = (fctrl >> 5) & 0x01;
  const fcnt = phyPayload.readUInt16LE(6);
  let macCommands = [];
  if (foptsLen > 0) {
    macCommands = parseMacCommands(phyPayload.slice(8, 8 + foptsLen));
  }
  const payloadStart = 8 + foptsLen;
  let fPort = null;
  if (phyPayload.length > payloadStart + 4) {
    fPort = phyPayload[payloadStart];
    const frmPayload = phyPayload.slice(payloadStart + 1, phyPayload.length - 4);
    if (fPort === 0 && frmPayload && frmPayload.length > 0) {
      try {
        const device = globalDeviceMap[devAddr];
        if (device && device.nwkSKey) {
          const nwkSKeyBuf = Buffer.isBuffer(device.nwkSKey) ? device.nwkSKey : Buffer.from(device.nwkSKey, 'hex');
          const devAddrBufLE = Buffer.from(devAddr, 'hex').reverse();
          const actualPayload = lorawanDecrypt(nwkSKeyBuf, devAddrBufLE, fcnt, 1, frmPayload);
          macCommands = parseMacCommands(actualPayload);
        } else {
          macCommands = parseMacCommands(frmPayload);
        }
      } catch (e) {
        macCommands = [];
      }
    }
  }
  if (isConfirmed) {
    macDl.markNeedsAck(devAddr);
  }
  if (macCommands.length > 0) {
    macDl.handleMacCommands(devAddr, macCommands);
  }
  return { devAddr, macCommands, isConfirmed, fPort, ackBit };
}

function createMqttHandlers(mqttMarshaler, mqttTopicPrefix, gatewayEuiBuf, gwProto, mqttClient, mqttCfg, macDl, vizHooks) {
  const mqttOpts = mqttCfg || {};
  let downlinkCount = 0;

  function handleMqttDownlink(topic, payload) {
    downlinkCount++;
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try {
      let downlinkFrame, downlinkId, phyPayload;
      if (gwProto || mqttMarshaler === 'protobuf') {
        const DownlinkFrame = gwProto.lookupType('gw.DownlinkFrame');
        downlinkFrame = DownlinkFrame.decode(payload);
        downlinkId = downlinkFrame.downlinkId || 0;
        if (downlinkFrame.items && downlinkFrame.items.length > 0) {
          phyPayload = downlinkFrame.items[0].phyPayload;
        }
      } else {
        downlinkFrame = JSON.parse(payload.toString());
        downlinkId = downlinkFrame.downlink_id || downlinkFrame.downlinkId || 0;
        if (downlinkFrame.items && downlinkFrame.items.length > 0) {
          const base64Phy = downlinkFrame.items[0].phy_payload || downlinkFrame.items[0].phyPayload;
          if (base64Phy) phyPayload = Buffer.from(base64Phy, 'base64');
        }
      }

      let devAddr = 'unknown';

      if (phyPayload && phyPayload.length >= 4) {
        const mhdr = phyPayload[0];
        const mType = (mhdr >> 5) & 0x07;

        if (mType === 0x01) {
          const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          console.log(`[⬇ ${ts}] Downlink #${downlinkCount} | Join Accept | ID: ${downlinkId}`);
          const encrypted = phyPayload.slice(1);
          if (pendingOtaaDevices.length > 0) {
            // Try all pending devices to find the correct one
            let matchedIndex = -1;
            let matchedPending = null;
            let matchedParsed = null;
            
            for (let i = 0; i < pendingOtaaDevices.length; i++) {
              const pending = pendingOtaaDevices[i];
              try {
                // LoRaWAN 1.0.x: Join Accept使用AppKey解密
                      console.log('[DEBUG] Using appKey:', pending.appKeyBuf.toString('hex'), 'nwkKey:', (pending.nwkKeyBuf || pending.appKeyBuf).toString('hex'));
                      const parsed = decryptJoinAccept(encrypted, pending.nwkKeyBuf || pending.appKeyBuf);
                if (parsed && parsed.devAddr) {
                  // Verify by deriving keys - this ensures it's the correct device
                  try {
                    deriveSessionKeys(pending.nwkKeyBuf || pending.appKeyBuf, pending.appEui || Buffer.alloc(8, 0), parsed.appNonce, parsed.netId, pending.devNonce);
                    matchedIndex = i;
                    matchedPending = pending;
                    matchedParsed = parsed;
                    break; // Found the correct device
                  } catch (e) {
                    // Key derivation failed, try next device
                    continue;
                  }
                }
              } catch (e) {
                // Decrypt failed, try next device
                continue;
              }
            }
            
            if (matchedPending && matchedParsed) {
              const { nwkSKey, appSKey } = deriveSessionKeys(matchedPending.nwkKeyBuf || matchedPending.appKeyBuf, matchedPending.appEui || Buffer.alloc(8, 0), matchedParsed.appNonce, matchedParsed.netId, matchedPending.devNonce);
              const devAddrLE = Buffer.from(matchedParsed.devAddr);
              const devAddrHex = Buffer.from(devAddrLE).reverse().toString('hex');
              const macParams = { maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000, dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6] };
              const o = matchedPending.otaaDevice;
              o.joined = true;
              o.devAddr = devAddrLE;
              o.nwkSKey = nwkSKey;
              o.appSKey = appSKey;
              o.fCntUp = 0;
              o.macParams = macParams;
              o.devAddrHex = devAddrHex;
              o.classC = true;
              globalDeviceMap[devAddrHex] = o;
              // Remove the matched device from pending queue
              pendingOtaaDevices.splice(matchedIndex, 1);
              console.log(`[OTAA] Join Accept OK | DevAddr: ${devAddrHex} | DevEUI: ${o.devEui.toString('hex')} `);
              if (vizHooks && typeof vizHooks.onOtaaJoinOk === 'function') {
                try {
                  vizHooks.onOtaaJoinOk(o, devAddrHex);
                } catch (e) {
                  console.error('[Visualizer] onOtaaJoinOk:', e.message);
                }
              }
            } else {
              console.warn(`[OTAA] Join Accept received but no matching device found in pending queue (${pendingOtaaDevices.length} pending)`);
            }
          } else {
            console.warn('[OTAA] Join Accept received but no pending devices');
          }
          sendDownlinkTxAck(downlinkId, 'join');
          return;
        }

        if (phyPayload.length >= 12 && (mType === 0x03 || mType === 0x05)) {
          const dlResult = applyDataDownlinkMacAndQueue(applyDownlinkPhyAnomalies(phyPayload), macDl);
          if (dlResult) {
            devAddr = dlResult.devAddr;
            const mTypeName = dlResult.isConfirmed ? 'Confirmed' : 'Unconfirmed';
            const ackInfo = dlResult.ackBit ? ' | LNS-ACK:✓' : '';
            if (dlResult.macCommands.length > 0) {
              const cmdNames = dlResult.macCommands.map((cmd) => cmd.name).join(', ');
              console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr} | MAC: [${cmdNames}]${ackInfo}`);
            } else if (dlResult.fPort !== null) {
              console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr} | FPort: ${dlResult.fPort}${ackInfo}`);
            } else {
              console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr}${ackInfo}`);
            }
          }
        } else {
          console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ID: ${downlinkId} | MType: 0x${mType.toString(16)}`);
        }
      } else {
        console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ID: ${downlinkId}`);
      }

      sendDownlinkTxAck(downlinkId, devAddr);
    } catch (error) {
      console.error(`[✗ ${timestamp}] Downlink parse error:`, error.message);
    }
  }

  function sendDownlinkTxAck(downlinkId, devAddr) {
    if (!mqttClient || !mqttClient.connected) return;
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const ackTopic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/event/ack`;
    try {
      let ackPayload;
      if (gwProto || mqttMarshaler === 'protobuf') {
        const DownlinkTxAck = gwProto.lookupType('gw.DownlinkTxAck');
        const ackMsg = DownlinkTxAck.create({
          gatewayId: gatewayEuiBuf.toString('hex'),
          downlinkId,
          items: [{ status: 1 }]
        });
        ackPayload = Buffer.from(DownlinkTxAck.encode(ackMsg).finish());
      } else {
        ackPayload = Buffer.from(JSON.stringify({
          gatewayID: gatewayEuiBuf.toString('hex'),
          downlink_id: downlinkId,
          items: [{ status: 'OK' }]
        }));
      }
      mqttClient.publish(ackTopic, ackPayload, { qos: mqttOpts.qos || 0 }, (err) => {
        if (err) console.error(`[✗ ${timestamp}] TxAck publish failed:`, err.message);
        else console.log(`[⬆ ${timestamp}] TxAck sent | ID: ${downlinkId} | DevAddr: ${devAddr}`);
      });
    } catch (error) {
      console.error(`[✗ ${timestamp}] TxAck encode error:`, error.message);
    }
  }

  return { handleMqttDownlink, getMacResponses: macDl.getMacResponses, downlinkCount: () => downlinkCount };
}

async function main() {
  let orchestrator = null;
  let topologyMqttStop = () => {};
  let topologyInventoryTimer = null;
  let cliArgs;
  try {
    cliArgs = parseCliConfigArgs(process.argv);
  } catch (e) {
    console.error('[config]', e.message || e);
    process.exit(1);
  }
  if (cliArgs.helpConfig) {
    console.log(HELP_CONFIG_TEXT);
    process.exit(0);
  }

  const configFilePath = path.isAbsolute(cliArgs.config)
    ? path.resolve(cliArgs.config)
    : path.resolve(process.cwd(), cliArgs.config);
  const configDirForProfiles = path.dirname(configFilePath);
  // Main file under simulator/configs/*.json: use sibling profiles/ (avoid configs/configs/profiles).
  const defaultProfilesDir =
    path.basename(configDirForProfiles) === 'configs'
      ? path.resolve(configDirForProfiles, 'profiles')
      : path.resolve(configDirForProfiles, 'configs', 'profiles');

  const safeJsonClone = (obj) => JSON.parse(JSON.stringify(obj ?? null));
  const normalizeProfileName = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const ensureProfilesDir = (absDir) => {
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  };
  const resolveProfilesDir = (cfg) => {
    const configured = cfg?.profileConfig?.profilesDir;
    if (!configured) return defaultProfilesDir;
    const p = String(configured).trim();
    if (!p) return defaultProfilesDir;
    let resolved = path.isAbsolute(p) ? path.normalize(p) : path.resolve(path.dirname(configFilePath), p);
    // Main file under .../configs/*.json + profilesDir "configs/profiles" resolves to
    // .../configs/configs/profiles (wrong). Map to sibling .../configs/profiles.
    if (path.basename(configDirForProfiles) === 'configs') {
      const wrongNested = path.resolve(configDirForProfiles, 'configs', 'profiles');
      if (resolved === wrongNested) {
        resolved = path.resolve(configDirForProfiles, 'profiles');
      }
    }
    return resolved;
  };
  const listProfileNames = (cfg) => {
    const dir = resolveProfilesDir(cfg);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((ent) => ent.isFile() && ent.name.endsWith('.json'))
        .map((ent) => ent.name.replace(/\.json$/i, ''))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };
  const profileFilePath = (cfg, profileName) => {
    const n = normalizeProfileName(profileName);
    if (!n) throw new Error('invalid profile name');
    return path.join(resolveProfilesDir(cfg), `${n}.json`);
  };
  const applyProfileSnapshot = (baseCfg, snapshot) => {
    const patch = {};
    const keys = [
      'devices',
      'multiGateway',
      'signalModel',
      'uplink',
      'simulation',
      'lorawan',
      'chirpstack',
      'gatewayEui',
      'lnsHost',
      'lnsPort',
      'udpBindPort',
      'mqtt',
      'controlServer',
      'control',
    ];
    for (const key of keys) {
      if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, key)) patch[key] = snapshot[key];
    }
    return deepMerge(baseCfg, patch);
  };

  let config = readConfig(cliArgs.config);
  config = applyCliConfigOverrides(config, cliArgs.entries);
  if (!config.chirpstack || typeof config.chirpstack !== 'object') config.chirpstack = {};
  if (config.chirpstack.baseUrl == null) config.chirpstack.baseUrl = 'http://10.0.0.3:8090';
  if (!config.chirpstack.authHeader) config.chirpstack.authHeader = 'Grpc-Metadata-Authorization';
  if (config.chirpstack.applicationId == null) config.chirpstack.applicationId = '540a999c-9eeb-4c5c-bed1-778dacddaf46';
  if (config.chirpstack.deviceProfileId == null) config.chirpstack.deviceProfileId = 'a1b2c3d4-1111-2222-3333-444444444444';
  if (config.chirpstack.tenantId == null) config.chirpstack.tenantId = '81d48efb-6216-4c7f-8c21-46a5eac9d737';
  if (config.chirpstack.topologyEnabled == null) config.chirpstack.topologyEnabled = false;
  if (config.chirpstack.inventoryPollSec == null) config.chirpstack.inventoryPollSec = 60;
  if (config.chirpstack.rxStalenessSec == null) config.chirpstack.rxStalenessSec = 120;
  if (!config.profileConfig || typeof config.profileConfig !== 'object') config.profileConfig = {};
  if (!config.profileConfig.profilesDir) {
    config.profileConfig.profilesDir = path.relative(path.dirname(configFilePath), defaultProfilesDir).replace(/\\/g, '/');
  }
  ensureProfilesDir(resolveProfilesDir(config));
  const defaultProfileName = normalizeProfileName(config.profileConfig.defaultProfile || '');
  if (defaultProfileName) {
    try {
      const abs = profileFilePath(config, defaultProfileName);
      if (fs.existsSync(abs)) {
        const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
        config = applyProfileSnapshot(config, raw);
        config.profileConfig.activeProfile = defaultProfileName;
        console.log(`[Profile] loaded default profile "${defaultProfileName}"`);
      } else {
        console.log(`[Profile] default profile not found: "${defaultProfileName}" (${abs})`);
      }
    } catch (e) {
      console.log(`[Profile] failed to load default profile "${defaultProfileName}": ${e.message}`);
    }
  }

  function persistConfig(nextConfig) {
    fs.writeFileSync(configFilePath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8');
  }
  function profileStateForUi() {
    const names = listProfileNames(config);
    const active = normalizeProfileName(config?.profileConfig?.activeProfile || '');
    const defaults = normalizeProfileName(config?.profileConfig?.defaultProfile || '');
    let profilesDirResolved = '';
    try {
      profilesDirResolved = resolveProfilesDir(config);
    } catch {
      profilesDirResolved = '';
    }
    const relConfigured = config?.profileConfig?.profilesDir;
    return {
      activeProfile: active || '',
      defaultProfile: defaults || '',
      availableProfiles: names,
      profilesDir: typeof relConfigured === 'string' ? relConfigured : '',
      profilesDirResolved,
    };
  }
  function profileNameExists(cfg, profileName) {
    const n = normalizeProfileName(profileName);
    if (!n) return false;
    const abs = profileFilePath(cfg, n);
    return fs.existsSync(abs);
  }
  function generateUniqueBlankProfileName() {
    const base = normalizeProfileName(`blank-${Date.now()}`);
    let name = base || 'blank';
    let n = 0;
    while (profileNameExists(config, name)) {
      n += 1;
      name = normalizeProfileName(`${base || 'blank'}-${n}`);
    }
    return name;
  }
  function replaceObjectContents(target, source) {
    const src = source && typeof source === 'object' ? source : {};
    for (const k of Object.keys(target || {})) delete target[k];
    Object.assign(target, src);
  }
  function setActiveDefaultProfile(profileName, setDefault) {
    if (!config.profileConfig || typeof config.profileConfig !== 'object') config.profileConfig = {};
    config.profileConfig.activeProfile = profileName;
    if (setDefault === true) config.profileConfig.defaultProfile = profileName;
  }

  const gatewayEuiBuf = euiStringToBuffer(config.gatewayEui || '0102030405060708');
  const lnsHost = config.lnsHost || '127.0.0.1';
  const lnsPort = Number(config.lnsPort || 1700);
  const bindPort = Number(config.udpBindPort || 0);

  const mqttCfg = config.mqtt || {};
  const mqttEnabled = Boolean(mqttCfg.enabled);
  const mqttMarshaler = String(mqttCfg.marshaler || 'json').toLowerCase();
  const mqttTopicPrefix = String(mqttCfg.mqttTopicPrefix || 'gateway').replace(/\/$/, '');

  let uplinkCount = 0;
  let statsCount = 0;
  const startTime = Date.now();

  const mqttMessageTracking = {
    uplinkSentIds: new Set(),
    applicationReceivedIds: new Set(),
    packetTimestamps: new Map(),
    stats: {
      totalSent: 0,
      totalReceived: 0,
      totalLost: 0,
      lossRate: 0,
      deviceCount: 0,
      lastUpdateTime: Date.now(),
      lastApplicationEventTime: Date.now(),
      latency: { sum: 0, count: 0, avg: 0, min: 0, max: 0, samples: [] }
    },
    activeDevices: new Set()
  };

  /**
   * Merge node into sim-state for visualizer (HTTP / sim-state.json).
   * @param {object} options
   * @param {boolean} [options.countTx=true] If false (e.g. OTAA Join Request), refresh node on map without incrementing global uplink stats.
   * @param {Array<{ gatewayEui?: string, eui?: string, rssi?: number, snr?: number, distance?: number, pathLoss?: number }>} [options.gatewayReceptions]
   * @param {number} [options.sf]
   */
  function recordVisualizerAfterUplink(lorawanDevice, label, rssi, snr, options = {}) {
    if (!lorawanDevice || !lorawanDevice.devEui) return;
    const countTx = options.countTx !== false;
    const devEuiUp = lorawanDevice.devEui.toString('hex').toUpperCase();
    const displayName = label || lorawanDevice._vizLabel || devEuiUp.slice(-4);
    const devAddr = lorawanDevice.devAddr ? lorawanDevice.devAddr.toString('hex').toUpperCase() : 'N/A';
    const existingNode = simState.nodes.find(n => n.eui === devEuiUp);
    const nowIso = new Date().toISOString();
    const payloadPreview = typeof options.payloadPreview === 'string' ? options.payloadPreview : '';
    if (countTx) {
      uplinkCount++;
      lorawanDevice._vizUplinkCount = (lorawanDevice._vizUplinkCount || 0) + 1;
      const fCntLog = Math.max(0, (lorawanDevice.fCntUp || 0) - 1);
      const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      console.log(`[⬆ ${timestamp}] Uplink #${uplinkCount} | ${displayName} | DevAddr:${devAddr} FCnt:${fCntLog}`);
      simState.stats.uplinks = uplinkCount;
    }
    const fCntDisplay = lorawanDevice.joined ? Math.max(0, (lorawanDevice.fCntUp || 0) - 1) : 0;
    const sfDisplay = Number.isFinite(Number(options.sf))
      ? Number(options.sf)
      : (dataRateToSf(lorawanDevice?.macParams?.dataRate) || dataRateToSf(lorawanDevice?.nodeState?.dataRate));
    const rssiVal = rssi !== undefined && rssi !== null ? Number(rssi) : (lorawanDevice.nodeState?.rssi ?? existingNode?.rssi ?? -80);
    const snrVal = snr !== undefined && snr !== null ? Number(snr) : (lorawanDevice.nodeState?.snr ?? existingNode?.snr ?? 5);
    const uplinksDisplay = countTx
      ? (lorawanDevice._vizUplinkCount || 0)
      : (existingNode && existingNode.uplinks !== undefined ? existingNode.uplinks : (lorawanDevice._vizUplinkCount || 0));
    const gatewayReceptions = Array.isArray(options.gatewayReceptions)
      ? options.gatewayReceptions
          .map((rx) => {
            const gatewayEui = String(rx.gatewayEui || rx.eui || '').toLowerCase();
            if (!/^[0-9a-f]{16}$/.test(gatewayEui)) return null;
            return {
              gatewayEui,
              rssi: Number.isFinite(Number(rx.rssi)) ? Number(rx.rssi) : undefined,
              snr: Number.isFinite(Number(rx.snr)) ? Number(rx.snr) : undefined,
              distance: Number.isFinite(Number(rx.distance)) ? Number(rx.distance) : undefined,
              pathLoss: Number.isFinite(Number(rx.pathLoss)) ? Number(rx.pathLoss) : undefined
            };
          })
          .filter(Boolean)
      : (Array.isArray(existingNode?.gatewayReceptions) ? existingNode.gatewayReceptions : undefined);
    const newNode = {
      eui: devEuiUp,
      enabled: existingNode?.enabled,
      name: displayName,
      devAddr,
      fCnt: fCntDisplay,
      joined: lorawanDevice.joined,
      rssi: rssiVal,
      snr: snrVal,
      uplinks: uplinksDisplay,
      position: lorawanDevice.position,
      anomaly: lorawanDevice.anomaly,
      nodeState: existingNode?.nodeState,
      adrReject: existingNode?.adrReject,
      devStatus: existingNode?.devStatus,
      duplicateFirstData: existingNode?.duplicateFirstData,
      lastSeen: nowIso,
      lastPayload: payloadPreview || existingNode?.lastPayload,
      gatewayReceptions,
      simulator: existingNode?.simulator
    };
    const idx = simState.nodes.findIndex(n => n.eui === devEuiUp);
    if (idx >= 0) simState.nodes[idx] = newNode;
    else simState.nodes.push(newNode);
    if (payloadPreview) {
      if (Array.isArray(gatewayReceptions) && gatewayReceptions.length > 0) {
        gatewayReceptions.forEach((rx) => {
          pushSimPacketLog({
            nodeId: devEuiUp,
            gatewayEui: rx.gatewayEui,
            time: nowIso,
            type: countTx ? 'data' : 'join',
            fCnt: fCntDisplay,
            sf: sfDisplay,
            rssi: rx.rssi != null ? Number(rx.rssi) : rssiVal,
            snr: rx.snr != null ? Number(rx.snr) : snrVal,
            payload: payloadPreview,
            status: 'ok'
          });
        });
      } else {
        pushSimPacketLog({
          nodeId: devEuiUp,
          time: nowIso,
          type: countTx ? 'data' : 'join',
          fCnt: fCntDisplay,
          sf: sfDisplay,
          rssi: rssiVal,
          snr: snrVal,
          payload: payloadPreview,
          status: 'ok'
        });
      }
    }
    if (lorawanDevice.nodeState) {
      if (rssiVal !== undefined && rssiVal !== null) {
        lorawanDevice.nodeState.rssi = rssiVal;
        lorawanDevice.nodeState.lastRssi = rssiVal;
      }
      if (snrVal !== undefined && snrVal !== null) {
        lorawanDevice.nodeState.snr = snrVal;
      }
    }
    if (options.vizJoinOk) {
      simState.stats.joins = (simState.stats.joins || 0) + 1;
    }
    simState.lastUpdate = nowIso;
    writeSimState();
  }

  function trackUplinkSent(uplinkMsg, devAddr, devEui, fCnt, confirmed, fPort) {
    const uniqueId = `${devEui}_${fCnt}`;
    const sentTime = Date.now();
    if (!mqttMessageTracking.uplinkSentIds.has(uniqueId)) {
      mqttMessageTracking.uplinkSentIds.add(uniqueId);
      mqttMessageTracking.stats.totalSent++;
      mqttMessageTracking.activeDevices.add(devEui);
      mqttMessageTracking.stats.deviceCount = mqttMessageTracking.activeDevices.size;
      mqttMessageTracking.packetTimestamps.set(uniqueId, { sentTime, receivedTime: null });
    } else {
      const existing = mqttMessageTracking.packetTimestamps.get(uniqueId);
      if (existing && (!existing.sentTime || sentTime < existing.sentTime)) existing.sentTime = sentTime;
    }
  }

  function extractDevEuiFromTopic(topic) {
    const match = topic.match(/application\/[^\/]+\/device\/([^\/]+)/);
    return match ? match[1] : null;
  }

  function handleApplicationEvent(topic, payload) {
    try {
      const event = JSON.parse(payload.toString());
      let devEui = extractDevEuiFromTopic(topic);
      if (!devEui) return;
      devEui = devEui.toUpperCase();
      if (orchestrator && topic.includes('/event/up') && Array.isArray(event.rxInfo)) {
        orchestrator.recordUplinkRxInfo(devEui, event.rxInfo);
      }
      const fCnt = event.fCnt;

      if (fCnt !== null && fCnt !== undefined) {
        const uniqueId = `${devEui}_${fCnt}`;
        if (!mqttMessageTracking.applicationReceivedIds.has(uniqueId)) {
          mqttMessageTracking.applicationReceivedIds.add(uniqueId);
          mqttMessageTracking.stats.totalReceived++;
          mqttMessageTracking.stats.lastApplicationEventTime = Date.now();
          const receiveTime = Date.now();
          const packetInfo = mqttMessageTracking.packetTimestamps.get(uniqueId);
          if (packetInfo && packetInfo.sentTime) {
            packetInfo.receivedTime = receiveTime;
            const latency = receiveTime - packetInfo.sentTime;
            if (latency >= 0 && latency < 65000) {
              const ls = mqttMessageTracking.stats.latency;
              ls.sum += latency;
              ls.count++;
              ls.avg = Math.round(ls.sum / ls.count);
              ls.samples.push(latency);
              if (ls.min === 0 || latency < ls.min) ls.min = latency;
              if (latency > ls.max) ls.max = latency;
              if (ls.samples.length > 1000) ls.samples = ls.samples.slice(-1000);
            }
          }
        }
        syncFCntFromChirpStack(devEui, fCnt);
        if (topic.includes('/event/up')) {
          console.log(`[📱 APP-UP] ${devEui} FCnt:${fCnt} Total:${mqttMessageTracking.stats.totalReceived}`);
        } else if (topic.endsWith('/rx')) {
          console.log(`[📱 APP-RX] ${devEui} FCnt:${fCnt} Total:${mqttMessageTracking.stats.totalReceived}`);
        }
      } else if (topic.includes('/log') && event.code === 'UPLINK_F_CNT_RESET') {
        handleFCntReset(devEui, event);
      }
    } catch (error) {
      console.error('[✗] Application event parse error:', error.message);
    }
  }

  function handleFCntReset(devEui, event) {
    const devAddr = findDevAddrByDevEui(devEui);
    if (devAddr) {
      updateFCntForDevice(globalFCntState, devAddr, 0);
      console.log(`[🔄 FCnt Reset] ${devEui} FCnt 已重置为 0`);
    }
  }

  function syncFCntFromChirpStack(devEui, chirpStackFCnt) {
    const devAddr = findDevAddrByDevEui(devEui);
    if (devAddr) {
      const currentFCnt = getFCntForDevice(globalFCntState, devAddr);
      if (chirpStackFCnt > currentFCnt) {
        updateFCntForDevice(globalFCntState, devAddr, chirpStackFCnt);
      }
    }
  }

  function findDevAddrByDevEui(devEui) {
    for (const [devAddrKey, device] of Object.entries(globalDeviceMap)) {
      if (device.devEui && device.devEui.toString('hex').toUpperCase() === devEui.toUpperCase()) {
        return Buffer.from(devAddrKey, 'hex');
      }
    }
    return null;
  }

  if (mqttEnabled) {
    setInterval(() => {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const uptimeStr = `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
      const dlCount = mqttHandlers ? mqttHandlers.downlinkCount() : 0;
      console.log(`\n[📈 Summary] Uptime: ${uptimeStr} | Uplinks: ${uplinkCount} | Downlinks: ${dlCount}\n`);
    }, 60000);
  }

  if (mqttEnabled) {
    try {
      mqttLib = require('mqtt');
    } catch (e) {
      console.error('MQTT mode enabled but module not installed. Run: npm i mqtt');
      process.exit(1);
    }
    // Always load protobuf for downlink decoding
    if (true) {
      try {
        protobuf = require('protobufjs');
        const protoPath = path.join(__dirname, 'gw.proto');
        gwProto = protobuf.loadSync(protoPath);
      } catch (e) {
        console.error('[✗] Protobuf failed to load.');
        process.exit(1);
      }
    }
  }

  let socket = null;
  let mqttHandlers = null;
  const macDl = createMacDownlinkHandlers();

  if (!mqttEnabled) {
    socket = await createSocket(bindPort);
    const localAddress = socket.address();
    console.log(`Gateway simulator bound on ${localAddress.address}:${localAddress.port}`);
  } else {
    console.log(`\n========================================`);
    console.log(`  LoRaWAN Gateway Simulator (MQTT)`);
    console.log(`========================================`);
    console.log(`Gateway EUI: ${gatewayEuiBuf.toString('hex')}`);
    console.log(`Broker: ${mqttCfg.server || '(missing)'}`);
    console.log(`Topic Prefix: ${mqttTopicPrefix}`);
    console.log(`========================================\n`);
    const mqttUrl = mqttCfg.server || 'tcp://127.0.0.1:1883';
    mqttClient = mqttLib.connect(mqttUrl, {
      username: mqttCfg.username,
      password: mqttCfg.password,
      clientId: mqttCfg.clientId || `gw-sim-${gatewayEuiBuf.toString('hex')}`,
      clean: mqttCfg.clean !== false,
    });
    mqttHandlers = createMqttHandlers(mqttMarshaler, mqttTopicPrefix, gatewayEuiBuf, gwProto, mqttClient, mqttCfg, macDl, {
      onOtaaJoinOk(o, devAddrHex) {
        const lbl = o._vizLabel || o.devEui.toString('hex').toUpperCase();
        const r = o.nodeState?.rssi ?? -80;
        const s = o.nodeState?.snr ?? 5;
        recordVisualizerAfterUplink(o, lbl, r, s, {
          countTx: false,
          payloadPreview: `JOIN:${devAddrHex}`,
          vizJoinOk: true,
        });
      },
    });

    mqttClient.on('connect', () => {
      const downTopic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/command/down`;
      mqttClient.subscribe(downTopic, { qos: mqttCfg.qos || 0 }, (err) => {
        if (err) console.error('[✗] MQTT subscribe failed:', err.message);
        else console.log(`[✓] Subscribed to downlink: ${downTopic}`);
      });
      ['application/+/device/+/event/up', 'application/+/device/+/rx', 'application/+/device/+/log'].forEach(topic => {
        mqttClient.subscribe(topic, { qos: mqttCfg.qos || 0 }, (err) => {
          if (err) console.error(`[✗] Subscribe failed: ${topic}`, err.message);
          else console.log(`[✓] Subscribed: ${topic}`);
        });
      });
    });

      // Send stats heartbeat to mark gateway as active
      function sendGatewayStats() {
        const statsTopic = mqttTopicPrefix + '/gateway/' + gatewayEuiBuf.toString('hex') + '/event/stats';
        const statsPayload = JSON.stringify({ stat: { time: new Date().toISOString(), rxnb: 1, rxok: 1, rxfw: 1, ackr: 100, dwnb: 0, txnb: 0 } });
        mqttClient.publish(statsTopic, statsPayload, { qos: 0 });
        console.log('[Stats] Sent to', gatewayEuiBuf.toString('hex'));
      }
      setInterval(sendGatewayStats, 30000);
      setTimeout(sendGatewayStats, 5000);
    mqttClient.on('close', () => console.log('[⚠️] MQTT connection closed'));
    mqttClient.on('error', (err) => console.error('[✗] MQTT error:', err.message));
    mqttClient.on('message', (topic, payload) => {
      if (topic.includes('/command/down')) {
        mqttHandlers.handleMqttDownlink(topic, payload);
      } else if (topic.startsWith('application/') && topic.includes('/device/')) {
        if (topic.endsWith('/up') || topic.includes('/event/up') || topic.endsWith('/rx') || topic.includes('/log')) {
          handleApplicationEvent(topic, payload);
        }
      }
    });
  }

  if (!mqttEnabled) {
    socket.on('message', (msg, rinfo) => {
      if (!sameUdpPeerAddress(lnsHost, rinfo.address) || rinfo.port !== lnsPort) return;
      if (msg.length < 4) return;
      const version = msg[0], tokenHi = msg[1], tokenLo = msg[2], identifier = msg[3];
      if (version !== PROTOCOL_VERSION) return;
      if (identifier === PKT.PULL_ACK) { console.log('<= PULL_ACK'); return; }
      if (identifier === PKT.PUSH_ACK) { console.log('<= PUSH_ACK'); return; }
      if (identifier === PKT.PULL_RESP) {
        try {
          const obj = JSON.parse(msg.slice(4).toString('utf8'));
          console.log('<= PULL_RESP (downlink):', JSON.stringify(obj));
          
          // 解析Join Accept (UDP模式)
          if (obj.txpk && obj.txpk.data) {
            const phyPayload = Buffer.from(obj.txpk.data, 'base64');
            if (phyPayload.length >= 1) {
              const mhdr = phyPayload[0];
              const mType = (mhdr >> 5) & 0x07;
              
              if (mType === 0x01) { // Join Accept
                const encrypted = phyPayload.slice(1);
                console.log(`[DEBUG] Join Accept received, encrypted length: ${encrypted.length}, pending devices: ${pendingOtaaDevices.length}`);
                if (pendingOtaaDevices.length > 0) {
                  let matchedIndex = -1;
                  let matchedPending = null;
                  let matchedParsed = null;
                  
                  for (let i = 0; i < pendingOtaaDevices.length; i++) {
                    const pending = pendingOtaaDevices[i];
                    try {
                      // 尝试AppKey和NwkKey解密，选择正确的结果
                      console.log(`[DEBUG] Trying device ${i}, DevEUI: ${pending.otaaDevice.devEui.toString('hex')}`);
                      
                      // 首先尝试AppKey (LoRaWAN 1.0.x)
console.log('[DEBUG] Using appKeyBuf:', pending.appKeyBuf.toString('hex'));
                      let parsed = decryptJoinAccept(encrypted, pending.nwkKeyBuf || pending.appKeyBuf);
                      let usedKey = 'AppKey';
                      
                      // 如果NetID不是000000，尝试NwkKey (可能是LoRaWAN 1.1或配置问题)
                      if (parsed && parsed.netId && parsed.netId.toString('hex') !== '000000') {
                        console.log(`[DEBUG] AppKey解密NetID=${parsed.netId.toString('hex')}，尝试NwkKey...`);
                        const parsedNwk = decryptJoinAccept(encrypted, pending.nwkKeyBuf);
                        if (parsedNwk && parsedNwk.netId && parsedNwk.netId.toString('hex') === '000000') {
                          parsed = parsedNwk;
                          usedKey = 'NwkKey';
                          console.log(`[DEBUG] NwkKey解密成功，NetID=000000`);
                        }
                      }
                      
                      console.log(`[DEBUG] Used ${usedKey}, NetID: ${parsed ? parsed.netId.toString('hex') : 'null'}`);
                      if (parsed && parsed.devAddr) {
                        console.log(`[DEBUG] Decrypt success, DevAddr (raw): ${parsed.devAddr.toString('hex')}, NetID: ${parsed.netId.toString('hex')}, AppNonce: ${parsed.appNonce.toString('hex')}`);
                        try {
                          deriveSessionKeys(pending.nwkKeyBuf || pending.appKeyBuf, pending.appEui || Buffer.alloc(8, 0), parsed.appNonce, parsed.netId, pending.devNonce);
                          matchedIndex = i;
                          matchedPending = pending;
                          matchedParsed = parsed;
                          console.log(`[DEBUG] Key derivation success`);
                          break;
                        } catch (e) {
                          console.log(`[DEBUG] Key derivation failed: ${e.message}`);
                          continue;
                        }
                      }
                    } catch (e) {
                      console.log(`[DEBUG] Decrypt failed for device ${i}: ${e.message}`);
                      continue;
                    }
                  }
                  
                  if (matchedPending && matchedParsed) {
                    const keyBuf = matchedPending.nwkKeyBuf || matchedPending.appKeyBuf;
                    const { nwkSKey, appSKey } = deriveSessionKeys(matchedPending.nwkKeyBuf || matchedPending.appKeyBuf, matchedPending.appEui || Buffer.alloc(8, 0), matchedParsed.appNonce, matchedParsed.netId, matchedPending.devNonce);
                    const devAddrLE = Buffer.from(matchedParsed.devAddr);
                    const devAddrHex = Buffer.from(devAddrLE).reverse().toString('hex');
                    console.log(`[DEBUG] Session keys derived, DevAddr (hex): ${devAddrHex}, nwkSKey: ${nwkSKey.toString('hex').slice(0,8)}..., appSKey: ${appSKey.toString('hex').slice(0,8)}...`);
                    const macParams = { maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000, dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6] };
                    const o = matchedPending.otaaDevice;
                    o.joined = true;
                    o.devAddr = devAddrLE;
                    o.nwkSKey = nwkSKey;
                    o.appSKey = appSKey;
                    o.fCntUp = 0;
                    o.macParams = macParams;
                    o.devAddrHex = devAddrHex;
                    o.classC = true;
                    o.joinRetryCount = 0;
                    delete o.joinLastAttemptAt;
                    globalDeviceMap[devAddrHex] = o;
                    pendingOtaaDevices.splice(matchedIndex, 1);
                    console.log(`[OTAA] Join Accept OK | DevAddr: ${devAddrHex} | DevEUI: ${o.devEui.toString('hex')} `);
                    {
                      const lbl = o._vizLabel || o.devEui.toString('hex').toUpperCase();
                      const r = o.nodeState?.rssi ?? -80;
                      const s = o.nodeState?.snr ?? 5;
                      recordVisualizerAfterUplink(o, lbl, r, s, {
                        countTx: false,
                        payloadPreview: `JOIN:${devAddrHex}`,
                        vizJoinOk: true,
                      });
                    }
                    console.log(`[DEBUG] Device stored in globalDeviceMap, keys: ${Object.keys(globalDeviceMap).join(', ')}`);
                  } else {
                    console.warn('[OTAA] Join Accept: no matching device found');
                  }
                }
              } else if (mType === 0x03 || mType === 0x05) {
                const udpDl = applyDataDownlinkMacAndQueue(applyDownlinkPhyAnomalies(phyPayload), macDl);
                if (udpDl && udpDl.macCommands.length > 0) {
                  const tsu = new Date().toLocaleTimeString('zh-CN', { hour12: false });
                  console.log(
                    `[UDP ⬇ ${tsu}] PULL_RESP | ${udpDl.isConfirmed ? 'Confirmed' : 'Unconfirmed'} | DevAddr: ${udpDl.devAddr} | MAC: [${udpDl.macCommands.map((c) => c.name).join(', ')}]`
                  );
                }
              }
            }
          }
          
          const txAck = createTxAckPacket(gatewayEuiBuf, [tokenHi, tokenLo], 'NONE');
          socket.send(txAck, 0, txAck.length, lnsPort, lnsHost, (err) => {
            if (err) console.error('TX_ACK send failed:', err.message);
            else console.log('=> TX_ACK (NONE)');
          });
        } catch (e) {
          console.error('Error handling PULL_RESP:', e.message);
        }
      }
    });
  }

  const pullIntervalMs = Number(config.pullKeepaliveMs || 5000);
  let pullTimer = null;
  if (!mqttEnabled) {
    // MULTI-GW-PATCH: Support multi-gateway PULL_DATA
    function sendPull() {
      const multiGw = config.multiGateway;
      if (multiGw && multiGw.enabled && multiGw.gateways && multiGw.gateways.length > 0) {
        multiGw.gateways.forEach((gw, idx) => {
          const gwEuiBuf = euiStringToBuffer(gw.eui);
          const pull = createPullDataPacket(gwEuiBuf);
          socket.send(pull, 0, pull.length, lnsPort, lnsHost, (err) => {
            if (err) console.error(`[✗] PULL_DATA GW${idx} failed:`, err.message);
            else console.log(`[📡] PULL GW${idx}: ${gw.eui.slice(0,8)}...`);
          });
        });
      } else {
        // Original single gateway
        const pull = createPullDataPacket(gatewayEuiBuf);
        socket.send(pull, 0, pull.length, lnsPort, lnsHost, (err) => {
          if (err) console.error('PULL_DATA send failed:', err.message);
          else console.log('=> PULL_DATA');
        });
      }
    }
    sendPull();
    pullTimer = setInterval(sendPull, pullIntervalMs);
  }

  const statsCfg = config.stats || {};
  const statsEnabled = statsCfg.enabled !== false;
  const statsIntervalMs = Number(statsCfg.intervalMs || 60000);
  let statTimer;
  if (statsEnabled) {
    const sendStat = () => {
      const stat = { time: nowGoTime(), rxnb: 0, rxok: 0, rxfw: 0, ackr: 100.0, dwnb: 0, txnb: 0 };
      
      // MULTI-GW-PATCH: Send stats for all gateways in multi-gateway mode
      const multiGw = config.multiGateway;
      if (multiGw && multiGw.enabled && multiGw.gateways && multiGw.gateways.length > 0) {
        multiGw.gateways.forEach((gw, idx) => {
          const gwEuiBuf = euiStringToBuffer(gw.eui);
          if (!mqttEnabled) {
            const pkt = createPushStatPacket(gwEuiBuf, stat);
            socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
              if (err) console.error(`[✗] PUSH_DATA (stat) GW${idx} failed:`, err.message);
              else console.log(`[📊] Stats GW${idx}: ${gw.eui.slice(0,8)}...`);
            });
          } else {
            const topic = `${mqttTopicPrefix}/gateway/${gw.eui}/event/stats`;
            let payload;
            if (gwProto || mqttMarshaler === 'protobuf') {
              const GatewayStats = gwProto.lookupType('gw.GatewayStats');
              const now = new Date();
              const statsMsg = GatewayStats.create({
                gatewayId: gw.eui,
                time: { seconds: Math.floor(now.getTime() / 1000), nanos: (now.getTime() % 1000) * 1e6 },
                rxPacketsReceived: stat.rxnb,
                rxPacketsReceivedOk: stat.rxok,
                txPacketsReceived: stat.rxfw,
                txPacketsEmitted: stat.txnb,
              });
              payload = Buffer.from(GatewayStats.encode(statsMsg).finish());
            } else {
              payload = JSON.stringify({
                gatewayID: gw.eui,
                time: stat.time,
                rxPacketsReceived: stat.rxnb,
                rxPacketsReceivedOK: stat.rxok,
                txPacketsReceived: stat.rxfw,
                txPacketsEmitted: stat.txnb,
              });
            }
            mqttClient.publish(topic, payload, { qos: mqttCfg.qos || 0 }, (err) => {
              if (err) console.error(`[✗] Stats publish GW${idx} failed:`, err.message);
              else { statsCount++; console.log(`[📊] Stats #${statsCount} GW${idx}`); }
            });
          }
        });
      } else if (!mqttEnabled) {
        // Original single gateway stats
        const pkt = createPushStatPacket(gatewayEuiBuf, stat);
        socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
          if (err) console.error('PUSH_DATA (stat) send failed:', err.message);
          else console.log('=> PUSH_DATA stat');
        });
      } else {
        const topic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/event/stats`;
        let payload;
        if (gwProto || mqttMarshaler === 'protobuf') {
          const GatewayStats = gwProto.lookupType('gw.GatewayStats');
          const now = new Date();
          const statsMsg = GatewayStats.create({
            gatewayId: gatewayEuiBuf.toString('hex'),
            time: { seconds: Math.floor(now.getTime() / 1000), nanos: (now.getTime() % 1000) * 1e6 },
            rxPacketsReceived: stat.rxnb,
            rxPacketsReceivedOk: stat.rxok,
            txPacketsReceived: stat.rxfw,
            txPacketsEmitted: stat.txnb,
          });
          payload = Buffer.from(GatewayStats.encode(statsMsg).finish());
        } else {
          payload = JSON.stringify({
            gatewayID: gatewayEuiBuf.toString('hex'),
            time: stat.time,
            rxPacketsReceived: stat.rxnb,
            rxPacketsReceivedOK: stat.rxok,
            txPacketsReceived: stat.rxfw,
            txPacketsEmitted: stat.txnb,
          });
        }
        mqttClient.publish(topic, payload, { qos: mqttCfg.qos || 0 }, (err) => {
          if (err) console.error('[✗] Stats publish failed:', err.message);
          else { statsCount++; console.log(`[📊] Stats #${statsCount}`); }
        });
      }
    };
    sendStat();
    statTimer = setInterval(sendStat, statsIntervalMs);
  }

  const uplinkTimers = [];
  let motionEnvRuntime = null;

  function mergeUplinkCfg(base, override) {
    const merged = { ...(base || {}), ...(override || {}) };
    merged.rf = { ...((base && base.rf) || {}), ...((override && override.rf) || {}) };
    if (merged.codec === undefined) merged.codec = 'simple';
    if (merged.payloadLength === undefined) merged.payloadLength = 4;
    return merged;
  }

  function startUplinkScheduler(uplinkCfg, label, lorawanDevice, deviceIndex, totalDeviceCount) {
    if (!uplinkCfg || !uplinkCfg.enabled) return;
    const scatterWindowMs = (() => {
      const raw = (uplinkCfg.intervalMs !== undefined && uplinkCfg.intervalMs !== null)
        ? uplinkCfg.intervalMs
        : (uplinkCfg.interval !== undefined && uplinkCfg.interval !== null ? uplinkCfg.interval : 10000);
      return Number(raw);
    })();
    const scatterMode = String(uplinkCfg.scatterMode || 'random').toLowerCase();

    let sentCount = 0;

    function vizPayloadPreview(joinReq, b64, frmBytes) {
      try {
        if (joinReq && b64) return Buffer.from(b64, 'base64').toString('hex').slice(0, 48);
        if (frmBytes && Buffer.isBuffer(frmBytes)) return frmBytes.toString('hex').slice(0, 48);
      } catch (e) { /* ignore */ }
      return '';
    }

    function readIntervalMs() {
      const raw = (uplinkCfg.intervalMs !== undefined && uplinkCfg.intervalMs !== null)
        ? uplinkCfg.intervalMs
        : (uplinkCfg.interval !== undefined && uplinkCfg.interval !== null ? uplinkCfg.interval : 10000);
      return Number(raw);
    }

    const sendUplink = () => {
      if (!simulationRuntime.running) return;
      if (!uplinkCfg || uplinkCfg.enabled === false) return;
      const countLimit = Number(uplinkCfg.count || 0);
      if (countLimit > 0 && sentCount >= countLimit) return;
      const rf = uplinkCfg.rf || {};

      const confirmed = Boolean((uplinkCfg.lorawan && uplinkCfg.lorawan.confirmed) || false);
      const devEui = lorawanDevice ? (lorawanDevice.devEui ? lorawanDevice.devEui.toString('hex') : 'default') : 'default';

      const payloadFormat = uplinkCfg.payloadFormat || 'base64';
      const payload = uplinkCfg.payload || '';
      let base64Payload = toBase64FromHexOrBase64(payload, payloadFormat);
      const payloadLength = uplinkCfg.payloadLength ?? 4;
      const customBytes = getCustomFrmPayload(uplinkCfg);
      const bytes = customBytes !== null ? customBytes : generateSimplePayload(devEui, payloadLength);

      if (lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined) {
        let devNonce = Math.floor(Math.random() * 65536);
        if (
          lorawanDevice._forceDevNonce != null &&
          Number.isFinite(Number(lorawanDevice._forceDevNonce))
        ) {
          devNonce = Number(lorawanDevice._forceDevNonce) & 0xffff;
          console.log(`[ANOMALY] devnonce-repeat: DevNonce=${devNonce}`);
        }
        lorawanDevice.devNonce = devNonce;
        const phy = buildJoinRequest(lorawanDevice.appEui, lorawanDevice.devEui, devNonce, lorawanDevice.nwkKeyBuf || lorawanDevice.appKeyBuf);
console.log('[DEBUG] nwkKeyBuf:', lorawanDevice.nwkKeyBuf ? lorawanDevice.nwkKeyBuf.toString('hex') : 'null', 'appKeyBuf:', lorawanDevice.appKeyBuf ? lorawanDevice.appKeyBuf.toString('hex') : 'null');
        base64Payload = phy.toString('base64');
        // Keep only one pending entry per DevEUI to avoid stale / duplicate matches.
        const devEuiHex = lorawanDevice.devEui.toString('hex');
        for (let i = pendingOtaaDevices.length - 1; i >= 0; i--) {
          if (pendingOtaaDevices[i].devEui && pendingOtaaDevices[i].devEui.toString('hex') === devEuiHex) {
            pendingOtaaDevices.splice(i, 1);
          }
        }
        pendingOtaaDevices.push({
          nwkKeyBuf: lorawanDevice.nwkKeyBuf || lorawanDevice.appKeyBuf,
          appKeyBuf: lorawanDevice.appKeyBuf,
          appEui: lorawanDevice.appEui,
          devEui: lorawanDevice.devEui,
          devNonce,
          createdAt: Date.now(),
          otaaDevice: lorawanDevice
        });
        lorawanDevice.joinRetryCount = Number(lorawanDevice.joinRetryCount || 0) + 1;
        lorawanDevice.joinLastAttemptAt = Date.now();
        console.log(`[OTAA] Join Request sent | DevEUI: ${lorawanDevice.devEui.toString('hex')} | DevNonce: ${devNonce} `);
      } else if (lorawanDevice && (!lorawanDevice.isOtaa || lorawanDevice.joined)) {
        const fPort = Number((uplinkCfg.lorawan && uplinkCfg.lorawan.fPort) || 1);
        const devAddrHex = lorawanDevice.devAddrHex || lorawanDevice.devAddr.toString('hex');
        const macResponses = macDl.getMacResponses(devAddrHex);
        const needsAck = macResponses.needsAck || false;
        delete macResponses.needsAck;
        const uplinkMacReqs = [];
        if (Number(uplinkCfg.linkCheckInterval) > 0 && sentCount > 0 && sentCount % Number(uplinkCfg.linkCheckInterval) === 0) {
          uplinkMacReqs.push({ cid: 0x02, name: 'LinkCheckReq', payload: Buffer.alloc(0) });
        }
        const allMacCommands = uplinkMacReqs.length > 0 ? [...uplinkMacReqs, ...macResponses] : macResponses;
        if (allMacCommands.length > 15) allMacCommands.splice(15);
        const devAddrLE = lorawanDevice.devAddrHex ? Buffer.from(lorawanDevice.devAddr) : Buffer.from(lorawanDevice.devAddr).reverse();

        const useFcnt = lorawanDevice.duplicateNextFcnt ? Math.max(0, lorawanDevice.fCntUp - 1) : lorawanDevice.fCntUp;
        // Get keys from globalDeviceMap if available (for OTAA devices)
        const deviceFromMap = globalDeviceMap[devAddrHex];
        const useNwkSKey = (deviceFromMap && deviceFromMap.nwkSKey) ? deviceFromMap.nwkSKey : lorawanDevice.nwkSKey;
        const useAppSKey = (deviceFromMap && deviceFromMap.appSKey) ? deviceFromMap.appSKey : lorawanDevice.appSKey;
        
        console.log('[DEBUG] Uplink keys:', {
          devAddrHex,
          fromMap: deviceFromMap ? 'yes' : 'no',
          nwkSKey: useNwkSKey ? (Buffer.isBuffer(useNwkSKey) ? useNwkSKey.toString('hex').substring(0, 16) : useNwkSKey.substring(0, 16)) : 'null',
          fCntUp: useFcnt
        });
        
        const adr =
          lorawanDevice && typeof lorawanDevice.adr === 'boolean'
            ? lorawanDevice.adr
            : resolveLorawanAdrEnabled({}, lorawanCfg);
        const phy = buildLorawanUplinkAbp({
          nwkSKey: useNwkSKey,
          appSKey: useAppSKey,
          devAddr: devAddrLE,
          fCntUp: useFcnt,
          fPort,
          confirmed,
          payload: bytes,
          macCommands: allMacCommands,
          ackDownlink: needsAck,
          adr,
        });
        const MAX_FCNT = 65535;
        if (lorawanDevice.duplicateNextFcnt) delete lorawanDevice.duplicateNextFcnt;
        else {
          lorawanDevice.fCntUp = (lorawanDevice.fCntUp + 1) % (MAX_FCNT + 1);
          updateFCntForDevice(globalFCntState, lorawanDevice.devAddr, lorawanDevice.fCntUp);
        }
        base64Payload = Buffer.from(phy).toString('base64');
      } else {
        base64Payload = Buffer.from(bytes).toString('base64');
      }

      let chosenFreq = rf.freq || 868.1;
      let chanIndex = 0;
      const customChannels = Array.isArray(uplinkCfg.channels) ? uplinkCfg.channels : null;
      const region = uplinkCfg.region && REGIONS[uplinkCfg.region] ? REGIONS[uplinkCfg.region] : null;
      const randomChannel = Boolean(uplinkCfg.randomChannel);

      let pool = null;
      if (lorawanDevice && lorawanDevice.nodeState && lorawanDevice.nodeState.channels && lorawanDevice.nodeState.channels.length > 0) {
        pool = lorawanDevice.nodeState.channels;
      } else if (lorawanDevice && lorawanDevice.macParams && lorawanDevice.macParams.channels) {
        pool = lorawanDevice.macParams.channels;
      } else if (customChannels && customChannels.length > 0) {
        pool = customChannels;
      } else if (region) {
        pool = region.channels;
      }

      if (pool && pool.length > 0) {
        if (lorawanDevice && lorawanDevice.macParams && lorawanDevice.macParams.channelMask) {
          const enabledChannels = [];
          for (let i = 0; i < pool.length && i < 16; i++) {
            if (lorawanDevice.macParams.channelMask & (1 << i)) enabledChannels.push(pool[i]);
          }
          if (enabledChannels.length > 0) pool = enabledChannels;
        }
        if (randomChannel) chanIndex = Math.floor(Math.random() * pool.length);
        else chanIndex = sentCount % pool.length;
        chosenFreq = Number(pool[chanIndex]);
      }

      // 支持设备级dataRate配置
      // 优先级: 1. uplinkCfg.rf.dataRate (用户显式配置) > 2. macParams.dataRate (网络分配)
      let sf = rf.sf || 7;
      let deviceDataRate = null;
      
      // 首先检查设备级显式配置 (用于固定DR测试)
      if (uplinkCfg && uplinkCfg.rf && uplinkCfg.rf.dataRate !== undefined) {
        deviceDataRate = uplinkCfg.rf.dataRate;
        console.log(`[DEBUG] Device ${lorawanDevice && lorawanDevice.devEui ? lorawanDevice.devEui.toString('hex').slice(-4) : 'unknown'} using FIXED dataRate ${deviceDataRate}`);
      } 
      // 否则使用网络分配的dataRate (ADR)
      else if (lorawanDevice && lorawanDevice.macParams && lorawanDevice.macParams.dataRate !== undefined) {
        deviceDataRate = lorawanDevice.macParams.dataRate;
        console.log(`[DEBUG] Device ${lorawanDevice && lorawanDevice.devEui ? lorawanDevice.devEui.toString('hex').slice(-4) : 'unknown'} using ADR dataRate ${deviceDataRate}`);
      }
      
      if (deviceDataRate !== null) {
        const drToSf = [12, 11, 10, 9, 8, 7];
        if (deviceDataRate >= 0 && deviceDataRate <= 5) sf = drToSf[deviceDataRate];
        console.log(`[DEBUG] -> SF${sf}`);
      }

      let motionAdj = null;
      if (motionEnvRuntime && lorawanDevice) {
        motionAdj = applyMotionEnvironmentBeforeSignal(motionEnvRuntime, lorawanDevice, config);
      }

      // ====== 真实信号模型集成 ======
      let rssi, lsnr, rssiStd;
      /** When anomaly injects signalOverride (e.g. signal-weak), multi-GW paths must not replace RSSI/SNR with per-gateway geometry (would look “strong” again). */
      let anomalyRfOverrideActive = false;

      const useRealisticSignalModel =
        config.signalModel &&
        config.signalModel.enabled &&
        lorawanDevice &&
        !(config.multiGateway && config.multiGateway.enabled);

      // 尝试使用真实信号模型
      if (useRealisticSignalModel) {
        const deviceIndex = lorawanDevice._deviceIndex || 0;
        const totalDevices = lorawanDevice._totalDevices || 1;
        const devicePosition = lorawanDevice && lorawanDevice.position;
        const cfgForSignal =
          motionAdj && motionAdj.signalModelEnvironment
            ? {
                ...config,
                signalModel: { ...config.signalModel, environment: motionAdj.signalModelEnvironment },
              }
            : config;
        const signalResult = calculateRealisticSignal(
          deviceIndex,
          totalDevices,
          { frequency: chosenFreq * 1000000 },
          cfgForSignal,
          Date.now(),
          devicePosition
        );
        rssi = signalResult.rssi;
        lsnr = signalResult.snr;
        rssiStd = signalResult.rssiStd;
        
        // 保存到设备状态用于后续抖动计算
        if (lorawanDevice.nodeState) {
          lorawanDevice.nodeState.lastRssi = rssi;
          lorawanDevice.nodeState.lastSnr = lsnr;
        }
      } else {
        // 原有逻辑 (向后兼容)
        rssi = rf.rssi ?? -42;
        lsnr = rf.lsnr ?? 5.5;
        
        if (lorawanDevice && lorawanDevice.nodeState) {
          const ns = lorawanDevice.nodeState;
          const jitterR = (ns.rssiJitter !== undefined ? ns.rssiJitter : 1.5) * (2 * Math.random() - 1);
          const jitterS = (ns.snrJitter !== undefined ? ns.snrJitter : 0.8) * (2 * Math.random() - 1);
          let baseRssi = (ns.lastRssi !== undefined ? ns.lastRssi : ns.rssi) + jitterR;
          if (lorawanDevice.macParams && lorawanDevice.macParams.txPower !== undefined) {
            const currentDbm = TX_POWER_DBM_AS923[lorawanDevice.macParams.txPower] ?? 14;
            const initialDbm = TX_POWER_DBM_AS923[ns.txPowerIndex] ?? 14;
            baseRssi += (currentDbm - initialDbm);
          }
          rssi = clamp(baseRssi, -120, 10);
          lsnr = Math.max(-20, Math.min(10, (ns.lastSnr !== undefined ? ns.lastSnr : ns.snr) + jitterS));
          ns.lastRssi = rssi;
          ns.lastSnr = lsnr;
        }
      }
      if (motionAdj && motionAdj.envRssiAdjust && !useRealisticSignalModel) {
        rssi = clamp((rssi ?? -80) + motionAdj.envRssiAdjust, -140, 10);
      }
      // ====== 信号模型集成结束 ======


      const dropRatio = Number(uplinkCfg.uplinkDropRatio || 0);
      if (dropRatio > 0 && Math.random() < dropRatio) {
        sentCount += 1;
        return;
      }


      // ====== 异常注入检查 ======
      if (lorawanDevice && lorawanDevice.anomaly && lorawanDevice.anomaly.enabled) {
        const anomalyResult = injectAnomaly(lorawanDevice, base64Payload, lorawanDevice.fCntUp, sentCount);
        if (anomalyResult.modified && anomalyResult.payload) {
          const mod = anomalyResult.payload;
          base64Payload = Buffer.isBuffer(mod) ? mod.toString('base64') : Buffer.from(mod).toString('base64');
          console.log(`[ANOMALY] ${lorawanDevice.anomaly.scenario} triggered for ${lorawanDevice.name || lorawanDevice.devEui.toString('hex')}`);
        }
        if (anomalyResult.dropUplink) {
          console.log(`[ANOMALY] Uplink dropped for ${lorawanDevice.name || lorawanDevice.devEui.toString('hex')}`);
          sentCount += 1;
          scheduleNextSend();
          return;
        }
        if (anomalyResult.signalOverride) {
          const so = anomalyResult.signalOverride;
          // 契约：先 offset 再绝对值覆盖；frequency(MHz)/dataRate(0–5) 作用于 rxpk（见 docs/ANOMALY_RESPONSE.md）
          if (so.rssiOffset != null && Number.isFinite(Number(so.rssiOffset))) {
            rssi = (rssi ?? -80) + Number(so.rssiOffset);
          }
          if (so.snrOffset != null && Number.isFinite(Number(so.snrOffset))) {
            lsnr = (lsnr ?? 5) + Number(so.snrOffset);
          }
          if (so.rssi != null && Number.isFinite(Number(so.rssi))) rssi = Number(so.rssi);
          if (so.snr != null && Number.isFinite(Number(so.snr))) lsnr = Number(so.snr);
          if (so.frequency != null && Number.isFinite(Number(so.frequency))) {
            chosenFreq = Number(so.frequency);
          }
          if (so.dataRate != null && Number.isFinite(Number(so.dataRate))) {
            const dr = Number(so.dataRate);
            const drToSf = [12, 11, 10, 9, 8, 7];
            if (dr >= 0 && dr <= 5) sf = drToSf[dr];
          }
          rssi = clamp(rssi ?? -80, -140, 10);
          lsnr = Math.max(-25, Math.min(15, lsnr ?? 5));
          anomalyRfOverrideActive = true;
          console.log(
            `[ANOMALY] RF metadata override RSSI=${rssi} SNR=${lsnr} freqMHz=${chosenFreq} SF=${sf}`
          );
        }
      }
      // ====== 异常注入结束 ======

      if (
        lorawanDevice &&
        lorawanDevice._gatewayOffline &&
        lorawanDevice._gatewayOfflineUntil != null &&
        Date.now() < lorawanDevice._gatewayOfflineUntil
      ) {
        console.log(
          `[ANOMALY] gateway-offline: suppressing uplink for ${lorawanDevice.name || lorawanDevice.devEui.toString('hex')}`
        );
        sentCount += 1;
        scheduleNextSend();
        return;
      }

      const rxpk = buildRxpk({
        freq: chosenFreq,
        sf,
        bw: rf.bw || 125,
        codr: rf.codr || '4/5',
        rssi,
        lsnr,
        base64Payload,
        chan: chanIndex,
      });

      if (!mqttEnabled) {
        // ====== UDP 模式多网关支持 ======
        if (config.multiGateway && config.multiGateway.enabled) {
          const safeDeviceIndex = Number.isFinite(Number(deviceIndex))
            ? Number(deviceIndex)
            : (lorawanDevice && Number.isFinite(Number(lorawanDevice._deviceIndex)) ? Number(lorawanDevice._deviceIndex) : 0);
          const effectiveDevice = lorawanDevice || { name: label || `device-${safeDeviceIndex + 1}` };
          const devicePos = (effectiveDevice && effectiveDevice.position) || {
            x: (safeDeviceIndex % 3) * 500,
            y: (safeDeviceIndex % 2) * 300,
            z: 2
          };
          
          const multiGwConfig = config.multiGateway;
          const freqHz = Math.round(Number(chosenFreq) * 1e6);
          const receptions = multiGwConfig.gateways.map(gw => {
            const signal = calculateGatewayReceptionForDevice(effectiveDevice, devicePos, gw, config, freqHz);
            return { eui: gw.eui, name: gw.name, ...signal };
          }).filter(r => r.canReceive);

          const selected = pickMultiGwReceivers(receptions, multiGwConfig);
          
          if (selected.length > 0) {
            console.log(`[Multi-GW UDP] ${(effectiveDevice && effectiveDevice.name) || safeDeviceIndex}: ${selected.length} gateway(s)`);
            let pendingUdp = selected.length;
            const okSignals = [];
            const isJoinPending = lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined;
            selected.forEach(gw => {
              const gwEuiBuf = euiStringToBuffer(gw.eui);
              const effRssi = anomalyRfOverrideActive ? Math.round(rssi) : Math.round(gw.rssi);
              const effSnr = anomalyRfOverrideActive ? lsnr : gw.snr;
              const rxpkWithSignal = { ...rxpk, rssi: effRssi, lsnr: effSnr };
              const pkt = createPushDataPacket(gwEuiBuf, [rxpkWithSignal]);
              socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
                if (err) console.error(`[✗] UDP MGW ${gw.eui} failed:`, err.message);
                else {
                  console.log(`[Multi-GW UDP] Sent to ${gw.eui}: RSSI=${effRssi}`);
                  okSignals.push({ rssi: effRssi, snr: effSnr });
                }
                pendingUdp--;
                if (pendingUdp === 0 && okSignals.length > 0) {
                  const best = okSignals.reduce((a, b) => (a.rssi >= b.rssi ? a : b));
                  if (lorawanDevice) {
                    recordVisualizerAfterUplink(lorawanDevice, label, best.rssi, best.snr, {
                      countTx: !isJoinPending,
                      sf,
                      payloadPreview: vizPayloadPreview(isJoinPending, base64Payload, bytes),
                      gatewayReceptions: selected.map((g) => ({
                        gatewayEui: g.eui,
                        rssi: g.rssi,
                        snr: g.snr,
                        distance: g.distance,
                        pathLoss: g.pathLoss
                      }))
                    });
                  }
                }
              });
            });
          } else {
            console.log(`[Multi-GW UDP] No gateway can receive from ${(effectiveDevice && effectiveDevice.name) || safeDeviceIndex}`);
          }
        } else {
          // 原有单网关发送
          const pkt = createPushDataPacket(gatewayEuiBuf, [rxpk]);
          const isJoinPending = lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined;
          socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
            if (err) console.error('PUSH_DATA send failed:', err.message);
            else {
              console.log('=> PUSH_DATA', label ? `[${label}]` : '', 'size', rxpk.size);
              recordVisualizerAfterUplink(lorawanDevice, label, rssi, lsnr, {
                countTx: !isJoinPending,
                sf,
                payloadPreview: vizPayloadPreview(isJoinPending, base64Payload, bytes),
                gatewayReceptions: [{
                  gatewayEui: gatewayEuiBuf.toString('hex'),
                  rssi,
                  snr: lsnr
                }]
              });
            }
          });
        }
        // ====== UDP 多网关结束 ======
      } else {
        const topic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/event/up`;
        const bwHz = Number(rf.bw || 125) * 1000;
        let payloadOut;
        console.log('[DEBUG] mqttMarshaler value:', mqttMarshaler);
        if (gwProto || mqttMarshaler === 'protobuf') {
          const UplinkFrame = gwProto.lookupType('gw.UplinkFrame');
          const phyPayloadBuf = Buffer.from(base64Payload, 'base64');
          const now = new Date();
          const uplinkMsg = UplinkFrame.create({
            phyPayload: phyPayloadBuf,
            txInfo: {
              frequency: Math.round(Number(rxpk.freq) * 1e6),
              modulation: {
                lora: {
                  bandwidth: bwHz,
                  spreadingFactor: Number(sf),
                  codeRate: mapCodeRateStringToEnum(rf.codr || '4/5'),
                  polarizationInversion: false,
                },
              },
            },
            rxInfo: {
              gatewayId: gatewayEuiBuf.toString('hex'),
              uplinkId: Math.floor(Math.random() * 0xffffffff),
              gwTime: { seconds: Math.floor(now.getTime() / 1000), nanos: (now.getTime() % 1000) * 1e6 },
              rssi: rxpk.rssi,
              snr: rxpk.lsnr,
              channel: rxpk.chan,
              rfChain: 0,
              board: 0,
              antenna: 0,
              context: Buffer.alloc(0),
              crcStatus: 2,
            },
          });
          payloadOut = Buffer.from(UplinkFrame.encode(uplinkMsg).finish());
        } else {
          payloadOut = JSON.stringify({
            gatewayID: gatewayEuiBuf.toString('hex'),
            uplinkID: Buffer.from(crypto.randomBytes(8)).toString('base64'),
            phyPayload: base64Payload,
            rxInfo: [{
              gatewayID: gatewayEuiBuf.toString('hex'),
              uplinkID: Buffer.from(crypto.randomBytes(8)).toString('base64'),
              name: 'gateway-1',
              time: rxpk.time,
              rssi: rxpk.rssi,
              loRaSNR: rxpk.lsnr,
              channel: rxpk.chan,
              rfChain: 0,
              board: 0,
              antenna: 0,
              location: { latitude: 0, longitude: 0, altitude: 0, source: 'UNKNOWN' }
            }],
            txInfo: {
              frequency: Math.round(Number(rxpk.freq) * 1e6),
              modulation: 'LORA',
              loRaModulationInfo: {
                bandwidth: bwHz,
                spreadingFactor: Number(sf),
                codeRate: rf.codr || '4/5',
              },
            }
          });
        }
      // ====== 多网关发送逻辑 (Fixed) ======
      if (config.multiGateway && config.multiGateway.enabled) {
        const deviceIndex = lorawanDevice._deviceIndex || 0;
        const totalDevices = lorawanDevice._totalDevices || 1;
        const devicePos = lorawanDevice.position || { x: (deviceIndex % 3) * 500, y: (deviceIndex % 2) * 300, z: 2 };
        
        // 计算各网关接收情况
        const multiGwConfig = config.multiGateway;
        const freqHzMqtt = Math.round(Number(chosenFreq) * 1e6);
        const receptions = multiGwConfig.gateways.map(gw => {
          const signal = calculateGatewayReceptionForDevice(lorawanDevice, devicePos, gw, config, freqHzMqtt);
          return { eui: gw.eui, name: gw.name, ...signal };
        }).filter(r => r.canReceive);

        const selected = pickMultiGwReceivers(receptions, multiGwConfig);
        
        if (selected.length > 0) {
          console.log(`[Multi-GW] ${lorawanDevice.name || deviceIndex}: ${selected.length} gateway(s) - ${selected.map(g => g.name).join(', ')}`);
          let pendingMgw = selected.length;
          const okSignalsMgw = [];
          const isJoinPendingMgw = lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined;
          selected.forEach(gw => {
            const gwTopic = `${mqttTopicPrefix}/gateway/${gw.eui}/event/up`;
            const effRssiMg = anomalyRfOverrideActive ? Math.round(rssi) : Math.round(gw.rssi);
            const effSnrMg = anomalyRfOverrideActive ? lsnr : gw.snr;
            const rxpkWithSignal = { ...rxpk, rssi: effRssiMg, lsnr: effSnrMg, loRaSNR: effSnrMg };
            const gwPayload = encodeUplinkPayload(rxpkWithSignal, mqttMarshaler, gwProto);
            mqttClient.publish(gwTopic, gwPayload, { qos: mqttCfg.qos || 0 }, (err) => {
              if (err) console.error(`[✗] MGW ${gw.eui} failed:`, err.message);
              else {
                console.log(`[Multi-GW] Sent to ${gw.eui}: RSSI=${effRssiMg}`);
                okSignalsMgw.push({ rssi: effRssiMg, snr: effSnrMg });
              }
              pendingMgw--;
              if (pendingMgw === 0 && okSignalsMgw.length > 0) {
                const best = okSignalsMgw.reduce((a, b) => (a.rssi >= b.rssi ? a : b));
                recordVisualizerAfterUplink(lorawanDevice, label, best.rssi, best.snr, {
                  countTx: !isJoinPendingMgw,
                  sf,
                  payloadPreview: vizPayloadPreview(isJoinPendingMgw, base64Payload, bytes),
                  gatewayReceptions: selected.map((g) => ({
                    gatewayEui: g.eui,
                    rssi: g.rssi,
                    snr: g.snr,
                    distance: g.distance,
                    pathLoss: g.pathLoss
                  }))
                });
                if (lorawanDevice && mqttEnabled && !isJoinPendingMgw) {
                  const devAddr = lorawanDevice.devAddr ? lorawanDevice.devAddr.toString('hex').toUpperCase() : 'N/A';
                  const devEuiUp = lorawanDevice.devEui.toString('hex').toUpperCase();
                  const fCnt = Math.max(0, (lorawanDevice.fCntUp || 0) - 1);
                  trackUplinkSent(gwPayload, devAddr, devEuiUp, fCnt, confirmed, (uplinkCfg.lorawan && uplinkCfg.lorawan.fPort) || 1);
                }
              }
            });
          });
          sentCount += 1; scheduleNextSend(); return;
        } else {
          console.log(`[Multi-GW] No gateway can receive from ${lorawanDevice.name || deviceIndex}`);
          sentCount += 1; scheduleNextSend(); return;
        }
      }
      // ====== 多网关逻辑结束 ======
      // ====== 多网关发送逻辑 ======
      if (config.multiGateway && config.multiGateway.enabled) {
        const mgwResult = sendUplinkWithMultiGateway(
          base64Payload, lorawanDevice, 
          lorawanDevice._deviceIndex || 0, 
          lorawanDevice._totalDevices || 1,
          config, mqttClient
        );
        
        if (mgwResult && mgwResult.length > 0) {
          let pendingMgw2 = mgwResult.length;
          const okSignalsMgw2 = [];
          const isJoinPendingMgw2 = lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined;
          mgwResult.forEach(gw => {
            const gwTopic = `${mqttTopicPrefix}/gateway/${gw.eui}/event/up`;
            const effRssi2 = anomalyRfOverrideActive ? Math.round(rssi) : Math.round(gw.rssi);
            const effSnr2 = anomalyRfOverrideActive ? lsnr : gw.snr;
            const rxpkWithSignal = {
              ...rxpk,
              rssi: effRssi2,
              lsnr: effSnr2,
              loRaSNR: effSnr2
            };
            const gwPayload = encodeUplinkPayload(rxpkWithSignal, mqttMarshaler, gwProto);
            
            mqttClient.publish(gwTopic, gwPayload, { qos: mqttCfg.qos || 0 }, (err) => {
              if (err) console.error(`[✗] MGW publish to ${gw.eui} failed:`, err.message);
              else {
                console.log(`[Multi-GW] Sent to ${gw.name || gw.eui}: RSSI=${effRssi2}, SNR=${effSnr2}`);
                okSignalsMgw2.push({ rssi: effRssi2, snr: effSnr2 });
              }
              pendingMgw2--;
              if (pendingMgw2 === 0 && okSignalsMgw2.length > 0) {
                const best = okSignalsMgw2.reduce((a, b) => (a.rssi >= b.rssi ? a : b));
                recordVisualizerAfterUplink(lorawanDevice, label, best.rssi, best.snr, {
                  countTx: !isJoinPendingMgw2,
                  sf,
                  payloadPreview: vizPayloadPreview(isJoinPendingMgw2, base64Payload, bytes),
                  gatewayReceptions: mgwResult.map((g) => ({
                    gatewayEui: g.eui,
                    rssi: g.rssi,
                    snr: g.snr,
                    distance: g.distance,
                    pathLoss: g.pathLoss
                  }))
                });
                if (lorawanDevice && mqttEnabled && !isJoinPendingMgw2) {
                  const devAddr = lorawanDevice.devAddr ? lorawanDevice.devAddr.toString('hex').toUpperCase() : 'N/A';
                  const devEuiUp = lorawanDevice.devEui.toString('hex').toUpperCase();
                  const fCnt = Math.max(0, (lorawanDevice.fCntUp || 0) - 1);
                  trackUplinkSent(gwPayload, devAddr, devEuiUp, fCnt, confirmed, (uplinkCfg.lorawan && uplinkCfg.lorawan.fPort) || 1);
                }
              }
            });
          });
          
          sentCount += 1;
          scheduleNextSend();
          return; // 跳过后续单网关发送
        } else if (mgwResult && mgwResult.length === 0) {
          console.log(`[Multi-GW] No gateway can receive from ${lorawanDevice.name || 'device'}`);
          sentCount += 1;
          scheduleNextSend();
          return;
        }
      }
      // ====== 多网关逻辑结束 ======

        mqttClient.publish(topic, payloadOut, { qos: mqttCfg.qos || 0 }, (err) => {
          if (err) console.error('[✗] Uplink publish failed:', err.message);
          else {
            const isJoinPending = lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined;
            recordVisualizerAfterUplink(lorawanDevice, label, rssi, lsnr, {
              countTx: !isJoinPending,
              sf,
              payloadPreview: vizPayloadPreview(isJoinPending, base64Payload, bytes),
              gatewayReceptions: [{
                gatewayEui: gatewayEuiBuf.toString('hex'),
                rssi,
                snr: lsnr
              }]
            });
            if (lorawanDevice && mqttEnabled && !isJoinPending) {
              const devAddr = lorawanDevice.devAddr ? lorawanDevice.devAddr.toString('hex').toUpperCase() : 'N/A';
              const devEuiUp = lorawanDevice.devEui.toString('hex').toUpperCase();
              const fCnt = Math.max(0, (lorawanDevice.fCntUp || 0) - 1);
              trackUplinkSent(payloadOut, devAddr, devEuiUp, fCnt, confirmed, (uplinkCfg.lorawan && uplinkCfg.lorawan.fPort) || 1);
            }
          }
        });
      }
      if (lorawanDevice && lorawanDevice.joined && sentCount === 0 && (uplinkCfg.duplicateFirstData || (lorawanDevice.duplicateFirstData))) lorawanDevice.duplicateNextFcnt = true;
      sentCount += 1;
    };

    const scheduleNextSend = () => {
      if (!uplinkCfg || uplinkCfg.enabled === false) return;
      const intervalMs = readIntervalMs();
      const joinRetryIntervalMs = Math.max(1000, Number(uplinkCfg.joinRetryIntervalMs ?? 5000));
      const joinRetryMaxAttempts = Math.max(1, Number(uplinkCfg.joinRetryMaxAttempts ?? 3));
      const burstCount = Number(uplinkCfg.burstCount || 0);
      const burstIntervalMs = Number(uplinkCfg.burstIntervalMs || 0);
      const silenceAfterBurstMs = Number(uplinkCfg.silenceAfterBurstMs || 0);
      const intervalAfterFirstDataMs = Number(uplinkCfg.intervalAfterFirstDataMs || 0);
      let nextDelay;
      // If OTAA join just failed, retry quickly instead of waiting a full uplink interval.
      if (lorawanDevice && lorawanDevice.isOtaa && !lorawanDevice.joined) {
        const attempts = Number(lorawanDevice.joinRetryCount || 0);
        if (attempts >= 1 && attempts <= joinRetryMaxAttempts) {
          nextDelay = joinRetryIntervalMs;
        }
      }
      if (nextDelay === undefined && sentCount === 1 && intervalAfterFirstDataMs > 0 && lorawanDevice && lorawanDevice.joined) {
        nextDelay = Math.max(50, intervalAfterFirstDataMs);
      } else if (nextDelay === undefined && burstCount > 0 && burstIntervalMs > 0 && silenceAfterBurstMs > 0) {
        nextDelay = (sentCount > 0 && sentCount % burstCount === 0) ? silenceAfterBurstMs : burstIntervalMs;
        nextDelay = Math.max(50, nextDelay);
      } else if (nextDelay === undefined) {
        const jitterRatio = uplinkCfg.jitterRatio !== undefined ? Number(uplinkCfg.jitterRatio) : 0.05;
        const maxJitterMs = Math.max(0, Math.floor(intervalMs * jitterRatio));
        const jitter = maxJitterMs > 0 ? (Math.floor(Math.random() * (2 * maxJitterMs + 1)) - maxJitterMs) : 0;
        nextDelay = Math.max(50, intervalMs + jitter);
      }
      const timer = setTimeout(() => {
        sendUplink();
        scheduleNextSend();
      }, nextDelay);
      uplinkTimers.push({ clear: () => clearTimeout(timer) });
    };

    let initialDelay;
    if (scatterMode === 'uniform' && totalDeviceCount > 0) {
      const slot = scatterWindowMs / totalDeviceCount;
      const jitter = Math.min(slot * 0.2, 200);
      initialDelay = Math.floor(slot * deviceIndex + Math.random() * jitter);
    } else {
      initialDelay = Math.floor(Math.random() * scatterWindowMs);
    }
    setTimeout(() => {
      sendUplink();
      scheduleNextSend();
    }, initialDelay);
    if (lorawanDevice && lorawanDevice.isOtaa && Number(uplinkCfg.rejoinIntervalMs) >= 1000) {
      const rejoinMs = Number(uplinkCfg.rejoinIntervalMs);
      const rejoinTimer = setInterval(() => {
        if (typeof resetLorawanDevice === 'function') resetLorawanDevice(lorawanDevice);
      }, rejoinMs);
      uplinkTimers.push({ clear: () => clearInterval(rejoinTimer) });
    }
  }

  globalFCntState = loadFCntState();

  const devices = Array.isArray(config.devices) ? config.devices : [];
  const globalUplink = config.uplink || {};
  if (globalUplink && globalUplink.codec === undefined) globalUplink.codec = 'simple';
  if (globalUplink && globalUplink.payloadLength === undefined) globalUplink.payloadLength = 4;
  const lorawanCfg = config.lorawan || {};
  const isAbp = String(lorawanCfg.activation || 'ABP').toUpperCase() === 'ABP';
  const classC = String(lorawanCfg.class || 'C').toUpperCase() === 'C';
  const deviceCount = Number(lorawanCfg.deviceCount || 0);
  const autoDevices = [];

  if (lorawanCfg.enabled && lorawanCfg.csvImportPath) {
    try {
      const csvPath = path.isAbsolute(lorawanCfg.csvImportPath)
        ? lorawanCfg.csvImportPath
        : path.join(process.cwd(), lorawanCfg.csvImportPath);
      const csvContent = fs.readFileSync(csvPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim().length > 0);
      const maxDevices = deviceCount > 0 ? deviceCount : lines.length - 1;
      const seenDevices = new Set();
      const seenDevEuiHex = new Set();
      const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
      const macParamsDefault = { maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000, dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6] };

      for (let i = 1; i < lines.length && autoDevices.length < maxDevices; i++) {
        const parts = lines[i].split(',');
        const joinMode = (parts[0] || '').trim().toUpperCase();
        const deviceName = (parts[2] || `device-${i}`).trim();
        if (seenDevices.has(deviceName)) continue;

        if (joinMode === 'OTAA' && parts.length >= 7) {
          const appEuiStr = (parts[4] || '').trim();
          const devEuiStr = (parts[5] || '').trim();
          const appKeyStr = (parts[6] || '').trim();
          if (!appEuiStr || !devEuiStr || !appKeyStr) continue;
          const appEui = hexToBufLen(appEuiStr, 8);
          const devEui = hexToBufLen(devEuiStr, 8);
          const devEuiHex = devEui.toString('hex').toLowerCase();
          if (seenDevEuiHex.has(devEuiHex)) continue;
          const appKeyBuf = hexToBufLen(appKeyStr, 16);
          const otaaDevice = {
            isOtaa: true,
            appEui,
            devEui,
            appKey: appKeyStr,
            appKeyBuf,
            nwkKeyBuf: appKeyBuf,
            devNonce: Math.floor(Math.random() * 65535),
            joined: false,
            macParams: { ...macParamsDefault },
            adr: resolveLorawanAdrEnabled({}, lorawanCfg),
          };
          initNodeState(autoDevices.length, otaaDevice, lorawanCfg, globalUplink, regionChannels);
          otaaDevice._vizLabel = deviceName;
          seenDevices.add(deviceName);
          seenDevEuiHex.add(devEuiHex);
          autoDevices.push({ name: deviceName, lorawanDevice: otaaDevice, uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}) });
          continue;
        }

        if (joinMode === 'ABP' && parts.length >= 9) {
          const has10Col = parts.length >= 10;
          const devEuiStr = (has10Col ? parts[5] : parts[4]).trim();
          const devAddrStr = (has10Col ? parts[7] : parts[6]).trim();
          const appSKeyStr = (has10Col ? parts[8] : parts[7]).trim();
          const nwkSKeyStr = (has10Col ? parts[9] : parts[8]).trim();
          const devEui = hexToBufLen(devEuiStr, 8);
          const devAddr = hexToBufLen(devAddrStr, 4);
          const appSKey = hexToBufLen(appSKeyStr, 16);
          const nwkSKey = hexToBufLen(nwkSKeyStr, 16);
          const fCntUp = getFCntForDevice(globalFCntState, devAddr);
          const lorawanDevice = {
            devAddr,
            nwkSKey,
            appSKey,
            devEui,
            fCntUp,
            classC,
            macParams: { ...macParamsDefault },
            adr: resolveLorawanAdrEnabled({}, lorawanCfg),
          };
          initNodeState(autoDevices.length, lorawanDevice, lorawanCfg, globalUplink, regionChannels);
          globalDeviceMap[devAddr.toString('hex')] = lorawanDevice;
          seenDevices.add(deviceName);
          autoDevices.push({ name: deviceName, lorawanDevice, uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}) });
        }
      }
      // CSV mode also merges config.devices OTAA entries (dedupe by DevEUI),
      // so nodes created via UI can send uplinks after process restart.
      if (Array.isArray(config.devices) && config.devices.length > 0) {
        for (let i = 0; i < config.devices.length; i++) {
          const d = config.devices[i];
          if (!d || d.enabled === false) continue;
          const act = (d.lorawan && d.lorawan.activation) || d.activation || 'OTAA';
          if (act !== 'OTAA') continue;
          const devEuiStr = d?.lorawan?.devEui ? String(d.lorawan.devEui).trim() : '';
          const appEuiStr = d?.lorawan?.appEui ? String(d.lorawan.appEui).trim() : '';
          const appKeyStr = d?.lorawan?.appKey ? String(d.lorawan.appKey).trim() : '';
          if (!/^[a-fA-F0-9]{16}$/.test(devEuiStr) || !/^[a-fA-F0-9]{16}$/.test(appEuiStr) || !/^[a-fA-F0-9]{32}$/.test(appKeyStr)) {
            continue;
          }
          const devEuiHex = devEuiStr.toLowerCase();
          if (seenDevEuiHex.has(devEuiHex)) continue;
          const appEui = hexToBufLen(appEuiStr, 8);
          const devEui = hexToBufLen(devEuiStr, 8);
          const appKeyBuf = hexToBufLen(appKeyStr, 16);
          const nwkKeyStr = (d.lorawan && d.lorawan.nwkKey) ? String(d.lorawan.nwkKey).trim() : appKeyStr;
          const nwkKeyBuf = hexToBufLen(nwkKeyStr, 16);
          const otaaDevice = {
            isOtaa: true,
            appEui,
            devEui,
            appKey: appKeyStr,
            appKeyBuf,
            nwkKeyBuf,
            devNonce: 0,
            joined: false,
            macParams: { ...macParamsDefault },
            adr: resolveLorawanAdrEnabled(d, lorawanCfg),
          };
          if (d.adrReject) otaaDevice.adrReject = true;
          if (d.devStatus) otaaDevice.devStatus = d.devStatus;
          if (d.duplicateFirstData) otaaDevice.duplicateFirstData = true;
          if (d.lorawan && d.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(d.lorawan.dataRate);
          if (d.position && typeof d.position === 'object') {
            otaaDevice.position = {
              x: Number(d.position.x) || 0,
              y: Number(d.position.y) || 0,
              z: d.position.z != null ? Number(d.position.z) : 2,
            };
          } else if (d.location && typeof d.location === 'object') {
            otaaDevice.position = {
              x: Number(d.location.x) || 0,
              y: Number(d.location.y) || 0,
              z: d.location.z != null ? Number(d.location.z) : 2,
            };
          }
          if (d.anomaly) otaaDevice.anomaly = d.anomaly;
          otaaDevice._vizLabel = d.name || `config-otaa-${i + 1}`;
          initNodeState(autoDevices.length, otaaDevice, lorawanCfg, globalUplink, regionChannels, d.nodeState);
          autoDevices.push({
            name: d.name || `config-otaa-${i + 1}`,
            lorawanDevice: otaaDevice,
            uplink: mergeUplinkCfg(globalUplink, d.uplink || {}),
          });
          seenDevEuiHex.add(devEuiHex);
        }
      }
      const abpCount = autoDevices.filter(d => !d.lorawanDevice.isOtaa).length;
      const otaaCount = autoDevices.filter(d => d.lorawanDevice.isOtaa).length;
      console.log(`[✅] 从CSV/Config加载 ${autoDevices.length} 个设备 (ABP: ${abpCount}, OTAA: ${otaaCount})`);
    } catch (e) {
      console.error('[✗] CSV导入失败:', e.message);
    }
  } else if (lorawanCfg.enabled && Array.isArray(config.devices) && config.devices.length > 0 && config.devices.some(d => d.lorawan || d.activation)) {
    const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
    const macParamsDefault = { maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000, dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6] };
    const appKeyDefault = (lorawanCfg.appKey && lorawanCfg.appKey.trim()) ? lorawanCfg.appKey.trim() : '';
    const appEuiBase = (lorawanCfg.appEuiStart || lorawanCfg.appEui || '0000000000000001').toString().trim();
    const devEuiBase = (lorawanCfg.devEuiStart || lorawanCfg.devEui || '0102030405060701').toString().trim();
    for (let i = 0; i < config.devices.length; i++) {
      const d = config.devices[i];
      if (!d || d.enabled === false) continue;
      const act = (d.lorawan && d.lorawan.activation) || d.activation || 'OTAA';
      if (act !== 'OTAA') continue;
      const appEui = (d.lorawan && d.lorawan.appEui) ? hexToBufLen(String(d.lorawan.appEui).trim(), 8) : genSequentialDevEui(appEuiBase, i);
      const devEui = (d.lorawan && d.lorawan.devEui) ? hexToBufLen(String(d.lorawan.devEui).trim(), 8) : genSequentialDevEui(devEuiBase, i);
      const appKey = (d.lorawan && d.lorawan.appKey) ? String(d.lorawan.appKey).trim() : appKeyDefault;
      if (!appKey) continue;
      const appKeyBuf = hexToBufLen(appKey, 16);
      // 对于LoRaWAN 1.0.x，nwkKey和appKey相同；对于1.1，可以分开配置
      const nwkKey = (d.lorawan && d.lorawan.nwkKey) ? String(d.lorawan.nwkKey).trim() : appKey;
      const nwkKeyBuf = hexToBufLen(nwkKey, 16);
      const otaaDevice = {
        isOtaa: true,
        appEui,
        devEui,
        appKey,
        appKeyBuf,
        nwkKeyBuf: nwkKeyBuf,
        devNonce: 0,
        joined: false,
        macParams: { ...macParamsDefault },
        adr: resolveLorawanAdrEnabled(d, lorawanCfg),
      };
      if (d.adrReject) otaaDevice.adrReject = true;
      if (d.devStatus) otaaDevice.devStatus = d.devStatus;
      if (d.duplicateFirstData) otaaDevice.duplicateFirstData = true;
      if (d.lorawan && d.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(d.lorawan.dataRate);
      if (d.position && typeof d.position === 'object') {
        otaaDevice.position = {
          x: Number(d.position.x) || 0,
          y: Number(d.position.y) || 0,
          z: d.position.z != null ? Number(d.position.z) : 2,
        };
      } else if (d.location && typeof d.location === 'object') {
        otaaDevice.position = {
          x: Number(d.location.x) || 0,
          y: Number(d.location.y) || 0,
          z: d.location.z != null ? Number(d.location.z) : 2,
        };
      } else if (
        d.nodeState &&
        typeof d.nodeState === 'object' &&
        (d.nodeState.x !== undefined || d.nodeState.y !== undefined)
      ) {
        otaaDevice.position = {
          x: Number(d.nodeState.x) || 0,
          y: Number(d.nodeState.y) || 0,
          z: d.nodeState.z != null ? Number(d.nodeState.z) : 2,
        };
      }
      if (d.anomaly) otaaDevice.anomaly = d.anomaly;
      otaaDevice._vizLabel = d.name || `otaa-${i + 1}`;
      initNodeState(i, otaaDevice, lorawanCfg, globalUplink, regionChannels, d.nodeState);
      autoDevices.push({
        name: d.name || `otaa-${i + 1}`,
        lorawanDevice: otaaDevice,
        uplink: mergeUplinkCfg(globalUplink, d.uplink || {}),
      });
    }
    console.log(`[✅] 从 config.devices 加载 ${autoDevices.length} 个 OTAA 设备`);
  } else if (lorawanCfg.enabled && !isAbp && lorawanCfg.randomBehaviors && deviceCount > 0) {
    const loaded = loadBehaviorTemplates(lorawanCfg, process.cwd());
    const templates = loaded && loaded.templates ? loaded.templates : null;
    const baseline = loaded && loaded.baseline ? loaded.baseline : null;
    const templateIds = templates && Object.keys(templates).length > 0
      ? (Array.isArray(lorawanCfg.behaviorTemplateList) ? lorawanCfg.behaviorTemplateList.filter(id => templates[id]) : (lorawanCfg.behaviorTemplateList === 'all' || !lorawanCfg.behaviorTemplateList ? Object.keys(templates) : Object.keys(templates)))
      : [];
    if (templateIds.length === 0) {
      console.error('[✗] randomBehaviors 已开启但未加载到任何行为模板，请配置 behaviorTemplatesFile 或 behaviorTemplates');
    } else {
      const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
      const macParamsDefault = { maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000, dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6] };
      const appKeyDefault = (lorawanCfg.appKey && lorawanCfg.appKey.trim()) ? lorawanCfg.appKey.trim() : '';
      const appEuiBase = (lorawanCfg.appEuiStart || lorawanCfg.appEui || '0000000000000001').toString().trim();
      const devEuiBase = (lorawanCfg.devEuiStart || lorawanCfg.devEui || '0102030405060701').toString().trim();
      for (let i = 0; i < deviceCount; i++) {
        const templateId = templateIds[Math.floor(Math.random() * templateIds.length)];
        const template = templates[templateId];
        const applied = applyBehaviorTemplate(template, baseline);
        const appEui = genSequentialDevEui(appEuiBase, i);
        const devEui = genSequentialDevEui(devEuiBase, i);
        const appKey = appKeyDefault;
        if (!appKey) continue;
        const appKeyBuf = hexToBufLen(appKey, 16);
        const otaaDevice = {
          isOtaa: true,
          appEui,
          devEui,
          appKey,
          appKeyBuf,
            nwkKeyBuf: appKeyBuf,
          devNonce: 0,
          joined: false,
          macParams: { ...macParamsDefault },
          adr: resolveLorawanAdrEnabled(applied, lorawanCfg),
        };
        if (applied.adrReject) otaaDevice.adrReject = true;
        if (applied.devStatus) otaaDevice.devStatus = applied.devStatus;
        if (applied.duplicateFirstData || (applied.uplink && applied.uplink.duplicateFirstData)) otaaDevice.duplicateFirstData = true;
        if (applied.lorawan && applied.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(applied.lorawan.dataRate);
        otaaDevice._vizLabel = `node-${i + 1}-${templateId}`;
        initNodeState(i, otaaDevice, lorawanCfg, globalUplink, regionChannels, applied.nodeState);
        autoDevices.push({
          name: `node-${i + 1}-${templateId}`,
          lorawanDevice: otaaDevice,
          uplink: mergeUplinkCfg(globalUplink, applied.uplink || {}),
        });
      }
      const counts = {};
      autoDevices.forEach(d => {
        const t = (d.name || '').replace(/^node-\d+-/, '') || 'unknown';
        counts[t] = (counts[t] || 0) + 1;
      });
      console.log(`[✅] 按行为模板随机生成 ${autoDevices.length} 个 OTAA 设备 | 模板分布:`, counts);
    }
  } else if (lorawanCfg.enabled && isAbp && deviceCount > 0) {
    for (let i = 0; i < deviceCount; i++) {
      const devAddr = genSequentialDevAddr(lorawanCfg.devAddrStart, i);
      const nwkSKey = lorawanCfg.nwkSKey ? hexToBufLen(lorawanCfg.nwkSKey.trim(), 16) : genRandomBytes(16);
      const appSKey = lorawanCfg.appSKey ? hexToBufLen(lorawanCfg.appSKey.trim(), 16) : genRandomBytes(16);
      const devEui = genSequentialDevEui(lorawanCfg.devEuiStart, i);
      const fCntUp = getFCntForDevice(globalFCntState, devAddr);
      const deviceName = `device-${i + 1}`;
      const macParams = {
        maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400,
        rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000,
        dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1,
        channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6],
      };
      const lorawanDevice = {
        devAddr,
        nwkSKey,
        appSKey,
        devEui,
        fCntUp,
        classC,
        macParams,
        adr: resolveLorawanAdrEnabled({}, lorawanCfg),
      };
      const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
      initNodeState(i, lorawanDevice, lorawanCfg, globalUplink, regionChannels);
      globalDeviceMap[devAddr.toString('hex')] = lorawanDevice;
      autoDevices.push({
        name: deviceName,
        lorawanDevice,
        uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}),
      });
    }
    console.log(`[✅] 生成 ${autoDevices.length} 个设备 (device-1 .. device-${deviceCount})`);
  } else if (lorawanCfg.enabled && !isAbp && (lorawanCfg.appKey && (lorawanCfg.appEui && lorawanCfg.devEui || (lorawanCfg.appEuiStart && lorawanCfg.devEuiStart && deviceCount > 0)))) {
    const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
    const n = (deviceCount > 0 && lorawanCfg.appEuiStart && lorawanCfg.devEuiStart) ? deviceCount : 1;
    for (let i = 0; i < n; i++) {
      const appEui = n > 1 ? genSequentialDevEui(lorawanCfg.appEuiStart.trim(), i) : hexToBufLen(lorawanCfg.appEui.trim(), 8);
      const devEui = n > 1 ? genSequentialDevEui(lorawanCfg.devEuiStart.trim(), i) : hexToBufLen(lorawanCfg.devEui.trim(), 8);
      const appKeyBuf = hexToBufLen(lorawanCfg.appKey.trim(), 16);
      const otaaNamePart = lorawanCfg.otaaName ? `${lorawanCfg.otaaName}-${i + 1}` : `otaa-node-${i + 1}`;
      const otaaDevice = {
        isOtaa: true,
        appEui,
        devEui,
        appKey: lorawanCfg.appKey.trim(),
        appKeyBuf,
            nwkKeyBuf: appKeyBuf,
        devNonce: 0,
        joined: false,
        macParams: {
          maxEIRP: 16,
          uplinkDwellTime: 400,
          downlinkDwellTime: 400,
          rx1DROffset: 0,
          rx2DataRate: 2,
          rx2Frequency: 923200000,
          dataRate: 0,
          txPower: 0,
          channelMask: 0xffff,
          nbTrans: 1,
          channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6],
        },
        adr: resolveLorawanAdrEnabled({}, lorawanCfg),
      };
      otaaDevice._vizLabel = otaaNamePart;
      initNodeState(i, otaaDevice, lorawanCfg, globalUplink, regionChannels);
      autoDevices.push({
        name: otaaNamePart,
        lorawanDevice: otaaDevice,
        uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}),
      });
    }
    console.log(`[✅] OTAA 节点已加载: ${n} 个 | AppEUI 起始: ${n > 1 ? lorawanCfg.appEuiStart : lorawanCfg.appEui} | DevEUI 起始: ${n > 1 ? lorawanCfg.devEuiStart : lorawanCfg.devEui}`);
  }

  const allDevices = devices.length > 0 ? devices.map(d => ({ name: d.name, uplink: mergeUplinkCfg(globalUplink, d.uplink || {}) })) : [];
  let schedTargets = autoDevices.length > 0 ? autoDevices : (allDevices.length > 0 ? allDevices : null);
  const simulationCfg = config.simulation || {};
  const simulationRuntime = { running: simulationCfg.autoStart === true };

  if (!simulationRuntime.running) {
    console.log(
      '[Simulation] autoStart=false: uplinks are PAUSED until POST /start or UI Start — OTAA devices will not send Join Request until then.',
    );
  }

  // Optional: clear OTAA session before schedulers start so the first uplink always sends Join Request (e.g. after process restart while ChirpStack still holds old session).
  if (simulationCfg.resetOtaaOnStart === true && schedTargets && schedTargets.length > 0) {
    for (const dev of schedTargets) {
      const ld = dev.lorawanDevice;
      if (!ld || !ld.isOtaa) continue;
      const oldHex = ld.devAddrHex;
      if (oldHex) delete globalDeviceMap[oldHex];
      ld.joined = false;
      delete ld.devAddr;
      delete ld.nwkSKey;
      delete ld.appSKey;
      delete ld.devAddrHex;
      if (ld.devNonce !== undefined) ld.devNonce = 0;
    }
    console.log('[Simulation] resetOtaaOnStart: cleared in-memory OTAA session; first uplink will send Join Request.');
  }

  motionEnvRuntime = buildMotionEnvironmentRuntime(config);

  if (schedTargets && schedTargets.length > 0) {
    schedTargets.forEach((dev, idx) => {
      const label = dev && dev.name ? String(dev.name) : `device-${idx + 1}`;
      startUplinkScheduler(dev.uplink, label, dev.lorawanDevice, idx, schedTargets.length);
    });
    if (autoDevices.length > 0 && (lorawanCfg.csvPath || lorawanCfg.csvGroup || lorawanCfg.csvProfile)) {
      try {
        const csvHeader = 'JoinMode,Group,Name,Profile,AppEUI,DevEUI,AppKey,DevAddr,AppSKey,NwkSKey\n';
        const group = lorawanCfg.csvGroup || '';
        const profile = lorawanCfg.csvProfile || 'default';
        const lines = autoDevices.map(d => {
          const dev = d.lorawanDevice;
          if (dev.isOtaa) {
            return ['OTAA', group, d.name, profile, bufToHexUpper(dev.appEui), bufToHexUpper(dev.devEui), dev.appKey || '', '', '', ''].join(',');
          }
          return ['ABP', group, d.name, profile, '', bufToHexUpper(dev.devEui), '', devAddrToHexUpperBE(dev.devAddr), bufToHexUpper(dev.appSKey), bufToHexUpper(dev.nwkSKey)].join(',');
        });
        const outPath = lorawanCfg.csvPath && lorawanCfg.csvPath.trim().length > 0
          ? (path.isAbsolute(lorawanCfg.csvPath) ? lorawanCfg.csvPath : path.join(process.cwd(), lorawanCfg.csvPath))
          : path.join(process.cwd(), 'devices_export.csv');
        fs.writeFileSync(outPath, csvHeader + lines.join('\n') + '\n', 'utf8');
        console.log(`[✓] Exported ${autoDevices.length} devices to ${path.basename(outPath)}`);
      } catch (e) {
        console.error('[✗] CSV export failed:', e.message);
      }
    }
  } else if (globalUplink && globalUplink.enabled) {
    startUplinkScheduler(globalUplink, 'device-1', null, 0, 1);
  } else {
    console.log('Uplink scheduler disabled (set uplink.enabled=true in config or add devices).');
  }

  /**
   * Reset device state: OTAA -> clear session so next uplink sends Join Request again; ABP -> reset FCnt to 0.
   * @param {object} lorawanDevice - device object (must have isOtaa or devAddr)
   * @param {{ resetDevNonce?: boolean, abpResetFcnt?: boolean }} options - OTAA: resetDevNonce to start devNonce from 0; ABP: abpResetFcnt (default true)
   */
  function resetLorawanDevice(lorawanDevice, options = {}) {
    if (!lorawanDevice) return;
    if (lorawanDevice.isOtaa) {
      const oldDevAddrHex = lorawanDevice.devAddrHex;
      if (oldDevAddrHex) delete globalDeviceMap[oldDevAddrHex];
      lorawanDevice.joined = false;
      delete lorawanDevice.devAddr;
      delete lorawanDevice.nwkSKey;
      delete lorawanDevice.appSKey;
      delete lorawanDevice.devAddrHex;
      if (options.resetDevNonce !== false) lorawanDevice.devNonce = 0;
      console.log(`[Reset] OTAA device cleared session (DevEUI: ${lorawanDevice.devEui ? lorawanDevice.devEui.toString('hex') : '?'}); next uplink will send Join Request.`);
    } else {
      const abpResetFcnt = options.abpResetFcnt !== false;
      if (abpResetFcnt && lorawanDevice.devAddr) {
        lorawanDevice.fCntUp = 0;
        updateFCntForDevice(globalFCntState, lorawanDevice.devAddr, 0);
        console.log(`[Reset] ABP device FCnt reset to 0 (DevAddr: ${lorawanDevice.devAddr.toString('hex')}).`);
      }
    }
  }

  function findDeviceByDevEui(devEuiStr) {
    if (!schedTargets || !schedTargets.length) return null;
    const key = (devEuiStr || '').trim().toLowerCase().replace(/\s/g, '');
    for (const dev of schedTargets) {
      const ld = dev.lorawanDevice;
      if (ld && ld.devEui && ld.devEui.toString('hex').toLowerCase() === key) return ld;
    }
    return null;
  }

  function resetDeviceByDevEui(devEuiStr, options = {}) {
    const ld = findDeviceByDevEui(devEuiStr);
    if (!ld) return false;
    resetLorawanDevice(ld, options);
    return true;
  }

  function resetAllOtaa(options = {}) {
    if (!schedTargets || !schedTargets.length) return 0;
    let n = 0;
    for (const dev of schedTargets) {
      if (dev.lorawanDevice && dev.lorawanDevice.isOtaa) {
        resetLorawanDevice(dev.lorawanDevice, options);
        n++;
      }
    }
    if (n > 0) console.log(`[Reset] ${n} OTAA device(s) cleared for re-join.`);
    return n;
  }

  function findRuntimeTargetByDevEui(devEuiStr) {
    if (!schedTargets || !schedTargets.length) return null;
    const key = String(devEuiStr || '').trim().toLowerCase().replace(/\s/g, '');
    if (!key) return null;
    for (const target of schedTargets) {
      const ld = target && target.lorawanDevice;
      if (!ld || !ld.devEui) continue;
      if (ld.devEui.toString('hex').toLowerCase() === key) return target;
    }
    return null;
  }

  function hotAddRuntimeNodeByDevEui(devEuiStr) {
    const key = String(devEuiStr || '').trim().toLowerCase().replace(/\s/g, '');
    if (!/^[0-9a-f]{16}$/.test(key)) return { added: false, reason: 'invalid_dev_eui' };
    if (!lorawanCfg || lorawanCfg.enabled !== true) return { added: false, reason: 'lorawan_disabled' };
    if (findRuntimeTargetByDevEui(key)) return { added: false, reason: 'already_loaded' };
    const dcfg = (config.devices || []).find((d) => {
      const de = d && (d.devEui || (d.lorawan && d.lorawan.devEui));
      return de && String(de).replace(/[^a-fA-F0-9]/g, '').toLowerCase() === key;
    });
    if (!dcfg || dcfg.enabled === false) return { added: false, reason: 'not_found_or_disabled' };
    const act = (dcfg.lorawan && dcfg.lorawan.activation) || dcfg.activation || 'OTAA';
    if (String(act).toUpperCase() !== 'OTAA') return { added: false, reason: 'only_otaa_supported' };
    let appEuiStr = (
      (dcfg?.lorawan?.appEui != null ? String(dcfg.lorawan.appEui).trim() : '') ||
      (dcfg?.joinEui != null ? String(dcfg.joinEui).trim() : '') ||
      (lorawanCfg?.appEui != null ? String(lorawanCfg.appEui).trim() : '') ||
      (lorawanCfg?.appEuiStart != null ? String(lorawanCfg.appEuiStart).trim() : '')
    );
    const appKeyStr = (
      (dcfg?.appKey != null ? String(dcfg.appKey).trim() : '') ||
      (dcfg?.lorawan?.appKey != null ? String(dcfg.lorawan.appKey).trim() : '') ||
      (lorawanCfg?.appKey != null ? String(lorawanCfg.appKey).trim() : '')
    );
    if (!/^[a-fA-F0-9]{16}$/.test(appEuiStr)) {
      // Keep hot-reload resilient when UI-created nodes omit JoinEUI.
      appEuiStr = '0000000000000001';
    }
    let finalAppEuiStr = appEuiStr;
    let finalAppKeyStr = appKeyStr;
    if (!/^[a-fA-F0-9]{16}$/.test(finalAppEuiStr) || !/^[a-fA-F0-9]{32}$/.test(finalAppKeyStr)) {
      const sample = (schedTargets || []).find((t) => t && t.lorawanDevice && t.lorawanDevice.isOtaa && t.lorawanDevice.appEui && t.lorawanDevice.appKey);
      if (sample && sample.lorawanDevice) {
        finalAppEuiStr = Buffer.from(sample.lorawanDevice.appEui).toString('hex');
        finalAppKeyStr = String(sample.lorawanDevice.appKey || '');
      }
    }
    if (!/^[a-fA-F0-9]{16}$/.test(finalAppEuiStr) || !/^[a-fA-F0-9]{32}$/.test(finalAppKeyStr)) {
      return { added: false, reason: 'missing_lorawan_identity' };
    }
    const appEui = hexToBufLen(finalAppEuiStr, 8);
    const devEui = hexToBufLen(key, 8);
    const appKeyBuf = hexToBufLen(finalAppKeyStr, 16);
    const nwkKeyStr = dcfg?.lorawan?.nwkKey ? String(dcfg.lorawan.nwkKey).trim() : finalAppKeyStr;
    const nwkKeyBuf = hexToBufLen(nwkKeyStr, 16);
    const macParamsDefault = {
      maxEIRP: 16, uplinkDwellTime: 400, downlinkDwellTime: 400, rx1DROffset: 0, rx2DataRate: 2, rx2Frequency: 923200000,
      dataRate: 0, txPower: 0, channelMask: 0xFFFF, nbTrans: 1, channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6]
    };
    const otaaDevice = {
      isOtaa: true,
      appEui,
      devEui,
      appKey: finalAppKeyStr,
      appKeyBuf,
      nwkKeyBuf,
      devNonce: 0,
      joined: false,
      macParams: { ...macParamsDefault },
      adr: resolveLorawanAdrEnabled(dcfg, lorawanCfg),
    };
    if (dcfg.adrReject) otaaDevice.adrReject = true;
    if (dcfg.devStatus) otaaDevice.devStatus = dcfg.devStatus;
    if (dcfg.duplicateFirstData) otaaDevice.duplicateFirstData = true;
    if (dcfg.lorawan && dcfg.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(dcfg.lorawan.dataRate);
    if (dcfg.position && typeof dcfg.position === 'object') {
      otaaDevice.position = {
        x: Number(dcfg.position.x) || 0,
        y: Number(dcfg.position.y) || 0,
        z: dcfg.position.z != null ? Number(dcfg.position.z) : 2,
      };
    } else if (dcfg.location && typeof dcfg.location === 'object') {
      otaaDevice.position = {
        x: Number(dcfg.location.x) || 0,
        y: Number(dcfg.location.y) || 0,
        z: dcfg.location.z != null ? Number(dcfg.location.z) : 2,
      };
    }
    if (dcfg.anomaly) otaaDevice.anomaly = dcfg.anomaly;
    otaaDevice._vizLabel = dcfg.name || `hot-node-${key.slice(-4)}`;
    const regionChannels = (REGIONS['AS923-1'] && REGIONS['AS923-1'].channels) || [];
    initNodeState(schedTargets && schedTargets.length ? schedTargets.length : 0, otaaDevice, lorawanCfg, globalUplink, regionChannels, dcfg.nodeState);
    const target = {
      name: dcfg.name || `hot-node-${key.slice(-4)}`,
      lorawanDevice: otaaDevice,
      uplink: mergeUplinkCfg(globalUplink, dcfg.uplink || {}),
    };
    if (!schedTargets) schedTargets = [];
    schedTargets.push(target);
    if (motionEnvRuntime && dcfg.movement) {
      registerMovementFromConfig(motionEnvRuntime, key, dcfg.movement);
    }
    startUplinkScheduler(target.uplink, target.name, target.lorawanDevice, schedTargets.length - 1, schedTargets.length);
    console.log(`[HotReload] Runtime node loaded: ${key.toUpperCase()} (${target.name})`);
    return { added: true, reason: 'ok' };
  }

  function hotRemoveRuntimeNodeByDevEui(devEuiStr) {
    if (!schedTargets || !schedTargets.length) return { removed: false, reason: 'empty_runtime' };
    const key = String(devEuiStr || '').trim().toLowerCase().replace(/\s/g, '');
    if (!key) return { removed: false, reason: 'invalid_dev_eui' };
    const idx = schedTargets.findIndex((target) => {
      const ld = target && target.lorawanDevice;
      return ld && ld.devEui && ld.devEui.toString('hex').toLowerCase() === key;
    });
    if (idx < 0) return { removed: false, reason: 'not_found' };
    const target = schedTargets[idx];
    if (target && target.uplink) target.uplink.enabled = false;
    const ld = target && target.lorawanDevice;
    if (ld && ld.devAddrHex) delete globalDeviceMap[ld.devAddrHex];
    schedTargets.splice(idx, 1);
    console.log(`[HotReload] Runtime node removed: ${key.toUpperCase()}`);
    return { removed: true, reason: 'ok' };
  }

  function hotUpdateRuntimeNodeByDevEui(devEuiStr) {
    const key = String(devEuiStr || '').trim().toLowerCase().replace(/\s/g, '');
    if (!/^[0-9a-f]{16}$/.test(key)) return { updated: false, reason: 'invalid_dev_eui' };
    const target = findRuntimeTargetByDevEui(key);
    if (!target || !target.lorawanDevice) return { updated: false, reason: 'not_loaded' };
    const dcfg = (config.devices || []).find((d) => {
      const de = d && (d.devEui || (d.lorawan && d.lorawan.devEui));
      return de && String(de).replace(/[^a-fA-F0-9]/g, '').toLowerCase() === key;
    });
    if (!dcfg) return { updated: false, reason: 'not_in_config' };
    const ld = target.lorawanDevice;
    const nextUplink = mergeUplinkCfg(globalUplink, dcfg.uplink || {});
    if (!target.uplink) target.uplink = {};
    Object.assign(target.uplink, nextUplink);
    if (dcfg.enabled === false) target.uplink.enabled = false;
    ld.adr = resolveLorawanAdrEnabled(dcfg, lorawanCfg);
    if (dcfg.adrReject) ld.adrReject = true;
    else delete ld.adrReject;
    if (dcfg.devStatus) ld.devStatus = dcfg.devStatus;
    else delete ld.devStatus;
    if (dcfg.duplicateFirstData) ld.duplicateFirstData = true;
    else delete ld.duplicateFirstData;
    if (dcfg.anomaly && typeof dcfg.anomaly === 'object') {
      ld.anomaly = dcfg.anomaly;
    } else {
      delete ld.anomaly;
      delete ld._anomalyOverride;
      delete ld._dropThisUplink;
      delete ld._rapidJoinScheduled;
      delete ld._rapidJoinCount;
    }
    if (dcfg.lorawan && dcfg.lorawan.dataRate !== undefined && ld.macParams) {
      ld.macParams.dataRate = Number(dcfg.lorawan.dataRate);
    }
    if (dcfg.position && typeof dcfg.position === 'object') {
      ld.position = {
        x: Number(dcfg.position.x) || 0,
        y: Number(dcfg.position.y) || 0,
        z: dcfg.position.z != null ? Number(dcfg.position.z) : 2,
      };
    } else if (dcfg.location && typeof dcfg.location === 'object') {
      ld.position = {
        x: Number(dcfg.location.x) || 0,
        y: Number(dcfg.location.y) || 0,
        z: dcfg.location.z != null ? Number(dcfg.location.z) : 2,
      };
    }
    target.name = dcfg.name || target.name;
    console.log(`[HotReload] Runtime node updated: ${key.toUpperCase()} anomaly=${ld.anomaly && ld.anomaly.scenario ? ld.anomaly.scenario : 'none'}`);
    return { updated: true, reason: 'ok' };
  }
  function buildVizNodesFromRuntime() {
    const out = [];
    if (!schedTargets || !schedTargets.length) return out;
    for (const dev of schedTargets) {
      const ld = dev && dev.lorawanDevice;
      if (!ld || !ld.devEui) continue;
      const devEuiUp = ld.devEui.toString('hex').toUpperCase();
      const dcfg = (config.devices || []).find((d) => {
        const de = d && (d.devEui || (d.lorawan && d.lorawan.devEui));
        return de && String(de).replace(/[^a-fA-F0-9]/g, '').toLowerCase() === devEuiUp.toLowerCase();
      });
      const uplinkMerged = (dev && dev.uplink) || {};
      out.push({
        eui: devEuiUp,
        enabled: dcfg ? dcfg.enabled !== false : true,
        name: (dev.name && String(dev.name)) || devEuiUp.slice(-4),
        devAddr: ld.devAddr ? ld.devAddr.toString('hex').toUpperCase() : 'N/A',
        fCnt: ld.joined ? Math.max(0, (ld.fCntUp || 0) - 1) : 0,
        joined: Boolean(ld.joined),
        rssi: ld.nodeState?.rssi ?? -80,
        snr: ld.nodeState?.snr ?? 5,
        uplinks: ld._vizUplinkCount || 0,
        position: ld.position,
        anomaly: ld.anomaly,
        nodeState: dcfg && dcfg.nodeState ? dcfg.nodeState : undefined,
        adrReject: Boolean(dcfg && dcfg.adrReject),
        devStatus: Boolean(dcfg && dcfg.devStatus),
        duplicateFirstData: Boolean(dcfg && dcfg.duplicateFirstData),
        lastSeen: null,
        simulator: {
          intervalMs: uplinkMerged.intervalMs ?? globalUplink.intervalMs ?? 10000,
          sf: dcfg && dcfg.lorawan && dcfg.lorawan.dataRate != null ? Number(dcfg.lorawan.dataRate) : undefined,
          txPower: dcfg && dcfg.lorawan && dcfg.lorawan.txPower != null ? Number(dcfg.lorawan.txPower) : undefined,
          adr:
            dcfg && dcfg.lorawan && dcfg.lorawan.adr !== undefined
              ? dcfg.lorawan.adr !== false
              : (dcfg && dcfg.adr !== undefined ? dcfg.adr !== false : true),
          fPort: dcfg && dcfg.fPort != null ? Number(dcfg.fPort) : 2,
          uplinkCodec: dcfg && dcfg.uplink && dcfg.uplink.codec ? String(dcfg.uplink.codec) : (globalUplink.codec || 'simple'),
        },
      });
    }
    return out;
  }
  function applyConfigToRuntimeFromProfile(nextConfig) {
    const before = safeJsonClone(config) || {};
    config = nextConfig;
    replaceObjectContents(globalUplink, config.uplink || {});
    replaceObjectContents(lorawanCfg, config.lorawan || {});
    replaceObjectContents(simulationCfg, config.simulation || {});
    const desiredSet = new Set(
      (config.devices || [])
        .filter((d) => d && d.enabled !== false)
        .map((d) => String(d.devEui || (d.lorawan && d.lorawan.devEui) || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase())
        .filter((eui) => /^[0-9a-f]{16}$/.test(eui)),
    );
    const runtimeSet = new Set(
      (schedTargets || [])
        .map((target) => target && target.lorawanDevice && target.lorawanDevice.devEui
          ? target.lorawanDevice.devEui.toString('hex').toLowerCase()
          : '')
        .filter((eui) => /^[0-9a-f]{16}$/.test(eui)),
    );
    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const eui of runtimeSet) {
      if (!desiredSet.has(eui)) {
        const r = hotRemoveRuntimeNodeByDevEui(eui);
        if (r.removed) removed += 1;
      }
    }
    for (const eui of desiredSet) {
      if (!runtimeSet.has(eui)) {
        const r = hotAddRuntimeNodeByDevEui(eui);
        if (r.added) added += 1;
      } else {
        const r = hotUpdateRuntimeNodeByDevEui(eui);
        if (r.updated) updated += 1;
      }
    }
    const unsafeReasons = [];
    if (before && before.lnsHost !== config.lnsHost) unsafeReasons.push('lnsHost_changed');
    if (before && Number(before.lnsPort || 0) !== Number(config.lnsPort || 0)) unsafeReasons.push('lnsPort_changed');
    if (before && before.gatewayEui !== config.gatewayEui) unsafeReasons.push('gatewayEui_changed');
    if (before && String(before?.lorawan?.region || '') !== String(config?.lorawan?.region || '')) unsafeReasons.push('lorawan_region_changed');
    if (before && String(before?.lorawan?.csvImportPath || '') !== String(config?.lorawan?.csvImportPath || '')) unsafeReasons.push('csvImportPath_changed');
    updateSimState({
      gateways: config.multiGateway?.enabled
        ? (config.multiGateway.gateways || [])
        : [{ eui: config.gatewayEui, name: 'default-gateway', position: config.signalModel?.gatewayPosition || { x: 0, y: 0, z: 30 } }],
      nodes: buildVizNodesFromRuntime(),
      config: {
        ...(simState.config || {}),
        simulation: safeJsonClone(config.simulation || {}),
        lorawan: safeJsonClone(config.lorawan || {}),
        uplink: safeJsonClone(config.uplink || {}),
        signalModel: config.signalModel,
        multiGateway: config.multiGateway,
        chirpstack: safeJsonClone(config.chirpstack || {}),
        gatewayEui: config.gatewayEui,
        lnsHost: config.lnsHost,
        lnsPort: config.lnsPort,
        udpBindPort: config.udpBindPort,
        mqtt: safeJsonClone(config.mqtt || {}),
        controlServer: safeJsonClone(config.controlServer || {}),
        control: safeJsonClone(config.control || {}),
        profileConfig: profileStateForUi(),
      },
    });
    writeSimState();
    return {
      added,
      updated,
      removed,
      reloadRequired: unsafeReasons.length > 0,
      reasons: unsafeReasons,
    };
  }

  /**
   * Write a blank profile JSON and hot-apply it (clear runtime devices; disable CS topology merge for an empty canvas).
   */
  function createBlankProfileAndHotApply(body) {
    const autoName = Boolean(body && body.autoName);
    let profileName = normalizeProfileName(body && body.name ? body.name : '');
    if (autoName || !profileName) {
      profileName = generateUniqueBlankProfileName();
    }
    if (!profileName) {
      return { err: { status: 400, body: { ok: false, error: { code: 'validation', message: 'profile name is required' } } } };
    }
    const allowOverwrite = Boolean(body && body.overwrite);
    if (!autoName && !allowOverwrite && profileNameExists(config, profileName)) {
      return {
        err: {
          status: 409,
          body: { ok: false, error: { code: 'conflict', message: `profile already exists: ${profileName}` } },
        },
      };
    }
    const setDefault = Boolean(body && body.setDefault);
    try {
      const snapshot = {
        $lorasimProfileHint:
          '空白配置集：devices 为空。已暂时关闭 chirpstack.topologyEnabled 以清空画布。主 -c 配置文件未写入；会话内内存态已热更新。需要合并 NS 清单时请改 topologyEnabled 为 true 后应用。',
        name: profileName,
        savedAt: new Date().toISOString(),
        devices: [],
        multiGateway: {},
        signalModel: {},
        uplink: {},
        simulation: {},
        lorawan: {},
        chirpstack: { topologyEnabled: false },
        mqtt: {},
        controlServer: {},
        control: {},
      };
      const abs = profileFilePath(config, profileName);
      ensureProfilesDir(path.dirname(abs));
      fs.writeFileSync(abs, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      const merged = applyProfileSnapshot(config, snapshot);
      setActiveDefaultProfile(profileName, setDefault);
      merged.profileConfig = safeJsonClone(config.profileConfig);
      const applied = applyConfigToRuntimeFromProfile(merged);
      // Do not persistConfig: keep the main -c JSON on disk unchanged (only profiles/<name>.json was written).
      return {
        ok: true,
        abs,
        applied,
        data: {
          ...profileStateForUi(),
          path: abs,
          applied: { added: applied.added, updated: applied.updated, removed: applied.removed },
          reloadRequired: applied.reloadRequired,
          reasons: applied.reasons,
          message: applied.reloadRequired
            ? `已新建「${profileName}」并热更新；主配置文件未写入磁盘；建议重启模拟器（${applied.reasons.join(', ')}）`
            : `已新建「${profileName}」并热更新；主配置文件（-c）未修改，仅写入 profiles 目录`,
        },
      };
    } catch (e) {
      return {
        err: { status: 500, body: { ok: false, error: { code: 'internal', message: e.message || String(e) } } },
      };
    }
  }

  function updateRuntimePosition(kind, id, position) {
    const pos = {
      x: Number(position?.x) || 0,
      y: Number(position?.y) || 0,
      z: position?.z != null ? Number(position.z) : (kind === 'gateway' ? 30 : 2),
    };
    const key = String(id || '').toLowerCase();
    if (kind === 'node') {
      if (!schedTargets || !schedTargets.length) return;
      for (const dev of schedTargets) {
        const ld = dev && dev.lorawanDevice;
        if (!ld || !ld.devEui) continue;
        if (ld.devEui.toString('hex').toLowerCase() === key) {
          ld.position = pos;
          console.log(`[Layout] Runtime node ${id} -> (${pos.x}, ${pos.y}, ${pos.z})`);
          return;
        }
      }
      console.log(`[Layout] Runtime node ${id} not found in schedTargets`);
      return;
    }
    const mgw = config.multiGateway;
    if (!mgw || !Array.isArray(mgw.gateways)) return;
    for (let i = 0; i < mgw.gateways.length; i++) {
      const gw = mgw.gateways[i];
      if (!gw || !gw.eui) continue;
      if (String(gw.eui).toLowerCase() === key) {
        gw.position = pos;
        console.log(`[Layout] Runtime gateway ${id} -> (${pos.x}, ${pos.y}, ${pos.z})`);
        return;
      }
    }
    console.log(`[Layout] Runtime gateway ${id} not found in multiGateway.gateways`);
  }

  const idempotencyStore = new IdempotencyStore();
  orchestrator = new OrchestratorService({
    getConfig: () => config,
    getSimState: () => simState,
    updateSimState: (updates) => updateSimState(updates),
    writeSimState: () => writeSimState(),
    updateRuntimePosition,
    persistConfig,
  });

  if (!mqttEnabled && config.chirpstack && config.chirpstack.integrationMqtt && config.chirpstack.integrationMqtt.enabled) {
    const { startChirpstackIntegrationMqtt } = require('./src/chirpstack/integration-mqtt');
    const h = startChirpstackIntegrationMqtt(config.chirpstack.integrationMqtt, orchestrator, (m) => console.log(m));
    topologyMqttStop = h.stop;
  }

  function parseJsonBody(req, cb) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!body) return cb(null, {});
      try {
        return cb(null, JSON.parse(body));
      } catch (e) {
        return cb(e);
      }
    });
  }

  const controlCfg = config.controlServer || config.control || {};
  if (controlCfg.enabled) {
    const orchestratorApiEnabled = String(process.env.ENABLE_ORCHESTRATOR_API || 'true').toLowerCase() !== 'false';
    const controlPort = Number(controlCfg.port) || 9999;
    const server = http.createServer((req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
        });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const sendResult = (result, okStatus = 200) => {
        if (result && result.ok === false) {
          const code = result.error && result.error.code;
          const status = code === 'validation' ? 400
            : code === 'not_found' ? 404
            : code === 'conflict_revision' ? 409
            : (code === 'partial_success' ? 207 : 500);
          return send(status, result);
        }
        return send(okStatus, result);
      };
      if (req.method === 'OPTIONS') return send(204, {});
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      let url = reqUrl.pathname || '';
      if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
      if ((req.method === 'GET' || req.method === 'POST') && (url.startsWith('/start') || url === '/start')) {
        let resetCount = 0;
        if (simulationCfg.resetOtaaOnStart === true) {
          resetCount = resetAllOtaa({ resetDevNonce: true });
        }
        simulationRuntime.running = true;
        updateSimState({ running: true });
        return send(200, {
          ok: true,
          running: true,
          message:
            resetCount > 0
              ? `Simulation started. ${resetCount} OTAA device(s) reset for re-join.`
              : 'Simulation started.',
        });
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url.startsWith('/stop') || url === '/stop')) {
        simulationRuntime.running = false;
        updateSimState({ running: false });
        return send(200, { ok: true, running: false, message: 'Simulation paused.' });
      }
      if (req.method === 'GET' && (url.startsWith('/status') || url === '/status')) {
        return send(200, { ok: true, running: simulationRuntime.running });
      }
      if (req.method === 'GET' && (url === '/sim-state' || url === '/state')) {
        simState.config = {
          ...(simState.config || {}),
          profileConfig: profileStateForUi(),
        };
        return send(200, orchestrator.getSimStateForHttp());
      }
      if (req.method === 'GET' && (url === '/config-profiles' || url === '/profiles' || url === '/profile')) {
        return send(200, { ok: true, data: profileStateForUi() });
      }
      if (req.method === 'POST' && (url === '/config-profiles/save' || url === '/profile/save' || url === '/profiles/save')) {
        return parseJsonBody(req, (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          try {
            if (String((body && body.mode) || '').toLowerCase() === 'blank') {
              const blankRes = createBlankProfileAndHotApply(body);
              if (blankRes.err) return send(blankRes.err.status, blankRes.err.body);
              return send(200, { ok: true, data: blankRes.data });
            }
            const profileName = normalizeProfileName(body && body.name ? body.name : '');
            if (!profileName) {
              return send(400, { ok: false, error: { code: 'validation', message: 'profile name is required' } });
            }
            const allowOverwrite = Boolean(body && body.overwrite);
            if (!allowOverwrite && profileNameExists(config, profileName)) {
              return send(409, { ok: false, error: { code: 'conflict', message: `profile already exists: ${profileName}` } });
            }
            const setDefault = Boolean(body && body.setDefault);
            const snapshot = {
              name: profileName,
              savedAt: new Date().toISOString(),
              devices: safeJsonClone(config.devices || []),
              multiGateway: safeJsonClone(config.multiGateway || {}),
              signalModel: safeJsonClone(config.signalModel || {}),
              uplink: safeJsonClone(config.uplink || {}),
              simulation: safeJsonClone(config.simulation || {}),
              lorawan: safeJsonClone(config.lorawan || {}),
              chirpstack: safeJsonClone(config.chirpstack || {}),
              gatewayEui: config.gatewayEui,
              lnsHost: config.lnsHost,
              lnsPort: config.lnsPort,
              udpBindPort: config.udpBindPort,
              mqtt: safeJsonClone(config.mqtt || {}),
              controlServer: safeJsonClone(config.controlServer || {}),
              control: safeJsonClone(config.control || {}),
            };
            const abs = profileFilePath(config, profileName);
            ensureProfilesDir(path.dirname(abs));
            fs.writeFileSync(abs, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
            setActiveDefaultProfile(profileName, setDefault);
            persistConfig(config);
            updateSimState({
              config: {
                ...(simState.config || {}),
                profileConfig: profileStateForUi(),
              },
            });
            return send(200, { ok: true, data: profileStateForUi() });
          } catch (e) {
            return send(500, { ok: false, error: { code: 'internal', message: e.message || String(e) } });
          }
        });
      }
      if (req.method === 'POST' && (url === '/config-profiles/create' || url === '/profile/create' || url === '/profiles/create')) {
        return parseJsonBody(req, (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const blankRes = createBlankProfileAndHotApply(body);
          if (blankRes.err) return send(blankRes.err.status, blankRes.err.body);
          return send(200, { ok: true, data: blankRes.data });
        });
      }
      if (req.method === 'POST' && (url === '/config-profiles/load' || url === '/profile/load' || url === '/profiles/load')) {
        return parseJsonBody(req, (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          try {
            const profileName = normalizeProfileName(body && body.name ? body.name : '');
            if (!profileName) {
              return send(400, { ok: false, error: { code: 'validation', message: 'profile name is required' } });
            }
            const setDefault = body && Object.prototype.hasOwnProperty.call(body, 'setDefault')
              ? Boolean(body.setDefault)
              : undefined;
            const abs = profileFilePath(config, profileName);
            if (!fs.existsSync(abs)) {
              return send(404, { ok: false, error: { code: 'not_found', message: `profile not found: ${profileName}` } });
            }
            const snapshot = JSON.parse(fs.readFileSync(abs, 'utf8'));
            config = applyProfileSnapshot(config, snapshot);
            setActiveDefaultProfile(profileName, setDefault);
            persistConfig(config);
            updateSimState({
              config: {
                ...(simState.config || {}),
                profileConfig: profileStateForUi(),
              },
            });
            return send(200, {
              ok: true,
              data: {
                ...profileStateForUi(),
                reloadRequired: true,
                message: 'Profile applied to config.json. Restart simulator to fully load runtime nodes/gateways.',
              },
            });
          } catch (e) {
            return send(500, { ok: false, error: { code: 'internal', message: e.message || String(e) } });
          }
        });
      }
      if (req.method === 'POST' && (url === '/config-profiles/apply' || url === '/profile/apply' || url === '/profiles/apply')) {
        return parseJsonBody(req, (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          try {
            const profileName = normalizeProfileName(body && body.name ? body.name : '');
            if (!profileName) {
              return send(400, { ok: false, error: { code: 'validation', message: 'profile name is required' } });
            }
            const setDefault = body && Object.prototype.hasOwnProperty.call(body, 'setDefault')
              ? Boolean(body.setDefault)
              : undefined;
            const abs = profileFilePath(config, profileName);
            if (!fs.existsSync(abs)) {
              return send(404, { ok: false, error: { code: 'not_found', message: `profile not found: ${profileName}` } });
            }
            const snapshot = JSON.parse(fs.readFileSync(abs, 'utf8'));
            const merged = applyProfileSnapshot(config, snapshot);
            setActiveDefaultProfile(profileName, setDefault);
            merged.profileConfig = safeJsonClone(config.profileConfig);
            const applied = applyConfigToRuntimeFromProfile(merged);
            persistConfig(config);
            return send(200, {
              ok: true,
              data: {
                ...profileStateForUi(),
                applied: { added: applied.added, updated: applied.updated, removed: applied.removed },
                reloadRequired: applied.reloadRequired,
                reasons: applied.reasons,
                message: applied.reloadRequired
                  ? `Profile applied with partial hot update. Restart recommended (${applied.reasons.join(', ')}).`
                  : 'Profile applied and hot-updated successfully.',
              },
            });
          } catch (e) {
            return send(500, { ok: false, error: { code: 'internal', message: e.message || String(e) } });
          }
        });
      }
      if (req.method === 'POST' && (url === '/config-profiles/rename' || url === '/profile/rename' || url === '/profiles/rename')) {
        return parseJsonBody(req, (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          try {
            const fromName = normalizeProfileName(body && body.from ? body.from : '');
            const toName = normalizeProfileName(body && body.to ? body.to : '');
            if (!fromName || !toName) {
              return send(400, { ok: false, error: { code: 'validation', message: 'from/to profile name required' } });
            }
            if (fromName === toName) {
              return send(400, { ok: false, error: { code: 'validation', message: 'source and target names are identical' } });
            }
            const fromPath = profileFilePath(config, fromName);
            const toPath = profileFilePath(config, toName);
            if (!fs.existsSync(fromPath)) {
              return send(404, { ok: false, error: { code: 'not_found', message: `profile not found: ${fromName}` } });
            }
            if (fs.existsSync(toPath)) {
              return send(409, { ok: false, error: { code: 'conflict', message: `target profile already exists: ${toName}` } });
            }
            fs.renameSync(fromPath, toPath);
            if (!config.profileConfig || typeof config.profileConfig !== 'object') config.profileConfig = {};
            if (normalizeProfileName(config.profileConfig.activeProfile || '') === fromName) {
              config.profileConfig.activeProfile = toName;
            }
            if (normalizeProfileName(config.profileConfig.defaultProfile || '') === fromName) {
              config.profileConfig.defaultProfile = toName;
            }
            persistConfig(config);
            updateSimState({
              config: {
                ...(simState.config || {}),
                profileConfig: profileStateForUi(),
              },
            });
            return send(200, {
              ok: true,
              data: {
                ...profileStateForUi(),
                message: `Profile renamed: ${fromName} -> ${toName}`,
              },
            });
          } catch (e) {
            return send(500, { ok: false, error: { code: 'internal', message: e.message || String(e) } });
          }
        });
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url.startsWith('/reset') || url === '/reset')) {
        let devEui = null;
        if (req.method === 'POST') {
          parseJsonBody(req, (err, j = {}) => {
            try {
              if (err) return send(400, { ok: false, message: err.message });
              devEui = j.devEui != null ? String(j.devEui) : null;
              const abpResetFcnt = j.abpResetFcnt !== false;
              const resetDevNonce = j.resetDevNonce !== false;
              if (devEui) {
                const ok = resetDeviceByDevEui(devEui, { abpResetFcnt, resetDevNonce });
                return send(200, { ok, message: ok ? `Device ${devEui} reset.` : `Device ${devEui} not found.` });
              }
              const n = resetAllOtaa({ resetDevNonce });
              return send(200, { ok: true, message: `${n} OTAA device(s) reset for re-join.` });
            } catch (e) {
              return send(400, { ok: false, message: e.message });
            }
          });
          return;
        }
        devEui = reqUrl.searchParams.get('devEui') || reqUrl.searchParams.get('DevEUI');
        if (devEui) {
          const ok = resetDeviceByDevEui(devEui);
          return send(200, { ok, message: ok ? `Device ${devEui} reset.` : `Device ${devEui} not found.` });
        }
        const n = resetAllOtaa();
        return send(200, { ok: true, message: `${n} OTAA device(s) reset for re-join.` });
      }

      const idemKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : '';
      const idemCached = idempotencyStore.get(req.method || 'GET', url, idemKey);
      if (idemCached) {
        return send(idemCached.status, idemCached.body);
      }
      if (!orchestratorApiEnabled && (
        url === '/resources/nodes' ||
        /^\/resources\/nodes\/[A-Fa-f0-9]{16}$/.test(url) ||
        url === '/resources/gateways' ||
        /^\/resources\/gateways\/[A-Fa-f0-9]{16}$/.test(url) ||
        url === '/resources/simulation' ||
        url === '/layout/apply' ||
        url === '/sync/retry'
      )) {
        return send(503, { ok: false, error: { code: 'feature_disabled', message: 'Orchestrator API disabled by ENABLE_ORCHESTRATOR_API=false' } });
      }

      if (req.method === 'POST' && (url === '/resources/nodes')) {
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.createNode(body);
          if (result && result.ok && result.data && result.data.node && result.data.node.devEui) {
            const hr = hotAddRuntimeNodeByDevEui(result.data.node.devEui);
            if (!hr.added && hr.reason !== 'already_loaded') {
              console.log(`[HotReload] Runtime node skip: ${result.data.node.devEui} (${hr.reason})`);
            }
          }
          const status = result.ok ? 200 : (result.error?.code === 'partial_success' ? 207 : 400);
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'PATCH' && /^\/resources\/nodes\/[A-Fa-f0-9]{16}$/.test(url)) {
        const devEui = url.split('/').pop();
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.updateNode(devEui, body);
          if (result && result.ok) {
            const hu = hotUpdateRuntimeNodeByDevEui(devEui);
            if (!hu.updated) {
              console.log(`[HotReload] Runtime node update skip: ${devEui} (${hu.reason})`);
            }
          }
          const status = result.ok ? 200 : (result.error?.code === 'partial_success' ? 207 : 400);
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'DELETE' && /^\/resources\/nodes\/[A-Fa-f0-9]{16}$/.test(url)) {
        const devEui = url.split('/').pop();
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.deleteNode(devEui, body || {});
          if (result && result.ok) hotRemoveRuntimeNodeByDevEui(devEui);
          const status = result.ok ? 200 : 400;
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'POST' && (url === '/resources/gateways')) {
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.createGateway(body);
          const status = result.ok ? 200 : (result.error?.code === 'partial_success' ? 207 : 400);
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'PATCH' && /^\/resources\/gateways\/[A-Fa-f0-9]{16}$/.test(url)) {
        const gatewayId = url.split('/').pop();
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.updateGateway(gatewayId, body);
          const status = result.ok ? 200 : (result.error?.code === 'partial_success' ? 207 : 400);
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'DELETE' && /^\/resources\/gateways\/[A-Fa-f0-9]{16}$/.test(url)) {
        const gatewayId = url.split('/').pop();
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.deleteGateway(gatewayId, body || {});
          const status = result.ok ? 200 : 400;
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'PATCH' && url === '/resources/simulation') {
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.updateSimulation(body);
          const status = result.ok ? 200 : 400;
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'POST' && url === '/layout/apply') {
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.applyLayout(body);
          const status = result.ok ? 200 : (result.error?.code === 'conflict_revision' ? 409 : 400);
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'POST' && url === '/sync/retry') {
        return parseJsonBody(req, async (err, body) => {
          if (err) return send(400, { ok: false, error: { code: 'validation', message: err.message } });
          const result = await orchestrator.retry(body.resourceIds || []);
          const status = 200;
          idempotencyStore.set(req.method, url, idemKey, { status, body: result });
          return sendResult(result, status);
        });
      }
      if (req.method === 'POST' && (url === '/chirpstack/refresh-inventory' || url === '/topology/refresh-inventory')) {
        (async () => {
          try {
            const data = await orchestrator.refreshChirpstackInventory();
            return send(200, { ok: true, data });
          } catch (e) {
            return send(500, { ok: false, error: { message: e.message || String(e) } });
          }
        })();
        return;
      }

      send(404, { ok: false, message: 'Not found. Use /start, /stop, /status, /reset, /sim-state, /resources/*, /resources/simulation, /layout/apply, /sync/retry, /chirpstack/refresh-inventory, /config-profiles/* (create/save/load/apply/rename) (or /profile/*).' });
    });
    server.listen(controlPort, controlCfg.host || '0.0.0.0', () => {
      console.log(`[Control] HTTP server on port ${controlPort} | /start /stop /status /reset /sim-state /resources/* /resources/simulation /layout/apply /sync/retry (orchestratorApiEnabled=${orchestratorApiEnabled})`);
    });
  }

  function shutdown() {
    console.log('\n[🛑] Stopping simulator...\n');
    if (topologyInventoryTimer) clearInterval(topologyInventoryTimer);
    topologyMqttStop();
    if (pullTimer) clearInterval(pullTimer);
    uplinkTimers.forEach(t => {
      if (t && typeof t.clear === 'function') t.clear();
    });
    if (statTimer) clearInterval(statTimer);
    if (socket) socket.close(() => process.exit(0));
    if (mqttClient) mqttClient.end(true, {}, () => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /** 初始化状态导出（sim-state.json）：DevEUI、name、地图坐标与 ChirpStack/JSON 中设备名一致 */
  const initialVizNodes = [];
  if (schedTargets && schedTargets.length > 0) {
    for (const dev of schedTargets) {
      const ld = dev.lorawanDevice;
      if (!ld || !ld.devEui) continue;
      const devEuiUp = ld.devEui.toString('hex').toUpperCase();
      const uplinkMerged = dev.uplink || {};
      const intervalMsGuess = uplinkMerged.intervalMs ?? globalUplink.intervalMs ?? 10000;
      const dcfg = (config.devices || []).find((d) => {
        if (!d) return false;
        const de = d.devEui || (d.lorawan && d.lorawan.devEui);
        if (!de) return false;
        const norm = String(de).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        return norm === devEuiUp.toLowerCase();
      });
      let appKeyStr = '';
      if (dcfg) {
        const k = dcfg.appKey || (dcfg.lorawan && dcfg.lorawan.appKey);
        if (k) appKeyStr = String(k);
      }
      const sfVal =
        dcfg && dcfg.dataRate != null
          ? Number(dcfg.dataRate)
          : dcfg && dcfg.lorawan && dcfg.lorawan.dataRate != null
            ? Number(dcfg.lorawan.dataRate)
            : undefined;
      const txVal =
        dcfg && dcfg.txPower != null
          ? Number(dcfg.txPower)
          : dcfg && dcfg.lorawan && dcfg.lorawan.txPower != null
            ? Number(dcfg.lorawan.txPower)
            : undefined;
      const adrVal =
        dcfg && dcfg.adr !== undefined
          ? dcfg.adr !== false
          : dcfg && dcfg.lorawan && dcfg.lorawan.adr !== undefined
            ? dcfg.lorawan.adr !== false
            : true;
      const simulator = {
        intervalMs: dcfg && dcfg.interval != null ? Math.max(1, Number(dcfg.interval)) * 1000 : intervalMsGuess,
        sf: sfVal,
        txPower: txVal,
        adr: adrVal,
        fPort: dcfg && dcfg.fPort != null ? Number(dcfg.fPort) : 2,
        uplinkCodec: dcfg && dcfg.uplink && dcfg.uplink.codec ? String(dcfg.uplink.codec) : (globalUplink.codec || 'simple'),
        appKeyConfigured: Boolean(appKeyStr && appKeyStr.replace(/\s/g, '').length === 32),
      };
      initialVizNodes.push({
        eui: devEuiUp,
        enabled: dcfg ? dcfg.enabled !== false : true,
        name: (dev.name && String(dev.name)) || devEuiUp.slice(-4),
        devAddr: ld.devAddr ? ld.devAddr.toString('hex').toUpperCase() : 'N/A',
        fCnt: ld.joined ? Math.max(0, (ld.fCntUp || 0) - 1) : 0,
        joined: Boolean(ld.joined),
        rssi: ld.nodeState?.rssi ?? -80,
        snr: ld.nodeState?.snr ?? 5,
        uplinks: 0,
        position: ld.position,
        anomaly: ld.anomaly,
        nodeState: dcfg && dcfg.nodeState ? dcfg.nodeState : undefined,
        adrReject: Boolean(dcfg && dcfg.adrReject),
        devStatus: Boolean(dcfg && dcfg.devStatus),
        duplicateFirstData: Boolean(dcfg && dcfg.duplicateFirstData),
        lastSeen: null,
        simulator,
      });
    }
  }

  // ===== 启动状态导出器 =====
  const stateIntervalMs = config.visualizer?.stateIntervalMs || 1000;
  startStateExporter(stateIntervalMs);

  const persistedTopologyFields = (() => {
    const defaults = {
      topologyOverlay: { nodes: {}, gateways: {} },
      chirpstackLiveRx: { byDevEui: {} },
      chirpstackInventory: { nodes: [], gateways: [], updatedAt: null, error: null },
    };
    try {
      if (fs.existsSync(SIM_STATE_FILE)) {
        const prev = JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8'));
        if (prev.topologyOverlay && typeof prev.topologyOverlay === 'object') {
          defaults.topologyOverlay = {
            nodes: { ...(prev.topologyOverlay.nodes || {}) },
            gateways: { ...(prev.topologyOverlay.gateways || {}) },
          };
        }
        if (prev.chirpstackLiveRx && typeof prev.chirpstackLiveRx === 'object' && prev.chirpstackLiveRx.byDevEui) {
          defaults.chirpstackLiveRx = { byDevEui: { ...prev.chirpstackLiveRx.byDevEui } };
        }
        if (prev.chirpstackInventory && typeof prev.chirpstackInventory === 'object') {
          defaults.chirpstackInventory = {
            nodes: Array.isArray(prev.chirpstackInventory.nodes) ? prev.chirpstackInventory.nodes : [],
            gateways: Array.isArray(prev.chirpstackInventory.gateways) ? prev.chirpstackInventory.gateways : [],
            updatedAt: prev.chirpstackInventory.updatedAt || null,
            error: prev.chirpstackInventory.error || null,
          };
        }
      }
    } catch (e) {
      console.warn('[State] merge topology from sim-state.json failed:', e.message);
    }
    return defaults;
  })();

  // 初始化状态
  updateSimState({
    running: simulationRuntime.running,
    gateways: config.multiGateway?.enabled
      ? config.multiGateway.gateways
      : [
          {
            eui: config.gatewayEui,
            name: 'default-gateway',
            position: config.signalModel?.gatewayPosition || { x: 0, y: 0, z: 30 },
          },
        ],
    config: {
      signalModel: config.signalModel,
      multiGateway: config.multiGateway,
      profileConfig: profileStateForUi(),
    },
    stats: { uplinks: 0, joins: 0, errors: 0 },
    packetLog: [],
    nodes: initialVizNodes,
    ...persistedTopologyFields,
  });

  const invPollSec = Number(config.chirpstack?.inventoryPollSec);
  const invPollMs = Number.isFinite(invPollSec) && invPollSec >= 5 ? invPollSec * 1000 : 60000;
  const topologyImportOn =
    String(process.env.ENABLE_CHIRPSTACK_TOPOLOGY || '').trim() !== ''
      ? /^(1|true|yes)$/i.test(String(process.env.ENABLE_CHIRPSTACK_TOPOLOGY))
      : Boolean(config.chirpstack && config.chirpstack.topologyEnabled);
  if (topologyImportOn) {
    void orchestrator.refreshChirpstackInventory();
    topologyInventoryTimer = setInterval(() => {
      orchestrator.refreshChirpstackInventory().catch((err) => console.warn('[Topology] inventory:', err.message));
    }, invPollMs);
  }

  console.log(`[State] State exporter started (interval: ${stateIntervalMs}ms)`);
  console.log(`[State] Write file: ${SIM_STATE_FILE} (read by local scripts/tools)`);
  // ===== 状态导出器结束 =====

  console.log('\n[✓] LoRaWAN Gateway Simulator started (standalone). Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
// ===============================
// 异常注入：injectAnomaly 来自 ./anomaly_module.js（单一事实来源）。
// ===============================


// ===============================
// 多网关支持模块 - Multi-Gateway Support Module
// ===============================

// 默认网关配置
const DEFAULT_GATEWAY_CONFIG = {
  enabled: false,
  mode: 'overlapping', // overlapping / handover / failover
  gateways: []
};
const PATH_LOSS_DISTANCE_MULTIPLIER = 10;

// 计算网关接收信号
function calculateGatewayReception(device, devicePosition, gateway, globalConfig) {
  const distance = calculateDistance(
    devicePosition,
    gateway.position || { x: 0, y: 0, z: 30 }
  ) * PATH_LOSS_DISTANCE_MULTIPLIER;
  
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
  const noiseFloor =
    gateway.noiseFloor != null
      ? Number(gateway.noiseFloor)
      : (globalConfig.signalModel?.noiseFloor ?? -120);
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

  return pickMultiGwReceivers(receptions, multiGwConfig);
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
    const topic = `${config.mqtt?.mqttTopicPrefix || 'as923'}/gateway/${frame.gatewayEui}/event/up`;
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
// ====== 多网关发送集成 ======
// 在原有的 MQTT publish 之前，检查是否启用多网关

function sendUplinkWithMultiGateway(phyPayload, device, deviceIndex, totalDevices, config, mqttClient) {
  if (!config.multiGateway || !config.multiGateway.enabled) {
    // 单网关模式：使用原有逻辑
    return null;
  }
  
  // 获取设备位置
  const devicePosition = device.position || generateDevicePosition(
    deviceIndex, totalDevices, config.signalModel?.nodePosition, 2000
  );
  
  // 计算各网关接收情况
  const multiGwConfig = config.multiGateway;
  const freqHz = Number(config.uplink?.rf?.frequency) || 923200000;
  const receptions = multiGwConfig.gateways.map(gw => {
    const signal = calculateGatewayReceptionForDevice(device, devicePosition, gw, config, freqHz);
    return {
      eui: gw.eui,
      name: gw.name,
      ...signal
    };
  }).filter(r => r.canReceive);

  const selectedGateways = pickMultiGwReceivers(receptions, multiGwConfig);

  if (selectedGateways.length === 0) {
    console.log(`[Multi-GW] No gateway can receive from device ${device.name || deviceIndex}`);
    return [];
  }
  
  console.log(`[Multi-GW] Device ${device.name || deviceIndex} will be received by ${selectedGateways.length} gateway(s): ${selectedGateways.map(g => g.name || g.eui).join(', ')}`);
  
  return selectedGateways;
}

// 与 calculateGatewayReception 同一套路径损耗/衰落（含 shadow、fast fading），供 UDP/MQTT 多网关路径使用
function calculateGatewayReceptionForDevice(device, devicePos, gateway, globalConfig, frequencyHz) {
  const freq =
    frequencyHz != null && Number.isFinite(Number(frequencyHz))
      ? Number(frequencyHz)
      : device?.frequency || globalConfig?.uplink?.rf?.frequency || 923200000;
  const dev = device && typeof device === 'object' ? { ...device, frequency: freq } : { frequency: freq };
  return calculateGatewayReception(dev, devicePos, gateway, globalConfig);
}

