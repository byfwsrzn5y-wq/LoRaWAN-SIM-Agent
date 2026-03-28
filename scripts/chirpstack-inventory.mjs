#!/usr/bin/env node
/**
 * 清点 ChirpStack v4（REST API 组件）上现有租户 / 应用 / 设备模板 / 网关 / 各应用下设备数量。
 * 供测试服务器在「沿用现网 vs 清空重建」前做决策；不修改任何数据。
 *
 * 环境变量（与 .env.example、openclaw-lorawan-sim 对齐）：
 *   CHIRPSTACK_API_URL   例 http://127.0.0.1:8090（不要带末尾 /api；若你填了 .../api 会自动去掉）
 *   CHIRPSTACK_API_TOKEN JWT
 *   CHIRPSTACK_AUTH_HEADER  可选，默认 Grpc-Metadata-Authorization（与插件一致）；若无效可试 Authorization
 *
 * 用法：
 *   node scripts/chirpstack-inventory.mjs
 *   node scripts/chirpstack-inventory.mjs --json   # 仅输出 JSON
 */

import process from 'node:process';

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (u.endsWith('/api')) u = u.slice(0, -4);
  return u;
}

function getEnv() {
  const baseUrl = normalizeBase(process.env.CHIRPSTACK_API_URL || '');
  const token = process.env.CHIRPSTACK_API_TOKEN || '';
  const authHeader = process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization';
  return { baseUrl, token, authHeader };
}

async function csFetch(baseUrl, authHeader, token, path, init = {}) {
  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = {
    [authHeader]: `Bearer ${token}`,
    Accept: 'application/json',
    ...init.headers,
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text || res.statusText;
    throw new Error(`${res.status} ${url}: ${msg}`);
  }
  return json;
}

async function listPaged(baseUrl, authHeader, token, pathBuilder, extractItems, pageSize = 100) {
  const all = [];
  let offset = 0;
  for (;;) {
    const path = pathBuilder(offset, pageSize);
    const json = await csFetch(baseUrl, authHeader, token, path);
    const items = extractItems(json);
    if (!items.length) break;
    all.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function extractArray(json, keys = ['result', 'items', 'tenants', 'applications', 'deviceProfiles', 'gateways', 'devices']) {
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(json[k])) return json[k];
  }
  if (Array.isArray(json)) return json;
  return [];
}

async function main() {
  const jsonOnly = process.argv.includes('--json');
  const { baseUrl, token, authHeader } = getEnv();
  if (!baseUrl || !token) {
    console.error(
      '缺少 CHIRPSTACK_API_URL 或 CHIRPSTACK_API_TOKEN。复制 .env.example 为 .env 并填写后：export $(grep -v ^# .env | xargs)'
    );
    process.exit(1);
  }

  const out = {
    apiBase: baseUrl,
    tenants: [],
    applications: [],
    deviceProfiles: [],
    gateways: [],
    devicesByApplication: {},
    errors: [],
  };

  const run = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      out.errors.push({ step: label, message: e.message });
      return null;
    }
  };

  await run('tenants', async () => {
    const tenants = await listPaged(
      baseUrl,
      authHeader,
      token,
      (off, lim) => `/api/tenants?limit=${lim}&offset=${off}`,
      (j) => extractArray(j, ['result', 'tenants'])
    );
    out.tenants = tenants.map((t) => ({
      id: t.id || t.tenantId,
      name: t.name,
    }));
  });

  for (const t of out.tenants) {
    const tid = t.id;
    if (!tid) continue;

    await run(`applications(${tid})`, async () => {
      const apps = await listPaged(
        baseUrl,
        authHeader,
        token,
        (off, lim) => `/api/applications?tenantId=${encodeURIComponent(tid)}&limit=${lim}&offset=${off}`,
        (j) => extractArray(j, ['result', 'applications'])
      );
      for (const a of apps) {
        out.applications.push({
          id: a.id,
          name: a.name,
          tenantId: tid,
          description: a.description,
        });
      }
    });

    await run(`device-profiles(${tid})`, async () => {
      const dps = await listPaged(
        baseUrl,
        authHeader,
        token,
        (off, lim) => `/api/device-profiles?tenantId=${encodeURIComponent(tid)}&limit=${lim}&offset=${off}`,
        (j) => extractArray(j, ['result', 'deviceProfiles'])
      );
      for (const d of dps) {
        out.deviceProfiles.push({
          id: d.id,
          name: d.name,
          tenantId: tid,
          region: d.region || d.region_name,
        });
      }
    });

    await run(`gateways(${tid})`, async () => {
      const gws = await listPaged(
        baseUrl,
        authHeader,
        token,
        (off, lim) => `/api/gateways?tenantId=${encodeURIComponent(tid)}&limit=${lim}&offset=${off}`,
        (j) => extractArray(j, ['result', 'gateways'])
      );
      for (const g of gws) {
        out.gateways.push({
          id: g.id || g.gatewayId,
          name: g.name,
          tenantId: tid,
        });
      }
    });
  }

  for (const app of out.applications) {
    const aid = app.id;
    await run(`devices(${aid})`, async () => {
      const devs = await listPaged(
        baseUrl,
        authHeader,
        token,
        (off, lim) => `/api/devices?applicationId=${encodeURIComponent(aid)}&limit=${lim}&offset=${off}`,
        (j) => extractArray(j, ['result', 'devices'])
      );
      out.devicesByApplication[aid] = {
        applicationName: app.name,
        count: devs.length,
        sampleDevEuis: devs.slice(0, 5).map((d) => d.devEui || d.dev_eui),
      };
    });
  }

  if (jsonOnly) {
    console.log(JSON.stringify(out, null, 2));
    if (out.errors.length) process.exit(2);
    return;
  }

  console.log('ChirpStack 现网清点（只读）');
  console.log('API:', baseUrl);
  console.log('');

  if (out.errors.length) {
    console.log('部分步骤失败（检查 Token、URL 是否含 /api、REST 组件是否启用）：');
    for (const e of out.errors) console.log(' -', e.step, ':', e.message);
    console.log('');
  }

  console.log('租户:', out.tenants.length);
  for (const t of out.tenants) console.log('  -', t.id, t.name || '');
  console.log('');
  console.log('应用:', out.applications.length);
  for (const a of out.applications) {
    const d = out.devicesByApplication[a.id];
    const n = d ? d.count : '?';
    console.log('  -', a.name, '| id=', a.id, '| devices≈', n);
  }
  console.log('');
  console.log('设备模板(Device Profile):', out.deviceProfiles.length);
  for (const p of out.deviceProfiles.slice(0, 20)) {
    console.log('  -', p.name, '| id=', p.id, '| region=', p.region || '');
  }
  if (out.deviceProfiles.length > 20) console.log('  ... 其余省略');
  console.log('');
  console.log('网关:', out.gateways.length);
  for (const g of out.gateways.slice(0, 30)) {
    console.log('  -', g.name, '| id=', g.id);
  }
  if (out.gateways.length > 30) console.log('  ... 其余省略');
  console.log('');
  console.log('决策建议：');
  console.log('  - 若应用下设备数已为 100 且密钥与 configs/config-100nodes-10types.json 一致，可「沿用」仅对齐模拟器 JSON。');
  console.log('  - 测试机可清空时：对目标 application 执行 scripts/chirpstack-wipe-application-devices.mjs，再批量创建设备（OpenClaw 工具或控制台）。');
  console.log('  - 完整流程见 simulator/docs/ChirpStack测试环境_100节点准备流程.md');

  if (out.errors.length) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
