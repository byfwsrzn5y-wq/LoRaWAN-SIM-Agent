#!/usr/bin/env node
/**
 * Generate an explicit simulator config (config.devices[]) from the 100-device OTAA pool CSV.
 *
 * Option "1" (explicit devices) supports per-node anomaly injection + position variation.
 * This script keeps your existing base simulator config, but replaces:
 * - lorawan.csvImportPath -> removed
 * - devices[] -> generated (100 entries), with enabled=false for i >= activeCount
 *
 * Usage:
 *   node scripts/generate-simulator-config-explicit-devices.mjs --active-count 5
 *   node scripts/generate-simulator-config-explicit-devices.mjs --active-count 20 --out simulator/configs/config-explicit-active-20.json
 */

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(process.cwd());

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    activeCount: null,
    baseConfigPath: 'simulator/config.json',
    poolCsvPath: 'simulator/configs/otaa-100-devices.csv',
    outPath: null,
    seed: 0,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--active-count' || a === '--device-count') {
      const v = args[++i];
      out.activeCount = v == null ? null : Number(v);
    } else if (a === '--base' || a === '--base-config') {
      out.baseConfigPath = args[++i] || out.baseConfigPath;
    } else if (a === '--pool' || a === '--pool-csv') {
      out.poolCsvPath = args[++i] || out.poolCsvPath;
    } else if (a === '--out') {
      out.outPath = args[++i] || out.outPath;
    } else if (a === '--seed') {
      out.seed = Number(args[++i] || 0);
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    }
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseCsv100Devices(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Pool CSV looks empty');
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = ['Name', 'Profile', 'AppEUI', 'DevEUI', 'AppKey'];
  for (const k of required) {
    if (idx[k] == null) throw new Error(`Pool CSV missing column: ${k}`);
  }
  const devices = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const name = parts[idx.Name]?.trim();
    const profile = parts[idx.Profile]?.trim();
    const appEui = parts[idx.AppEUI]?.trim();
    const devEui = parts[idx.DevEUI]?.trim();
    const appKey = parts[idx.AppKey]?.trim();
    if (!name || !appEui || !devEui || !appKey) continue;
    devices.push({ name, profile, appEui, devEui, appKey });
  }
  if (devices.length < 1) throw new Error('No devices parsed from pool CSV');
  return devices;
}

function getAnomalyForIndex(i) {
  // Deterministic "different per node" mapping.
  // anomaly_module.js expects:
  // - anomaly.enabled boolean
  // - anomaly.scenario one of ANOMALY_SCENARIOS keys
  // - anomaly.trigger one of shouldTriggerAnomaly switch cases
  // - anomaly.params optional
  const mod = i % 10;
  switch (mod) {
    case 0:
      return { enabled: true, scenario: 'mic-corrupt', trigger: 'random-30-percent', params: { flipBits: 2 } };
    case 1:
      return { enabled: true, scenario: 'random-drop', trigger: 'random-30-percent', params: { dropRate: 0.25 } };
    case 2:
      return { enabled: true, scenario: 'fcnt-duplicate', trigger: 'every-3rd-uplink', params: {} };
    case 3:
      return { enabled: true, scenario: 'fcnt-jump', trigger: 'every-5th-uplink', params: { jump: 1000 } };
    case 4:
      return { enabled: true, scenario: 'signal-weak', trigger: 'always', params: { rssi: -145, snr: -25 } };
    case 5:
      return { enabled: true, scenario: 'signal-spike', trigger: 'random-10-percent', params: {} };
    case 6:
      return { enabled: true, scenario: 'payload-corrupt', trigger: 'random-30-percent', params: {} };
    case 7:
      return { enabled: true, scenario: 'confirmed-noack', trigger: 'random-30-percent', params: {} };
    case 8:
      return { enabled: true, scenario: 'devnonce-repeat', trigger: 'always', params: {} };
    case 9:
    default:
      return null;
  }
}

function getPositionForIndex(i) {
  // Simple grid; simulator uses it for RF calculations + visualizer.
  return {
    x: 100 + (i % 10) * 120,
    y: 100 + Math.floor(i / 10) * 120,
    z: 2,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node scripts/generate-simulator-config-explicit-devices.mjs --active-count <N> [--out <path>]
Defaults:
  base: simulator/config.json
  pool: simulator/configs/otaa-100-devices.csv
`);
    process.exit(0);
  }

  if (!args.activeCount || !Number.isFinite(args.activeCount) || args.activeCount < 1) {
    throw new Error('--active-count must be a positive number (e.g. 5, 20, 50, 100)');
  }

  const basePath = path.isAbsolute(args.baseConfigPath) ? args.baseConfigPath : path.join(repoRoot, args.baseConfigPath);
  const poolPath = path.isAbsolute(args.poolCsvPath) ? args.poolCsvPath : path.join(repoRoot, args.poolCsvPath);
  const outPath =
    args.outPath && String(args.outPath).trim()
      ? (path.isAbsolute(args.outPath) ? args.outPath : path.join(repoRoot, args.outPath))
      : path.join(repoRoot, 'simulator/configs', `config-explicit-active-${args.activeCount}.json`);

  const base = readJson(basePath);
  const pool = parseCsv100Devices(poolPath);

  const devices = [];
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    const enabled = i < args.activeCount;
    const anomaly = enabled ? getAnomalyForIndex(i) : null;
    const nodeState = { ...getPositionForIndex(i) };

    const d = {
      name: p.name,
      enabled,
      lorawan: {
        activation: 'OTAA',
        devEui: p.devEui,
        appEui: p.appEui,
        // appKey/nwkKey are taken from config.lorawan.appKey in index.js
      },
      nodeState,
    };
    if (anomaly) d.anomaly = anomaly;
    devices.push(d);
  }

  const next = { ...base };
  // ensure the simulator actually uses config.devices branch
  next.lorawan = { ...(next.lorawan || {}) };
  delete next.lorawan.csvImportPath;
  next.lorawan.deviceCount = args.activeCount;
  next.devices = devices;

  writeJson(outPath, next);
  console.log(`[ok] Wrote: ${outPath}`);
  console.log(`    activeCount=${args.activeCount} pool=${pool.length}`);
}

main().catch((e) => {
  console.error(e?.message || String(e));
  process.exit(1);
});

