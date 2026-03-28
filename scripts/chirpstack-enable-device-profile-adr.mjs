#!/usr/bin/env node
/**
 * 为 ChirpStack v4（chirpstack-rest-api）中的 Device Profile 开启 ADR：
 * 将 deviceProfile.adrAlgorithmId 设为内置默认（可通过 --algorithm 覆盖）。
 *
 * 说明：
 * - NS 区域文件里 adr_disabled=false 表示「未禁用 ADR」；若 Device Profile 未选 ADR 算法，仍不会下发 LinkADRReq。
 * - REST 请求体使用 OpenAPI 的 camelCase（deviceProfile、adrAlgorithmId），与 scripts/chirpstack-provision-otaa-from-config.mjs 里 devices 的 snake_case 不同。
 *
 * 环境变量（与仓库 .env.example 一致）：
 *   CHIRPSTACK_API_URL、CHIRPSTACK_API_TOKEN
 *   CHIRPSTACK_DEVICE_PROFILE_ID  可选；未设时须传 --profile-id
 *   CHIRPSTACK_AUTH_HEADER        可选，默认 Grpc-Metadata-Authorization
 *
 * 用法：
 *   node scripts/chirpstack-enable-device-profile-adr.mjs --dry-run
 *   node scripts/chirpstack-enable-device-profile-adr.mjs
 *   node scripts/chirpstack-enable-device-profile-adr.mjs --algorithm default
 *   node scripts/chirpstack-enable-device-profile-adr.mjs --list-algorithms
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

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let listAlgorithms = false;
  let profileId = '';
  let algorithm = 'default';
  let envFile = path.join(repoRoot, '.env');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--list-algorithms') listAlgorithms = true;
    else if (a === '--profile-id' && args[i + 1]) profileId = args[++i];
    else if (a === '--algorithm' && args[i + 1]) algorithm = args[++i];
    else if (a === '--env-file' && args[i + 1]) envFile = args[++i];
  }
  return { dryRun, listAlgorithms, profileId, algorithm, envFile };
}

function pickProfile(json) {
  return json?.deviceProfile ?? json?.device_profile ?? null;
}

async function main() {
  const { dryRun, listAlgorithms, profileId: argPid, algorithm, envFile } = parseArgs();
  loadEnvFromFile(envFile);

  const baseUrl = normalizeBase(process.env.CHIRPSTACK_API_URL || '');
  const token = process.env.CHIRPSTACK_API_TOKEN || '';
  const authHeader = process.env.CHIRPSTACK_AUTH_HEADER || 'Grpc-Metadata-Authorization';
  const profileId =
    argPid || String(process.env.CHIRPSTACK_DEVICE_PROFILE_ID || '').trim();

  if (!baseUrl || !token) {
    console.error('缺少 CHIRPSTACK_API_URL 或 CHIRPSTACK_API_TOKEN');
    process.exit(1);
  }

  if (listAlgorithms) {
    const r = await csFetch(baseUrl, authHeader, token, '/api/device-profiles/adr-algorithms');
    if (!r.ok) {
      console.error(`${r.status}:`, (r.text || '').slice(0, 400));
      process.exit(2);
    }
    const items = r.json?.result ?? r.json?.results ?? [];
    console.log(JSON.stringify(items, null, 2));
    process.exit(0);
  }

  if (!profileId) {
    console.error('缺少 Device Profile UUID：设置 CHIRPSTACK_DEVICE_PROFILE_ID 或使用 --profile-id');
    process.exit(1);
  }

  const getPath = `/api/device-profiles/${encodeURIComponent(profileId)}`;
  const gr = await csFetch(baseUrl, authHeader, token, getPath);
  if (!gr.ok) {
    console.error(`GET ${getPath} -> ${gr.status}:`, (gr.text || '').slice(0, 500));
    process.exit(2);
  }

  const dp = pickProfile(gr.json);
  if (!dp || typeof dp !== 'object') {
    console.error('无法解析 deviceProfile:', JSON.stringify(gr.json, null, 2).slice(0, 800));
    process.exit(2);
  }

  const current =
    dp.adrAlgorithmId ?? dp.adr_algorithm_id ?? '(empty)';
  console.log('Device profile:', dp.name || profileId);
  console.log('Current adrAlgorithmId:', current);
  console.log('Target adrAlgorithmId:', algorithm);

  if (dryRun) {
    console.log('[dry-run] 未发送 PUT');
    process.exit(0);
  }

  if (current === algorithm) {
    console.log('已是目标值，跳过 PUT');
    process.exit(0);
  }

  const next = { ...dp, adrAlgorithmId: algorithm };
  delete next.createdAt;
  delete next.updatedAt;
  delete next.created_at;
  delete next.updated_at;

  const putPath = `/api/device-profiles/${encodeURIComponent(profileId)}`;
  const pr = await csFetch(baseUrl, authHeader, token, putPath, 'PUT', { deviceProfile: next });
  if (!pr.ok) {
    console.error(`PUT ${putPath} -> ${pr.status}:`, (pr.text || '').slice(0, 600));
    process.exit(2);
  }

  console.log('已更新：adrAlgorithmId =', algorithm);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
