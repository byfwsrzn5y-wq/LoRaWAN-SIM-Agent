#!/usr/bin/env node
/**
 * CI: 校验 openclaw 插件 resolveSimulatorRoot（仓库根 vs simulator/ 两种填法）。
 * 在仓库根目录执行: node scripts/ci-openclaw-resolve-smoke.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSimulatorRoot } from '../simulator/openclaw-lorawan-sim/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const simDir = path.join(root, 'simulator');

const a = resolveSimulatorRoot(root);
const b = resolveSimulatorRoot(simDir);
if (a !== simDir || b !== simDir) {
  console.error('[ci-openclaw-resolve-smoke] fail', { fromRoot: a, fromSimulator: b, expected: simDir });
  process.exit(1);
}
console.log('[ci-openclaw-resolve-smoke] ok');
