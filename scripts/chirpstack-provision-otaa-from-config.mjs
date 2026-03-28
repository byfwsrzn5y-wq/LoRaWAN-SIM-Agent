#!/usr/bin/env node
/**
 * 将 JSON 中 OTAA 批量规则（与 index.js 一致）注册到 ChirpStack REST API。
 * 需已在 NS 中创建 Application 与 Device Profile（OTAA、区域与模拟器一致）。
 *
 * 环境变量:
 *   CHIRPSTACK_API_URL
 *   CHIRPSTACK_API_TOKEN
 *   CHIRPSTACK_APPLICATION_ID   (UUID)
 *   CHIRPSTACK_DEVICE_PROFILE_ID (UUID)
 *   CHIRPSTACK_AUTH_HEADER       可选，默认 Grpc-Metadata-Authorization
 *
 * 用法:
 *   node scripts/chirpstack-provision-otaa-from-config.mjs [simulator/configs/config-100nodes-10types.json]
 *   node scripts/chirpstack-provision-otaa-from-config.mjs --dry-run [config.json]
 *   node scripts/chirpstack-provision-otaa-from-config.mjs --env-file /path/.env configs/foo.json
 *   node scripts/chirpstack-provision-otaa-from-config.mjs --replace-all configs/foo.json
 *     先删除 CHIRPSTACK_APPLICATION_ID 下全部设备，再按配置重新创建并写入密钥。
 *
 * 若仓库根存在 `.env`，启动时会自动加载（不覆盖已在环境中设置的变量）。可用 `--env-file` 指定路径。
 *
 * 若 JSON 含顶层 devices[]（与 index.js 单设备列表一致），则按每台 name/devEui/appKey 注册，忽略 lorawan.*。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/**
 * 轻量 .env 解析：不依赖 dotenv。仅当 process.env[key] 尚未定义时写入。
 */
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

function parseCliArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let replaceAll = false;
  let envFile = '';
  const posArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--replace-all') replaceAll = true;
    else if (a === '--env-file' && args[i + 1]) envFile = args[++i];
    else if (!a.startsWith('-')) posArgs.push(a);
  }
  if (!envFile) envFile = path.join(repoRoot, '.env');
  return { dryRun, replaceAll, envFile, posArgs };
}

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/$/, '');
  if (u.endsWith('/api')) u = u.slice(0, -4);
  return u;
}

