/**
 * Utility Functions Module
 */

const crypto = require('crypto');

function hexToBufLen(hexStr, len) {
  const buf = Buffer.from(hexStr.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  if (buf.length === len) return buf;
  if (buf.length < len) return Buffer.concat([Buffer.alloc(len - buf.length, 0), buf]);
  return buf.slice(buf.length - len);
}

function genRandomBytes(n) {
  return crypto.randomBytes(n);
}

function genSequentialDevAddr(startHex, index) {
  const start = parseInt(startHex.replace(/[^0-9a-fA-F]/g, ''), 16);
  const addr = (start + index) & 0xffffffff;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(addr, 0);
  return buf;
}

function genSequentialDevEui(startHex, index) {
  const clean = startHex.replace(/[^0-9a-fA-F]/g, '');
  const start = BigInt('0x' + clean);
  const eui = (start + BigInt(index)) & BigInt('0xFFFFFFFFFFFFFFFF');
  const hex = eui.toString(16).padStart(16, '0');
  return Buffer.from(hex, 'hex');
}

function bufToHexUpper(buf) {
  return buf.toString('hex').toUpperCase();
}

function devAddrToHexUpperBE(devAddrLE) {
  return Buffer.from(devAddrLE).reverse().toString('hex').toUpperCase();
}

function hexToBuffer(hex) {
  return Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
}

function euiStringToBuffer(euiStr) {
  return hexToBuffer(euiStr);
}

function toBase64FromHexOrBase64(str, format) {
  if (format === 'base64') return str;
  return Buffer.from(str.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('base64');
}

function sfBwString(sf, bw) {
  return `SF${sf}BW${Math.round(bw / 1000)}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pickWeighted(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 是否在上行 Data 帧 FCtrl 中置 ADR 位（与 ChirpStack ADR 联动）。
 * 优先级：deviceSpec.lorawan.adr → deviceSpec.adr → lorawanCfg.adr → 默认 true。
 * @param {object | null | undefined} deviceSpec - 配置里的单设备对象或行为模板合并结果
 * @param {object | null | undefined} lorawanCfg - config.lorawan
 */
function resolveLorawanAdrEnabled(deviceSpec, lorawanCfg) {
  const lw = deviceSpec && deviceSpec.lorawan;
  if (lw && typeof lw.adr === 'boolean') return lw.adr;
  if (deviceSpec && typeof deviceSpec.adr === 'boolean') return deviceSpec.adr;
  if (lorawanCfg && typeof lorawanCfg.adr === 'boolean') return lorawanCfg.adr;
  return true;
}

/**
 * LinkADRAns status bit0 (channel mask ACK). ChirpStack often sends ChMaskCntl=6 with ChMask=0
 * ("all default channels on" per regional params); the old check only allowed cntl===0 && mask!==0,
 * which made ch_mask_ack false forever and tripped chirpstack::maccommand::link_adr warnings.
 */
function linkAdrChannelMaskAck(chMask, chMaskCntl) {
  const cntl = chMaskCntl & 0x07;
  const m = chMask & 0xffff;
  if (cntl === 0) {
    // ChirpStack/NS + tooling sometimes leads to a byte-order / mapping
    // mismatch between "channel bits list" views and how this simulator
    // reads ChMask (readUInt16LE).
    // Keep the check strict enough to avoid masking arbitrary masks:
    // accept only masks where one byte is all-zero and the other byte is non-zero.
    const low = m & 0x00ff;
    const high = m & 0xff00;
    return m !== 0 && ((low !== 0 && high === 0) || (high !== 0 && low === 0));
  }
  if (cntl === 6 || cntl === 7) return true;
  return false;
}

/** Stored channel mask after a fully accepted LinkADRReq (status 0x07). */
function linkAdrAppliedChannelMask(chMask, chMaskCntl) {
  const cntl = chMaskCntl & 0x07;
  if (cntl === 6 || cntl === 7) return 0xffff;
  return chMask & 0xffff;
}

module.exports = {
  hexToBufLen,
  genRandomBytes,
  genSequentialDevAddr,
  genSequentialDevEui,
  bufToHexUpper,
  devAddrToHexUpperBE,
  hexToBuffer,
  euiStringToBuffer,
  toBase64FromHexOrBase64,
  sfBwString,
  clamp,
  shuffleArray,
  pickWeighted,
  nowIso,
  resolveLorawanAdrEnabled,
  linkAdrChannelMaskAck,
  linkAdrAppliedChannelMask
};
