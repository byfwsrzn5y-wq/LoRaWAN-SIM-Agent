/**
 * Optional MQTT client for ChirpStack application integration (uplink JSON + rxInfo)
 * when the main simulator uses UDP gateway bridge (no shared mqtt client).
 */

function startChirpstackIntegrationMqtt(cfg, orchestrator, log) {
  const im = cfg && typeof cfg === 'object' ? cfg : {};
  if (!im.enabled) return { stop: () => {} };
  const url = String(im.server || im.url || '').trim();
  if (!url) {
    if (log) log('[Topology MQTT] integrationMqtt.enabled but no server/url');
    return { stop: () => {} };
  }
  let mqttLib;
  try {
    mqttLib = require('mqtt');
  } catch (e) {
    if (log) log('[Topology MQTT] mqtt module missing');
    return { stop: () => {} };
  }
  const client = mqttLib.connect(url, {
    username: im.username,
    password: im.password,
    clientId: im.clientId || `lorasim-cs-topology-${Date.now().toString(36)}`,
    clean: im.clean !== false,
  });
  const topics = Array.isArray(im.subscribeTopics) && im.subscribeTopics.length
    ? im.subscribeTopics
    : ['application/+/device/+/event/up'];
  client.on('connect', () => {
    for (const topic of topics) {
      client.subscribe(topic, { qos: Number(im.qos) || 0 }, (err) => {
        if (err && log) log(`[Topology MQTT] subscribe failed ${topic}: ${err.message}`);
        else if (log) log(`[Topology MQTT] subscribed ${topic}`);
      });
    }
  });
  client.on('message', (topic, payload) => {
    orchestrator.recordChirpstackIntegrationMessage(topic, payload);
  });
  client.on('error', (err) => {
    if (log) log(`[Topology MQTT] error: ${err.message}`);
  });
  return {
    stop: () => {
      try {
        client.end(true);
      } catch {
        // ignore
      }
    },
  };
}

module.exports = { startChirpstackIntegrationMqtt };
