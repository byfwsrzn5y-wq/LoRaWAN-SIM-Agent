/**
 * CLI flags and --set dot-path overrides for index.js (after JSON merge / normalize).
 * Any nested path can be set via --set path.to.key=value; see --help-config for named flags.
 */

const { normalizeV20ConfigForLegacyIndex } = require('./v20-normalize');

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseCliScalar(raw) {
  const s = String(raw);
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t === '') return '';
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t) || /^-?\d+e[+-]?\d+$/i.test(t)) return parseFloat(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return s;
}

/**
 * @param {object} obj
 * @param {string} dotPath - e.g. uplink.lorawan.fPort
 * @param {unknown} value
 */
function setByPath(obj, dotPath, value) {
  const parts = String(dotPath)
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('empty config path');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Named flags: argv flag -> consume next arg and return list of { path, value }.
 * @type {Record<string, (val: string) => Array<{ path: string, value: unknown }>>}
 */
const NAMED_FLAG_APPLIERS = {
  '--lns-host': (v) => [
    { path: 'lnsHost', value: v },
    { path: 'simulation.gateway.address', value: v },
  ],
  '--lns-port': (v) => {
    const n = Number(v);
    return [
      { path: 'lnsPort', value: n },
      { path: 'simulation.gateway.port', value: n },
    ];
  },
  '--gateway-eui': (v) => [
    { path: 'gatewayEui', value: v },
    { path: 'simulation.gateway.gatewayEui', value: v },
  ],
  '--udp-bind-port': (v) => [{ path: 'udpBindPort', value: Number(v) }],
  '--region': (v) => [
    { path: 'simulation.region', value: v },
    { path: 'lorawan.region', value: v },
  ],
  '--log-level': (v) => [{ path: 'simulation.logLevel', value: v }],
  '--device-count': (v) => [{ path: 'lorawan.deviceCount', value: parseInt(v, 10) }],
  '--app-key': (v) => [{ path: 'lorawan.appKey', value: v }],
  '--app-eui': (v) => [{ path: 'lorawan.appEui', value: v }],
  '--app-eui-start': (v) => [{ path: 'lorawan.appEuiStart', value: v }],
  '--dev-eui-start': (v) => [{ path: 'lorawan.devEuiStart', value: v }],
  '--dev-eui': (v) => [{ path: 'lorawan.devEui', value: v }],
  '--activation': (v) => [{ path: 'lorawan.activation', value: v }],
  '--class': (v) => [{ path: 'lorawan.class', value: v }],
  '--uplink-interval-ms': (v) => [{ path: 'uplink.intervalMs', value: Number(v) }],
  '--uplink-interval': (v) => [{ path: 'uplink.interval', value: Number(v) }],
  '--payload-length': (v) => [{ path: 'uplink.payloadLength', value: Number(v) }],
  '--fport': (v) => [{ path: 'uplink.lorawan.fPort', value: parseInt(v, 10) }],
  '--codec': (v) => [{ path: 'uplink.codec', value: v }],
  '--csv-import': (v) => [{ path: 'lorawan.csvImportPath', value: v }],
  '--mqtt-enabled': (v) => [{ path: 'mqtt.enabled', value: v === 'true' || v === '1' }],
  '--mqtt-server': (v) => [{ path: 'mqtt.server', value: v }],
  '--mqtt-topic-prefix': (v) => [
    { path: 'mqtt.topicPrefix', value: v },
    { path: 'mqtt.mqttTopicPrefix', value: v },
  ],
  '--mqtt-marshaler': (v) => [{ path: 'mqtt.marshaler', value: v }],
  '--multigw': (v) => [{ path: 'multiGateway.enabled', value: v === 'true' || v === '1' }],
  '--primary-gateway': (v) => [{ path: 'multiGateway.primaryGateway', value: v }],
  '--control-host': (v) => [{ path: 'controlServer.host', value: v }],
  '--control-port': (v) => [{ path: 'controlServer.port', value: Number(v) }],
  '--control-enabled': (v) => [{ path: 'controlServer.enabled', value: v === 'true' || v === '1' }],
  '--auto-start': (v) => [{ path: 'simulation.autoStart', value: v === 'true' || v === '1' }],
  '--duration': (v) => [{ path: 'simulation.duration', value: Number(v) }],
  '--signal-model': (v) => [{ path: 'signalModel.enabled', value: v === 'true' || v === '1' }],
  '--tx-power': (v) => [{ path: 'signalModel.txPower', value: Number(v) }],
  '--environment': (v) => [{ path: 'signalModel.environment', value: v }],
  '--node-x': (v) => [{ path: 'signalModel.nodePosition.x', value: Number(v) }],
  '--node-y': (v) => [{ path: 'signalModel.nodePosition.y', value: Number(v) }],
  '--node-z': (v) => [{ path: 'signalModel.nodePosition.z', value: Number(v) }],
};

const HELP_CONFIG_TEXT = `LoRaWAN-SIM — config CLI (merged on top of -c JSON, then v2 normalize)

Usage:
  node index.js [-c|--config FILE] [--set path.to.key=value ...] [named flags ...]

  --set KEY=VALUE     Any dot path; VALUE is bool/number/JSON or string. First '=' separates key.
                      Example: --set lorawan.deviceCount=10
                      Example: --set multiGateway.mode=handover

Named flags (pair with next argument unless noted):
  --lns-host HOST              Sets lnsHost + simulation.gateway.address
  --lns-port PORT              Sets lnsPort + simulation.gateway.port
  --gateway-eui HEX            Sets gatewayEui + simulation.gateway.gatewayEui
  --udp-bind-port N
  --region REGION              simulation.region + lorawan.region
  --log-level LEVEL
  --device-count N
  --app-key HEX
  --app-eui HEX
  --app-eui-start HEX
  --dev-eui-start HEX
  --dev-eui HEX
  --activation OTAA|ABP
  --class A|B|C
  --uplink-interval-ms MS
  --uplink-interval MS
  --payload-length N
  --fport N
  --codec simple|hex|...
  --csv-import PATH
  --mqtt-enabled true|false
  --mqtt-server URL
  --mqtt-topic-prefix PREFIX
  --mqtt-marshaler json|protobuf|...
  --multigw true|false
  --primary-gateway EUI
  --control-host HOST
  --control-port PORT
  --control-enabled true|false
  --auto-start true|false
  --duration SEC
  --signal-model true|false
  --tx-power DBM
  --environment urban|suburban|...

Legacy (unchanged):
  --device-count N   (same as named)
  --frequency N      uplink interval seconds -> uplink.interval = N*1000 ms

See also: docs/CONFIG_MAP.md
`;

/**
 * @param {string[]} argv
 * @returns {{
 *   config: string,
 *   helpConfig: boolean,
 *   entries: Array<{ path: string, value: unknown }>,
 * }}
 */
function parseCliConfigArgs(argv) {
  const args = argv.slice(2);
  const entries = [];
  const result = {
    config: 'config.json',
    helpConfig: false,
    entries,
  };
  let legacyFrequencySec = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help-config' || a === '--config-help') {
      result.helpConfig = true;
      continue;
    }
    if (a === '-c' || a === '--config') {
      if (args[i + 1]) result.config = args[++i];
      continue;
    }
    if (a === '--set') {
      if (!args[i + 1]) throw new Error('--set requires KEY=VALUE');
      const spec = args[++i];
      const eq = spec.indexOf('=');
      if (eq <= 0) throw new Error(`--set requires KEY=VALUE, got: ${spec}`);
      const pathStr = spec.slice(0, eq).trim();
      const valRaw = spec.slice(eq + 1);
      entries.push({ path: pathStr, value: parseCliScalar(valRaw) });
      continue;
    }
    if (a === '--frequency' && args[i + 1]) {
      legacyFrequencySec = parseInt(args[++i], 10);
      continue;
    }
    if (a === '--device-count' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      entries.push({ path: 'lorawan.deviceCount', value: n });
      continue;
    }
    const apply = NAMED_FLAG_APPLIERS[a];
    if (apply) {
      if (!args[i + 1]) throw new Error(`${a} requires a value`);
      const val = args[++i];
      for (const e of apply(val)) entries.push(e);
      continue;
    }
  }

  if (legacyFrequencySec != null && Number.isFinite(legacyFrequencySec)) {
    entries.push({ path: 'uplink.interval', value: legacyFrequencySec * 1000 });
  }

  return result;
}

