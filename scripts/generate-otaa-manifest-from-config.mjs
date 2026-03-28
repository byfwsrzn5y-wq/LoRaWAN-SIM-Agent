#!/usr/bin/env node
/**
 * 按 simulator/index.js 中 genSequentialDevEui 规则，从 JSON 的 lorawan.* 生成 OTAA 设备清单（CSV）。
 * 用于与 ChirpStack NS 侧批量导入或人工核对；与 randomBehaviors 批量生成逻辑一致。
 *
 * 用法:
 *   node scripts/generate-otaa-manifest-from-config.mjs [path/to/config.json] [--out path.csv]
 * 默认配置: simulator/configs/config-100nodes-10types.json
 * 默认输出: 打印到 stdout；若指定 --out 则写入文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function genSequentialDevEuiBuf(startHex, index) {
  const clean = String(startHex || '').replace(/[^a-fA-F0-9]/g, '');
  if (!clean) throw new Error('empty start hex');
  const v = (BigInt('0x' + clean) + BigInt(index)) & BigInt('0xffffffffffffffff');
  const b = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    b[7 - i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  return b;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let configPath = null;
  let outPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outPath = args[++i];
    } else if (!args[i].startsWith('-')) {
      configPath = args[i];
    }
  }
  if (!configPath) {
    configPath = path.join(repoRoot, 'simulator', 'configs', 'config-100nodes-10types.json');
  }
  if (!path.isAbsolute(configPath)) {
    configPath = path.join(repoRoot, configPath);
  }
  return { configPath, outPath };
}

function main() {
  const { configPath, outPath } = parseArgs();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const lw = raw.lorawan || {};
  const deviceCount = Number(lw.deviceCount || 0);
  const appKey = String(lw.appKey || '').replace(/[^a-fA-F0-9]/g, '');
  const appEuiStart = (lw.appEuiStart || lw.appEui || '0000000000000001').toString().trim();
  const devEuiStart = (lw.devEuiStart || lw.devEui || '0102030405060701').toString().trim();

  if (String(lw.activation || '').toUpperCase() !== 'OTAA') {
    console.error('配置不是 OTAA，未生成 manifest');
    process.exit(1);
  }
  if (!deviceCount || !appKey || appKey.length !== 32) {
    console.error('需要 lorawan.deviceCount 与 32 hex 的 appKey');
    process.exit(1);
  }

  const lines = ['join_eui,dev_eui,app_key,device_name'];
  for (let i = 0; i < deviceCount; i++) {
    const joinEui = genSequentialDevEuiBuf(appEuiStart, i).toString('hex').toLowerCase();
    const devEui = genSequentialDevEuiBuf(devEuiStart, i).toString('hex').toLowerCase();
    const name = `sim-node-${String(i + 1).padStart(3, '0')}`;
    lines.push(`${joinEui},${devEui},${appKey},${name}`);
  }

  const text = lines.join('\n') + '\n';
  if (outPath) {
    const abs = path.isAbsolute(outPath) ? outPath : path.join(repoRoot, outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    console.error(`Wrote ${deviceCount} rows -> ${abs}`);
  } else {
    process.stdout.write(text);
  }
}

main();
