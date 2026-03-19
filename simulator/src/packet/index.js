/**
 * LoRaWAN Packet Builder Module
 * Join Request/Accept, Uplink/Downlink packet construction
 */

const { aes128EcbEncryptBlock, aesCmac, lorawanEncrypt } = require('../crypto');

function buildJoinRequest(appEuiBuf, devEuiBuf, devNonce, nwkKeyBuf) {
  const MHDR = Buffer.from([0x00]);
  const msg = Buffer.concat([
    MHDR,
    Buffer.from(appEuiBuf).reverse(),
    Buffer.from(devEuiBuf).reverse(),
    Buffer.from([devNonce & 0xff, (devNonce >> 8) & 0xff]),
  ]);
  const mic = aesCmac(nwkKeyBuf, msg);
  return Buffer.concat([msg, mic]);
}

function decryptJoinAccept(encryptedPayload, keyBuf) {
  if (encryptedPayload.length !== 16 && encryptedPayload.length !== 32) return null;
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
  const block = Buffer.alloc(16, 0);
  
  block[0] = 0x01;
  block[1] = appNonce[0];
  block[2] = appNonce[1];
  block[3] = appNonce[2];
  block[4] = netId[0];
  block[5] = netId[1];
  block[6] = netId[2];
  block[7] = devNonce & 0xff;
  block[8] = (devNonce >> 8) & 0xff;
  
  const nwkSKey = aes128EcbEncryptBlock(nwkKeyBuf, block);

  block[0] = 0x02;
  const appSKey = aes128EcbEncryptBlock(nwkKeyBuf, block);
  
  return { nwkSKey, appSKey };
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

module.exports = {
  buildJoinRequest,
  decryptJoinAccept,
  deriveSessionKeys,
  buildLorawanUplinkAbp
};
