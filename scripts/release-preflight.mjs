#!/usr/bin/env node
/**
 * Release preflight checks (read-only):
 * - control port availability
 * - ChirpStack API reachability
 * - required env completeness
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const repoRoot = process.cwd();

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (let line of text.split('\n')) {
    line = line.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let envFile = path.join(repoRoot, '.env');
  let controlPort = 9999;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-file' && args[i + 1]) envFile = path.resolve(args[++i]);
    else if (args[i] === '--control-port' && args[i + 1]) controlPort = Number(args[++i]) || 9999;
  }
  return { envFile, controlPort };
}

function mask(v) {
  const s = String(v || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

async function checkControlPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function checkChirpstack(baseUrl) {
  if (!baseUrl) return { ok: false, reason: 'missing CHIRPSTACK_API_URL' };
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/api/internal/ping`);
    // some deployments return 404; that still means reachable
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function main() {
  const { envFile, controlPort } = parseArgs();
  loadEnvFromFile(envFile);

  const required = [
    'CHIRPSTACK_API_URL',
    'CHIRPSTACK_API_TOKEN',
    'CHIRPSTACK_APPLICATION_ID',
    'CHIRPSTACK_DEVICE_PROFILE_ID',
    'CHIRPSTACK_TENANT_ID',
    'ENABLE_ORCHESTRATOR_API',
    'ENABLE_CHIRPSTACK_SYNC',
  ];

  const missing = required.filter((k) => !String(process.env[k] || '').trim());
  const portFree = await checkControlPortAvailable(controlPort);
  const cs = await checkChirpstack(process.env.CHIRPSTACK_API_URL);

  console.log('== Release Preflight ==');
  console.log(`env file: ${envFile}`);
  console.log(`control port ${controlPort}: ${portFree ? 'available' : 'in use'}`);
  console.log(`chirpstack reachability: ${cs.ok ? `ok (status=${cs.status})` : `fail (${cs.reason})`}`);
  for (const k of required) {
    const val = process.env[k];
    console.log(`${k}=${k.includes('TOKEN') ? mask(val) : (val || '(empty)')}`);
  }

  if (missing.length || !portFree || !cs.ok) {
    console.error('\nPreflight failed.');
    if (missing.length) console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('\nPreflight passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
