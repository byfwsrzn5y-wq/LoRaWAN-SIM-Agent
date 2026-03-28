#!/usr/bin/env node
/**
 * CI: require 关键模块但不启动 index 主循环（避免连接 LNS）。
 * 在仓库根目录执行: node scripts/ci-module-smoke.js
 */
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'simulator', 'signal_model'));
require(path.join(root, 'simulator', 'anomaly_module'));
console.log('[ci-module-smoke] ok');
