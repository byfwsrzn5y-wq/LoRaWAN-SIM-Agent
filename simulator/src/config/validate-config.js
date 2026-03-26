/**
 * Structured validation for LoRaSIM index.js configs (Schema + profile rules).
 */

const fs = require('fs');
const path = require('path');
const { Ajv2020 } = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { resolveMergedConfigSync, normalizeV20ConfigForLegacyIndex } = require('./v20-normalize');
const { hasDeviceSource, isValidProfileId, PROFILE_IDS } = require('./profiles');

function schemaPath() {
  return path.join(__dirname, '..', '..', '..', 'schemas', 'lorasim-config.schema.json');
}

function loadBehaviorTemplatesLight(lorawanCfg, cwd) {
  if (!lorawanCfg) return null;
  if (
    lorawanCfg.behaviorTemplates &&
    typeof lorawanCfg.behaviorTemplates === 'object' &&
    !Array.isArray(lorawanCfg.behaviorTemplates)
  ) {
    const bt = lorawanCfg.behaviorTemplates;
    const templates = bt.templates || bt;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: bt.baseline || null, templates };
  }
  const filePath = lorawanCfg.behaviorTemplatesFile || lorawanCfg.behaviorTemplatesPath;
  if (!filePath) return null;
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const templates = data.templates || data;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: data.baseline || null, templates };
  } catch {
    return null;
  }
}

function hexNorm(s) {
  return String(s || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/\s/g, '');
}

function isHexLen(s, byteLen) {
  const h = hexNorm(s);
  return /^[0-9a-fA-F]+$/.test(h) && h.length === byteLen * 2;
}

function push(arr, code, message, p, checklistId) {
  const o = { code, message };
  if (p != null && p !== '') o.path = p;
  if (checklistId) o.checklistId = checklistId;
  arr.push(o);
}

function buildPreview(cfg) {
  const lw = cfg.lorawan || {};
  const upl = cfg.uplink || {};
  return {
    version: cfg.version != null ? cfg.version : null,
    gatewayEui: cfg.gatewayEui != null ? String(cfg.gatewayEui) : null,
    lnsHost: cfg.lnsHost != null ? String(cfg.lnsHost) : null,
    lnsPort: cfg.lnsPort != null ? Number(cfg.lnsPort) : null,
    udpBindPort: cfg.udpBindPort != null ? Number(cfg.udpBindPort) : null,
    mqttEnabled: Boolean(cfg.mqtt && cfg.mqtt.enabled),
    multigwEnabled: Boolean(cfg.multiGateway && cfg.multiGateway.enabled),
    lorawanEnabled: lw.enabled !== false,
    uplinkEnabled: upl.enabled !== false,
    deviceCountDeclared: Number.isFinite(Number(lw.deviceCount)) ? Number(lw.deviceCount) : null,
    devicesListed: Array.isArray(cfg.devices)
      ? cfg.devices.filter((d) => d && d.enabled !== false).length
      : 0,
    appKeyRedacted:
      lw.appKey && String(lw.appKey).trim()
        ? `${String(lw.appKey).replace(/\s/g, '').slice(0, 4)}…`
        : null,
    controlServerEnabled: Boolean((cfg.controlServer || cfg.control || {}).enabled),
  };
}

/**
 * @param {object} options
 * @param {string} options.configPath
 * @param {string} [options.profile='v20-udp']
 * @param {string} [options.cwd=process.cwd()]
 * @returns {{
 *   ok: boolean,
 *   profile: string,
 *   errors: Array<{code:string,message:string,path?:string}>,
 *   warnings: Array<{code:string,message:string,path?:string,checklistId?:string}>,
 *   normalizedPreview: object
 * }}
 */
