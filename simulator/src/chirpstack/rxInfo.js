/**
 * Map ChirpStack application-integration JSON uplink rxInfo to UI gatewayReceptions.
 * @see https://www.chirpstack.io/docs/chirpstack/integrations/events/
 */

function normalizeGatewayId(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
  if (s.length !== 16) return '';
  return s;
}

/**
 * @param {unknown} rxInfo - event.rxInfo array from ChirpStack JSON integration
 * @returns {Array<{ gatewayEui: string, rssi?: number, snr?: number }>}
 */
function mapRxInfoToGatewayReceptions(rxInfo) {
  if (!Array.isArray(rxInfo)) return [];
  const out = [];
  for (const rx of rxInfo) {
    if (!rx || typeof rx !== 'object') continue;
    const gatewayEui = normalizeGatewayId(rx.gatewayId ?? rx.gatewayID ?? rx.gateway_id);
    if (!gatewayEui) continue;
    const rssi = rx.rssi != null ? Number(rx.rssi) : undefined;
    const snr =
      rx.loRaSNR != null
        ? Number(rx.loRaSNR)
        : rx.loraSnr != null
          ? Number(rx.loraSnr)
          : rx.snr != null
            ? Number(rx.snr)
            : undefined;
    out.push({
      gatewayEui: gatewayEui.toUpperCase(),
      ...(Number.isFinite(rssi) ? { rssi } : {}),
      ...(Number.isFinite(snr) ? { snr } : {}),
    });
  }
  return out;
}

module.exports = { mapRxInfoToGatewayReceptions, normalizeGatewayId };
