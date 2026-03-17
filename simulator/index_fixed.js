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
let mqttLib = null;
let mqttClient = null;
let protobuf = null;
let gwProto = null;

const PROTOCOL_VERSION = 2;

// FCnt 持久化预留（当前为内存态，未写盘）
const FCNT_STATE_FILE = path.join(__dirname, 'fcnt_state.json');
let globalFCntState = {};
const globalDeviceMap = {};
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
  const len = Math.min(Math.max(payloadLength || 4, 2), 20);
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

function decryptJoinAccept(encryptedPayload, appKeyBuf) {
  if (encryptedPayload.length !== 16 && encryptedPayload.length !== 32) return null;
  const decipher = crypto.createDecipheriv('aes-128-ecb', appKeyBuf, null);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
  const appNonce = dec.slice(0, 3);
  const netId = dec.slice(3, 6);
  const devAddr = dec.slice(6, 10);
  const dlSettings = dec[10];
  const rxDelay = dec[11];
  const cfList = dec.length >= 28 ? dec.slice(12, 28) : null;
  return { appNonce, netId, devAddr, dlSettings, rxDelay, cfList };
}

function deriveSessionKeys(appKeyBuf, appNonce, netId, devNonce) {
  const block = Buffer.alloc(16, 0);
  block[0] = 0x01;
  appNonce.copy(block, 1);
  netId.copy(block, 4);
  block[6] = devNonce & 0xff;
  block[7] = (devNonce >> 8) & 0xff;
  const nwkSKey = aes128EcbEncryptBlock(appKeyBuf, block);

  block[0] = 0x02;
  const appSKey = aes128EcbEncryptBlock(appKeyBuf, block);
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

function buildLorawanUplinkAbp({ nwkSKey, appSKey, devAddr, fCntUp, fPort, confirmed, payload, macCommands, ackDownlink }) {
  const MHDR = Buffer.from([confirmed ? 0x80 : 0x40]);

  let FOpts = Buffer.alloc(0);
  if (macCommands && macCommands.length > 0) {
    const macBuffers = macCommands.map(cmd => Buffer.concat([Buffer.from([cmd.cid]), cmd.payload]));
    FOpts = Buffer.concat(macBuffers);
    if (FOpts.length > 15) FOpts = FOpts.slice(0, 15);
  }

  let fctrlByte = FOpts.length & 0x0f;
  if (ackDownlink) fctrlByte |= 0x20;
  fctrlByte |= 0x80;
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
  return new Date().toISOString();
}

function sfBwString(sf, bw) {
  return `SF${sf}BW${bw}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function readConfig(configPath) {
  const absolute = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
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
    if (template.duplicateFirstData !== undefined) out.duplicateFirstData = template.duplicateFirstData; else if (baseline.duplicateFirstData !== undefined) out.duplicateFirstData = baseline.duplicateFirstData;
  } else {
    if (template.nodeState) out.nodeState = { ...template.nodeState };
    if (template.uplink) out.uplink = { ...template.uplink };
    if (template.lorawan) out.lorawan = { ...template.lorawan };
    if (template.devStatus) out.devStatus = { ...template.devStatus };
    if (template.adrReject !== undefined) out.adrReject = template.adrReject;
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
    rssi: clamp(Number(rssi ?? -42), -120, 10),
    lsnr: Number(lsnr ?? 5.5),
    size,
    data: base64Payload,
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const result = { config: 'config.json', deviceCount: null, frequency: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-c' || a === '--config') && args[i + 1]) result.config = args[++i];
    else if (a === '--device-count' && args[i + 1]) result.deviceCount = parseInt(args[++i]);
    else if (a === '--frequency' && args[i + 1]) result.frequency = parseInt(args[++i]);
  }
  return result;
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

// -----------------------------
// MQTT Downlink Handler Factory
// -----------------------------
function createMqttHandlers(mqttMarshaler, mqttTopicPrefix, gatewayEuiBuf, gwProto, mqttClient, mqttCfg) {
  const mqttOpts = mqttCfg || {};
  let downlinkCount = 0;
  const macResponseQueues = {};

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
            if (chMaskCntl === 0 && (chMask & 0xFF00) === 0 && chMask !== 0) statusByte |= 0x01;
            if (statusByte === 0x07) {
              device.macParams.dataRate = dataRate;
              device.macParams.txPower = txPower;
              device.macParams.channelMask = chMask;
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
            const rx2Frequency = (cmd.payload[1] | (cmd.payload[2] << 8) | (cmd.payload[3] << 16)) * 100;
            let statusByte = 0x00;
            if (rx1DROffset >= 0 && rx1DROffset <= 7) statusByte |= 0x04;
            if (rx2DataRate >= 0 && rx2DataRate <= 7) statusByte |= 0x02;
            if (rx2Frequency >= 915000000 && rx2Frequency <= 928000000) statusByte |= 0x01;
            if (statusByte === 0x07) {
              device.macParams.rx1DROffset = rx1DROffset;
              device.macParams.rx2DataRate = rx2DataRate;
              device.macParams.rx2Frequency = rx2Frequency;
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

  function handleMqttDownlink(topic, payload) {
    downlinkCount++;
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try {
      let downlinkFrame, downlinkId, phyPayload;
      if (mqttMarshaler === 'protobuf') {
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

      let devAddr = 'unknown', fPort = null, frmPayload = null, fOpts = null, macCommands = [];

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
                const parsed = decryptJoinAccept(encrypted, pending.appKeyBuf);
                if (parsed && parsed.devAddr) {
                  // Verify by deriving keys - this ensures it's the correct device
                  try {
                    deriveSessionKeys(pending.appKeyBuf, parsed.appNonce, parsed.netId, pending.devNonce);
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
              const { nwkSKey, appSKey } = deriveSessionKeys(matchedPending.appKeyBuf, matchedParsed.appNonce, matchedParsed.netId, matchedPending.devNonce);
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
          const isConfirmed = (mType === 0x05);
          devAddr = phyPayload.slice(1, 5).reverse().toString('hex');
          const fctrl = phyPayload[5];
          const foptsLen = fctrl & 0x0F;
          const ackBit = (fctrl >> 5) & 0x01;
          const fcnt = phyPayload.readUInt16LE(6);
          if (foptsLen > 0) {
            fOpts = phyPayload.slice(8, 8 + foptsLen);
            macCommands = parseMacCommands(fOpts);
          }
          const payloadStart = 8 + foptsLen;
          if (phyPayload.length > payloadStart + 4) {
            fPort = phyPayload[payloadStart];
            frmPayload = phyPayload.slice(payloadStart + 1, phyPayload.length - 4);
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

          const mTypeName = isConfirmed ? 'Confirmed' : 'Unconfirmed';
          const ackInfo = ackBit ? ' | LNS-ACK:✓' : '';
          if (macCommands.length > 0) {
            const cmdNames = macCommands.map(cmd => cmd.name).join(', ');
            console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr} | MAC: [${cmdNames}]${ackInfo}`);
          } else if (fPort !== null) {
            console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr} | FPort: ${fPort}${ackInfo}`);
          } else {
            console.log(`[⬇ ${timestamp}] Downlink #${downlinkCount} | ${mTypeName} | ID: ${downlinkId} | DevAddr: ${devAddr}${ackInfo}`);
          }

          if (isConfirmed) {
            if (!macResponseQueues[devAddr]) macResponseQueues[devAddr] = [];
            macResponseQueues[devAddr].needsAck = true;
          }
          if (macCommands.length > 0) handleMacCommands(devAddr, macCommands);
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
      if (mqttMarshaler === 'protobuf') {
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

  return { handleMqttDownlink, getMacResponses, downlinkCount: () => downlinkCount };
}

