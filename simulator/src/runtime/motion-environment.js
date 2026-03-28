'use strict';

/**
 * Optional v2 motion / environment zones / derived anomalies, integrated into index.js uplink path.
 * Enabled when config has environment zones/events, device.movement, derivedAnomalies, or v2DerivedAnomalies.
 */

const { MovementEngine } = require('../movement');
const { EnvironmentManager } = require('../environment');
const { DerivedAnomalyEngine, DEFAULT_ANOMALIES } = require('../derived-anomalies');

const PATH_LOSS_KEYS = new Set(['free-space', 'suburban', 'urban', 'dense-urban', 'indoor']);

function mapEnvTypeForSignalModel(zoneType) {
  if (!zoneType || typeof zoneType !== 'string') return null;
  if (PATH_LOSS_KEYS.has(zoneType)) return zoneType;
  if (zoneType === 'rural') return 'suburban';
  return 'urban';
}

function devEuiHexFromDeviceEntry(d) {
  if (!d || d.enabled === false) return null;
  const raw =
    (d.lorawan && d.lorawan.devEui && String(d.lorawan.devEui).trim()) ||
    (d.devEui && String(d.devEui).trim()) ||
    '';
  const hex = raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  return hex.length === 16 ? hex : null;
}

function shouldEnableMotionEnvironmentRuntime(config) {
  const env = config.environment;
  const hasEnv =
    env &&
    ((Array.isArray(env.zones) && env.zones.length > 0) ||
      (Array.isArray(env.events) && env.events.length > 0));
  const hasMovement = (config.devices || []).some((d) => d && d.movement);
  const der = config.derivedAnomalies;
  const hasDerived = der && typeof der === 'object' && Object.keys(der).length > 0;
  return Boolean(hasEnv || hasMovement || hasDerived || config.v2DerivedAnomalies === true);
}

function buildMotionEnvironmentRuntime(config) {
  if (!shouldEnableMotionEnvironmentRuntime(config)) return null;

  const movementEngines = new Map();
  for (const d of config.devices || []) {
    const hex = devEuiHexFromDeviceEntry(d);
    if (hex && d.movement) {
      movementEngines.set(hex, new MovementEngine(d.movement));
    }
  }

  const environmentManager = new EnvironmentManager(config.environment || {});
  environmentManager.initialize();

  const derivedAnomalyEngine = new DerivedAnomalyEngine({
    anomalies: { ...DEFAULT_ANOMALIES, ...(config.derivedAnomalies || {}) },
  });

  console.log(
    `[MotionEnv] integrated (index.js): movementDevices=${movementEngines.size} zones=${(config.environment && config.environment.zones && config.environment.zones.length) || 0}`,
  );

  return { environmentManager, movementEngines, derivedAnomalyEngine };
}

function registerMovementFromConfig(runtime, devEuiHex, movementConfig) {
  if (!runtime || !devEuiHex || !movementConfig) return;
  const key = String(devEuiHex).replace(/[^a-fA-F0-9]/gi, '').toLowerCase();
  if (key.length !== 16) return;
  runtime.movementEngines.set(key, new MovementEngine(movementConfig));
}

/**
 * Updates lorawanDevice.position, runs environment events / derived anomaly logging.
 * @returns {{ signalModelEnvironment: string, envRssiAdjust: number }|null}
 */
function applyMotionEnvironmentBeforeSignal(runtime, lorawanDevice, baseConfig) {
  if (!runtime || !lorawanDevice || !lorawanDevice.devEui) return null;

  const devEui = lorawanDevice.devEui.toString('hex').toLowerCase();
  const movementEngine = runtime.movementEngines.get(devEui);

  let pos =
    lorawanDevice.position && typeof lorawanDevice.position === 'object'
      ? {
          x: Number(lorawanDevice.position.x) || 0,
          y: Number(lorawanDevice.position.y) || 0,
          z: lorawanDevice.position.z != null ? Number(lorawanDevice.position.z) : 2,
        }
      : { x: 0, y: 0, z: 2 };

  let velocity = { x: 0, y: 0, z: 0 };
  if (movementEngine) {
    pos = movementEngine.update();
    velocity = movementEngine.getVelocity();
  }
  lorawanDevice.position = { ...pos };

  const em = runtime.environmentManager;
  let envInfo = em.getBlendedEnvironment(devEui, lorawanDevice.position);
  const events = em.checkEvents(devEui, lorawanDevice.position, Date.now());
  for (const event of events) {
    if (event.effect && event.effect.environment) {
      em.startTransition(
        devEui,
        envInfo.type,
        event.effect.environment,
        event.effect.transitionDuration || 10,
      );
    }
  }
  envInfo = em.getBlendedEnvironment(devEui, lorawanDevice.position);
  const modifiers = em.getSignalModifiers(envInfo.type);

  let envRssiAdjust = 0;
  if (envInfo.transitioning && envInfo.from != null && envInfo.blend != null) {
    const fromModifiers = em.getSignalModifiers(envInfo.from);
    const blend = envInfo.blend;
    envRssiAdjust -=
      (fromModifiers.pathLossFactor * (1 - blend) + modifiers.pathLossFactor * blend) * 5;
  } else {
    envRssiAdjust -= modifiers.pathLossFactor * 5;
  }

  const signalForDerived = {
    rssi: lorawanDevice.nodeState?.lastRssi ?? lorawanDevice.nodeState?.rssi ?? -85,
    snr: lorawanDevice.nodeState?.lastSnr ?? lorawanDevice.nodeState?.snr ?? 5,
  };
  const derived = runtime.derivedAnomalyEngine.evaluate(devEui, lorawanDevice, {
    signal: signalForDerived,
    position: lorawanDevice.position,
    environment: envInfo,
    movement: { velocity },
  });
  for (const a of derived) {
    console.log(`[Derived Anomaly] ${lorawanDevice.name || devEui}: ${a.type} (${a.reason || ''})`);
  }

  const mapped = mapEnvTypeForSignalModel(envInfo.type);
  const baseEnv = baseConfig && baseConfig.signalModel && baseConfig.signalModel.environment;
  const signalModelEnvironment = mapped || baseEnv || 'urban';

  return { signalModelEnvironment, envRssiAdjust };
}

module.exports = {
  buildMotionEnvironmentRuntime,
  shouldEnableMotionEnvironmentRuntime,
  registerMovementFromConfig,
  applyMotionEnvironmentBeforeSignal,
};
