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
  nowIso
};
