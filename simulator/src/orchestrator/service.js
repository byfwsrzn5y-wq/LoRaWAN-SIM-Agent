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

function extractHostFromUrlLike(urlLike) {
  const raw = String(urlLike || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname || '';
  } catch {
    try {
      return new URL(`http://${raw}`).hostname || '';
    } catch {
      return '';
    }
  }
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

  _syncOk({ chirpstackSynced = true } = {}) {
    const targets = ['simulator'];
    if (chirpstackSynced) targets.unshift('chirpstack');
    return { state: 'synced', targets, lastError: null, updatedAt: new Date().toISOString() };
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

  _stringTrim(v) {
    return String(v == null ? '' : v).trim();
  }

  _pickFirstIdFromList(json, listKeys, idKeys = ['id', 'applicationId', 'deviceProfileId']) {
    if (!json || typeof json !== 'object') return '';
    for (const k of listKeys) {
      const arr = json[k];
      if (Array.isArray(arr) && arr.length) {
        const first = arr[0] || {};
        for (const idKey of idKeys) {
          const candidate = first[idKey];
          if (candidate) return String(candidate).trim();
        }
        if (first.id) return String(first.id).trim();
      }
    }
    return '';
  }

  async _chirpstackEnsureApplicationId(baseUrl, authHeader, token, tenantId, preferredAppId) {
    // Strategy:
    // - If preferredAppId exists (non-empty) we still might fail later, so this method returns it only when it is present in list.
    // - Otherwise pick the first existing application under tenant.
    // - If tenant has no applications, auto-create one.
    const pid = this._stringTrim(preferredAppId);
    if (!tenantId) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Missing tenantId for application auto-create');

    // Try to find preferred app in tenant list (first page).
    if (pid) {
      const listRes = await csFetch(
        baseUrl,
        authHeader,
        token,
        `/api/applications?tenantId=${encodeURIComponent(tenantId)}&limit=200&offset=0`
      );
      if (listRes.ok) {
        const found = this._pickFirstIdFromList(listRes.json, ['result', 'applications'], ['id', 'applicationId']);
        // If listRes returned a first id but not matching pid, ignore; we will fall back to "first existing" below.
        if (found && found.toLowerCase() === pid.toLowerCase()) return pid;
      }
    }

    const listRes = await csFetch(
      baseUrl,
      authHeader,
      token,
      `/api/applications?tenantId=${encodeURIComponent(tenantId)}&limit=1&offset=0`
    );
    if (listRes.ok) {
      const firstId = this._pickFirstIdFromList(listRes.json, ['result', 'applications'], ['id', 'applicationId']);
      if (firstId) return firstId;
    }

    const createName = 'LoRaWAN-SIM auto';
    const createBody = {
      application: {
        tenantId,
        name: createName,
        description: 'Auto-created by LoRaWAN-SIM UI (ensure applicationId for device provisioning).',
      },
    };
    const createRes = await csFetch(baseUrl, authHeader, token, '/api/applications', 'POST', createBody);
    if (!createRes.ok) {
      const hint = String(createRes.text || createRes.json || '').slice(0, 500);
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Auto-create application failed (${createRes.status}): ${hint}`);
    }
    const createdId = this._stringTrim(createRes.json?.id);
    if (!createdId) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Auto-create application returned empty id');
    return createdId;
  }

  async _chirpstackEnsureDeviceProfileId(baseUrl, authHeader, token, tenantId, preferredProfileId, node) {
    const pid = this._stringTrim(preferredProfileId);
    if (!tenantId) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Missing tenantId for deviceProfile auto-create');

    // Try preferred id by direct GET first.
    if (pid) {
      const getPath = `/api/device-profiles/${encodeURIComponent(pid)}`;
      const gr = await csFetch(baseUrl, authHeader, token, getPath);
      if (gr.ok) return pid;
    }

    // Pick first existing device profile under tenant.
    const listRes = await csFetch(
      baseUrl,
      authHeader,
      token,
      `/api/device-profiles?tenantId=${encodeURIComponent(tenantId)}&limit=1&offset=0`
    );
    if (listRes.ok) {
      const firstId = this._pickFirstIdFromList(listRes.json, ['result', 'deviceProfiles'], ['id', 'deviceProfileId']);
      if (firstId) return firstId;
    }

    // Auto-create a minimal OTAA-capable device profile (based on simulator config defaults).
    const config = this.getConfig() || {};
    const region = this._stringTrim(config.lorawan?.region || config.simulation?.region || 'AS923');
    const macVersion = this._stringTrim(config.lorawan?.macVersion || 'LORAWAN_1_0_4');
    const regParamsRevision = this._stringTrim(
      (macVersion.includes('1_1_0') ? 'RP002_1_0_4' : 'RP002_1_0_3') || 'RP002_1_0_3'
    );

    const intervalMsReq = node?.radio && typeof node.radio === 'object' ? Number(node.radio.intervalMs) : null;
    const uplinkInterval = Number.isFinite(intervalMsReq) && intervalMsReq > 0 ? Math.max(1, Math.round(intervalMsReq / 1000)) : 60;

    // ADR algorithm: pick first available if possible.
    let adrAlgorithmId = 'default';
    try {
      const adrRes = await csFetch(baseUrl, authHeader, token, '/api/device-profiles/adr-algorithms');
      if (adrRes.ok) {
        const list = adrRes.json?.result;
        if (Array.isArray(list) && list.length) {
          const first = list[0] || {};
          adrAlgorithmId = this._stringTrim(first.id || first.adrAlgorithmId || adrAlgorithmId);
        }
      }
    } catch {
      // ignore, fallback to 'default'
    }

    const createBody = {
      deviceProfile: {
        tenantId,
        name: 'LoRaWAN-SIM auto',
        description: 'Auto-created by LoRaWAN-SIM UI (ensure deviceProfileId for device provisioning).',
        region,
        macVersion,
        regParamsRevision,
        adrAlgorithmId,
        payloadCodecRuntime: 'NONE',
        payloadCodecScript: '',
        flushQueueOnActivate: true,
        uplinkInterval,
        deviceStatusReqInterval: 1,
        supportsOtaa: true,
        supportsClassB: false,
        supportsClassC: false,
      },
    };
    const createRes = await csFetch(baseUrl, authHeader, token, '/api/device-profiles', 'POST', createBody);
    if (!createRes.ok) {
      const hint = String(createRes.text || createRes.json || '').slice(0, 800);
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Auto-create deviceProfile failed (${createRes.status}): ${hint}`);
    }
    const createdId = this._stringTrim(createRes.json?.id);
    if (!createdId) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, 'Auto-create deviceProfile returned empty id');
    return createdId;
  }

  async _chirpstackUpsertNode(node, isUpdate) {
    const { baseUrl, token, authHeader } = this._ensureChirpstackEnv();
    const config = this.getConfig() || {};
    const cs = config.chirpstack && typeof config.chirpstack === 'object' ? config.chirpstack : {};

    const tenantId = this._stringTrim(cs.tenantId || process.env.CHIRPSTACK_TENANT_ID || node.chirpstack.tenantId || '');
    let appId = this._stringTrim(
      node.chirpstack.applicationId || cs.applicationId || process.env.CHIRPSTACK_APPLICATION_ID || ''
    );
    let profileId = this._stringTrim(
      node.chirpstack.deviceProfileId || cs.deviceProfileId || process.env.CHIRPSTACK_DEVICE_PROFILE_ID || ''
    );

    let autoCreated = false;
    const ensureIds = async (force = false) => {
      if (!force && appId && profileId) return;
      const nextAppId = await this._chirpstackEnsureApplicationId(baseUrl, authHeader, token, tenantId, appId);
      const nextProfileId = await this._chirpstackEnsureDeviceProfileId(baseUrl, authHeader, token, tenantId, profileId, node);
      // Persist to simulator config so subsequent UI operations can reuse them as defaults.
      appId = nextAppId;
      profileId = nextProfileId;
      autoCreated = true;
      config.chirpstack = { ...(config.chirpstack || {}), tenantId, applicationId: appId, deviceProfileId: profileId };
      node.chirpstack = { ...(node.chirpstack || {}), applicationId: appId, deviceProfileId: profileId };
    };

    await ensureIds(false);

    const sanitizeAppKey = (raw) => String(raw == null ? '' : raw).replace(/[^a-fA-F0-9]/g, '');
    const appKeyFromNode = sanitizeAppKey(node.chirpstack?.appKey);
    const appKeyFromSim = sanitizeAppKey(config.lorawan?.appKey);
    const appKey =
      appKeyFromNode.length === 32 ? appKeyFromNode
        : appKeyFromSim.length === 32 ? appKeyFromSim
          : '';
    const appKeySource =
      appKeyFromNode.length === 32 ? 'node.chirpstack.appKey'
        : appKeyFromSim.length === 32 ? 'config.lorawan.appKey'
          : 'none';
    const appKeyMask =
      appKey.length === 32 ? `${appKey.slice(0, 4)}…${appKey.slice(-4)}` : '';

    if (!isUpdate) {
      const createDevice = async () => {
        const createBody = {
          device: {
            dev_eui: node.devEui,
            name: node.name,
            application_id: appId,
            device_profile_id: profileId,
          },
        };
        return csFetch(baseUrl, authHeader, token, '/api/devices', 'POST', createBody);
      };

      let createRes = await createDevice();
      if (!createRes.ok && createRes.status !== 409) {
        // If application/device-profile were wrong or missing, try auto-creating defaults and retry once.
        if (!autoCreated && (createRes.status === 400 || createRes.status === 404)) {
          await ensureIds(true);
          if (appId && profileId && appId !== '' && profileId !== '') createRes = await createDevice();
        }
      }

      if (!createRes.ok && createRes.status !== 409) {
        const hint = String(createRes.text || createRes.json || '').slice(0, 800);
        throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Create device failed (${createRes.status}): ${hint}`);
      }

      // Upsert device keys if we have a valid appKey.
      let keys = { attempted: false, ok: null, status: null, hint: null, source: appKeySource, mask: appKeyMask };
      if (appKey.length === 32) {
        keys.attempted = true;
        const keyBody = { device_keys: { dev_eui: node.devEui, nwk_key: appKey, app_key: appKey } };
        let keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'POST', keyBody);
        if (!keyRes.ok) {
          keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'PUT', keyBody);
        }
        keys.ok = keyRes.ok;
        keys.status = keyRes.status;
        keys.hint = String(keyRes.text || keyRes.json || '').slice(0, 400) || null;
        if (!keyRes.ok) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Upsert keys failed (${keyRes.status}): ${keys.hint || ''}`.trim());
      }

      // Verify by reading it back from ChirpStack (helps users confirm correct tenant/app/profile).
      const getRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}`);
      const keysGetRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`);
      return {
        action: 'create',
        applicationId: appId,
        deviceProfileId: profileId,
        create: { status: createRes.status, ok: createRes.ok },
        device: getRes.ok ? (getRes.json?.device || getRes.json || null) : { status: getRes.status },
        keys,
        keysGet: keysGetRes.ok ? (keysGetRes.json?.deviceKeys || keysGetRes.json || null) : { status: keysGetRes.status, hint: String(keysGetRes.text || '').slice(0, 200) },
      };
    }
    const updateBody = {
      device: {
        dev_eui: node.devEui,
        name: node.name,
        application_id: appId,
        device_profile_id: profileId,
      },
    };
    let updateRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}`, 'PUT', updateBody);
    if (!updateRes.ok && (updateRes.status === 400 || updateRes.status === 404)) {
      // Retry once with auto-created defaults if the relation IDs were invalid.
      if (!autoCreated) {
        await ensureIds(true);
        if (appId && profileId && appId !== '' && profileId !== '') {
          updateRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}`, 'PUT', updateBody);
        }
      }
    }
    if (!updateRes.ok) {
      const hint = String(updateRes.text || updateRes.json || '').slice(0, 800);
      throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Update device failed (${updateRes.status}): ${hint}`);
    }

    // Even for update (device already exists), ensure device keys exist when we have a valid appKey.
    let keys = { attempted: false, ok: null, status: null, hint: null, source: appKeySource, mask: appKeyMask };
    if (appKey.length === 32) {
      keys.attempted = true;
      const keyBody = { device_keys: { dev_eui: node.devEui, nwk_key: appKey, app_key: appKey } };
      let keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'POST', keyBody);
      if (!keyRes.ok) {
        keyRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`, 'PUT', keyBody);
      }
      keys.ok = keyRes.ok;
      keys.status = keyRes.status;
      keys.hint = String(keyRes.text || keyRes.json || '').slice(0, 400) || null;
      if (!keyRes.ok) throw createError(ERROR_CODES.CHIRPSTACK_FAILED, `Upsert keys failed (${keyRes.status}): ${keys.hint || ''}`.trim());
    }

    const getRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}`);
    const keysGetRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${node.devEui}/keys`);
    return {
      action: 'update',
      applicationId: appId,
      deviceProfileId: profileId,
      update: { status: updateRes.status, ok: updateRes.ok },
      device: getRes.ok ? (getRes.json?.device || getRes.json || null) : { status: getRes.status },
      keys,
      keysGet: keysGetRes.ok ? (keysGetRes.json?.deviceKeys || keysGetRes.json || null) : { status: keysGetRes.status, hint: String(keysGetRes.text || '').slice(0, 200) },
    };
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

  _upsertSimulatorNode(node, { chirpstackSynced = true } = {}) {
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
      syncStatus: this._syncOk({ chirpstackSynced }),
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
    if (!config.simulation) config.simulation = {};
    if (!config.simulation.gateway || typeof config.simulation.gateway !== 'object') config.simulation.gateway = {};

    const udpCfg = simulation.udp && typeof simulation.udp === 'object' ? simulation.udp : {};
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

    // Keep UDP target host aligned with ChirpStack base URL host
    // (REST baseUrl controls API, while UDP forwarding uses lnsHost / simulation.gateway.address).
    const derivedHost = extractHostFromUrlLike(config.chirpstack.baseUrl);
    if (derivedHost) {
      config.lnsHost = derivedHost;
      config.simulation.gateway.address = derivedHost;
    }

    // Apply UDP family + port from UI
    // (UDP target uses lnsHost/lnsPort and simulation.gateway.address/port).
    const udpProtocolRaw = this._stringTrim(udpCfg.protocol || udpCfg.family || udpCfg.socketFamily || udpCfg.udpSocketFamily);
    const udpProtocol = udpProtocolRaw.toLowerCase();
    if (udpProtocol === 'udp' || udpProtocol === 'udp4' || udpProtocol === 'udp6') {
      config.udpSocketFamily = udpProtocol === 'udp' ? 'udp4' : udpProtocol;
    }
    const udpPortNum = udpCfg.port != null ? Number(udpCfg.port) : NaN;
    if (Number.isFinite(udpPortNum) && udpPortNum >= 1 && udpPortNum <= 65535) {
      config.lnsPort = udpPortNum;
      config.simulation.gateway.port = udpPortNum;
    }

    const simState = this.getSimState();
    this.updateSimState({
      config: {
        ...(simState.config || {}),
        signalModel: config.signalModel,
        multiGateway: config.multiGateway,
        lnsHost: config.lnsHost,
        lnsPort: config.lnsPort,
        udpSocketFamily: config.udpSocketFamily,
        simulation: {
          ...((simState.config && simState.config.simulation) || {}),
          gateway: {
            ...(((simState.config && simState.config.simulation) || {}).gateway || {}),
            address: config.simulation?.gateway?.address,
            port: config.simulation?.gateway?.port,
          },
        },
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
      const chirpstackResult = needSync ? await this._chirpstackUpsertNode(req.node, false) : null;
      this._upsertSimulatorNode(req.node, { chirpstackSynced: Boolean(chirpstackResult) });
      this._persistConfigIfNeeded();
      this.writeSimState();
      return {
        ok: true,
        data: { node: req.node, syncStatus: this._syncOk({ chirpstackSynced: Boolean(chirpstackResult) }), chirpstack: chirpstackResult },
        correlationId,
      };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        const req = validateNodeCreate(body);
        const job = this._enqueuePartial(req.node.devEui, 'create_node', e.message, req);
        const syncStatus = this._syncError(ERROR_CODES.PARTIAL_SUCCESS, e.message);
        // Ensure the node exists locally even if ChirpStack provisioning fails.
        this._upsertSimulatorNode({ ...req.node, syncStatus });
        this.writeSimState();
        return {
          ok: false,
          error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
          correlationId,
        };
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
      const chirpstackResult = needSync ? await this._chirpstackUpsertNode(req.node, true) : null;
      this._upsertSimulatorNode(req.node, { chirpstackSynced: Boolean(chirpstackResult) });
      this._persistConfigIfNeeded();
      this.writeSimState();
      return {
        ok: true,
        data: { node: req.node, syncStatus: this._syncOk({ chirpstackSynced: Boolean(chirpstackResult) }), chirpstack: chirpstackResult },
        correlationId,
      };
    } catch (e) {
      if (e.code === ERROR_CODES.CHIRPSTACK_FAILED) {
        const req = validateNodeCreate({ ...body, node: { ...(body?.node || {}), devEui } });
        const job = this._enqueuePartial(req.node.devEui, 'update_node', e.message, req);
        const syncStatus = this._syncError(ERROR_CODES.PARTIAL_SUCCESS, e.message);
        this._upsertSimulatorNode({ ...req.node, syncStatus });
        this.writeSimState();
        return {
          ok: false,
          error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
          correlationId,
        };
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
        const req = validateGatewayCreate(body);
        const job = this._enqueuePartial(req.gateway.gatewayId, 'create_gateway', e.message, req);
        const syncStatus = this._syncError(ERROR_CODES.PARTIAL_SUCCESS, e.message);
        this._upsertSimulatorGateway({ ...req.gateway, syncStatus });
        this.writeSimState();
        return {
          ok: false,
          error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
          correlationId,
        };
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
        const req = validateGatewayCreate({ ...body, gateway: { ...(body?.gateway || {}), gatewayId } });
        const job = this._enqueuePartial(req.gateway.gatewayId, 'update_gateway', e.message, req);
        const syncStatus = this._syncError(ERROR_CODES.PARTIAL_SUCCESS, e.message);
        this._upsertSimulatorGateway({ ...req.gateway, syncStatus });
        this.writeSimState();
        return {
          ok: false,
          error: { code: ERROR_CODES.PARTIAL_SUCCESS, message: e.message, retryable: true, jobId: job.jobId },
          correlationId,
        };
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
