const {
  ERROR_CODES,
  createCorrelationId,
  createError,
  normalizeHexId,
  validateNodeCreate,
  validateGatewayCreate,
  validateLayoutApply,
  validateSimulationPatch,
} = require('./contracts');
const { RetryQueue } = require('./retry-queue');
const { fetchAllApplicationDevices, fetchAllTenantGateways } = require('../chirpstack/inventory');
const {
  ensureTopologyOverlay,
  ensureChirpstackLiveRx,
  buildMergedTopology,
} = require('../chirpstack/topology-merge');
const { mapRxInfoToGatewayReceptions } = require('../chirpstack/rxInfo');

function normalizeApiBase(url) {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return raw.endsWith('/api') ? raw.slice(0, -4) : raw;
}

async function csFetch(baseUrl, authHeader, token, apiPath, method = 'GET', body = null) {
  const url = `${baseUrl}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
  const headers = {
    [authHeader]: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  return { ok: res.ok, status: res.status, json, text };
}

class OrchestratorService {
  constructor(options) {
    this.getConfig = options.getConfig;
    this.getSimState = options.getSimState;
    this.updateSimState = options.updateSimState;
    this.writeSimState = options.writeSimState;
    this.updateRuntimePosition = options.updateRuntimePosition;
    this.persistConfig = options.persistConfig;
    this.retryQueue = options.retryQueue || new RetryQueue();
    this.layoutRevision = 0;
    this.resourceMeta = { nodes: {}, gateways: {} };
    /** @type {Map<string, number>} */
    this._topologyRxThrottle = new Map();
  }

  /**
   * @param {string} devEuiUpper
   * @param {unknown} rxInfo - ChirpStack JSON integration rxInfo array
   */
  recordUplinkRxInfo(devEuiUpper, rxInfo) {
    if (!this._isTopologyEnabled()) return;
    const receptions = mapRxInfoToGatewayReceptions(rxInfo);
    if (!receptions.length) return;
    const simState = this.getSimState();
    ensureChirpstackLiveRx(simState);
    ensureTopologyOverlay(simState);
    const idLower = String(devEuiUpper || '')
      .replace(/[^a-fA-F0-9]/g, '')
      .toLowerCase();
    if (idLower.length !== 16) return;
    const now = Date.now();
    const last = this._topologyRxThrottle.get(idLower) || 0;
    if (now - last < 600) return;
    this._topologyRxThrottle.set(idLower, now);
    simState.chirpstackLiveRx.byDevEui[idLower] = { receptions, ts: now };
    this.updateSimState({ chirpstackLiveRx: simState.chirpstackLiveRx });
  }

  recordChirpstackIntegrationMessage(topic, payloadBuf) {
    if (!this._isTopologyEnabled() || !payloadBuf) return;
    try {
      const t = String(topic || '');
      if (!t.includes('/event/up')) return;
      const match = t.match(/application\/[^/]+\/device\/([^/]+)/);
      let devEui = match ? match[1] : null;
      if (!devEui) return;
      devEui = devEui.toUpperCase();
      const event = JSON.parse(payloadBuf.toString());
      if (!event || !Array.isArray(event.rxInfo)) return;
      this.recordUplinkRxInfo(devEui, event.rxInfo);
    } catch {
      // ignore malformed integration payloads
    }
  }

  _syncOk() {
    return { state: 'synced', targets: ['chirpstack', 'simulator'], lastError: null, updatedAt: new Date().toISOString() };
  }

  _syncError(code, message, retryable = true) {
    return {
      state: code === ERROR_CODES.PARTIAL_SUCCESS ? 'partial_success' : 'error',
      targets: ['chirpstack', 'simulator'],
      lastError: { code, message, retryable },
      updatedAt: new Date().toISOString(),
    };
  }

  _ensureConfigStructures() {
    const config = this.getConfig();
    if (!config.multiGateway) config.multiGateway = { enabled: true, mode: 'overlapping', gateways: [] };
    if (!Array.isArray(config.multiGateway.gateways)) config.multiGateway.gateways = [];
    if (!Array.isArray(config.devices)) config.devices = [];
    return config;
  }

  _deviceDevEui(device) {
    if (!device || typeof device !== 'object') return '';
    return normalizeHexId(device.devEui || (device.lorawan && device.lorawan.devEui), 8);
  }

  _ensureChirpstackEnv() {
    const config = this.getConfig() || {};
    const cs = config.chirpstack && typeof config.chirpstack === 'object' ? config.chirpstack : {};
    const baseUrl = normalizeApiBase(cs.baseUrl || process.env.CHIRPSTACK_API_URL || '');
    const token = String(cs.apiToken || process.env.CHIRPSTACK_API_TOKEN || '');
    const authHeader = String(cs.authHeader || process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization');
    if (!baseUrl || !token) {
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Missing CHIRPSTACK_API_URL or CHIRPSTACK_API_TOKEN');
    }
    return { baseUrl, token, authHeader };
  }

  _isChirpstackSyncEnabled() {
    return String(process.env.ENABLE_CHIRPSTACK_SYNC || 'true').toLowerCase() !== 'false';
  }

  _isTopologyEnabled() {
    const env = process.env.ENABLE_CHIRPSTACK_TOPOLOGY;
    if (env != null && String(env).trim() !== '') {
      const v = String(env).toLowerCase();
      return v === 'true' || v === '1' || v === 'yes';
    }
    const cs = this.getConfig()?.chirpstack || {};
    return Boolean(cs.topologyEnabled);
  }

  _topologyRxStalenessSec() {
    const cs = this.getConfig()?.chirpstack || {};
    const n = Number(cs.rxStalenessSec);
    return Number.isFinite(n) && n > 0 ? n : 120;
  }

  _topologyInventoryPollSec() {
    const cs = this.getConfig()?.chirpstack || {};
    const n = Number(cs.inventoryPollSec);
    return Number.isFinite(n) && n >= 5 ? n : 60;
  }

  /**
   * Pull devices/gateways from ChirpStack REST into simState.chirpstackInventory.
   */
  async refreshChirpstackInventory() {
    const simState = this.getSimState();
    ensureTopologyOverlay(simState);
    ensureChirpstackLiveRx(simState);
    if (!this._isTopologyEnabled()) {
      const cur = simState.chirpstackInventory;
      this.updateSimState({
        chirpstackInventory: {
          nodes: cur?.nodes || [],
          gateways: cur?.gateways || [],
          updatedAt: cur?.updatedAt || null,
          error: null,
          skipped: true,
        },
      });
      return { ok: true, skipped: true };
    }
    let baseUrl;
    let token;
    let authHeader;
    try {
      ({ baseUrl, token, authHeader } = this._ensureChirpstackEnv());
    } catch (e) {
      const inv = {
        nodes: simState.chirpstackInventory?.nodes || [],
        gateways: simState.chirpstackInventory?.gateways || [],
        updatedAt: new Date().toISOString(),
        error: { message: e.message || String(e) },
      };
      this.updateSimState({ chirpstackInventory: inv });
      this.writeSimState();
      return { ok: false, error: inv.error };
    }
    const config = this.getConfig() || {};
    const cs = config.chirpstack && typeof config.chirpstack === 'object' ? config.chirpstack : {};
    const applicationIds = Array.isArray(cs.applicationIds) && cs.applicationIds.length
      ? cs.applicationIds.map((x) => String(x).trim()).filter(Boolean)
      : [cs.applicationId || process.env.CHIRPSTACK_APPLICATION_ID || ''].map((x) => String(x).trim()).filter(Boolean);
    const tenantId = String(cs.tenantId || process.env.CHIRPSTACK_TENANT_ID || '').trim();
    const seenDev = new Set();
    const allDevices = [];
    const errors = [];
    for (const appId of applicationIds) {
      const r = await fetchAllApplicationDevices(baseUrl, authHeader, token, appId);
      if (!r.ok) errors.push(r.message || `devices:${r.status}`);
      else {
        for (const d of r.devices) {
          const k = String(d.devEui || '').toLowerCase();
          if (k && !seenDev.has(k)) {
            seenDev.add(k);
            allDevices.push(d);
          }
        }
      }
    }
    const gwRes = await fetchAllTenantGateways(baseUrl, authHeader, token, tenantId);
    if (!gwRes.ok) errors.push(gwRes.message || `gateways:${gwRes.status}`);
    const inv = {
      nodes: allDevices,
      gateways: gwRes.ok ? gwRes.gateways : simState.chirpstackInventory?.gateways || [],
      updatedAt: new Date().toISOString(),
      error: errors.length ? { message: errors.join('; ') } : null,
    };
    this.updateSimState({ chirpstackInventory: inv });
    this.writeSimState();
    return { ok: !errors.length, error: inv.error };
  }

  /**
   * HTTP response body for GET /sim-state (merged topology when enabled).
   */
  getSimStateForHttp() {
    const simState = this.getSimState();
    const profileConfig = simState.config?.profileConfig;
    if (this._isTopologyEnabled()) {
      const merged = buildMergedTopology(simState, { rxStalenessSec: this._topologyRxStalenessSec() });
      return {
        ...simState,
        config: {
          ...(simState.config || {}),
          profileConfig,
        },
        nodes: merged.nodes,
        gateways: merged.gateways,
        topologyDisplayEnabled: true,
      };
    }
    return {
      ...simState,
      config: {
        ...(simState.config || {}),
        profileConfig,
      },
      topologyDisplayEnabled: false,
    };
  }

  _chirpstackOnlyInInventory(simState, kind, idLower) {
    const inv = simState.chirpstackInventory || { nodes: [], gateways: [] };
    if (kind === 'node') {
      const list = Array.isArray(inv.nodes) ? inv.nodes : [];
      return list.some((row) => String(row.devEui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase() === idLower);
    }
    const list = Array.isArray(inv.gateways) ? inv.gateways : [];
    return list.some((row) => String(row.gatewayId || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase() === idLower);
  }

  _chirpstackLiveOnlyNode(simState, idLower) {
    const live = simState.chirpstackLiveRx?.byDevEui?.[idLower];
    return Boolean(live && Array.isArray(live.receptions) && live.receptions.length);
  }

  async _chirpstackUpsertNode(node, isUpdate) {
    const { baseUrl, token, authHeader } = this._ensureChirpstackEnv();
    const config = this.getConfig() || {};
    const cs = config.chirpstack && typeof config.chirpstack === 'object' ? config.chirpstack : {};
    const appId = node.chirpstack.applicationId || cs.applicationId || process.env.CHIRPSTACK_APPLICATION_ID || '';
    const profileId = node.chirpstack.deviceProfileId || cs.deviceProfileId || process.env.CHIRPSTACK_DEVICE_PROFILE_ID || '';
    if (!appId || !profileId) {
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Missing applicationId/deviceProfileId for node sync');
    }
    if (!isUpdate) {
      const createBody = {
        device: {
          dev_eui: node.devEui,
          name: node.name,
          application_id: appId,
          device_profile_id: profileId,
        },
      };
      const createRes = await csFetch(baseUrl, authHeader, token, '/api/devices', 'POST', createBody);
      if (!createRes.ok && createRes.status !== 409) {
        throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Create device failed (${createRes.status})`);
      }
      const appKey = String(node.chirpstack.appKey || '').replace(/[^a-fA-F0-9]/g, '');
      if (appKey.length === 32) {
        const keyBody = { device_keys: { dev_eui: node.devEui, nwk_key: appKey, app_key: appKey } };
        let keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'POST', keyBody);
        if (!keyRes.ok) {
          keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'PUT', keyBody);
        }
        if (!keyRes.ok) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Upsert keys failed (${keyRes.status})`);
      }
      return;
    }
    const updateBody = {
      device: {
        dev_eui: node.devEui,
        name: node.name,
        application_id: appId,
        device_profile_id: profileId,
      },
    };
    const updateRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}`, 'PUT', updateBody);
    if (!updateRes.ok) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Update device failed (${updateRes.status})`);
  }

  async _chirpstackUpsertGateway(gateway, isUpdate) {
    const { baseUrl, token, authHeader } = this._ensureChirpstackEnv();
    const config = this.getConfig() || {};
    const cs = config.chirpstack && typeof config.chirpstack === 'object' ? config.chirpstack : {};
    const tenantId = gateway.chirpstack.tenantId || cs.tenantId || process.env.CHIRPSTACK_TENANT_ID || '';
    if (!tenantId) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Missing tenantId for gateway sync');
    const body = {
      gateway: {
        gateway_id: gateway.gatewayId,
        name: gateway.name,
        tenant_id: tenantId,
        description: 'LoRaWAN-SIM UI orchestrator',
        stats_interval: 30,
      },
    };
    const method = isUpdate ? 'PUT' : 'POST';
    const path = isUpdate ? `/api/gateways/${gateway.gatewayId}` : '/api/gateways';
    const res = await csFetch(baseUrl, authHeader, token, path, method, body);
    if (!res.ok && !(res.status === 409 && !isUpdate)) {
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Gateway upsert failed (${res.status})`);
    }
  }

  async _chirpstackDeleteNode(devEui) {
    const { baseUrl, token, authHeader } = this._ensureChirpstackEnv();
    const res = await csFetch(baseUrl, authHeader, token, `/api/devices/${devEui}`, 'DELETE');
    if (!res.ok && res.status !== 404) {
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Delete device failed (${res.status})`);
    }
  }

  async _chirpstackDeleteGateway(gatewayId) {
    const { baseUrl, token, authHeader } = this._ensureChirpstackEnv();
    const res = await csFetch(baseUrl, authHeader, token, `/api/gateways/${gatewayId}`, 'DELETE');
    if (!res.ok && res.status !== 404) {
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Delete gateway failed (${res.status})`);
    }
  }

  _upsertSimulatorNode(node) {
    const config = this._ensureConfigStructures();
    const devEuiUp = node.devEui.toUpperCase();
    const idx = config.devices.findIndex((d) => this._deviceDevEui(d) === node.devEui);
    const prev = idx >= 0 ? config.devices[idx] : {};
    const radio = node.radio && typeof node.radio === 'object' ? node.radio : {};
    const chirp = node.chirpstack && typeof node.chirpstack === 'object' ? node.chirpstack : {};
    const uplink = node.uplink && typeof node.uplink === 'object' ? node.uplink : {};
    const lorawan = node.lorawan && typeof node.lorawan === 'object' ? node.lorawan : {};

    const intervalMsReq = radio.intervalMs != null ? Number(radio.intervalMs) : null;
    const intervalSec =
      intervalMsReq != null && Number.isFinite(intervalMsReq)
        ? Math.max(1, Math.round(intervalMsReq / 1000))
        : prev.interval != null
          ? Math.max(1, Number(prev.interval))
          : Math.max(1, Math.round(10000 / 1000));

    let appKey = prev.appKey || '';
    if (chirp.appKey != null) {
      const raw = String(chirp.appKey).replace(/\s/g, '');
      if (raw.length === 32) appKey = raw.toUpperCase();
    }

    let dataRate = prev.dataRate;
    if (radio.sf !== undefined && radio.sf !== null && radio.sf !== '') {
      const n = Number(radio.sf);
      if (Number.isFinite(n)) dataRate = n;
    }

    let txPower = prev.txPower;
    if (radio.txPower !== undefined && radio.txPower !== null && radio.txPower !== '') {
      const n = Number(radio.txPower);
      if (Number.isFinite(n)) txPower = n;
    }

    let adr = prev.adr !== false;
    if (Object.prototype.hasOwnProperty.call(radio, 'adr')) {
      adr = radio.adr !== false;
    }

    const fPortReq = radio.fPort != null ? Number(radio.fPort) : undefined;
    let fPort = prev.fPort != null ? Number(prev.fPort) : 2;
    if (Number.isFinite(fPortReq) && fPortReq >= 1 && fPortReq <= 223) fPort = Math.round(fPortReq);

    const devicePayload = {
      ...prev,
      name: node.name,
      enabled: node.enabled !== false,
      mode: 'otaa',
      devEui: devEuiUp,
      appKey,
      interval: intervalSec,
      fPort,
      location: { x: Number(node.position.x), y: Number(node.position.y), z: Number(node.position.z || 2) },
      adr,
    };
    if (lorawan.appEui || lorawan.joinEui) devicePayload.joinEui = String(lorawan.appEui || lorawan.joinEui);
    if (lorawan.nwkKey) devicePayload.nwkKey = String(lorawan.nwkKey);
    if (node.adrReject !== undefined) devicePayload.adrReject = Boolean(node.adrReject);
    if (node.devStatus !== undefined) devicePayload.devStatus = Boolean(node.devStatus);
    if (node.duplicateFirstData !== undefined) devicePayload.duplicateFirstData = Boolean(node.duplicateFirstData);
    if (node.anomaly && typeof node.anomaly === 'object') devicePayload.anomaly = node.anomaly;
    if (node.nodeState && typeof node.nodeState === 'object') devicePayload.nodeState = node.nodeState;
    if (Object.keys(uplink).length > 0) {
      devicePayload.uplink = { ...(prev.uplink || {}), ...uplink };
    }
    if (dataRate !== undefined && dataRate !== null) devicePayload.dataRate = dataRate;
    if (txPower !== undefined && txPower !== null) devicePayload.txPower = txPower;

    if (idx >= 0) config.devices[idx] = devicePayload;
    else config.devices.push(devicePayload);

    const simState = this.getSimState();
    if (!Array.isArray(simState.nodes)) simState.nodes = [];
    const sidx = simState.nodes.findIndex((n) => normalizeHexId(n.eui, 8) === node.devEui);
    const old = sidx >= 0 ? simState.nodes[sidx] : {};
    const intervalMsOut = intervalSec * 1000;
    const next = {
      ...old,
      eui: devEuiUp,
      name: node.name,
      enabled: node.enabled !== false,
      anomaly: devicePayload.anomaly,
      nodeState: devicePayload.nodeState,
      adrReject: devicePayload.adrReject,
      devStatus: devicePayload.devStatus,
      duplicateFirstData: devicePayload.duplicateFirstData,
      joined: old.joined || false,
      devAddr: old.devAddr || 'N/A',
      fCnt: old.fCnt || 0,
      rssi: old.rssi ?? -80,
      snr: old.snr ?? 5,
      uplinks: old.uplinks || 0,
      position: { x: Number(node.position.x), y: Number(node.position.y), z: Number(node.position.z || 2) },
      syncStatus: this._syncOk(),
      simulator: {
        intervalMs: intervalMsOut,
        sf: devicePayload.dataRate,
        txPower: devicePayload.txPower,
        adr: devicePayload.adr !== false,
        fPort: devicePayload.fPort,
        uplinkCodec: devicePayload.uplink?.codec,
        appKeyConfigured: Boolean(appKey && String(appKey).replace(/\s/g, '').length === 32),
      },
    };
    if (sidx >= 0) simState.nodes[sidx] = next;
    else simState.nodes.push(next);
    this.resourceMeta.nodes[node.devEui] = { revision: (this.resourceMeta.nodes[node.devEui]?.revision || 0) + 1 };
    this.updateSimState({ nodes: simState.nodes });
  }

  _upsertSimulatorGateway(gateway) {
    const config = this._ensureConfigStructures();
    const idx = config.multiGateway.gateways.findIndex((g) => normalizeHexId(g.eui, 8) === gateway.gatewayId);
    const prev = idx >= 0 ? config.multiGateway.gateways[idx] : {};
    const radio = gateway.radio && typeof gateway.radio === 'object' ? gateway.radio : {};
    const defNoise = config.signalModel?.noiseFloor ?? -100;
    const payload = {
      ...prev,
      eui: gateway.gatewayId,
      name: gateway.name,
      position: {
        x: Number(gateway.position.x),
        y: Number(gateway.position.y),
        z: Number(gateway.position.z || 30),
      },
      rxGain: Number(radio.rxGain != null ? radio.rxGain : prev.rxGain != null ? prev.rxGain : 5),
      rxSensitivity: Number(
        radio.rxSensitivity != null ? radio.rxSensitivity : prev.rxSensitivity != null ? prev.rxSensitivity : -137,
      ),
      cableLoss: Number(radio.cableLoss != null ? radio.cableLoss : prev.cableLoss != null ? prev.cableLoss : 0.5),
      noiseFloor: Number(radio.noiseFloor != null ? radio.noiseFloor : prev.noiseFloor != null ? prev.noiseFloor : defNoise),
    };
    if (idx >= 0) config.multiGateway.gateways[idx] = payload;
    else config.multiGateway.gateways.push(payload);

    const simState = this.getSimState();
    if (!Array.isArray(simState.gateways)) simState.gateways = [];
    const sidx = simState.gateways.findIndex((g) => normalizeHexId(g.eui, 8) === gateway.gatewayId);
    const next = { ...(sidx >= 0 ? simState.gateways[sidx] : {}), ...payload, syncStatus: this._syncOk() };
    if (sidx >= 0) simState.gateways[sidx] = next;
    else simState.gateways.push(next);
    this.resourceMeta.gateways[gateway.gatewayId] = { revision: (this.resourceMeta.gateways[gateway.gatewayId]?.revision || 0) + 1 };
    this.updateSimState({
      gateways: simState.gateways,
      config: {
        ...(simState.config || {}),
        signalModel: config.signalModel,
        multiGateway: config.multiGateway,
        chirpstack: {
          ...(config.chirpstack || {}),
          apiToken: config.chirpstack && config.chirpstack.apiToken ? '***' : '',
        },
      },
    });
  }

  _upsertSimulationConfig(simulation) {
    const config = this._ensureConfigStructures();
    if (!config.signalModel) config.signalModel = {};
    if (!config.multiGateway) config.multiGateway = { enabled: true, mode: 'overlapping', gateways: [] };
    const signalModel = simulation.signalModel && typeof simulation.signalModel === 'object' ? simulation.signalModel : {};
    const multiGateway = simulation.multiGateway && typeof simulation.multiGateway === 'object' ? simulation.multiGateway : {};
    const chirpstack = simulation.chirpstack && typeof simulation.chirpstack === 'object' ? simulation.chirpstack : {};
    config.signalModel = { ...config.signalModel, ...signalModel };
    config.multiGateway = { ...config.multiGateway, ...multiGateway };
    if (!config.chirpstack) config.chirpstack = {};
    const prevCs = { ...(config.chirpstack || {}) };
    const incCs = { ...chirpstack };
    if (incCs.integrationMqtt && typeof incCs.integrationMqtt === 'object') {
      const prevIm = prevCs.integrationMqtt && typeof prevCs.integrationMqtt === 'object' ? prevCs.integrationMqtt : {};
      const incIm = incCs.integrationMqtt;
      incCs.integrationMqtt = { ...prevIm, ...incIm };
      if (!incIm.password && prevIm.password) {
        incCs.integrationMqtt.password = prevIm.password;
      }
    }
    config.chirpstack = { ...prevCs, ...incCs };
    const simState = this.getSimState();
    this.updateSimState({
      config: {
        ...(simState.config || {}),
        signalModel: config.signalModel,
        multiGateway: config.multiGateway,
        chirpstack: {
          ...(config.chirpstack || {}),
          apiToken: config.chirpstack && config.chirpstack.apiToken ? '***' : '',
        },
      },
    });
  }

  _enqueuePartial(resourceId, operation, errorMessage, payload) {
    const jobId = `sync-job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return this.retryQueue.enqueue({
      jobId,
      resourceId,
      operation,
      stageFailed: 'simulator_apply',
      errorMessage,
      payload,
    });
  }

  _persistConfigIfNeeded() {
    if (typeof this.persistConfig === 'function') {
      this.persistConfig(this.getConfig());
    }
  }

  async createNode(body) {
    const correlationId = createCorrelationId();
    try {
      const req = validateNodeCreate(body);
      const needSync = req.mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackUpsertNode(req.node, false);
      this._upsertSimulatorNode(req.node);
      this._persistConfigIfNeeded();
      this.writeSimState();
      return { ok: true, data: { node: req.node, syncStatus: this._syncOk() }, correlationId };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: true }, correlationId };
      }
      if (e.code === ERROR_CODES.VALIDATION) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: false }, correlationId };
      }
      const req = validateNodeCreate(body);
      const job = this._enqueuePartial(req.node.devEui, 'create_node', e.message, req);
      const syncStatus = this._syncError(ERROR_CODES.PARTIAL_SUCCESS, e.message);
      this._upsertSimulatorNode({ ...req.node, syncStatus });
      this.writeSimState();
      return {
        ok: false,
        error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
        correlationId,
      };
    }
  }

  async updateNode(devEui, body) {
    const correlationId = createCorrelationId();
    try {
      const req = validateNodeCreate({ ...body, node: { ...(body?.node || {}), devEui } });
      const needSync = req.mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackUpsertNode(req.node, true);
      this._upsertSimulatorNode(req.node);
      this._persistConfigIfNeeded();
      this.writeSimState();
      return { ok: true, data: { node: req.node, syncStatus: this._syncOk() }, correlationId };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: true }, correlationId };
      }
      if (e.code === ERROR_CODES.VALIDATION) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: false }, correlationId };
      }
      const req = validateNodeCreate({ ...body, node: { ...(body?.node || {}), devEui } });
      const job = this._enqueuePartial(req.node.devEui, 'update_node', e.message, req);
      return {
        ok: false,
        error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
        correlationId,
      };
    }
  }

  async createGateway(body) {
    const correlationId = createCorrelationId();
    try {
      const req = validateGatewayCreate(body);
      const needSync = req.mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackUpsertGateway(req.gateway, false);
      this._upsertSimulatorGateway(req.gateway);
      this._persistConfigIfNeeded();
      this.writeSimState();
      return { ok: true, data: { gateway: req.gateway, syncStatus: this._syncOk() }, correlationId };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: true }, correlationId };
      }
      if (e.code === ERROR_CODES.VALIDATION) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: false }, correlationId };
      }
      const req = validateGatewayCreate(body);
      const job = this._enqueuePartial(req.gateway.gatewayId, 'create_gateway', e.message, req);
      return {
        ok: false,
        error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
        correlationId,
      };
    }
  }

  async updateGateway(gatewayId, body) {
    const correlationId = createCorrelationId();
    try {
      const req = validateGatewayCreate({ ...body, gateway: { ...(body?.gateway || {}), gatewayId } });
      const needSync = req.mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackUpsertGateway(req.gateway, true);
      this._upsertSimulatorGateway(req.gateway);
      this._persistConfigIfNeeded();
      this.writeSimState();
      return { ok: true, data: { gateway: req.gateway, syncStatus: this._syncOk() }, correlationId };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: true }, correlationId };
      }
      if (e.code === ERROR_CODES.VALIDATION) {
        return { ok: false, error: { code: e.code, message: e.message, retryable: false }, correlationId };
      }
      const req = validateGatewayCreate({ ...body, gateway: { ...(body?.gateway || {}), gatewayId } });
      const job = this._enqueuePartial(req.gateway.gatewayId, 'update_gateway', e.message, req);
      return {
        ok: false,
        error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
        correlationId,
      };
    }
  }

  async deleteNode(devEui, body = {}) {
    const id = normalizeHexId(devEui, 8);
    if (!id) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION, message: 'devEui must be 16 hex chars', retryable: false }, correlationId: createCorrelationId() };
    }
    const correlationId = createCorrelationId();
    const mode = String(body.mode || 'simulator_only');
    try {
      const needSync = mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackDeleteNode(id.toUpperCase());
      const config = this._ensureConfigStructures();
      config.devices = config.devices.filter((d) => this._deviceDevEui(d) !== id);
      const simState = this.getSimState();
      if (!Array.isArray(simState.nodes)) simState.nodes = [];
      const sidx = simState.nodes.findIndex((n) => normalizeHexId(n.eui, 8) === id);
      if (sidx >= 0) simState.nodes.splice(sidx, 1);
      delete this.resourceMeta.nodes[id];
      this._persistConfigIfNeeded();
      this.updateSimState({ nodes: simState.nodes });
      this.writeSimState();
      return { ok: true, data: { deleted: id.toUpperCase(), kind: 'node' }, correlationId };
    } catch (e) {
      return {
        ok: false,
        error: { code: e.code || ERROR_CODES.SIMULATOR_FAILED, message: e.message || String(e), retryable: true },
        correlationId,
      };
    }
  }

  async deleteGateway(gatewayId, body = {}) {
    const id = normalizeHexId(gatewayId, 8);
    if (!id) {
      return { ok: false, error: { code: ERROR_CODES.VALIDATION, message: 'gatewayId must be 16 hex chars', retryable: false }, correlationId: createCorrelationId() };
    }
    const correlationId = createCorrelationId();
    const mode = String(body.mode || 'simulator_only');
    try {
      const needSync = mode !== 'simulator_only' && this._isChirpstackSyncEnabled();
      if (needSync) await this._chirpstackDeleteGateway(id);
      const config = this._ensureConfigStructures();
      const gidx = config.multiGateway.gateways.findIndex((g) => normalizeHexId(g.eui, 8) === id);
      if (gidx >= 0) config.multiGateway.gateways.splice(gidx, 1);
      const simState = this.getSimState();
      if (!Array.isArray(simState.gateways)) simState.gateways = [];
      const sidx = simState.gateways.findIndex((g) => normalizeHexId(g.eui, 8) === id);
      if (sidx >= 0) simState.gateways.splice(sidx, 1);
      delete this.resourceMeta.gateways[id];
      this._persistConfigIfNeeded();
      this.updateSimState({
        gateways: simState.gateways,
        config: {
          ...(simState.config || {}),
          signalModel: config.signalModel,
          multiGateway: config.multiGateway,
          chirpstack: {
            ...(config.chirpstack || {}),
            apiToken: config.chirpstack && config.chirpstack.apiToken ? '***' : '',
          },
        },
      });
      this.writeSimState();
      return { ok: true, data: { deleted: id, kind: 'gateway' }, correlationId };
    } catch (e) {
      return {
        ok: false,
        error: { code: e.code || ERROR_CODES.SIMULATOR_FAILED, message: e.message || String(e), retryable: true },
        correlationId,
      };
    }
  }

  async applyLayout(body) {
    const correlationId = createCorrelationId();
    let req;
    try {
      req = validateLayoutApply(body);
    } catch (e) {
      return { ok: false, error: { code: e.code || ERROR_CODES.VALIDATION, message: e.message, retryable: false }, correlationId };
    }
    if (Number.isFinite(req.revision) && req.revision < this.layoutRevision) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.CONFLICT_REVISION,
          message: `layout revision conflict: current=${this.layoutRevision}, request=${req.revision}`,
          retryable: false,
        },
        correlationId,
      };
    }
    const simState = this.getSimState();
    ensureTopologyOverlay(simState);
    const updatedItems = [];
    for (const item of req.items) {
      const arr = item.kind === 'node' ? simState.nodes : simState.gateways;
      const idx = (arr || []).findIndex((v) => normalizeHexId(v.eui || v.id, 8) === item.id);
      if (idx < 0) {
        const idLower = normalizeHexId(item.id, 8);
        const overlayKey = item.kind === 'node' ? 'nodes' : 'gateways';
        const inCsInv = this._chirpstackOnlyInInventory(simState, item.kind, idLower);
        const inLive = item.kind === 'node' && this._chirpstackLiveOnlyNode(simState, idLower);
        if (this._isTopologyEnabled() && (inCsInv || inLive)) {
          simState.topologyOverlay[overlayKey][idLower] = item.position;
          updatedItems.push({ id: item.id, kind: item.kind, position: item.position, overlayOnly: true });
          continue;
        }
        return { ok: false, error: { code: ERROR_CODES.NOT_FOUND, message: `${item.kind} ${item.id} not found`, retryable: false }, correlationId };
      }
      arr[idx].position = item.position;
      arr[idx].syncStatus = this._syncOk();
      if (item.kind === 'gateway') {
        const config = this._ensureConfigStructures();
        const gidx = config.multiGateway.gateways.findIndex((g) => normalizeHexId(g.eui, 8) === item.id);
        if (gidx >= 0) config.multiGateway.gateways[gidx].position = item.position;
      } else {
        const config = this._ensureConfigStructures();
        const didx = config.devices.findIndex((d) => this._deviceDevEui(d) === item.id);
        if (didx >= 0) config.devices[didx].location = item.position;
      }
      if (typeof this.updateRuntimePosition === 'function') {
        this.updateRuntimePosition(item.kind, item.id, item.position);
      }
      updatedItems.push({
        id: item.id,
        kind: item.kind,
        position: item.position,
      });
    }
    this.layoutRevision += 1;
    if (typeof this.persistConfig === 'function') {
      try {
        this.persistConfig(this.getConfig());
      } catch (e) {
        return {
          ok: false,
          error: {
            code: ERROR_CODES.SIMULATOR_FAILED,
            message: `persist config failed: ${e.message || e}`,
            retryable: true,
          },
          correlationId,
        };
      }
    }
    this.updateSimState({ nodes: simState.nodes, gateways: simState.gateways, layoutRevision: this.layoutRevision });
    this.writeSimState();
    return {
      ok: true,
      data: { revision: this.layoutRevision, updated: req.items.length, items: updatedItems },
      correlationId,
    };
  }

  async updateSimulation(body) {
    const correlationId = createCorrelationId();
    try {
      const req = validateSimulationPatch(body);
      this._upsertSimulationConfig(req.simulation);
      if (typeof this.persistConfig === 'function') {
        this.persistConfig(this.getConfig());
      }
      this.writeSimState();
      return { ok: true, data: { simulation: req.simulation, syncStatus: this._syncOk() }, correlationId };
    } catch (e) {
      return {
        ok: false,
        error: { code: ERROR_CODES.SIMULATOR_FAILED, message: e.message || String(e), retryable: true },
        correlationId,
      };
    }
  }

  async retry(resourceIds) {
    const correlationId = createCorrelationId();
    const ids = Array.isArray(resourceIds) ? resourceIds.map((v) => normalizeHexId(v, 8)).filter(Boolean) : [];
    const jobs = this.retryQueue.list().filter((j) => !ids.length || ids.includes(normalizeHexId(j.resourceId, 8)));
    const results = [];
    for (const job of jobs) {
      try {
        if (job.operation === 'create_node') await this.createNode(job.payload);
        else if (job.operation === 'update_node') await this.updateNode(job.resourceId, job.payload);
        else if (job.operation === 'create_gateway') await this.createGateway(job.payload);
        else if (job.operation === 'update_gateway') await this.updateGateway(job.resourceId, job.payload);
        this.retryQueue.markSuccess(job.jobId);
        results.push({ jobId: job.jobId, status: 'success' });
      } catch (e) {
        const next = this.retryQueue.markFailure(job.jobId);
        results.push({ jobId: job.jobId, status: next?.dead ? 'dead' : 'retry_scheduled', error: e.message });
      }
    }
    return { ok: true, data: { retried: results.length, results, queueSize: this.retryQueue.list().length }, correlationId };
  }
}

module.exports = { OrchestratorService };
