/**
 * v2.0 config normalization — single source used by index.js and validate-config.
 * Official runtime entry: node index.js -c <file>
 *
 * Optional layering: top-level `preset` (name under configs/presets/) and/or `extends`
 * (path string or array). Merge order: each preset/extends file is resolved recursively
 * (depth-first: its own preset + extends first), then later siblings override earlier ones;
 * the entry file's own keys (except meta) win last. Arrays are replaced wholesale on override.
 */

const fs = require('fs');
const path = require('path');

/** @param {object|null|undefined} base @param {object|null|undefined} override */
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (override === null) return null;
  if (Array.isArray(override)) return override.slice();
  if (typeof override !== 'object') return override;
  const b = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const out = { ...b };
  for (const k of Object.keys(override)) {
    const v = override[k];
    if (v !== undefined && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = deepMerge(b[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function stripConfigMeta(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const { extends: _ext, preset: _preset, $comment: _comment, ...rest } = obj;
  return rest;
}

function normalizeExtends(val) {
  if (val == null || val === '') return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Simulator package root (directory containing index.js).
 */
function defaultSimulatorRoot() {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Resolve merged JSON object before v2 normalization (no `extends` / `preset` in output).
 *
 * @param {string} absoluteConfigPath - Absolute path to the entry config file
 * @param {{ cwd?: string, simulatorRoot?: string }} [options]
 * @returns {object}
 */
function resolveMergedConfigSync(absoluteConfigPath, options = {}) {
  const simulatorRoot = options.simulatorRoot || defaultSimulatorRoot();
  const presetsDir = path.join(simulatorRoot, 'configs', 'presets');
  const visiting = new Set();

  function resolvePresetToPath(presetName) {
    const name = String(presetName).trim();
    if (!name) throw new Error('preset name is empty');
    const filename = name.endsWith('.json') ? path.basename(name) : `${path.basename(name)}.json`;
    const p = path.join(presetsDir, filename);
    if (!fs.existsSync(p)) {
      throw new Error(`preset not found: "${name}" (expected file: ${p})`);
    }
    return path.resolve(p);
  }

  function resolveRefToPath(ref, fromFile) {
    const r = String(ref).trim();
    if (!r) throw new Error('extends entry is empty');
    if (path.isAbsolute(r)) {
      if (fs.existsSync(r)) return path.resolve(r);
      throw new Error(`extends path not found: ${r}`);
    }
    const fromDir = path.dirname(fromFile);
    const candidates = [
      path.resolve(fromDir, r),
      path.join(presetsDir, path.basename(r)),
      path.resolve(fromDir, 'presets', path.basename(r)),
      path.join(simulatorRoot, 'configs', r),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return path.resolve(c);
    }
    throw new Error(`extends path not found: "${ref}" (resolved from ${fromFile})`);
  }

  function loadMerged(absPath) {
    const resolved = path.resolve(absPath);
    if (visiting.has(resolved)) {
      throw new Error(`circular extends/preset chain: ${resolved}`);
    }
    visiting.add(resolved);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
      visiting.delete(resolved);
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`failed to read config ${resolved}: ${msg}`);
    }

    const extendsList = normalizeExtends(raw.extends);
    const preset = raw.preset;

    let merged = {};

    if (preset != null && String(preset).trim() !== '') {
      const pPath = resolvePresetToPath(preset);
      merged = deepMerge(merged, loadMerged(pPath));
    }

    for (const ex of extendsList) {
      const ePath = resolveRefToPath(ex, resolved);
      merged = deepMerge(merged, loadMerged(ePath));
    }

    const self = stripConfigMeta(raw);
    merged = deepMerge(merged, self);
    visiting.delete(resolved);
    return merged;
  }

  return loadMerged(absoluteConfigPath);
}

/**
 * @param {object} config - Raw parsed JSON
 * @returns {object}
 */
function normalizeV20ConfigForLegacyIndex(config) {
  const v = config && config.version;
  const isV20 = v === '2.0' || v === 2;
  if (!isV20 || !config.simulation) return config;
  const sim = config.simulation;
  const gw = sim.gateway || {};
  const out = { ...config };
  out.gatewayEui = config.gatewayEui || gw.gatewayEui;
  out.lnsHost =
    config.lnsHost ||
    process.env.LORAWAN_SIM_LNS_HOST ||
    gw.address ||
    '127.0.0.1';
  out.lnsPort = config.lnsPort != null ? Number(config.lnsPort) : Number(gw.port || 1700);
  if (out.udpBindPort === undefined) out.udpBindPort = 0;
  out.lorawan = {
    enabled: true,
    joinEnabled: true,
    region: sim.region || 'AS923',
    macVersion: 'LORAWAN_1_0_4',
    ...(config.lorawan || {}),
  };
  out.uplink = {
    enabled: true,
    intervalMs: 60000,
    scatterMode: 'random',
    codec: 'hex',
    ...(config.uplink || {}),
  };
  if (!out.mqtt) out.mqtt = { enabled: false };
  if (Array.isArray(config.devices)) {
    out.devices = config.devices.map((d, i) => {
      if (!d || d.enabled === false) return d;
      if (d.lorawan && d.lorawan.devEui) return d;
      if (!d.devEui || !d.appKey) return d;
      const mode = String(d.mode || 'otaa').toLowerCase();
      if (mode !== 'otaa') return d;
      const intervalSec = Number(d.interval);
      const intervalMs =
        Number.isFinite(intervalSec) && intervalSec > 0 ? Math.round(intervalSec * 1000) : 60000;
      const loc = d.location;
      const position =
        loc && typeof loc.x === 'number' && typeof loc.y === 'number'
          ? { x: loc.x, y: loc.y, z: 2 }
          : undefined;
      const entry = {
        name: d.name || `device-${i}`,
        activation: 'OTAA',
        position,
        lorawan: {
          devEui: String(d.devEui).trim(),
          appEui: String(d.joinEui || '0000000000000000').trim(),
          appKey: String(d.appKey).trim(),
          nwkKey: String(d.nwkKey || d.appKey).trim(),
        },
        uplink: {
          enabled: true,
          intervalMs,
          codec: 'hex',
          payload: d.payload != null ? String(d.payload) : undefined,
          lorawan: {
            fPort: d.fPort != null ? Number(d.fPort) : 2,
          },
        },
      };
      if (d.dataRate !== undefined) entry.lorawan.dataRate = Number(d.dataRate);
      if (d.txPower !== undefined) entry.lorawan.txPower = Number(d.txPower);
      if (d.adr !== undefined) entry.lorawan.adr = Boolean(d.adr);
      if (d.anomaly) entry.anomaly = d.anomaly;
      return entry;
    });
  }
  return out;
}

/**
 * @param {string} configPath
 * @param {{ cwd?: string, simulatorRoot?: string }} [options]
 * @returns {object}
 */
function readConfig(configPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const absolute = path.isAbsolute(configPath) ? path.resolve(configPath) : path.resolve(cwd, configPath);
  const merged = resolveMergedConfigSync(absolute, { cwd, simulatorRoot: options.simulatorRoot });
  return normalizeV20ConfigForLegacyIndex(merged);
}

module.exports = {
  deepMerge,
  resolveMergedConfigSync,
  normalizeV20ConfigForLegacyIndex,
  readConfig,
};
