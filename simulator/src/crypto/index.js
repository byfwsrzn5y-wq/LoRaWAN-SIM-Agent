/**
 * LoRaWAN Crypto Module
 * AES-ECB, AES-CMAC, LoRaWAN encryption/decryption
 */

const crypto = require('crypto');

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
  
  const L = aes128EcbEncryptBlock(keyBuf, zero16);
  
  let K1 = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const newCarry = (L[i] & 0x80) ? 1 : 0;
    K1[i] = ((L[i] << 1) & 0xff) | carry;
    carry = newCarry;
  }
  if (L[0] & 0x80) K1[15] ^= constRb;
  
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
  
  for (let i = 0; i < n - 1; i++) {
    const block = messageBuf.slice(i * 16, (i + 1) * 16);
    X = aes128EcbEncryptBlock(keyBuf, xor16(X, block));
  }
  
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

module.exports = {
  aes128EcbEncryptBlock,
  aesCmac,
  lorawanEncrypt,
  lorawanDecrypt,
  xor16
};