function genSequentialDevEuiBuf(startHex, index) {
  const clean = String(startHex || '').replace(/[^a-fA-F0-9]/g, '');
  const v = (BigInt('0x' + clean) + BigInt(index)) & BigInt('0xffffffffffffffff');
  const b = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    b[7 - i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  return b;
}

async function csFetch(baseUrl, authHeader, token, path, method = 'GET', body = null) {
  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
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

function normDevEui(hex) {
  return String(hex || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toLowerCase();
}

/**
 * 分页列出某应用下全部 DevEUI（REST: GET /api/devices?applicationId=…）。
 */
async function listAllDevEuisInApplication(baseUrl, authHeader, token, applicationId) {
  const pageSize = 500;
  let offset = 0;
  const seen = new Set();
  const euids = [];
  for (;;) {
    const q = new URLSearchParams({
      applicationId,
      limit: String(pageSize),
      offset: String(offset),
    });
    const res = await csFetch(baseUrl, authHeader, token, `/api/devices?${q.toString()}`);
    if (!res.ok) {
      throw new Error(`列出设备失败 ${res.status}: ${res.text?.slice(0, 300)}`);
    }
    const data = res.json;
    const batch = data?.result ?? data?.devices ?? [];
    const total = Number(data?.totalCount ?? data?.total_count ?? 0) || 0;
    for (const d of batch) {
      const e = normDevEui(d.devEui ?? d.dev_eui);
      if (e.length === 16 && !seen.has(e)) {
        seen.add(e);
        euids.push(e);
      }
    }
    offset += batch.length;
    if (batch.length === 0) break;
    if (total > 0 && offset >= total) break;
    if (batch.length < pageSize) break;
  }
  return euids;
}

async function deleteAllDevicesInApplication(baseUrl, authHeader, token, applicationId) {
  const euids = await listAllDevEuisInApplication(baseUrl, authHeader, token, applicationId);
  let deleted = 0;
  let errors = 0;
  for (const devEui of euids) {
    const dr = await csFetch(baseUrl, authHeader, token, `/api/devices/${devEui}`, 'DELETE');
    if (dr.ok) deleted++;
    else {
      console.error('Delete failed', devEui, dr.status, dr.text?.slice(0, 200));
      errors++;
    }
  }
  return { deleted, errors, listed: euids.length };
}

function buildRowsFromDevicesArray(devices) {
  const rows = [];
  for (const d of devices) {
    if (d == null || typeof d !== 'object') continue;
    if (d.enabled === false) continue;
    // Support both flat schema (devEui/appKey/mode) and simulator v2 schema (lorawan.*).
    const mode = String(d.mode || d.activation || d.lorawan?.activation || 'otaa').toUpperCase();
    if (mode !== 'OTAA') continue;
    const devEuiRaw = d.devEui || d.lorawan?.devEui;
    const devEui = normDevEui(devEuiRaw);
    if (devEui.length !== 16) {
      console.error(`跳过无效 devEui (${d.name || '?'}): ${devEuiRaw}`);
      continue;
    }
    const appKeyRaw = d.appKey || d.lorawan?.appKey;
    const appKey = String(appKeyRaw || '').replace(/[^a-fA-F0-9]/g, '');
    if (appKey.length !== 32) {
      console.error(`跳过无效 appKey (${d.name || devEui})`);
      continue;
    }
    const name = String(d.name || `device-${devEui}`).slice(0, 256);
    rows.push({ devEui, name, appKey });
  }
  return rows;
}

async function main() {
  const { dryRun, replaceAll, envFile, posArgs } = parseCliArgs();
  const loaded = loadEnvFromFile(envFile);
  if (loaded) {
    console.error(`Loaded env: ${envFile}`);
  }

  let configPath = posArgs[0];
  if (!configPath) {
    configPath = path.join(repoRoot, 'simulator', 'configs', 'config-100nodes-10types.json');
  }
  if (!path.isAbsolute(configPath)) configPath = path.join(repoRoot, configPath);

  const baseUrl = normalizeBase(process.env.CHIRPSTACK_API_URL || '');
  const token = process.env.CHIRPSTACK_API_TOKEN || '';
  const authHeader = process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization';
  const applicationId = process.env.CHIRPSTACK_APPLICATION_ID || '';
  const deviceProfileId = process.env.CHIRPSTACK_DEVICE_PROFILE_ID || '';

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  /** @type {{ devEui: string, name: string, appKey?: string }[]} */
  let rows = [];
  /** @type {string | null} */
  let singleAppKey = null;

  if (Array.isArray(raw.devices) && raw.devices.length > 0) {
    rows = buildRowsFromDevicesArray(raw.devices);
    if (rows.length === 0) {
      console.error('devices[] 中无有效 OTAA 设备（检查 devEui/appKey/mode/enabled）');
      process.exit(1);
    }
  } else {
    const lw = raw.lorawan || {};
    if (String(lw.activation || '').toUpperCase() !== 'OTAA') {
      console.error('仅支持 OTAA：提供 lorawan.activation=OTAA 或顶层 devices[]');
      process.exit(1);
    }
    const deviceCount = Number(lw.deviceCount || 0);
    const appKey = String(lw.appKey || '').replace(/[^a-fA-F0-9]/g, '');
    const devEuiStart = (lw.devEuiStart || lw.devEui || '0102030405060701').toString().trim();

    if (!deviceCount || appKey.length !== 32) {
      console.error('无效 deviceCount 或 appKey');
      process.exit(1);
    }
    singleAppKey = appKey;
    for (let i = 0; i < deviceCount; i++) {
      const devEui = genSequentialDevEuiBuf(devEuiStart, i).toString('hex').toLowerCase();
      const name = `sim-node-${String(i + 1).padStart(3, '0')}`;
      rows.push({ devEui, name });
    }
  }

  if (!dryRun && (!baseUrl || !token || !applicationId || !deviceProfileId)) {
    console.error(
      '缺少环境变量：CHIRPSTACK_API_URL、CHIRPSTACK_API_TOKEN、CHIRPSTACK_APPLICATION_ID、CHIRPSTACK_DEVICE_PROFILE_ID'
    );
    process.exit(1);
  }

  console.log(`Config: ${configPath}`);
  console.log(`Devices: ${rows.length} (dry-run=${dryRun}, replace-all=${replaceAll})`);

  if (dryRun) {
    if (replaceAll && baseUrl && token && applicationId) {
      try {
        const euids = await listAllDevEuisInApplication(baseUrl, authHeader, token, applicationId);
        console.log(`[dry-run] 应用内现有设备: ${euids.length} 台（将先全部删除再添加 ${rows.length} 台）`);
      } catch (e) {
        console.error('[dry-run] 无法列出应用设备（检查 URL/Token/ApplicationId）:', e.message);
      }
    } else if (replaceAll) {
      console.log('[dry-run] --replace-all 需要 CHIRPSTACK_API_URL / TOKEN / APPLICATION_ID 才能预览应用内数量');
    }
    console.log('Sample:', rows[0], rows[rows.length - 1]);
    return;
  }

  if (replaceAll) {
    console.error(`正在删除应用 ${applicationId} 下的全部设备…`);
    try {
      const { deleted, errors, listed } = await deleteAllDevicesInApplication(
        baseUrl,
        authHeader,
        token,
        applicationId
      );
      console.error(`Wipe done: listed=${listed} deleted=${deleted} delete_errors=${errors}`);
      if (errors > 0) {
        console.error('存在删除失败项，停止后续创建。请检查权限或重试。');
        process.exit(2);
      }
    } catch (e) {
      console.error('清空应用设备失败:', e.message);
      process.exit(2);
    }
  }

  let created = 0;
  let skipped = 0;
  let keysOk = 0;
  let errors = 0;

  for (const row of rows) {
    const { devEui, name } = row;
    const appKey = row.appKey || singleAppKey;
    if (!appKey || appKey.length !== 32) {
      console.error('缺少 appKey', devEui);
      errors++;
      continue;
    }

    const getRes = await csFetch(baseUrl, authHeader, token, `/api/devices/${devEui}`);
    if (getRes.ok && getRes.json) {
      skipped++;
    } else {
      const body = {
        device: {
          dev_eui: devEui,
          name,
          application_id: applicationId,
          device_profile_id: deviceProfileId,
        },
      };
      const cr = await csFetch(baseUrl, authHeader, token, '/api/devices', 'POST', body);
      if (!cr.ok) {
        console.error('Create failed', devEui, cr.status, cr.text?.slice(0, 200));
        errors++;
        continue;
      }
      created++;
    }

    const keyBody = {
      device_keys: {
        dev_eui: devEui,
        nwk_key: appKey,
        app_key: appKey,
      },
    };
    let kr = await csFetch(baseUrl, authHeader, token, `/api/devices/${devEui}/keys`, 'POST', keyBody);
    if (
      !kr.ok &&
      /duplicate|unique constraint/i.test(String(kr.text || '') + String(kr.json?.message || ''))
    ) {
      kr = await csFetch(baseUrl, authHeader, token, `/api/devices/${devEui}/keys`, 'PUT', keyBody);
    }
    if (kr.ok) {
      keysOk++;
    } else {
      console.error('Keys failed', devEui, kr.status, kr.text?.slice(0, 200));
      errors++;
    }
  }

  console.log(`Done: created=${created} skipped=${skipped} keys_ok=${keysOk} errors=${errors}`);
  process.exit(errors > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
