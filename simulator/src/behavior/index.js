/**
 * Behavior Templates Module
 * Device behavior template loading and application
 */

const fs = require('fs');
const path = require('path');

/**
 * Load behavior templates from file or config
 * @param {Object} lorawanCfg - LoRaWAN config section
 * @param {string} cwd - Current working directory
 * @returns {Object|null} { baseline, templates }
 */
function loadBehaviorTemplates(lorawanCfg, cwd) {
  if (!lorawanCfg) return null;
  
  // Inline templates in config
  if (lorawanCfg.behaviorTemplates && typeof lorawanCfg.behaviorTemplates === 'object' && !Array.isArray(lorawanCfg.behaviorTemplates)) {
    const bt = lorawanCfg.behaviorTemplates;
    const templates = bt.templates || bt;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: bt.baseline || null, templates };
  }
  
  // Load from file
  const filePath = lorawanCfg.behaviorTemplatesFile || lorawanCfg.behaviorTemplatesPath;
  if (!filePath) return null;
  
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd || process.cwd(), filePath);
    const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const templates = data.templates || data;
    if (!templates || typeof templates !== 'object') return null;
    return { baseline: data.baseline || null, templates };
  } catch (e) {
    console.error('[✗] Behavior template load failed:', e.message);
    return null;
  }
}

/**
 * Apply behavior template to device config
 * @param {Object} template - Template object
 * @param {Object} baseline - Baseline template (optional)
 * @returns {Object} Merged device config
 */
function applyBehaviorTemplate(template, baseline) {
  if (!template || typeof template !== 'object') return {};
  
  const mergeOne = (base, override) => 
    (override && typeof override === 'object' ? { ...(base || {}), ...override } : (base || {}));
  
  let out = {};
  
  if (template.extends === 'baseline' && baseline && typeof baseline === 'object') {
    out.nodeState = mergeOne(baseline.nodeState, template.nodeState);
    out.uplink = mergeOne(baseline.uplink, template.uplink);
    out.lorawan = mergeOne(baseline.lorawan, template.lorawan);
    out.devStatus = template.devStatus ? { ...template.devStatus } : 
                   (baseline.devStatus ? { ...baseline.devStatus } : undefined);
    
    if (template.adrReject !== undefined) out.adrReject = template.adrReject;
    else if (baseline.adrReject !== undefined) out.adrReject = baseline.adrReject;
    
    if (template.duplicateFirstData !== undefined) out.duplicateFirstData = template.duplicateFirstData;
    else if (baseline.duplicateFirstData !== undefined) out.duplicateFirstData = baseline.duplicateFirstData;
  } else {
    if (template.nodeState) out.nodeState = { ...template.nodeState };
    if (template.uplink) out.uplink = { ...template.uplink };
    if (template.lorawan) out.lorawan = { ...template.lorawan };
    if (template.devStatus) out.devStatus = { ...template.devStatus };
    if (template.adrReject !== undefined) out.adrReject = template.adrReject;
    if (template.duplicateFirstData !== undefined) out.duplicateFirstData = template.duplicateFirstData;
  }
  
  return out;
}

/**
 * Pick a template based on weights
 * @param {Object} weights - { templateId: weight }
 * @returns {string} Selected template ID
 */
function pickWeightedTemplate(weights) {
  const ids = Object.keys(weights);
  const total = ids.reduce((s, id) => s + (Number(weights[id]) || 0), 0);
  if (total <= 0) return ids[0];
  
  let r = Math.random() * total;
  for (const id of ids) {
    r -= Number(weights[id]) || 0;
    if (r <= 0) return id;
  }
  return ids[ids.length - 1];
}

/**
 * Initialize node state with random or fixed values
 * @param {number} deviceIndex - Device index
 * @param {Object} device - Device object
 * @param {Object} lorawanCfg - LoRaWAN config
 * @param {Object} globalUplink - Global uplink config
 * @param {Array} regionChannels - Region channel list
 * @param {Object} perDeviceOverride - Per-device override config
 */
function initNodeState(deviceIndex, device, lorawanCfg, globalUplink, regionChannels, perDeviceOverride) {
  const nodeCfg = perDeviceOverride || lorawanCfg?.nodeState || globalUplink?.nodeState || {};
  const useRandom = (perDeviceOverride ? false : (nodeCfg.random === true || nodeCfg.mode === 'random'));
  const defaultChannels = regionChannels?.length > 0 ? regionChannels : [923.2, 923.4, 923.6, 923.8, 924.0, 924.2, 924.4, 924.6];

  let channels = defaultChannels;
  let txPowerIndex = 0;
  let rssi = -85;
  let snr = 5;

  if (useRandom) {
    const rssiRange = nodeCfg.rssiRange || [-95, -75];
    const snrRange = nodeCfg.snrRange || [2, 9];
    const txRange = nodeCfg.txPowerIndexRange || [0, 5];
    rssi = rssiRange[0] + Math.random() * (rssiRange[1] - rssiRange[0]);
    snr = snrRange[0] + Math.random() * (snrRange[1] - snrRange[0]);
    txPowerIndex = Math.floor(txRange[0] + Math.random() * (Math.min(txRange[1], 7) - txRange[0] + 1));
    if (nodeCfg.channelSubset?.length > 0) {
      channels = nodeCfg.channelSubset;
    } else if (nodeCfg.channelCount && nodeCfg.channelCount < defaultChannels.length) {
      const start = deviceIndex % Math.max(1, defaultChannels.length - nodeCfg.channelCount);
      channels = defaultChannels.slice(start, start + nodeCfg.channelCount);
      if (channels.length < nodeCfg.channelCount) channels = defaultChannels.slice(0, nodeCfg.channelCount);
    }
  } else if (nodeCfg.rssi !== undefined || nodeCfg.snr !== undefined || nodeCfg.txPowerIndex !== undefined || nodeCfg.channels) {
    if (nodeCfg.rssi !== undefined) rssi = Number(nodeCfg.rssi);
    if (nodeCfg.snr !== undefined) snr = Number(nodeCfg.snr);
    if (nodeCfg.txPowerIndex !== undefined) txPowerIndex = Math.max(0, Math.min(7, Number(nodeCfg.txPowerIndex)));
    if (Array.isArray(nodeCfg.channels) && nodeCfg.channels.length > 0) channels = nodeCfg.channels.map(Number);
  }

  device.nodeState = {
    channels: [...channels],
    txPowerIndex,
    rssi,
    snr,
    lastRssi: rssi,
    lastSnr: snr,
    rssiJitter: nodeCfg.rssiJitter !== undefined ? Number(nodeCfg.rssiJitter) : 1.5,
    snrJitter: nodeCfg.snrJitter !== undefined ? Number(nodeCfg.snrJitter) : 0.8,
  };
}

module.exports = {
  loadBehaviorTemplates,
  applyBehaviorTemplate,
  pickWeightedTemplate,
  initNodeState
};