function validateLorasimConfig(options) {
  const configPath = options && options.configPath;
  const profile = options && options.profile != null ? String(options.profile) : 'v20-udp';
  const cwd = (options && options.cwd) || process.cwd();

  const errors = [];
  const warnings = [];

  if (!configPath || !String(configPath).trim()) {
    push(errors, 'ERR_NO_CONFIG_PATH', 'configPath is required');
    return {
      ok: false,
      profile,
      errors,
      warnings,
      normalizedPreview: {},
    };
  }

  if (!isValidProfileId(profile)) {
    push(
      warnings,
      'W_UNKNOWN_PROFILE',
      `Unknown profile "${profile}". Known: ${PROFILE_IDS.join(', ')}. Using generic checks.`
    );
  }

  const absolute = path.isAbsolute(configPath) ? path.resolve(configPath) : path.resolve(cwd, configPath);
  const simulatorRoot = path.join(__dirname, '..', '..');

  let mergedRaw;
  try {
    mergedRaw = resolveMergedConfigSync(absolute, { cwd, simulatorRoot });
  } catch (e) {
    push(errors, 'ERR_READ_JSON', e.message || String(e), configPath);
    return { ok: false, profile, errors, warnings, normalizedPreview: {} };
  }

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(schemaPath(), 'utf8'));
    const validate = ajv.compile(schema);
    const schemaOk = validate(mergedRaw);
    if (!schemaOk && validate.errors) {
      for (const er of validate.errors) {
        const p = er.instancePath || er.schemaPath || '';
        push(
          errors,
          'ERR_SCHEMA',
          `${er.message || 'schema'} (${er.keyword})`.trim(),
          p || '/'
        );
      }
    }
  } catch (e) {
    push(warnings, 'W_SCHEMA_SKIPPED', `JSON Schema validation skipped: ${e.message || e}`);
  }

  let normalized;
  try {
    normalized = normalizeV20ConfigForLegacyIndex(mergedRaw);
  } catch (e) {
    push(errors, 'ERR_NORMALIZE', e.message || String(e));
    return {
      ok: false,
      profile,
      errors,
      warnings,
      normalizedPreview: {},
    };
  }

  const preview = buildPreview(normalized);

  const gwEui = normalized.gatewayEui;
  if (!gwEui || !String(gwEui).trim()) {
    push(
      errors,
      'ERR_GATEWAY_EUI',
      'gatewayEui missing (set src or simulation.gateway.gatewayEui for v2.0)',
      '',
      'CS-CHK-GW-EUI'
    );
  } else if (!isHexLen(gwEui, 8)) {
    push(
      errors,
      'ERR_GATEWAY_EUI_FORMAT',
      'gatewayEui must be 16 hex characters (8 bytes)',
      '',
      'CS-CHK-GW-EUI'
    );
  }

  const host = normalized.lnsHost != null ? String(normalized.lnsHost).trim() : '';
  if (!host) {
    push(errors, 'ERR_LNS_HOST', 'lnsHost missing (v2.0: simulation.gateway.address)', '', 'CS-CHK-LNS-UDP');
  }

  const port = normalized.lnsPort != null ? Number(normalized.lnsPort) : NaN;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    push(errors, 'ERR_LNS_PORT', 'lnsPort must be 1–65535', '', 'CS-CHK-LNS-UDP');
  }

  const lw = normalized.lorawan || {};
  const upl = normalized.uplink || {};
  if (lw.enabled !== false && upl.enabled !== false && !hasDeviceSource(normalized)) {
    push(
      warnings,
      'W_NO_DEVICE_SOURCE',
      'lorawan/uplink enabled but no device source detected (devices[], csvImportPath, randomBehaviors+templates, ABP deviceCount, or OTAA keys). Scheduler may only run uplink without LoRaWAN device.',
      'lorawan',
      'CS-CHK-DEV-SOURCE'
    );
  }

  if (lw.randomBehaviors && Number(lw.deviceCount) > 0) {
    const loaded = loadBehaviorTemplatesLight(lw, cwd);
    if (!loaded || !loaded.templates || Object.keys(loaded.templates).length === 0) {
      push(
        errors,
        'ERR_BEHAVIOR_TEMPLATES',
        'randomBehaviors requires behaviorTemplates (inline) or behaviorTemplatesFile that loads a non-empty templates object',
        'lorawan'
      );
    } else {
      const list = lw.behaviorTemplateList;
      if (Array.isArray(list)) {
        const missing = list.filter((id) => !loaded.templates[id]);
        if (missing.length) {
          push(
            warnings,
            'W_TEMPLATE_LIST',
            `behaviorTemplateList references unknown template ids: ${missing.join(', ')}`
          );
        }
      }
      if (!list || (Array.isArray(list) && list.length === 0)) {
        push(warnings, 'W_TEMPLATE_LIST_EMPTY', 'behaviorTemplateList unset — all loaded templates may be used');
      }
    }
  }

  const rawUplink = mergedRaw.uplink || {};
  if (
    rawUplink.intervalMs == null &&
    rawUplink.interval != null &&
    Number(rawUplink.interval) > 0 &&
    Number(rawUplink.interval) < 1000
  ) {
    push(
      warnings,
      'W_INTERVAL_MS',
      'uplink.interval is interpreted as milliseconds by index.js. Values <1000 are often unintentional; use intervalMs for clarity.',
      'uplink.interval',
      'SIM-CHK-UPLINK-INTERVAL'
    );
  }

  if (profile === 'mqtt') {
    if (!normalized.mqtt || !normalized.mqtt.enabled) {
      push(errors, 'ERR_MQTT_DISABLED', 'profile mqtt requires mqtt.enabled === true', 'mqtt', 'CS-CHK-MQTT-ENABLED');
    } else {
      if (!normalized.mqtt.host && !normalized.mqtt.hostname) {
        push(warnings, 'W_MQTT_HOST', 'mqtt.host not set (may rely on library default)', 'mqtt.host', 'CS-CHK-MQTT-BROKER');
      }
    }
  }

  if (profile === 'multigw') {
    const mg = normalized.multiGateway || {};
    if (!mg.enabled) {
      push(errors, 'ERR_MULTIGW_OFF', 'profile multigw requires multiGateway.enabled === true');
    }
    if (!Array.isArray(mg.gateways) || mg.gateways.length === 0) {
      push(errors, 'ERR_MULTIGW_GATEWAYS', 'multiGateway.gateways must be a non-empty array');
    }
    const mode = String(mg.mode || 'overlapping').toLowerCase();
    if (mode === 'failover' && mg.primaryGateway) {
      const primary = hexNorm(mg.primaryGateway);
      const ok = (mg.gateways || []).some((g) => hexNorm(g.eui) === primary);
      if (!ok) {
        push(
          warnings,
          'W_MULTIGW_PRIMARY',
          'primaryGateway does not match any gateways[].eui',
          'multiGateway.primaryGateway',
          'CS-CHK-MGW-PRIMARY'
        );
      }
    }
    for (let i = 0; i < (mg.gateways || []).length; i++) {
      const g = mg.gateways[i];
      if (g && g.eui && !isHexLen(g.eui, 8)) {
        push(errors, 'ERR_MULTIGW_EUI', `gateways[${i}].eui must be 16 hex chars`, `multiGateway.gateways[${i}].eui`);
      }
    }
  }

  if (profile === 'openclaw') {
    if (!(normalized.controlServer || normalized.control || {}).enabled) {
      push(
        warnings,
        'W_OPENCLAW_CONTROL',
        'controlServer.enabled is false; OpenClaw lorawan_sim_reset_device will not work without it',
        'controlServer',
        'CS-CHK-CONTROL-HTTP'
      );
    }
  }

  const v = mergedRaw && mergedRaw.version;
  const isV20 = v === '2.0' || v === 2;
  if (isV20 && mergedRaw.simulation && mergedRaw.simulation.gateway) {
    const simGw = mergedRaw.simulation.gateway;
    const mergedPort = normalized.lnsPort;
    if (simGw.port != null && Number(simGw.port) !== mergedPort) {
      push(
        warnings,
        'W_PORT_MERGE',
        `simulation.gateway.port (${simGw.port}) vs normalized lnsPort (${mergedPort}); check lnsPort override at root`,
        'simulation.gateway.port'
      );
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    profile,
    errors,
    warnings,
    normalizedPreview: preview,
  };
}

module.exports = {
  validateLorasimConfig,
  loadBehaviorTemplatesLight,
  PROFILE_IDS,
};
