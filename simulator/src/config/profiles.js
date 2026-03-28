/**
 * Scenario profiles for LoRaSIM (official runtime: node index.js -c <config>).
 * Each profile adds conditional rules on top of base JSON Schema validation.
 */

/** @typedef {'v20-udp'|'mqtt'|'multigw'|'openclaw'} LorasimProfileId */

const PROFILE_IDS = /** @type {const} */ (['v20-udp', 'mqtt', 'multigw', 'openclaw']);

const PROFILE_META = {
  'v20-udp': {
    title: 'Gateway Bridge UDP（如 ChirpStack / 任意兼容 NS）',
    description:
      '对端可为自建或第三方 ChirpStack，只需 lnsHost/lnsPort 等与 Bridge UDP 一致。version 2.0：simulation.gateway（或顶层 gatewayEui/lnsHost/lnsPort）、lorawan、uplink，以及设备来源之一：devices[]（OTAA lorawan）、csvImportPath、randomBehaviors+模板、ABP deviceCount、或 OTAA 单组/批量 appEui+devEui(+Start)+appKey。',
    officialEntry: '在 simulator 目录执行: node index.js -c <path/to/config.json>',
  },
  mqtt: {
    title: 'Gateway Bridge (MQTT)',
    description: '在 v20-udp 基础上必须启用 mqtt.enabled，并配置 broker、marshaler、topic 前缀等与 index.js MQTT 路径一致。',
    officialEntry: 'node index.js -c ...',
  },
  multigw: {
    title: 'Multi-gateway',
    description: 'multiGateway.enabled 为 true，gateways[] 非空；mode=failover 时需 primaryGateway 匹配某网关 eui。',
    officialEntry: 'node index.js -c ...',
  },
  openclaw: {
    title: 'OpenClaw / AI Agent 联调',
    description:
      '与 v20-udp 相同的核心模拟器键；插件侧另需 projectPath 或 LORAWAN_SIM_PROJECT_PATH。若用插件调对端 NS REST（如 ChirpStack 或兼容 API）需 CHIRPSTACK_* 等环境变量。建议开启 controlServer 以便 lorawan_sim_reset_device。',
    officialEntry: 'OpenClaw 插件 + node index.js',
  },
};

/**
 * Whether config will load devices via index.js branches (~2446–2720).
 * @param {object} cfg - normalized config
 */
function hasDeviceSource(cfg) {
  const lw = cfg.lorawan || {};
  if (lw.enabled === false) return true;
  if (lw.csvImportPath && String(lw.csvImportPath).trim()) return true;

  if (Array.isArray(cfg.devices)) {
    const usable = cfg.devices.some((d) => {
      if (!d || d.enabled === false) return false;
      if (d.lorawan && d.lorawan.devEui && d.lorawan.appKey) return true;
      if (d.lorawan && d.lorawan.devEui) return true;
      if (d.devEui && d.appKey) return true;
      return false;
    });
    if (usable) return true;
    const anyOtaaShape = cfg.devices.some(
      (d) => d && d.enabled !== false && (d.lorawan || d.activation)
    );
    if (anyOtaaShape) return true;
  }

  if (lw.randomBehaviors && Number(lw.deviceCount) > 0) return true;

  const isAbp = String(lw.activation || 'ABP').toUpperCase() === 'ABP';
  if (isAbp && Number(lw.deviceCount) > 0) return true;

  if (
    lw.appKey &&
    lw.appKey.trim() &&
    ((lw.appEui && lw.devEui) || (lw.appEuiStart && lw.devEuiStart && Number(lw.deviceCount) > 0))
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} id
 * @returns {id is LorasimProfileId}
 */
function isValidProfileId(id) {
  return PROFILE_IDS.includes(/** @type {any} */ (id));
}

module.exports = {
  PROFILE_IDS,
  PROFILE_META,
  hasDeviceSource,
  isValidProfileId,
};
