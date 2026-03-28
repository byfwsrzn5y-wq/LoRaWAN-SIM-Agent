#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, 'simulator', 'config.json');

const baseUrl = process.env.LORASIM_CONTROL_URL || 'http://127.0.0.1:9999';
const nowTag = Date.now().toString(16).slice(-6);
const nodeEui = `18d3bf0000${nowTag}`.slice(0, 16);
const gwEui = `19023c6b00${nowTag}`.slice(0, 16);

function fail(message, extra) {
  console.error(`[FAIL] ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function ok(message) {
  console.log(`[OK] ${message}`);
}

async function requestJson(method, pathname, body, idemKey) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep text-only for diagnostics
  }
  if (!res.ok) {
    fail(`${method} ${pathname} -> HTTP ${res.status}`, text);
  }
  return json;
}

function findNodeFromConfig(config, targetEui) {
  return (config.devices || []).find((d) => {
    const key = String(d?.devEui || d?.lorawan?.devEui || '').toLowerCase();
    return key === targetEui.toLowerCase();
  });
}

function findGatewayFromConfig(config, targetEui) {
  return (config.multiGateway?.gateways || []).find(
    (g) => String(g?.eui || '').toLowerCase() === targetEui.toLowerCase(),
  );
}

async function run() {
  const status = await requestJson('GET', '/status');
  if (!status?.ok) fail('control server status check failed', status);
  ok(`control server reachable (${baseUrl})`);

  await requestJson(
    'POST',
    '/resources/nodes',
    {
      mode: 'simulator_only',
      node: {
        devEui: nodeEui,
        name: `smoke-node-${nowTag}`,
        enabled: true,
        position: { x: 555, y: 777, z: 2 },
        radio: { intervalMs: 9000, sf: 9, txPower: 13, adr: false, fPort: 19 },
        uplink: { codec: 'custom', payload: 'ABCD', payloadFormat: 'hex' },
        lorawan: { appEui: '0000000000000002', nwkKey: '00112233445566778899AABBCCDDEEFF' },
        adrReject: true,
        devStatus: true,
        duplicateFirstData: true,
        anomaly: { kind: 'drop' },
        nodeState: { random: true },
        chirpstack: { appKey: '00112233445566778899AABBCCDDEEFF' },
      },
    },
    `smoke-create-node-${nodeEui}`,
  );
  ok('node created');

  await requestJson(
    'PATCH',
    `/resources/nodes/${nodeEui}`,
    {
      mode: 'simulator_only',
      node: {
        name: `smoke-node-${nowTag}-patched`,
        position: { x: 556, y: 778, z: 3 },
        radio: { txPower: 12 },
      },
    },
    `smoke-patch-node-${nodeEui}`,
  );
  ok('node patched');

  await requestJson(
    'POST',
    '/resources/gateways',
    {
      mode: 'simulator_only',
      gateway: {
        gatewayId: gwEui,
        name: `smoke-gw-${nowTag}`,
        position: { x: 1111, y: 333, z: 30 },
        radio: { rxGain: 7, rxSensitivity: -135, cableLoss: 0.8, noiseFloor: -103 },
        chirpstack: {},
      },
    },
    `smoke-create-gw-${gwEui}`,
  );
  ok('gateway created');

  await requestJson(
    'PATCH',
    `/resources/gateways/${gwEui}`,
    {
      mode: 'simulator_only',
      gateway: {
        name: `smoke-gw-${nowTag}-patched`,
        position: { x: 1112, y: 334, z: 31 },
        radio: { noiseFloor: -104 },
      },
    },
    `smoke-patch-gw-${gwEui}`,
  );
  ok('gateway patched');

  await requestJson(
    'PATCH',
    '/resources/simulation',
    {
      mode: 'simulator_only',
      simulation: {
        multiGateway: { mode: 'handover', primaryGateway: gwEui },
        signalModel: {
          txPower: 18,
          txGain: 3.2,
          environment: 'suburban',
          shadowFadingStd: 6,
          fastFadingEnabled: false,
        },
      },
    },
    `smoke-patch-sim-${nowTag}`,
  );
  ok('scenario patched');

  const simState = await requestJson('GET', '/sim-state');
  const stateNode = (simState.nodes || []).find(
    (n) => String(n?.eui || '').toLowerCase() === nodeEui.toLowerCase(),
  );
  const stateGw = (simState.gateways || []).find(
    (g) => String(g?.eui || '').toLowerCase() === gwEui.toLowerCase(),
  );
  if (!stateNode) fail('node not found in /sim-state');
  if (!stateGw) fail('gateway not found in /sim-state');
  if (stateNode?.simulator?.fPort !== 19) fail('sim-state node fPort mismatch', stateNode?.simulator);
  if (stateNode?.simulator?.uplinkCodec !== 'custom') fail('sim-state node uplinkCodec mismatch', stateNode?.simulator);
  if (stateGw?.noiseFloor !== -104) fail('sim-state gateway noiseFloor mismatch', stateGw);
  ok('sim-state assertions passed');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const configNode = findNodeFromConfig(config, nodeEui);
  const configGw = findGatewayFromConfig(config, gwEui);
  if (!configNode) fail('node not persisted in simulator/config.json');
  if (!configGw) fail('gateway not persisted in simulator/config.json');
  if (Number(configNode.fPort) !== 19) fail('config node fPort mismatch', configNode);
  if (String(configNode.uplink?.codec) !== 'custom') fail('config node uplink codec mismatch', configNode);
  if (String(configNode.joinEui || '') !== '0000000000000002') fail('config node joinEui mismatch', configNode);
  if (!configNode.anomaly || configNode.anomaly.kind !== 'drop') fail('config node anomaly mismatch', configNode);
  if (!configNode.nodeState || configNode.nodeState.random !== true) fail('config node nodeState mismatch', configNode);
  if (Number(configGw.noiseFloor) !== -104) fail('config gateway noiseFloor mismatch', configGw);
  if (String(config.multiGateway?.mode) !== 'handover') fail('config scenario mode mismatch', config.multiGateway);
  if (String(config.multiGateway?.primaryGateway || '').toLowerCase() !== gwEui.toLowerCase()) {
    fail('config scenario primaryGateway mismatch', config.multiGateway);
  }
  if (Number(config.signalModel?.txPower) !== 18) fail('config signalModel txPower mismatch', config.signalModel);
  ok('config persistence assertions passed');

  console.log(
    JSON.stringify(
      {
        success: true,
        baseUrl,
        nodeEui,
        gwEui,
      },
      null,
      2,
    ),
  );
}

run().catch((e) => fail('unexpected error in smoke test', e?.stack || String(e)));
