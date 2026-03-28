/**
 * ChirpStack v4 REST: paginated device and gateway listing for topology import.
 */

function normalizeApiBase(url) {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return raw.endsWith('/api') ? raw.slice(0, -4) : raw;
}

async function csFetch(baseUrl, authHeader, token, apiPath, method = 'GET', body = null) {
  const root = normalizeApiBase(baseUrl);
  const url = `${root}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
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

function extractList(json) {
  if (!json || typeof json !== 'object') return { items: [], totalCount: 0 };
  if (Array.isArray(json.result)) return { items: json.result, totalCount: Number(json.totalCount) || json.result.length };
  if (Array.isArray(json.devices)) return { items: json.devices, totalCount: json.devices.length };
  if (Array.isArray(json.gateways)) return { items: json.gateways, totalCount: json.gateways.length };
  return { items: [], totalCount: 0 };
}

function normalizeDevEui(d) {
  const raw = d.devEui ?? d.dev_eui ?? (d.device && (d.device.devEui ?? d.device.dev_eui));
  const s = String(raw || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
  return s.length === 16 ? s : '';
}

function normalizeGwId(g) {
  const raw = g.id ?? g.gatewayId ?? g.gateway_id ?? (g.gateway && (g.gateway.id ?? g.gateway.gatewayId));
  const s = String(raw || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
  return s.length === 16 ? s : '';
}

/**
 * @param {object} d - raw device list item from ChirpStack
 */
function mapDeviceRow(d) {
  const devEui = normalizeDevEui(d);
  if (!devEui) return null;
  const name = String(d.name ?? d.device?.name ?? '').trim() || devEui.slice(-8);
  const lastSeen =
    d.lastSeenAt ?? d.last_seen_at ?? d.device?.lastSeenAt ?? d.device?.last_seen_at ?? null;
  return { devEui, name, lastSeenAt: lastSeen ? String(lastSeen) : null };
}

/**
 * @param {object} g - raw gateway list item
 */
function mapGatewayRow(g) {
  const gatewayId = normalizeGwId(g);
  if (!gatewayId) return null;
  const name = String(g.name ?? g.gateway?.name ?? '').trim() || gatewayId.slice(-8);
  const loc = g.location ?? g.gateway?.location;
  let latitude;
  let longitude;
  if (loc && typeof loc === 'object') {
    latitude = loc.latitude != null ? Number(loc.latitude) : undefined;
    longitude = loc.longitude != null ? Number(loc.longitude) : undefined;
  }
  return {
    gatewayId,
    name,
    ...(Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : {}),
  };
}

/**
 * @param {string} baseUrl
 * @param {string} authHeader
 * @param {string} token
 * @param {string} applicationId - UUID
 */
async function fetchAllApplicationDevices(baseUrl, authHeader, token, applicationId) {
  const appId = String(applicationId || '').trim();
  if (!appId) return { ok: true, devices: [], status: 200 };
  const limit = 100;
  let offset = 0;
  const devices = [];
  let guard = 0;
  while (guard++ < 500) {
    const path = `/api/applications/${encodeURIComponent(appId)}/devices?limit=${limit}&offset=${offset}`;
    const res = await csFetch(baseUrl, authHeader, token, path, 'GET');
    if (!res.ok) {
      return { ok: false, devices, status: res.status, message: res.text?.slice(0, 200) || `HTTP ${res.status}` };
    }
    const { items, totalCount } = extractList(res.json);
    for (const row of items) {
      const m = mapDeviceRow(row);
      if (m) devices.push(m);
    }
    offset += items.length;
    if (items.length < limit || (totalCount > 0 && offset >= totalCount)) break;
    if (items.length === 0) break;
  }
  return { ok: true, devices, status: 200 };
}

/**
 * @param {string} tenantId - UUID
 */
async function fetchAllTenantGateways(baseUrl, authHeader, token, tenantId) {
  const tid = String(tenantId || '').trim();
  if (!tid) return { ok: true, gateways: [], status: 200 };
  const limit = 100;
  let offset = 0;
  const gateways = [];
  let guard = 0;
  while (guard++ < 500) {
    let path = `/api/gateways?limit=${limit}&offset=${offset}&tenantId=${encodeURIComponent(tid)}`;
    let res = await csFetch(baseUrl, authHeader, token, path, 'GET');
    if (!res.ok && res.status === 400 && offset === 0 && gateways.length === 0) {
      path = `/api/gateways?limit=${limit}&offset=${offset}&tenant_id=${encodeURIComponent(tid)}`;
      res = await csFetch(baseUrl, authHeader, token, path, 'GET');
    }
    if (!res.ok) {
      return { ok: false, gateways, status: res.status, message: res.text?.slice(0, 200) || `HTTP ${res.status}` };
    }
    const { items, totalCount } = extractList(res.json);
    for (const row of items) {
      const m = mapGatewayRow(row);
      if (m) gateways.push(m);
    }
    offset += items.length;
    if (items.length < limit || (totalCount > 0 && offset >= totalCount)) break;
    if (items.length === 0) break;
  }
  return { ok: true, gateways, status: 200 };
}

module.exports = {
  csFetch,
  normalizeApiBase,
  fetchAllApplicationDevices,
  fetchAllTenantGateways,
  mapDeviceRow,
  mapGatewayRow,
};