async function main() {
  const cliArgs = parseCliArgs();
  const config = readConfig(cliArgs.config);

  if (cliArgs.deviceCount !== null) {
    if (!config.lorawan) config.lorawan = {};
    config.lorawan.deviceCount = cliArgs.deviceCount;
  }
  if (cliArgs.frequency !== null) {
    if (!config.uplink) config.uplink = {};
    config.uplink.interval = cliArgs.frequency * 1000;
  }

  const gatewayEuiBuf = euiStringToBuffer(config.gatewayEui || '0102030405060708');
  const lnsHost = config.lnsHost || '127.0.0.1';
  const lnsPort = Number(config.lnsPort || 1700);
  const bindPort = Number(config.udpBindPort || 0);

  const mqttCfg = config.mqtt || {};
  const mqttEnabled = Boolean(mqttCfg.enabled);
  const mqttMarshaler = String(mqttCfg.marshaler || 'json').toLowerCase();
  const mqttTopicPrefix = String(mqttCfg.topicPrefix || 'gateway').replace(/\/$/, '');

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
    if (mqttMarshaler === 'protobuf') {
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
    mqttHandlers = createMqttHandlers(mqttMarshaler, mqttTopicPrefix, gatewayEuiBuf, gwProto, mqttClient, mqttCfg);

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
      if (rinfo.address !== lnsHost || rinfo.port !== lnsPort) return;
      if (msg.length < 4) return;
      const version = msg[0], tokenHi = msg[1], tokenLo = msg[2], identifier = msg[3];
      if (version !== PROTOCOL_VERSION) return;
      if (identifier === PKT.PULL_ACK) { console.log('<= PULL_ACK'); return; }
      if (identifier === PKT.PUSH_ACK) { console.log('<= PUSH_ACK'); return; }
      if (identifier === PKT.PULL_RESP) {
        try {
          const obj = JSON.parse(msg.slice(4).toString('utf8'));
          console.log('<= PULL_RESP (downlink):', JSON.stringify(obj));
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
    function sendPull() {
      const pull = createPullDataPacket(gatewayEuiBuf);
      socket.send(pull, 0, pull.length, lnsPort, lnsHost, (err) => {
        if (err) console.error('PULL_DATA send failed:', err.message);
        else console.log('=> PULL_DATA');
      });
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
      const stat = { time: nowIso(), rxnb: 0, rxok: 0, rxfw: 0, ackr: 100.0, dwnb: 0, txnb: 0 };
      if (!mqttEnabled) {
        const pkt = createPushStatPacket(gatewayEuiBuf, stat);
        socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
          if (err) console.error('PUSH_DATA (stat) send failed:', err.message);
          else console.log('=> PUSH_DATA stat');
        });
      } else {
        const topic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/event/stats`;
        let payload;
        if (mqttMarshaler === 'protobuf') {
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

    function readIntervalMs() {
      const raw = (uplinkCfg.intervalMs !== undefined && uplinkCfg.intervalMs !== null)
        ? uplinkCfg.intervalMs
        : (uplinkCfg.interval !== undefined && uplinkCfg.interval !== null ? uplinkCfg.interval : 10000);
      return Number(raw);
    }

    const sendUplink = () => {
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
        const devNonce = lorawanDevice.devNonce;
        lorawanDevice.devNonce = (devNonce + 1) % 65536;
        const phy = buildJoinRequest(lorawanDevice.appEui, lorawanDevice.devEui, devNonce, lorawanDevice.appKeyBuf);
        base64Payload = phy.toString('base64');
        pendingOtaaDevices.push({ appKeyBuf: lorawanDevice.appKeyBuf, devNonce, otaaDevice: lorawanDevice });
        console.log(`[OTAA] Join Request sent | DevEUI: ${lorawanDevice.devEui.toString('hex')} | DevNonce: ${devNonce} `);
      } else if (lorawanDevice && (!lorawanDevice.isOtaa || lorawanDevice.joined)) {
        const fPort = Number((uplinkCfg.lorawan && uplinkCfg.lorawan.fPort) || 1);
        const devAddrHex = lorawanDevice.devAddrHex || lorawanDevice.devAddr.toString('hex');
        const macResponses = mqttHandlers ? mqttHandlers.getMacResponses(devAddrHex) : [];
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
        const phy = buildLorawanUplinkAbp({
          nwkSKey: lorawanDevice.nwkSKey,
          appSKey: lorawanDevice.appSKey,
          devAddr: devAddrLE,
          fCntUp: useFcnt,
          fPort,
          confirmed,
          payload: bytes,
          macCommands: allMacCommands,
          ackDownlink: needsAck,
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

      let sf = rf.sf || 7;
      if (lorawanDevice && lorawanDevice.macParams && lorawanDevice.macParams.dataRate !== undefined) {
        const drToSf = [12, 11, 10, 9, 8, 7];
        const dr = lorawanDevice.macParams.dataRate;
        if (dr >= 0 && dr <= 5) sf = drToSf[dr];
      }

      let rssi = rf.rssi ?? -42;
      let lsnr = rf.lsnr ?? 5.5;
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

      const dropRatio = Number(uplinkCfg.uplinkDropRatio || 0);
      if (dropRatio > 0 && Math.random() < dropRatio) {
        sentCount += 1;
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
        const pkt = createPushDataPacket(gatewayEuiBuf, [rxpk]);
        socket.send(pkt, 0, pkt.length, lnsPort, lnsHost, (err) => {
          if (err) console.error('PUSH_DATA send failed:', err.message);
          else console.log('=> PUSH_DATA', label ? `[${label}]` : '', 'size', rxpk.size);
        });
      } else {
        const topic = `${mqttTopicPrefix}/gateway/${gatewayEuiBuf.toString('hex')}/event/up`;
        const bwHz = Number(rf.bw || 125) * 1000;
        let payloadOut;
        console.log('[DEBUG] mqttMarshaler value:', mqttMarshaler);
        if (mqttMarshaler === 'protobuf') {
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
        mqttClient.publish(topic, payloadOut, { qos: mqttCfg.qos || 0 }, (err) => {
          if (err) console.error('[✗] Uplink publish failed:', err.message);
          else {
            uplinkCount++;
            const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const devAddr = lorawanDevice && lorawanDevice.devAddr ? lorawanDevice.devAddr.toString('hex').toUpperCase() : 'N/A';
            const devEuiUp = lorawanDevice ? lorawanDevice.devEui.toString('hex').toUpperCase() : 'N/A';
            const fCnt = lorawanDevice ? lorawanDevice.fCntUp - 1 : 0;
            console.log(`[⬆ ${timestamp}] Uplink #${uplinkCount} | ${label || 'device'} | DevAddr:${devAddr} FCnt:${fCnt}`);
            if (lorawanDevice && mqttEnabled) {
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
      const burstCount = Number(uplinkCfg.burstCount || 0);
      const burstIntervalMs = Number(uplinkCfg.burstIntervalMs || 0);
      const silenceAfterBurstMs = Number(uplinkCfg.silenceAfterBurstMs || 0);
      const intervalAfterFirstDataMs = Number(uplinkCfg.intervalAfterFirstDataMs || 0);
      let nextDelay;
      if (sentCount === 1 && intervalAfterFirstDataMs > 0 && lorawanDevice && lorawanDevice.joined) {
        nextDelay = Math.max(50, intervalAfterFirstDataMs);
      } else if (burstCount > 0 && burstIntervalMs > 0 && silenceAfterBurstMs > 0) {
        nextDelay = (sentCount > 0 && sentCount % burstCount === 0) ? silenceAfterBurstMs : burstIntervalMs;
        nextDelay = Math.max(50, nextDelay);
      } else {
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
          const appKeyBuf = hexToBufLen(appKeyStr, 16);
          const otaaDevice = {
            isOtaa: true,
            appEui,
            devEui,
            appKey: appKeyStr,
            appKeyBuf,
            devNonce: Math.floor(Math.random() * 65535),
            joined: false
          };
          initNodeState(autoDevices.length, otaaDevice, lorawanCfg, globalUplink, regionChannels);
          seenDevices.add(deviceName);
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
          const lorawanDevice = { devAddr, nwkSKey, appSKey, devEui, fCntUp, classC, macParams: { ...macParamsDefault } };
          initNodeState(autoDevices.length, lorawanDevice, lorawanCfg, globalUplink, regionChannels);
          globalDeviceMap[devAddr.toString('hex')] = lorawanDevice;
          seenDevices.add(deviceName);
          autoDevices.push({ name: deviceName, lorawanDevice, uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}) });
        }
      }
      const abpCount = autoDevices.filter(d => !d.lorawanDevice.isOtaa).length;
      const otaaCount = autoDevices.filter(d => d.lorawanDevice.isOtaa).length;
      console.log(`[✅] 从CSV加载 ${autoDevices.length} 个设备 (ABP: ${abpCount}, OTAA: ${otaaCount})`);
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
      const act = (d.lorawan && d.lorawan.activation) || d.activation || 'OTAA';
      if (act !== 'OTAA') continue;
      const appEui = (d.lorawan && d.lorawan.appEui) ? hexToBufLen(String(d.lorawan.appEui).trim(), 8) : genSequentialDevEui(appEuiBase, i);
      const devEui = (d.lorawan && d.lorawan.devEui) ? hexToBufLen(String(d.lorawan.devEui).trim(), 8) : genSequentialDevEui(devEuiBase, i);
      const appKey = (d.lorawan && d.lorawan.appKey) ? String(d.lorawan.appKey).trim() : appKeyDefault;
      if (!appKey) continue;
      const appKeyBuf = hexToBufLen(appKey, 16);
      const otaaDevice = {
        isOtaa: true,
        appEui,
        devEui,
        appKey,
        appKeyBuf,
        devNonce: 0,
        joined: false
      };
      if (d.adrReject) otaaDevice.adrReject = true;
      if (d.devStatus) otaaDevice.devStatus = d.devStatus;
      if (d.duplicateFirstData) otaaDevice.duplicateFirstData = true;
      if (d.lorawan && d.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(d.lorawan.dataRate);
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
          devNonce: 0,
          joined: false
        };
        if (applied.adrReject) otaaDevice.adrReject = true;
        if (applied.devStatus) otaaDevice.devStatus = applied.devStatus;
        if (applied.duplicateFirstData || (applied.uplink && applied.uplink.duplicateFirstData)) otaaDevice.duplicateFirstData = true;
        if (applied.lorawan && applied.lorawan.dataRate !== undefined) otaaDevice.macParams.dataRate = Number(applied.lorawan.dataRate);
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
      const lorawanDevice = { devAddr, nwkSKey, appSKey, devEui, fCntUp, classC, macParams };
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
      const otaaDevice = {
        isOtaa: true,
        appEui,
        devEui,
        appKey: lorawanCfg.appKey.trim(),
        appKeyBuf,
        devNonce: 0,
      };
      initNodeState(i, otaaDevice, lorawanCfg, globalUplink, regionChannels);
      autoDevices.push({
        name: lorawanCfg.otaaName ? `${lorawanCfg.otaaName}-${i + 1}` : `otaa-node-${i + 1}`,
        lorawanDevice: otaaDevice,
        uplink: mergeUplinkCfg(globalUplink, lorawanCfg.uplink || {}),
      });
    }
    console.log(`[✅] OTAA 节点已加载: ${n} 个 | AppEUI 起始: ${n > 1 ? lorawanCfg.appEuiStart : lorawanCfg.appEui} | DevEUI 起始: ${n > 1 ? lorawanCfg.devEuiStart : lorawanCfg.devEui}`);
  }

  const allDevices = devices.length > 0 ? devices.map(d => ({ name: d.name, uplink: mergeUplinkCfg(globalUplink, d.uplink || {}) })) : [];
  const schedTargets = autoDevices.length > 0 ? autoDevices : (allDevices.length > 0 ? allDevices : null);

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

  const controlCfg = config.controlServer || config.control || {};
  if (controlCfg.enabled && (controlCfg.port || controlCfg.port === 0)) {
    const controlPort = Number(controlCfg.port) || 9999;
    const server = http.createServer((req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const url = req.url || '';
      if ((req.method === 'GET' || req.method === 'POST') && (url.startsWith('/reset') || url === '/reset')) {
        let devEui = null;
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const j = body ? JSON.parse(body) : {};
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
        const q = url.indexOf('?');
        if (q >= 0) {
          const params = new URLSearchParams(url.slice(q));
          devEui = params.get('devEui') || params.get('DevEUI');
        }
        if (devEui) {
          const ok = resetDeviceByDevEui(devEui);
          return send(200, { ok, message: ok ? `Device ${devEui} reset.` : `Device ${devEui} not found.` });
        }
        const n = resetAllOtaa();
        return send(200, { ok: true, message: `${n} OTAA device(s) reset for re-join.` });
      }
      send(404, { ok: false, message: 'Not found. Use GET/POST /reset?devEui=... or POST /reset with body { devEui }. Omit devEui to reset all OTAA.' });
    });
    server.listen(controlPort, controlCfg.host || '0.0.0.0', () => {
      console.log(`[Control] HTTP server on port ${controlPort} | POST /reset { "devEui": "..." } or GET /reset?devEui=... to reset device; omit devEui to reset all OTAA.`);
    });
  }

  function shutdown() {
    console.log('\n[🛑] Stopping simulator...\n');
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

  console.log('\n[✓] LoRaWAN Gateway Simulator started (standalone). Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
