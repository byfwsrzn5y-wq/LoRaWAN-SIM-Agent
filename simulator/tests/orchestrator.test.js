const assert = require('assert');
const { IdempotencyStore } = require('../src/orchestrator/idempotency');
const { RetryQueue } = require('../src/orchestrator/retry-queue');
const { OrchestratorService } = require('../src/orchestrator/service');

async function run() {
  const idem = new IdempotencyStore(1000);
  idem.set('POST', '/resources/nodes', 'k1', { status: 200 });
  assert.deepStrictEqual(idem.get('POST', '/resources/nodes', 'k1').status, 200);

  const rq = new RetryQueue();
  const job = rq.enqueue({ jobId: 'j1', resourceId: 'aa', operation: 'create_node' });
  assert.strictEqual(job.attempt, 0);
  rq.markFailure('j1');
  assert.strictEqual(rq.get('j1').attempt, 1);

  const config = { devices: [], multiGateway: { enabled: true, gateways: [] }, signalModel: {} };
  const simState = { nodes: [], gateways: [], stats: { uplinks: 0, joins: 0, errors: 0 } };
  const service = new OrchestratorService({
    getConfig: () => config,
    getSimState: () => simState,
    updateSimState: (updates) => Object.assign(simState, updates),
    writeSimState: () => {},
    retryQueue: rq,
  });

  const createRes = await service.createNode({
    mode: 'simulator_only',
    node: {
      devEui: '18d3bf0000000001',
      name: 'node-1',
      position: { x: 1, y: 2, z: 3 },
      radio: { intervalMs: 10000, adr: true, fPort: 15 },
      uplink: { codec: 'custom', payload: 'AA55', payloadFormat: 'hex' },
      anomaly: { kind: 'drop' },
      nodeState: { random: true },
      adrReject: true,
      devStatus: true,
      duplicateFirstData: true,
      chirpstack: {},
    },
  });
  assert.strictEqual(createRes.ok, true);
  assert.strictEqual(simState.nodes.length, 1);
  assert.strictEqual(config.devices.length, 1);
  assert.strictEqual(config.devices[0].fPort, 15);
  assert.strictEqual(config.devices[0].uplink.codec, 'custom');
  assert.strictEqual(config.devices[0].anomaly.kind, 'drop');

  const updateNodeRes = await service.updateNode('18d3bf0000000001', {
    mode: 'simulator_only',
    node: {
      name: 'node-1-patched',
      position: { x: 5, y: 6, z: 3 },
      radio: { txPower: 14 },
    },
  });
  assert.strictEqual(updateNodeRes.ok, true);
  assert.strictEqual(config.devices[0].fPort, 15);
  assert.strictEqual(config.devices[0].uplink.codec, 'custom');
  assert.strictEqual(config.devices[0].txPower, 14);

  const simPatchRes = await service.updateSimulation({
    mode: 'simulator_only',
    simulation: {
      multiGateway: { mode: 'handover', primaryGateway: '19023c6b00000000' },
      signalModel: { txPower: 18, txGain: 3.5, environment: 'suburban' },
    },
  });
  assert.strictEqual(simPatchRes.ok, true);
  assert.strictEqual(config.multiGateway.mode, 'handover');
  assert.strictEqual(config.signalModel.txPower, 18);

  const layoutRes = await service.applyLayout({
    revision: 1,
    items: [{ id: '18d3bf0000000001', kind: 'node', position: { x: 11, y: 22, z: 3 }, revision: 1 }],
  });
  assert.strictEqual(layoutRes.ok, true);
  assert.strictEqual(simState.nodes[0].position.x, 11);

  const conflictRes = await service.applyLayout({
    revision: 0,
    items: [{ id: '18d3bf0000000001', kind: 'node', position: { x: 12, y: 23, z: 3 }, revision: 1 }],
  });
  assert.strictEqual(conflictRes.ok, false);
  assert.strictEqual(conflictRes.error.code, 'conflict_revision');

  config.chirpstack = { topologyEnabled: true };
  simState.topologyOverlay = { nodes: {}, gateways: {} };
  simState.chirpstackInventory = {
    nodes: [{ devEui: 'feedface00000001', name: 'cs-only' }],
    gateways: [],
    updatedAt: new Date().toISOString(),
    error: null,
  };
  simState.chirpstackLiveRx = { byDevEui: {} };
  service.layoutRevision = 2;
  const overlayLayout = await service.applyLayout({
    revision: 2,
    items: [{ id: 'feedface00000001', kind: 'node', position: { x: 99, y: 88, z: 2 }, revision: 2 }],
  });
  assert.strictEqual(overlayLayout.ok, true);
  assert.strictEqual(simState.topologyOverlay.nodes.feedface00000001.x, 99);

  const delNodeRes = await service.deleteNode('18d3bf0000000001', { mode: 'simulator_only' });
  assert.strictEqual(delNodeRes.ok, true);
  assert.strictEqual(config.devices.findIndex((d) => String(d.devEui).toLowerCase() === '18d3bf0000000001'), -1);
  assert.strictEqual(simState.nodes.findIndex((n) => String(n.eui).toLowerCase() === '18d3bf0000000001'), -1);

  await service.createGateway({
    mode: 'simulator_only',
    gateway: {
      gatewayId: '19023c6b000000aa',
      name: 'gw-1',
      position: { x: 1, y: 2, z: 30 },
      radio: { noiseFloor: -100 },
      chirpstack: {},
    },
  });
  const delGwRes = await service.deleteGateway('19023c6b000000aa', { mode: 'simulator_only' });
  assert.strictEqual(delGwRes.ok, true);
  assert.strictEqual(config.multiGateway.gateways.findIndex((g) => String(g.eui).toLowerCase() === '19023c6b000000aa'), -1);

  console.log('orchestrator tests passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
