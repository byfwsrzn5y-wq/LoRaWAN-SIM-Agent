#!/usr/bin/env node
/**
 * Validate LoRaSIM JSON config (node index.js -c …).
 * Example (repo root): node scripts/lorasim-config-validate.mjs -c simulator/config.json --profile v20-udp
 * Example (simulator dir): node ../scripts/lorasim-config-validate.mjs -c config.json
 */

import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { validateLorasimConfig, PROFILE_IDS } = require('../simulator/src/config/validate-config.js');

function parseArgs(argv) {
  let configPath = '';
  let profile = 'v20-udp';
  let cwd = process.cwd();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--config') configPath = argv[++i] || '';
    else if (a === '--profile') profile = argv[++i] || 'v20-udp';
    else if (a === '--cwd') cwd = argv[++i] || cwd;
    else if (a === '-h' || a === '--help') return { help: true, configPath, profile, cwd };
  }
  return { help: false, configPath, profile, cwd: path.resolve(cwd) };
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`lorasim-config-validate — JSON Schema + profile rules for LoRaSIM (index.js)

Usage:
  node scripts/lorasim-config-validate.mjs -c <path/to/config.json> [--profile PROFILE] [--cwd DIR]

Profiles: ${PROFILE_IDS.join(', ')}
  v20-udp   ChirpStack GW Bridge UDP (default)
  mqtt      Requires mqtt.enabled
  multigw   Requires multiGateway.enabled + gateways[]
  openclaw  Same as v20-udp; warns if controlServer disabled

--cwd  Base for resolving relative config paths (default: current directory)

Config layering (same as index.js readConfig):
  Top-level \"preset\" loads simulator/configs/presets/<name>.json first.
  Top-level \"extends\" (string or array) merges additional JSON; see docs/CONFIG_MAP.md.
  Validation runs on the fully merged config.

Exit code: 0 if ok (no errors), 1 if any errors. Warnings do not fail.
`);
  process.exit(0);
}

if (!args.configPath) {
  console.error('Error: missing -c <config.json>');
  process.exit(1);
}

const result = validateLorasimConfig({
  configPath: args.configPath,
  profile: args.profile,
  cwd: args.cwd,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
