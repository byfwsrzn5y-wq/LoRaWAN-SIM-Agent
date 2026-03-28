/**
 * MAC Commands Module
 * LoRaWAN MAC command parser and response generator
 */

const { linkAdrChannelMaskAck, linkAdrAppliedChannelMask } = require('../utils');

// MAC Command definitions
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

/**
 * Parse MAC commands from FOpts or Port 0 payload
 * @param {Buffer} payload - Raw MAC command bytes
 * @returns {Array} Array of parsed commands
 */
function parseMacCommands(payload) {
  const commands = [];
  let offset = 0;

  while (offset < payload.length) {
    const cid = payload[offset];
    const cmdInfo = MAC_COMMANDS[cid];
    if (!cmdInfo) { offset++; continue; }
    
    const cmd = {
      cid,
      name: cmdInfo.name,
      payload: payload.slice(offset + 1, offset + 1 + cmdInfo.length)
    };

    // Parse command-specific parameters
    switch (cid) {
      case 0x03: // LinkADRReq
        cmd.params = {
          dataRate: (cmd.payload[0] >> 4) & 0x0F,
          txPower: cmd.payload[0] & 0x0F,
          chMask: cmd.payload.readUInt16LE(1),
          redundancy: cmd.payload[3]
        };
        break;
      case 0x05: // RXParamSetupReq
        cmd.params = {
          rx1DROffset: (cmd.payload[0] >> 4) & 0x07,
          rx2DR: cmd.payload[0] & 0x0F,
          rx2Freq: (cmd.payload[1] | (cmd.payload[2] << 8) | (cmd.payload[3] << 16)) * 100
        };
        break;
      case 0x09: // TXParamSetupReq
        cmd.params = {
          maxEIRP: cmd.payload[0] & 0x0F,
          uplinkDwellTime: (cmd.payload[0] & 0x10) ? 400 : 0,
          downlinkDwellTime: (cmd.payload[0] & 0x20) ? 400 : 0
        };
        break;
    }
    
    commands.push(cmd);
    offset += 1 + cmdInfo.length;
  }
  
  return commands;
}

/**
 * Generate MAC command responses
 * @param {Array} commands - Received commands
 * @param {Object} device - Device state object
 * @returns {Array} Array of response commands
 */
function generateMacResponses(commands, device) {
  const responses = [];
  
  if (!device) return responses;
  if (!device.macParams) {
    device.macParams = {
      maxEIRP: 16,
      uplinkDwellTime: 400,
      downlinkDwellTime: 400,
      rx1DROffset: 0,
      rx2DataRate: 2,
      rx2Frequency: 923200000,
      dataRate: 0,
      txPower: 0,
      channelMask: 0xFFFF,
      nbTrans: 1,
      channels: [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6]
    };
  }

  commands.forEach(cmd => {
    let response = null;
    
    switch (cmd.cid) {
      case 0x03: // LinkADRReq -> LinkADRAns
        if (device.adrReject) {
          response = { cid: 0x03, name: 'LinkADRAns', payload: Buffer.from([0x00]) };
        } else if (cmd.payload && cmd.payload.length >= 4) {
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
        if (cmd.payload && cmd.payload.length >= 4) {
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
        
      case 0x06: // DevStatusReq -> DevStatusAns
        if (device.devStatus) {
          const bat = Math.max(0, Math.min(255, Number(device.devStatus.battery) ?? 255));
          const margin = Math.max(-32, Math.min(31, Number(device.devStatus.margin) ?? 5));
          const marginByte = (margin + 32) & 0x3f;
          response = { cid: 0x06, name: 'DevStatusAns', payload: Buffer.from([bat, marginByte]) };
        } else {
          response = { cid: 0x06, name: 'DevStatusAns', payload: Buffer.from([200, 5]) };
        }
        break;
        
      case 0x07: // NewChannelReq -> NewChannelAns
        if (cmd.payload && cmd.payload.length >= 5) {
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
        
      case 0x08: // RXTimingSetupReq -> RXTimingSetupAns
        response = { cid: 0x08, name: 'RXTimingSetupAns', payload: Buffer.from([]) };
        break;
        
      case 0x09: // TXParamSetupReq -> TXParamSetupAns
        if (cmd.payload && cmd.payload.length >= 1) {
          const eirpDwellTime = cmd.payload[0];
          device.macParams.maxEIRP = eirpDwellTime & 0x0F;
          device.macParams.uplinkDwellTime = (eirpDwellTime & 0x10) ? 400 : 0;
          device.macParams.downlinkDwellTime = (eirpDwellTime & 0x20) ? 400 : 0;
        }
        response = { cid: 0x09, name: 'TXParamSetupAns', payload: Buffer.from([]) };
        break;
        
      case 0x0A: // DLChannelReq -> DLChannelAns
        response = { cid: 0x0A, name: 'DLChannelAns', payload: Buffer.from([0x03]) };
        break;
    }
    
    if (response) responses.push(response);
  });
  
  return responses;
}

module.exports = {
  MAC_COMMANDS,
  parseMacCommands,
  generateMacResponses
};
