/**
 * Constants Module
 */

const PKT = {
  PUSH_DATA: 0x00,
  PUSH_ACK: 0x01,
  PULL_DATA: 0x02,
  PULL_RESP: 0x03,
  PULL_ACK: 0x04,
  TX_ACK: 0x05,
};

const PROTOCOL_VERSION = 2;

const REGIONS = {
  'AS923-1': {
    channels: [
      923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6,
    ],
  },
};

const TX_POWER_DBM_AS923 = [16, 14, 12, 10, 8, 6, 4, 2];

module.exports = {
  PKT,
  PROTOCOL_VERSION,
  REGIONS,
  TX_POWER_DBM_AS923
};
