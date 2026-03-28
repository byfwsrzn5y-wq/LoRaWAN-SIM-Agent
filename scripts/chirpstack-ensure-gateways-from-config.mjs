#!/usr/bin/env node
/**
 * 测试前：根据模拟器 JSON 中的 multiGateway.gateways[] 核对 ChirpStack 是否已登记对应 Gateway EUI；
 * 缺失时可选自动创建（需租户 ID）。
 *
 * 环境变量（与 scripts/chirpstack-provision-otaa-from-config.mjs 一致）:
 *   CHIRPSTACK_API_URL
 *   CHIRPSTACK_API_TOKEN
 *   CHIRPSTACK_TENANT_ID   可选；未设则取租户列表第一个
 *   CHIRPSTACK_AUTH_HEADER 可选，默认 Grpc-Metadata-Authorization
 *
 * 用法:
 *   node scripts/chirpstack-ensure-gateways-from-config.mjs simulator/config.json
 *   node scripts/chirpstack-ensure-gateways-from-config.mjs --dry-run simulator/config.json
 *   node scripts/chirpstack-ensure-gateways-from-config.mjs --check-only simulator/config.json   # 仅检查，缺任一网关则 exit 1
 *   node scripts/chirpstack-ensure-gateways-from-config.mjs --env-file /path/.env <config.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
  for (let line of text.split('\n')) {
    line = line.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (u.endsWith('/api')) u = u.slice(0, -4);
  return u;
}

function normEui(hex) {
  return String(hex || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
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
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json, text };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let checkOnly = false;
  let envFile = '';
  const posArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--check-only') checkOnly = true;
    else if (a === '--env-file' && args[i + 1]) envFile = args[++i];
    else if (!a.startsWith('-')) posArgs.push(a);
  }
  if (!envFile) envFile = path.join(repoRoot, '.env');
  return { dryRun, checkOnly, envFile, posArgs };
}

function extractGatewaysFromConfig(raw) {
  const mg = raw.multiGateway;
  if (!mg || !mg.enabled || !Array.isArray(mg.gateways)) {
    return [];
  }
  const out = [];
  for (const g of mg.gateways) {
    const eui = normEui(g.eui);
    if (eui.length !== 16) continue;
    out.push({
      eui,
      name: String(g.name || `gw-${eui.slice(-4)}`).slice(0, 256),
    });
  }
  return out;
}

async function listTenants(baseUrl, authHeader, token) {
  const res = await csFetch(baseUrl, authHeader, token, '/api/tenants?limit=100&offset=0');
  if (!res.ok) throw new Error(`列出租户失败 ${res.status}: ${res.text?.slice(0, 200)}`);
  const arr = res.json?.result ?? res.json?.tenants ?? [];
  return arr.map((t) => ({ id: t.id || t.tenantId, name: t.name })).filter((t) => t.id);
}

async function resolveTenantId(baseUrl, authHeader, token) {
  const fromEnv = String(process.env.CHIRPSTACK_TENANT_ID || '').trim();
  if (fromEnv) return fromEnv;
  const tenants = await listTenants(baseUrl, authHeader, token);
  if (!tenants.length) throw new Error('无可用租户，请在 .env 设置 CHIRPSTACK_TENANT_ID');
  console.error(`[info] 未设置 CHIRPSTACK_TENANT_ID，使用首个租户: ${tenants[0].name} (${tenants[0].id})`);
  return tenants[0].id;
}

async function gatewayGet(baseUrl, authHeader, token, gatewayId) {
  return csFetch(
    baseUrl,
    authHeader,
    token,
    `/api/gateways/${encodeURIComponent(gatewayId)}`
  );
}

async function gatewayCreate(baseUrl, authHeader, token, tenantId, eui, name) {
  // ChirpStack REST（grpc-gateway）与设备 API 一致，常用 snake_case
  const body = {
    gateway: {
      gateway_id: eui,
      name,
      description: 'LoRaWAN-SIM (chirpstack-ensure-gateways-from-config.mjs)',
      tenant_id: tenantId,
      stats_interval: 30,
    },
  };
  let res = await csFetch(baseUrl, authHeader, token, '/api/gateways', 'POST', body);
  if (res.ok) return res;
  // 部分部署使用 camelCase
  const bodyCamel = {
    gateway: {
      gatewayId: eui,
      name,
      description: 'LoRaWAN-SIM',
      tenantId,
      statsInterval: 30,
    },
  };
  return csFetch(baseUrl, authHeader, token, '/api/gateways', 'POST', bodyCamel);
}

async function main() {
  const { dryRun, checkOnly, envFile, posArgs } = parseCliArgs();
  loadEnvFromFile(envFile);

  let configPath = posArgs[0];
  if (!configPath) {
    configPath = path.join(repoRoot, 'simulator', 'config.json');
  }
  if (!path.isAbsolute(configPath)) configPath = path.join(repoRoot, configPath);

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const gateways = extractGatewaysFromConfig(raw);
  if (gateways.length === 0) {
    console.error('配置中无 multiGateway.enabled + gateways[]，跳过网关检查。');
    process.exit(0);
  }

  const baseUrl = normalizeBase(process.env.CHIRPSTACK_API_URL || '');
  const token = process.env.CHIRPSTACK_API_TOKEN || '';
  const authHeader = process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization';

  console.error(`Config: ${configPath}`);
  console.error(`Gateways in config: ${gateways.map((g) => g.eui).join(', ')}`);

  if (!baseUrl || !token) {
    console.error('缺少 CHIRPSTACK_API_URL 或 CHIRPSTACK_API_TOKEN，无法检查/创建网关。');
    process.exit(1);
  }

  if (dryRun) {
    console.error('[dry-run] 将检查上述 EUIs（不会调用创建）。');
    for (const g of gateways) {
      const gr = await gatewayGet(baseUrl, authHeader, token, g.eui);
      console.error(`  ${g.eui} ${gr.ok ? 'exists' : `missing (${gr.status})`}`);
    }
    return;
  }

  let tenantId;
  try {
    tenantId = await resolveTenantId(baseUrl, authHeader, token);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  let missing = 0;
  let created = 0;
  let ok = 0;

  for (const g of gateways) {
    const gr = await gatewayGet(baseUrl, authHeader, token, g.eui);
    if (gr.ok) {
      ok++;
      console.error(`[ok] gateway ${g.eui} (${g.name})`);
      continue;
    }
    missing++;
    if (checkOnly) {
      console.error(`[missing] gateway ${g.eui} (${g.name}) — NS 中未登记`);
      continue;
    }
    const cr = await gatewayCreate(baseUrl, authHeader, token, tenantId, g.eui, g.name);
    if (cr.ok) {
      created++;
      console.error(`[created] gateway ${g.eui} (${g.name})`);
    } else {
      console.error(`[fail] create ${g.eui}: ${cr.status} ${cr.text?.slice(0, 400)}`);
    }
  }

  if (checkOnly && missing > 0) {
    console.error(`检查失败: ${missing} 个网关未在 ChirpStack 中配置。请先运行（去掉 --check-only）或手工添加。`);
    process.exit(1);
  }

  if (!checkOnly && missing > 0 && created + ok < gateways.length) {
    const failed = gateways.length - ok - created;
    if (failed > 0) {
      console.error(`完成: 已存在=${ok} 新建=${created} 仍失败=${failed}`);
      process.exit(2);
    }
  }

  console.error(`完成: 已存在=${ok} 新建=${created}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
