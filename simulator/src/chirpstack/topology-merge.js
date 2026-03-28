/**
 * Build display nodes/gateways for GET /sim-state (simulator + ChirpStack inventory + live rx).
 */

function ensureTopologyOverlay(simState) {
  if (!simState.topologyOverlay || typeof simState.topologyOverlay !== 'object') {
    simState.topologyOverlay = { nodes: {}, gateways: {} };
  }
  if (!simState.topologyOverlay.nodes || typeof simState.topologyOverlay.nodes !== 'object') {
    simState.topologyOverlay.nodes = {};
  }
  if (!simState.topologyOverlay.gateways || typeof simState.topologyOverlay.gateways !== 'object') {
    simState.topologyOverlay.gateways = {};
  }
}

function ensureChirpstackLiveRx(simState) {
  if (!simState.chirpstackLiveRx || typeof simState.chirpstackLiveRx !== 'object') {
    simState.chirpstackLiveRx = { byDevEui: {} };
  }
  if (!simState.chirpstackLiveRx.byDevEui || typeof simState.chirpstackLiveRx.byDevEui !== 'object') {
    simState.chirpstackLiveRx.byDevEui = {};
  }
}

function defaultSpiralPosition(index, kind) {
  const angle = index * 0.85;
  const r = 40 + index * 18;
  const x = 200 + Math.cos(angle) * r;
  const y = 180 + Math.sin(angle) * r;
  const z = kind === 'gateway' ? 30 : 2;
  return { x, y, z };
}

function geoToCanvas(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const scale = 5000;
  const x = 400 + lon * scale;
  const y = 200 - lat * scale;
  return { x, y, z: 30 };
}

/**
 * Fresh gatewayReceptions from live MQTT store (respect staleness).
 */
function liveReceptionsForDevEui(simState, devEuiLower, rxStalenessSec) {
  ensureChirpstackLiveRx(simState);
  const entry = simState.chirpstackLiveRx.byDevEui[devEuiLower];
  if (!entry || !Array.isArray(entry.receptions) || entry.receptions.length === 0) return undefined;
  const staleMs = Math.max(10, Number(rxStalenessSec) || 120) * 1000;
  const ts = Number(entry.ts) || 0;
  if (Date.now() - ts > staleMs) return undefined;
  return entry.receptions;
}

/**
 * @returns {{ nodes: object[], gateways: object[] }}
 */
function buildMergedTopology(simState, options = {}) {
  const rxStalenessSec = options.rxStalenessSec ?? 120;
  ensureTopologyOverlay(simState);
  const overlay = simState.topologyOverlay;
  const inv = simState.chirpstackInventory || { nodes: [], gateways: [] };
  const invNodes = Array.isArray(inv.nodes) ? inv.nodes : [];
  const invGws = Array.isArray(inv.gateways) ? inv.gateways : [];

  const simNodeEuils = new Set(
    (simState.nodes || []).map((n) => String(n.eui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()).filter(Boolean),
  );
  const simGwEuils = new Set(
    (simState.gateways || []).map((g) => String(g.eui || g.id || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()).filter(Boolean),
  );

  const nodesOut = (simState.nodes || []).map((n) => {
    const eui = String(n.eui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    const base = { ...n, source: n.source || 'simulator' };
    const live = eui ? liveReceptionsForDevEui(simState, eui, rxStalenessSec) : undefined;
    if (live && live.length && base.source === 'chirpstack') {
      return { ...base, gatewayReceptions: live };
    }
    return base;
  });

  let csNodeIdx = 0;
  for (const row of invNodes) {
    const eui = String(row.devEui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    if (!eui || simNodeEuils.has(eui)) continue;
    simNodeEuils.add(eui);
    const pos =
      overlay.nodes[eui] ||
      defaultSpiralPosition(nodesOut.length + csNodeIdx, 'node');
    csNodeIdx += 1;
    const live = liveReceptionsForDevEui(simState, eui, rxStalenessSec);
    nodesOut.push({
      eui: eui.toUpperCase(),
      name: row.name || eui.slice(-8),
      source: 'chirpstack',
      position: pos,
      joined: Boolean(row.lastSeenAt),
      lastSeen: row.lastSeenAt || null,
      ...(live && live.length ? { gatewayReceptions: live } : {}),
    });
  }

  const liveEuils = Object.keys((simState.chirpstackLiveRx && simState.chirpstackLiveRx.byDevEui) || {});
  for (const eui of liveEuils) {
    if (simNodeEuils.has(eui)) continue;
    const live = liveReceptionsForDevEui(simState, eui, rxStalenessSec);
    if (!live || !live.length) continue;
    simNodeEuils.add(eui);
    const pos = overlay.nodes[eui] || defaultSpiralPosition(nodesOut.length, 'node');
    nodesOut.push({
      eui: eui.toUpperCase(),
      name: eui.slice(-8),
      source: 'chirpstack',
      position: pos,
      joined: true,
      lastSeen: null,
      gatewayReceptions: live,
      liveOnly: true,
    });
  }

  const gatewaysOut = (simState.gateways || []).map((g) => {
    const eui = String(g.eui || g.id || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    const base = { ...g, eui: (g.eui || g.id || '').toString().replace(/[^a-fA-F0-9]/g, '').toUpperCase(), source: g.source || 'simulator' };
    if (eui && overlay.gateways[eui]) {
      return { ...base, position: overlay.gateways[eui] };
    }
    return base;
  });

  let csGwIdx = 0;
  for (const row of invGws) {
    const gid = String(row.gatewayId || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    if (!gid || simGwEuils.has(gid)) continue;
    simGwEuils.add(gid);
    let pos = overlay.gateways[gid];
    if (!pos && row.latitude != null && row.longitude != null) {
      const g = geoToCanvas(row.latitude, row.longitude);
      if (g) pos = g;
    }
    if (!pos) pos = defaultSpiralPosition(gatewaysOut.length + csGwIdx, 'gateway');
    csGwIdx += 1;
    gatewaysOut.push({
      eui: gid.toUpperCase(),
      id: gid.toUpperCase(),
      name: row.name || gid.slice(-8),
      source: 'chirpstack',
      position: pos,
    });
  }

  return { nodes: nodesOut, gateways: gatewaysOut };
}

module.exports = {
  ensureTopologyOverlay,
  ensureChirpstackLiveRx,
  buildMergedTopology,
  defaultSpiralPosition,
  geoToCanvas,
};