/**
 * v2: if user changed simulation.gateway, drop stale flat fields so normalize repicks from gw.
 * @param {object} config
 * @param {Set<string>} touchedPaths
 */
function clearStaleV20FlatFields(config, touchedPaths) {
  const v = config && config.version;
  if (v !== '2.0' && v !== 2) return;
  if (touchedPaths.has('simulation.gateway.address')) delete config.lnsHost;
  if (touchedPaths.has('simulation.gateway.port')) delete config.lnsPort;
  if (touchedPaths.has('simulation.gateway.gatewayEui')) delete config.gatewayEui;
}

/**
 * Apply CLI entries and re-run v2 normalization when applicable.
 * @param {object} config - already readConfig() output
 * @param {Array<{ path: string, value: unknown }>} entries
 * @returns {object}
 */
function applyCliConfigOverrides(config, entries) {
  if (!entries || entries.length === 0) return config;
  const touched = new Set();
  for (const { path: p, value } of entries) {
    setByPath(config, p, value);
    touched.add(p);
  }
  clearStaleV20FlatFields(config, touched);
  return normalizeV20ConfigForLegacyIndex(config);
}

module.exports = {
  parseCliConfigArgs,
  applyCliConfigOverrides,
  parseCliScalar,
  setByPath,
  HELP_CONFIG_TEXT,
  NAMED_FLAG_APPLIERS,
};
