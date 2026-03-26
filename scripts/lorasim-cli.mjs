#!/usr/bin/env node
/**
 * Unified short CLI for LoRaSIM + ChirpStack helper scripts.
 *
 * Usage:
 *   node scripts/lorasim-cli.mjs <subcommand> [options]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const nodeBin = process.execPath;

const HELP = `LoRaSIM unified short CLI

Usage:
  node scripts/lorasim-cli.mjs <subcommand> [options]

Subcommands:
  help
      Show this help.

  run -c <config> [-- ...simulatorArgs]
      Run simulator/index.js with short config path.
      Example:
        node scripts/lorasim-cli.mjs run -c simulator/configs/example-extends-chirpstack.json -- --lns-host 127.0.0.1

  validate -c <config> [-p <profile>] [--cwd <dir>]
      Validate config via scripts/lorasim-config-validate.mjs.
      Profile default: v20-udp

  cs-gw-check -c <config> [--env-file <path>] [--dry-run]
      Check (and optionally dry-run) gateway existence from config.
      Internally adds --check-only.

  cs-gw-apply -c <config> [--env-file <path>] [--dry-run]
      Create missing gateways from config.

  cs-dev-dry -c <config> [--env-file <path>]
      Dry-run OTAA device provisioning from config.

  cs-dev-apply -c <config> [--env-file <path>] [--replace-all]
      Apply OTAA device provisioning from config.

Short flags:
  -c, --config      Config path (relative to repo root or absolute)
  -p, --profile     Validate profile (v20-udp | multigw | mqtt | openclaw)

Notes:
  - Unknown trailing args are passed through to underlying script.
  - Exit code is propagated from child command.
`;

function toAbsoluteMaybe(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

function parseCommon(argv) {
  let configPath = '';
  let profile = '';
  let envFile = '';
  let cwd = '';
  const passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '-c' || a === '--config') && argv[i + 1]) configPath = argv[++i];
    else if ((a === '-p' || a === '--profile') && argv[i + 1]) profile = argv[++i];
    else if (a === '--env-file' && argv[i + 1]) envFile = argv[++i];
    else if (a === '--cwd' && argv[i + 1]) cwd = argv[++i];
    else passthrough.push(a);
  }

  return { configPath, profile, envFile, cwd, passthrough };
}

function requireConfigPath(configPath, subcommand) {
  if (!configPath) {
    console.error(`[lorasim-cli] ${subcommand} requires -c <config>`);
    process.exit(1);
  }
}

function spawnNode(args, options = {}) {
  const cwd = options.cwd || repoRoot;
  const cp = spawn(nodeBin, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  cp.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || 'help';
  const rest = argv.slice(1);

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  const { configPath, profile, envFile, cwd, passthrough } = parseCommon(rest);

  if (sub === 'run') {
    requireConfigPath(configPath, sub);
    // Support `--` delimiter and pass-through all remaining args.
    const idx = rest.indexOf('--');
    const extra = idx >= 0 ? rest.slice(idx + 1) : passthrough;
    const args = [
      path.join(repoRoot, 'simulator', 'index.js'),
      '-c',
      toAbsoluteMaybe(configPath),
      ...extra,
    ];
    const simulatorCwd = path.join(repoRoot, 'simulator');
    return spawnNode(args, { cwd: simulatorCwd });
  }

  if (sub === 'validate') {
    requireConfigPath(configPath, sub);
    const args = [
      path.join(repoRoot, 'scripts', 'lorasim-config-validate.mjs'),
      '-c',
      toAbsoluteMaybe(configPath),
      '--profile',
      profile || 'v20-udp',
    ];
    if (cwd) args.push('--cwd', toAbsoluteMaybe(cwd));
    if (envFile) {
      // validate script does not consume --env-file; keep compatibility by warning.
      console.error('[lorasim-cli] note: validate ignores --env-file');
    }
    return spawnNode(args);
  }

  if (sub === 'cs-gw-check' || sub === 'cs-gw-apply') {
    requireConfigPath(configPath, sub);
    const args = [path.join(repoRoot, 'scripts', 'chirpstack-ensure-gateways-from-config.mjs')];
    if (sub === 'cs-gw-check') args.push('--check-only');
    if (passthrough.includes('--dry-run')) args.push('--dry-run');
    if (envFile) args.push('--env-file', toAbsoluteMaybe(envFile));
    args.push(toAbsoluteMaybe(configPath));
    return spawnNode(args);
  }

  if (sub === 'cs-dev-dry' || sub === 'cs-dev-apply') {
    requireConfigPath(configPath, sub);
    const args = [path.join(repoRoot, 'scripts', 'chirpstack-provision-otaa-from-config.mjs')];
    if (sub === 'cs-dev-dry') args.push('--dry-run');
    if (passthrough.includes('--replace-all')) args.push('--replace-all');
    if (envFile) args.push('--env-file', toAbsoluteMaybe(envFile));
    args.push(toAbsoluteMaybe(configPath));
    return spawnNode(args);
  }

  console.error(`[lorasim-cli] unknown subcommand: ${sub}`);
  console.error('Use: node scripts/lorasim-cli.mjs help');
  process.exit(1);
}

main();

