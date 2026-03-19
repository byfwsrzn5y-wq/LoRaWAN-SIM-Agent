/**
 * Transport Layer Module
 * UDP and MQTT transport for Gateway Bridge
 */

const dgram = require('dgram');
const { PKT, PROTOCOL_VERSION } = require('../constants');

// Packet Builders
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

// UDP Transport
class UdpTransport {
  constructor(bindPort = 0) {
    this.socket = null;
    this.bindPort = bindPort;
  }

  async createSocket() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.once('error', reject);
      this.socket.bind(this.bindPort || 0, () => {
        this.socket.off('error', reject);
        resolve(this.socket);
      });
    });
  }

  send(message, port, host) {
    return new Promise((resolve, reject) => {
      this.socket.send(message, port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onMessage(handler) {
    this.socket.on('message', handler);
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket) this.socket.close(resolve);
      else resolve();
    });
  }

  // Gateway Protocol Packet Builders
  createPushDataPacket(gatewayEuiBuf, rxpkArray, token) {
    const [tHi, tLo] = token || randToken();
    const header = buildHeader(tHi, tLo, PKT.PUSH_DATA);
    const payload = Buffer.concat([gatewayEuiBuf, Buffer.from(JSON.stringify({ rxpk: rxpkArray }))]);
    return Buffer.concat([header, payload]);
  }

  createPushStatPacket(gatewayEuiBuf, statObj, token) {
    const [tHi, tLo] = token || randToken();
    const header = buildHeader(tHi, tLo, PKT.PUSH_DATA);
    const payload = Buffer.concat([gatewayEuiBuf, Buffer.from(JSON.stringify({ stat: statObj }))]);
    return Buffer.concat([header, payload]);
  }

  createPullDataPacket(gatewayEuiBuf, token) {
    const [tHi, tLo] = token || randToken();
    const header = buildHeader(tHi, tLo, PKT.PULL_DATA);
    return Buffer.concat([header, gatewayEuiBuf]);
  }

  createTxAckPacket(gatewayEuiBuf, referencedToken, error) {
    const [tHi, tLo] = referencedToken || randToken();
    const header = buildHeader(tHi, tLo, PKT.TX_ACK);
    const ack = { txpk_ack: { error: error || 'NONE' } };
    return Buffer.concat([header, gatewayEuiBuf, Buffer.from(JSON.stringify(ack))]);
  }
}

// MQTT Transport
class MqttTransport {
  constructor(mqttClient, topicPrefix) {
    this.client = mqttClient;
    this.topicPrefix = topicPrefix || 'gateway';
  }

  publishUplink(gatewayId, payload) {
    const topic = `${this.topicPrefix}/${gatewayId}/event/up`;
    return this.client.publish(topic, payload);
  }

  publishStats(gatewayId, stats) {
    const topic = `${this.topicPrefix}/${gatewayId}/event/stats`;
    return this.client.publish(topic, JSON.stringify(stats));
  }

  subscribeDownlink(gatewayId, handler) {
    const topic = `${this.topicPrefix}/${gatewayId}/command/down`;
    this.client.subscribe(topic);
    this.client.on('message', (receivedTopic, message) => {
      if (receivedTopic === topic) {
        handler(message);
      }
    });
  }
}

module.exports = {
  UdpTransport,
  MqttTransport,
  buildHeader,
  randToken
};
