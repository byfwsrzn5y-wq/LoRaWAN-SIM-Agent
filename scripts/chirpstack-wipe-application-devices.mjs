#!/usr/bin/env node
/**
 * 删除指定 ChirpStack Application 下的全部设备（测试服务器专用）。
 *
 * 环境变量：同 chirpstack-inventory.mjs（CHIRPSTACK_API_URL、CHIRPSTACK_API_TOKEN、可选 CHIRPSTACK_AUTH_HEADER）
 *
 * 用法：
 *   node scripts/chirpstack-wipe-application-devices.mjs --application-id <UUID> --confirm DELETE_ALL_DEVICES
 *
 * 若不传 --confirm 或值不对，则仅打印将删除的数量并 exit 1（干跑）。
 */

import process from 'node:process';

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (u.endsWith('/api')) u = u.slice(0, -4);
  return u;
}

async function csFetch(baseUrl, authHeader, token, path, method = 'GET', body = null) {
  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = {
    [authHeader]: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text || res.statusText;
    throw new Error(`${res.status}: ${msg}`);
  }
  return json;
}

function extractDevices(json) {
  if (!json) return [];
  if (Array.isArray(json.result)) return json.result;
  if (Array.isArray(json.devices)) return json.devices;
  return [];
}

async function listAllDevices(baseUrl, authHeader, token, applicationId) {
  const all = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const path = `/api/devices?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}&offset=${offset}`;
    const json = await csFetch(baseUrl, authHeader, token, path);
    const batch = extractDevices(json);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

function parseArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

async function main() {
  const applicationId = parseArg('--application-id');
  const confirm = parseArg('--confirm');
  const baseUrl = normalizeBase(process.env.CHIRPSTACK_API_URL || '');
  const token = process.env.CHIRPSTACK_API_TOKEN || '';
  const authHeader = process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization';

  if (!baseUrl || !token) {
    console.error('需要 CHIRPSTACK_API_URL 与 CHIRPSTACK_API_TOKEN');
    process.exit(1);
  }
  if (!applicationId) {
    console.error('用法: node scripts/chirpstack-wipe-application-devices.mjs --application-id <UUID> --confirm DELETE_ALL_DEVICES');
    process.exit(1);
  }

  const devices = await listAllDevices(baseUrl, authHeader, token, applicationId);
  const euis = devices.map((d) => (d.devEui || d.dev_eui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()).filter((x) => x.length === 16);

  console.log(`Application ${applicationId}: ${euis.length} device(s) to delete.`);

  if (confirm !== 'DELETE_ALL_DEVICES') {
    console.log('干跑未执行删除。若确认清空测试应用，请追加: --confirm DELETE_ALL_DEVICES');
    process.exit(1);
  }

  let ok = 0;
  for (const eui of euis) {
    try {
      await csFetch(baseUrl, authHeader, token, `/api/devices/${eui}`, 'DELETE');
      ok++;
    } catch (err) {
      console.error('删除失败', eui, err.message);
    }
  }
  console.log(`完成: 成功删除 ${ok} / ${euis.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
