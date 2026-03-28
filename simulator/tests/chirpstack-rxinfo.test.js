const assert = require('assert');
const { mapRxInfoToGatewayReceptions, normalizeGatewayId } = require('../src/chirpstack/rxInfo');
const { buildMergedTopology } = require('../src/chirpstack/topology-merge');

function run() {
  assert.strictEqual(normalizeGatewayId('0102030405060708'), '0102030405060708');
  assert.strictEqual(normalizeGatewayId(''), '');

  const rx = mapRxInfoToGatewayReceptions([
    { gatewayId: '0102030405060708', rssi: -90, loRaSNR: 5.5 },
    { gatewayId: 'bad', rssi: 0 },
  ]);
  assert.strictEqual(rx.length, 1);
  assert.strictEqual(rx[0].gatewayEui, '0102030405060708');
  assert.strictEqual(rx[0].rssi, -90);
  assert.strictEqual(rx[0].snr, 5.5);

  const simState = {
    nodes: [{ eui: 'AAAAAAAAAAAAAAAA', name: 'sim', source: 'simulator' }],
    gateways: [],
    topologyOverlay: { nodes: {}, gateways: {} },
    chirpstackInventory: {
      nodes: [{ devEui: 'bbbbbbbbbbbbbbbb', name: 'c1', lastSeenAt: '2020-01-01T00:00:00Z' }],
      gateways: [{ gatewayId: 'cccccccccccccccc', name: 'gw1' }],
    },
    chirpstackLiveRx: {
      byDevEui: {
        bbbbbbbbbbbbbbbb: { receptions: [{ gatewayEui: 'CCCCCCCCCCCCCCCC', rssi: -88 }], ts: Date.now() },
      },
    },
  };
  const merged = buildMergedTopology(simState, { rxStalenessSec: 120 });
  assert.strictEqual(merged.nodes.length, 2);
  const cs = merged.nodes.find((n) => n.eui === 'BBBBBBBBBBBBBBBB');
  assert.ok(cs);
  assert.strictEqual(cs.source, 'chirpstack');
  assert.ok(Array.isArray(cs.gatewayReceptions));
  assert.strictEqual(merged.gateways.length, 1);
  assert.strictEqual(merged.gateways[0].eui, 'CCCCCCCCCCCCCCCC');

  console.log('chirpstack-rxinfo tests passed');
}

run();
