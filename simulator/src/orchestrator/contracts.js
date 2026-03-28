const crypto = require('crypto');

const ERROR_CODES = {
  VALIDATION: 'validation',
  CHIRPSTACK_FAILED: 'chirpstack_failed',
  SIMULATOR_FAILED: 'simulator_failed',
  PARTIAL_SUCCESS: 'partial_success',
  CONFLICT_REVISION: 'conflict_revision',
  NOT_FOUND: 'not_found',
};

function createCorrelationId() {
  return `sync-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function createError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function normalizeHexId(v, bytes) {
  const s = String(v || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
  if (bytes && s.length !== bytes * 2) return '';
  return s;
}

function ensureObject(v, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw createError(ERROR_CODES.VALIDATION, `${name} must be object`);
  }
  return v;
}

function validateNodeCreate(body) {
  const b = ensureObject(body, 'body');
  const node = ensureObject(b.node, 'node');
  const devEui = normalizeHexId(node.devEui, 8);
  if (!devEui) throw createError(ERROR_CODES.VALIDATION, 'node.devEui must be 16 hex chars');
  const radio = node.radio && typeof node.radio === 'object' ? node.radio : {};
  if (radio.fPort != null) {
    const fp = Number(radio.fPort);
    if (!Number.isFinite(fp) || fp < 1 || fp > 223) {
      throw createError(ERROR_CODES.VALIDATION, 'node.radio.fPort must be 1..223');
    }
  }
  return {
    mode: String(b.mode || 'sync_both'),
    node: {
      devEui,
      name: String(node.name || `sim-node-${devEui.slice(-4)}`),
      position: node.position || { x: 0, y: 0, z: 2 },
      radio,
      chirpstack: node.chirpstack || {},
      lorawan: node.lorawan || {},
      uplink: node.uplink || {},
      nodeState: node.nodeState || undefined,
      anomaly: node.anomaly || undefined,
      adrReject: node.adrReject,
      devStatus: node.devStatus,
      duplicateFirstData: node.duplicateFirstData,
      enabled: node.enabled !== false,
    },
  };
}

function validateGatewayCreate(body) {
  const b = ensureObject(body, 'body');
  const gw = ensureObject(b.gateway, 'gateway');
  const gatewayId = normalizeHexId(gw.gatewayId || gw.id, 8);
  if (!gatewayId) throw createError(ERROR_CODES.VALIDATION, 'gateway.gatewayId must be 16 hex chars');
  return {
    mode: String(b.mode || 'sync_both'),
    gateway: {
      gatewayId,
      name: String(gw.name || `gw-${gatewayId.slice(-4)}`),
      position: gw.position || { x: 0, y: 0, z: 30 },
      radio: gw.radio || {},
      chirpstack: gw.chirpstack || {},
      enabled: gw.enabled !== false,
    },
  };
}

function validateLayoutApply(body) {
  const b = ensureObject(body, 'body');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw createError(ERROR_CODES.VALIDATION, 'items cannot be empty');
  const normalizedItems = items.map((it, idx) => {
    const item = ensureObject(it, `items[${idx}]`);
    const kind = String(item.kind || '').toLowerCase();
    if (kind !== 'node' && kind !== 'gateway') {
      throw createError(ERROR_CODES.VALIDATION, `items[${idx}].kind must be node|gateway`);
    }
    const id = normalizeHexId(item.id, 8);
    if (!id) throw createError(ERROR_CODES.VALIDATION, `items[${idx}].id must be 16 hex chars`);
    const position = ensureObject(item.position, `items[${idx}].position`);
    return {
      id,
      kind,
      position: {
        x: Number(position.x),
        y: Number(position.y),
        z: Number(position.z || (kind === 'gateway' ? 30 : 2)),
      },
      revision: Number(item.revision || 0),
    };
  });
  return { revision: Number(b.revision || 0), items: normalizedItems };
}

function validateSimulationPatch(body) {
  const b = ensureObject(body, 'body');
  return {
    mode: String(b.mode || 'simulator_only'),
    simulation: b.simulation && typeof b.simulation === 'object' ? b.simulation : {},
  };
}

module.exports = {
  ERROR_CODES,
  createError,
  createCorrelationId,
  normalizeHexId,
  validateNodeCreate,
  validateGatewayCreate,
  validateLayoutApply,
  validateSimulationPatch,
};
