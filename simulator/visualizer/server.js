#!/usr/bin/env node
/**
 * LoRaWAN Simulator Visualizer Server
 * 提供静态文件服务和实时状态 API
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3030;
const STATE_FILE = path.join(__dirname, '..', 'sim-state.json');
const HTML_FILE = path.join(__dirname, 'index.html');

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// MIME types
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

// 当前模拟状态
let currentState = {
  running: false,
  gateways: [],
  nodes: [],
  stats: { uplinks: 0, joins: 0, errors: 0 },
  config: null,
  lastUpdate: null
};

// 监听状态文件变化
function watchStateFile() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      currentState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      // 忽略解析错误
    }
  }

  fs.watchFile(STATE_FILE, { interval: 500 }, () => {
    try {
      if (fs.existsSync(STATE_FILE)) {
        currentState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        console.log(`[${new Date().toISOString()}] State updated: ${currentState.nodes?.length || 0} nodes`);
      }
    } catch (e) {
      // 忽略错误
    }
  });
}

// HTTP 请求处理
function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API: 获取状态
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(currentState));
    return;
  }

  // API: 健康检查
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // 静态文件
  let filePath = url.pathname === '/' ? HTML_FILE : path.join(__dirname, url.pathname);
  const ext = path.extname(filePath);
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType, ...corsHeaders });
    res.end(data);
  });
}

// 启动服务器
function start() {
  watchStateFile();

  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`\n📡 LoRaWAN Simulator Visualizer`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`\n   API:`);
    console.log(`   - GET /api/state  - 获取模拟器状态`);
    console.log(`   - GET /api/health - 健康检查`);
    console.log(`\n   状态文件: ${STATE_FILE}`);
    console.log(`\n   按 Ctrl+C 停止\n`);
  });
}

start();
