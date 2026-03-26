/**
 * OpenClaw 插件：LoRaWAN 网关模拟器 + ChirpStack v4
 * 模拟器：启动/停止/状态,配置读写,设备重置,从 ChirpStack 同步设备
 * ChirpStack v4：网关与设备的列表/创建/删除,设备下行入队
 * 强关联：一次配置（projectPath + ChirpStack API）,完整流程（注册网关/设备 → 同步 → 启动模拟器）
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import http from 'http';

const require = createRequire(import.meta.url);
const { validateLorasimConfig, PROFILE_IDS } = require('../src/config/validate-config.js');
const { readConfig: readSimConfigMerged } = require('../src/config/v20-normalize.js');

const PID_FILE = '.sim.pid';
const PID_STATE_FILE = '.sim.pid.json';
const DEFAULT_CONFIG = 'configs/config.json';

/** 解析插件配置：可选从 configFile 加载，再与 openclaw 传入的 config 合并。不把敏感信息写死在 openclaw.json 时，用环境变量或独立文件。 */
function resolveConfig(config) {
  if (!config || typeof config !== 'object') return {};
  let base = {};
  if (config.configFile) {
    const resolvedPath = path.resolve(
      String(config.configFile).replace(/^~/, process.env.HOME || process.env.USERPROFILE || '')
    );
    if (fs.existsSync(resolvedPath)) {
      try {
        base = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      } catch {
        // 忽略解析错误
      }
    }
  }
  return { ...base, ...config };
}

/**
 * 解析为「含有 simulator/index.js 的目录」（cwd 与 config 路径均相对此目录）。
 * 支持两种填法：直接指向 …/LoRaWAN-SIM/simulator，或指向 Git 克隆根 …/LoRaWAN-SIM（自动落到 simulator/）。
 */
function resolveSimulatorRoot(rawPath) {
  const resolved = path.resolve(String(rawPath).trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`模拟器项目路径不存在: ${resolved}`);
  }
  const indexHere = path.join(resolved, 'index.js');
  if (fs.existsSync(indexHere)) {
    return resolved;
  }
  const nested = path.join(resolved, 'simulator', 'index.js');
  if (fs.existsSync(nested)) {
    return path.join(resolved, 'simulator');
  }
  throw new Error(
    `未找到模拟器入口 index.js：在「${resolved}」及「${path.join(resolved, 'simulator')}」均未发现。请将 LORAWAN_SIM_PROJECT_PATH / projectPath 设为含有 index.js 的目录（本仓库为 <克隆路径>/simulator），或设为克隆根目录以自动使用 simulator/ 子目录。`
  );
}

function getProjectPath(config) {
  const merged = resolveConfig(config);
  const fromEnv = process.env.LORAWAN_SIM_PROJECT_PATH;
  const fromConfig = merged?.projectPath;
  const projectPath = fromEnv || fromConfig;
  if (!projectPath) {
    throw new Error(
      '未配置模拟器运行目录。可设置环境变量 LORAWAN_SIM_PROJECT_PATH，或在 configFile / OpenClaw 插件 config 中设置 projectPath：填 **含 index.js 的 simulator 目录**，或填 **Git 仓库根**（插件会自动使用 simulator/ 子目录）'
    );
  }
  return resolveSimulatorRoot(projectPath);
}

function getPidFilePath(projectPath) {
  return path.join(projectPath, PID_FILE);
}

function getPidStateFilePath(projectPath) {
  return path.join(projectPath, PID_STATE_FILE);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读取 PID 状态：兼容旧版 .sim.pid（单数字）与新版 .sim.pid.json（configPath -> pid）。返回 { [configPath]: pid } */
function readPidState(projectPath) {
  const statePath = getPidStateFilePath(projectPath);
  const legacyPath = getPidFilePath(projectPath);
  if (fs.existsSync(statePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return typeof data === 'object' && data !== null ? data : {};
    } catch {
      return {};
    }
  }
  if (fs.existsSync(legacyPath)) {
    try {
      const pid = parseInt(fs.readFileSync(legacyPath, 'utf8').trim(), 10);
      if (!Number.isNaN(pid)) {
        const state = { [DEFAULT_CONFIG]: pid };
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        fs.unlinkSync(legacyPath);
        return state;
      }
    } catch {}
  }
  return {};
}

function writePidState(projectPath, state) {
  const statePath = getPidStateFilePath(projectPath);
  const alive = Object.fromEntries(Object.entries(state).filter(([, pid]) => isProcessAlive(pid)));
  if (Object.keys(alive).length === 0 && fs.existsSync(statePath)) fs.unlinkSync(statePath);
  else fs.writeFileSync(statePath, JSON.stringify(alive, null, 2), 'utf8');
}

/**
 * 获取运行状态。若传 configPath 则返回该配置的单一状态；否则返回所有配置的运行列表。
 */
function getRunningState(projectPath, configPath = null) {
  const state = readPidState(projectPath);
  if (configPath != null && configPath !== '') {
    const pid = state[configPath];
    if (pid == null) return { running: false, pid: null, message: '该配置未在运行', configPath };
    if (!isProcessAlive(pid)) {
      const next = { ...state };
      delete next[configPath];
      writePidState(projectPath, next);
      return { running: false, pid: null, message: '进程已退出', configPath };
    }
    return { running: true, pid, message: `模拟器运行中 (PID: ${pid})`, configPath };
  }
  const runs = [];
  let anyAlive = false;
  for (const [cfg, pid] of Object.entries(state)) {
    const alive = isProcessAlive(pid);
    if (alive) anyAlive = true;
    runs.push({ configPath: cfg, pid, running: alive });
  }
  if (!anyAlive && Object.keys(state).length > 0) writePidState(projectPath, {});
  return { running: anyAlive, runs, message: runs.length === 0 ? '模拟器未在运行' : undefined };
}

function readConfigFile(projectPath, configPath) {
  const fullPath = path.isAbsolute(configPath)
    ? path.resolve(configPath)
    : path.resolve(projectPath, configPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`配置文件不存在: ${fullPath}`);
  }
  // Same merge as index.js: preset / extends, then v2.0 normalization
  return readSimConfigMerged(fullPath, { cwd: path.dirname(fullPath) });
}

function writeConfigFile(projectPath, configPath, data) {
  const fullPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(projectPath, configPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
}

function getControlServerUrl(projectPath, configPath) {
  const config = readConfigFile(projectPath, configPath);
  const control = config.controlServer || config.control || {};
  if (!control.enabled) {
    return null;
  }
  const port = Number(control.port) || 9999;
  const host = (control.host && control.host !== '0.0.0.0') ? control.host : '127.0.0.1';
  return `http://${host}:${port}`;
}

// ---------- ChirpStack v4 API（与模拟器强关联,共用同一配置）----------
const CS_API_PREFIX = '/api';

function getChirpstackConfig(pluginConfig) {
  const merged = resolveConfig(pluginConfig);
  // 环境变量优先，避免在 openclaw.json 中写死敏感配置
  const baseUrl = (process.env.CHIRPSTACK_API_URL || merged?.chirpstackBaseUrl || merged?.baseUrl || '').replace(/\/$/, '');
  const apiToken = process.env.CHIRPSTACK_API_TOKEN || merged?.chirpstackApiToken || merged?.apiToken || '';
  const authHeader = merged?.chirpstackAuthHeader || merged?.authHeader || 'Grpc-Metadata-Authorization';
  const defaultTenantId = process.env.CHIRPSTACK_TENANT_ID || merged?.chirpstackTenantId || merged?.defaultTenantId || '';
  const defaultApplicationId = process.env.CHIRPSTACK_APPLICATION_ID || merged?.chirpstackApplicationId || merged?.defaultApplicationId || '';
  const defaultDeviceProfileId = process.env.CHIRPSTACK_DEVICE_PROFILE_ID || merged?.chirpstackDeviceProfileId || merged?.defaultDeviceProfileId || '';
  // REST 风格：服务器暴露 /api/gateways、/api/devices 等；grpc 为 /api.GatewayService/List
  const apiStyle = process.env.CHIRPSTACK_API_STYLE || merged?.chirpstackApiStyle || merged?.apiStyle || 'grpc';
  return { baseUrl, apiToken, authHeader, defaultTenantId, defaultApplicationId, defaultDeviceProfileId, apiStyle: String(apiStyle).toLowerCase() };
}

async function chirpstackRequest(cfg, method, path, body = null) {
  if (!cfg.baseUrl || !cfg.apiToken) {
    throw new Error('未配置 ChirpStack：请设置环境变量 CHIRPSTACK_API_URL 与 CHIRPSTACK_API_TOKEN，或在使用 configFile 的 JSON / 插件配置中设置 chirpstackBaseUrl 与 chirpstackApiToken');
  }
  const url = path.startsWith('http') ? path : `${cfg.baseUrl}${cfg.baseUrl.endsWith('/') ? '' : '/'}${path}`;
  const opts = {
    method,
    headers: {
      [cfg.authHeader]: `Bearer ${cfg.apiToken}`,
      Accept: 'application/json',
    },
  };
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text || res.statusText;
    throw new Error(`ChirpStack API ${res.status}: ${msg}`);
  }
  return json;
}

function normDevEui(devEui) {
  return String(devEui || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function normGatewayId(id) {
  return String(id || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

async function csListGateways(cfg, tenantId, limit = 100, offset = 0) {
  const tId = tenantId || cfg.defaultTenantId;
  if (!tId) throw new Error('请提供 tenant_id 或在插件配置中设置 defaultTenantId / CHIRPSTACK_TENANT_ID');
  if (cfg.apiStyle === 'rest') {
    const q = new URLSearchParams({ tenantId: tId, limit: String(limit), offset: String(offset) });
    const json = await chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}/gateways?${q}`);
    const result = json?.result ?? json?.gateways ?? [];
    const total = json?.totalCount ?? json?.total_count ?? result.length;
    return { result: Array.isArray(result) ? result : [], total_count: total };
  }
  const q = new URLSearchParams({ tenant_id: tId, limit: String(limit), offset: String(offset) });
  return chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}.GatewayService/List?${q}`);
}

async function csCreateGateway(cfg, { gatewayId, name, tenantId, description }) {
  const tId = tenantId || cfg.defaultTenantId;
  if (!tId) throw new Error('请提供 tenant_id 或在插件配置中设置 defaultTenantId');
  const gwIdNorm = normGatewayId(gatewayId);
  if (gwIdNorm.length !== 16) throw new Error('Gateway ID 必须为 16 位十六进制（8 字节 EUI64）');
  const gateway = { gateway_id: gwIdNorm, name: name || `gateway-${gwIdNorm}`, tenant_id: tId };
  if (description != null) gateway.description = String(description);
  if (cfg.apiStyle === 'rest') {
    await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}/gateways`, { gateway });
    return { gateway_id: gwIdNorm, name: gateway.name };
  }
  await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.GatewayService/Create`, { gateway });
  return { gateway_id: gwIdNorm, name: gateway.name };
}

async function csDeleteGateway(cfg, gatewayId) {
  const gwIdNorm = normGatewayId(gatewayId);
  if (gwIdNorm.length !== 16) throw new Error('Gateway ID 必须为 16 位十六进制');
  if (cfg.apiStyle === 'rest') {
    await chirpstackRequest(cfg, 'DELETE', `${CS_API_PREFIX}/gateways/${gwIdNorm}`);
    return { gateway_id: gwIdNorm, deleted: true };
  }
  await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.GatewayService/Delete`, { gateway_id: gwIdNorm });
  return { gateway_id: gwIdNorm, deleted: true };
}

async function csListDevices(cfg, applicationId, limit = 100, offset = 0) {
  const appId = applicationId || cfg.defaultApplicationId;
  if (!appId) throw new Error('请提供 application_id 或在插件配置中设置 defaultApplicationId');
  if (cfg.apiStyle === 'rest') {
    const q = new URLSearchParams({ applicationId: appId, limit: String(limit), offset: String(offset) });
    const json = await chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}/devices?${q}`);
    const result = json?.result ?? json?.devices ?? [];
    const total = json?.totalCount ?? json?.total_count ?? result.length;
    return { result: Array.isArray(result) ? result : [], total_count: total };
  }
  const q = new URLSearchParams({ application_id: appId, limit: String(limit), offset: String(offset) });
  return chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}.DeviceService/List?${q}`);
}

async function csCreateDevice(cfg, { devEui, name, applicationId, deviceProfileId, description }) {
  const appId = applicationId || cfg.defaultApplicationId;
  const dpId = deviceProfileId || cfg.defaultDeviceProfileId;
  if (!appId) throw new Error('请提供 application_id 或配置 defaultApplicationId');
  if (!dpId) throw new Error('请提供 device_profile_id 或配置 defaultDeviceProfileId');
  const devEuiNorm = normDevEui(devEui);
  if (devEuiNorm.length !== 16) throw new Error('DevEUI 必须为 16 位十六进制');
  const device = { dev_eui: devEuiNorm, name: name || `device-${devEuiNorm}`, application_id: appId, device_profile_id: dpId };
  if (description != null) device.description = String(description);
  if (cfg.apiStyle === 'rest') {
    await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}/devices`, { device });
    return { dev_eui: devEuiNorm, name: device.name };
  }
  await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.DeviceService/Create`, { device });
  return { dev_eui: devEuiNorm, name: device.name };
}

async function csCreateDeviceKeys(cfg, devEui, appKey) {
  const devEuiNorm = normDevEui(devEui);
  if (devEuiNorm.length !== 16) throw new Error('DevEUI 必须为 16 位十六进制');
  const keyHex = String(appKey || '').replace(/[^a-fA-F0-9]/g, '');
  if (keyHex.length !== 32) throw new Error('AppKey 必须为 32 位十六进制');
  if (cfg.apiStyle === 'rest') {
    await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}/devices/${devEuiNorm}/keys`, { device_keys: { dev_eui: devEuiNorm, nwk_key: keyHex } });
    return { dev_eui: devEuiNorm };
  }
  await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.DeviceService/CreateKeys`, { device_keys: { dev_eui: devEuiNorm, nwk_key: keyHex } });
  return { dev_eui: devEuiNorm };
}

async function csDeleteDevice(cfg, devEui) {
  const devEuiNorm = normDevEui(devEui);
  if (devEuiNorm.length !== 16) throw new Error('DevEUI 必须为 16 位十六进制');
  if (cfg.apiStyle === 'rest') {
    await chirpstackRequest(cfg, 'DELETE', `${CS_API_PREFIX}/devices/${devEuiNorm}`);
    return { dev_eui: devEuiNorm, deleted: true };
  }
  await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.DeviceService/Delete`, { dev_eui: devEuiNorm });
  return { dev_eui: devEuiNorm, deleted: true };
}

async function csEnqueueDownlink(cfg, devEui, { data, fPort = 10, confirmed = false }) {
  const devEuiNorm = normDevEui(devEui);
  if (devEuiNorm.length !== 16) throw new Error('DevEUI 必须为 16 位十六进制');
  let dataBase64 = data;
  if (typeof data === 'string' && !/^[A-Za-z0-9+/=]+$/.test(data)) {
    dataBase64 = Buffer.from(data, 'utf8').toString('base64');
  } else if (typeof data === 'string' && data.startsWith('0x')) {
    dataBase64 = Buffer.from(data.slice(2).replace(/\s/g, ''), 'hex').toString('base64');
  } else if (typeof data === 'string') {
    dataBase64 = data;
  }
  if (cfg.apiStyle === 'rest') {
    const out = await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}/devices/${devEuiNorm}/queue`, {
      queue_item: { dev_eui: devEuiNorm, f_port: Number(fPort) || 10, confirmed: Boolean(confirmed), data: dataBase64 },
    });
    return out || { enqueued: true, dev_eui: devEuiNorm };
  }
  const out = await chirpstackRequest(cfg, 'POST', `${CS_API_PREFIX}.DeviceService/Enqueue`, {
    queue_item: { dev_eui: devEuiNorm, f_port: Number(fPort) || 10, confirmed: Boolean(confirmed), data: dataBase64 },
  });
  return out || { enqueued: true, dev_eui: devEuiNorm };
}

async function chirpstackListDevices(cfg, limit = 500, offset = 0, applicationIdOverride = null) {
  const appId = applicationIdOverride || cfg.defaultApplicationId;
  if (!cfg.baseUrl || !cfg.apiToken) throw new Error('未配置 ChirpStack API');
  if (!appId) throw new Error('未配置 ChirpStack 应用 ID（chirpstackApplicationId 或 CHIRPSTACK_APPLICATION_ID）');
  if (cfg.apiStyle === 'rest') {
    const q = new URLSearchParams({ applicationId: appId, limit: String(limit), offset: String(offset) });
    const json = await chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}/devices?${q}`);
    const result = json?.result ?? json?.devices ?? [];
    const total = (json?.totalCount != null ? json.totalCount : json?.total_count) ?? result.length;
    return { result: Array.isArray(result) ? result : [], total_count: total };
  }
  const json = await chirpstackRequest(cfg, 'GET', `${CS_API_PREFIX}.DeviceService/List?${new URLSearchParams({ application_id: appId, limit: String(limit), offset: String(offset) })}`);
  const result = (json && json.result) || [];
  const total = (json && json.total_count != null) ? json.total_count : result.length;
  return { result: Array.isArray(result) ? result : [], total_count: total };
}

function httpPostJson(url, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname || '/', url);
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const json = raw ? JSON.parse(raw) : {};
            resolve({ statusCode: res.statusCode, body: json });
          } catch {
            resolve({ statusCode: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.write(data);
    req.end();
  });
}

export default function (api) {
  if (!api || typeof api.registerTool !== 'function') {
    console.warn('[lorawan_sim] OpenClaw api.registerTool 不可用,跳过注册');
    return;
  }

  // ---------- 状态（只读,默认可用）----------
  api.registerTool({
    name: 'lorawan_sim_status',
    description: '查看 LoRaWAN 网关模拟器运行状态。不传 configPath 时列出所有以不同配置启动的实例（多 channel）；传 configPath 时只查该配置的实例。',
    parameters: {
      type: 'object',
      properties: {
        configPath: {
          type: 'string',
          description: '可选。配置文件路径,如 configs/gw1.json；不传则返回所有运行中的实例列表',
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, { config } = {}) {
      const projectPath = getProjectPath(config);
      const configPath = params?.configPath || null;
      const state = getRunningState(projectPath, configPath);
      const summary = configPath
        ? { projectPath, configPath, running: state.running, pid: state.pid, message: state.message }
        : { projectPath, running: state.running, runs: state.runs || [], message: state.message };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    },
  });

  // ---------- 启动（有副作用,可选工具）----------
  api.registerTool(
    {
      name: 'lorawan_sim_start',
      description: '在后台启动 LoRaWAN 网关模拟器。可指定配置文件路径；用不同 configPath 可同时跑多实例（多 channel,各自连不同 ChirpStack/网关）。',
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description: '配置文件路径，相对模拟器目录（含 index.js，即本仓库 simulator/），例如 configs/config.json',
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.configPath || DEFAULT_CONFIG;
        const state = getRunningState(projectPath, configPath);
        if (state.running) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: `该配置已在运行 (configPath: ${configPath}, PID: ${state.pid}),无需重复启动`,
                }, null, 2),
              },
            ],
          };
        }
        const indexPath = path.join(projectPath, 'index.js');
        if (!fs.existsSync(indexPath)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: `未找到 index.js: ${indexPath}`,
                }, null, 2),
              },
            ],
          };
        }
        const child = spawn(
          process.execPath,
          ['index.js', '-c', configPath],
          {
            cwd: projectPath,
            detached: true,
            stdio: 'ignore',
          }
        );
        child.unref();
        const pid = child.pid;
        const fullState = readPidState(projectPath);
        fullState[configPath] = pid;
        writePidState(projectPath, fullState);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message: '模拟器已启动',
                pid: pid,
                configPath: configPath,
                projectPath: projectPath,
              }, null, 2),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ---------- 停止（有副作用,可选工具）----------
  api.registerTool(
    {
      name: 'lorawan_sim_stop',
      description: '停止 LoRaWAN 网关模拟器进程。传 configPath 只停该配置的实例；不传则停止所有已启动的实例（多 channel 时一次全停）。',
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description: '可选。要停止的配置文件路径,如 configs/gw2.json；不传则停止全部实例',
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.configPath || null;
        const fullState = readPidState(projectPath);
        const toStop = configPath != null && configPath !== '' ? { [configPath]: fullState[configPath] } : fullState;
        const stopped = [];
        for (const [cfg, pid] of Object.entries(toStop)) {
          if (pid == null) continue;
          try {
            process.kill(pid, 'SIGTERM');
          } catch (e) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
          stopped.push({ configPath: cfg, pid });
          delete fullState[cfg];
        }
        writePidState(projectPath, fullState);
        const message = stopped.length === 0
          ? (configPath ? '该配置未在运行' : '模拟器未在运行')
          : `已发送停止信号,共 ${stopped.length} 个实例`;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message,
                stopped: stopped.length ? stopped : undefined,
              }, null, 2),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ---------- 读取配置（只读）----------
  api.registerTool({
    name: 'lorawan_sim_config_get',
    description: '读取 LoRaWAN 模拟器配置文件内容。可指定配置文件路径（默认 configs/config.json）',
    parameters: {
      type: 'object',
      properties: {
        configPath: {
          type: 'string',
          description: '配置文件路径，相对模拟器目录（含 index.js）',
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, { config } = {}) {
      const projectPath = getProjectPath(config);
      const configPath = params?.configPath || DEFAULT_CONFIG;
      const data = readConfigFile(projectPath, configPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    },
  });

  // ---------- 列出配置（只读）----------
  api.registerTool({
    name: 'lorawan_sim_config_list',
    description: '列出模拟器 configs 目录下的所有配置文件',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute(_id, _params, { config } = {}) {
      const projectPath = getProjectPath(config);
      const configsDir = path.join(projectPath, 'configs');
      if (!fs.existsSync(configsDir)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ configs: [], message: 'configs 目录不存在' }, null, 2),
            },
          ],
        };
      }
      const files = fs.readdirSync(configsDir).filter((f) => f.endsWith('.json'));
      const configs = files.map((f) => `configs/${f}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ configs }, null, 2),
          },
        ],
      };
    },
  });

  // ---------- 配置校验（只读）----------
  api.registerTool({
    name: 'lorawan_sim_config_validate',
    description: `校验 LoRaSIM 配置文件（JSON Schema + 场景规则）。官方运行方式：在含 index.js 的目录执行 node index.js -c <configPath>。profiles: ${PROFILE_IDS.join(', ')}。返回 normalizedPreview（脱敏 appKey 前缀）。`,
    parameters: {
      type: 'object',
      properties: {
        configPath: {
          type: 'string',
          description: '配置文件路径，相对模拟器目录；默认 configs/config.json',
        },
        profile: {
          type: 'string',
          description: `场景：v20-udp | mqtt | multigw | openclaw（默认 v20-udp）。OpenClaw 自动化建议 openclaw。`,
        },
      },
      additionalProperties: false,
    },
    async execute(_id, params, { config } = {}) {
      const projectPath = getProjectPath(config);
      const configPath = params?.configPath || DEFAULT_CONFIG;
      const profile = params?.profile || 'v20-udp';
      const result = validateLorasimConfig({
        configPath,
        profile,
        cwd: projectPath,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  });

  // ---------- 更新配置（有副作用,可选工具）----------
  api.registerTool(
    {
      name: 'lorawan_sim_config_set',
      description: `更新模拟器配置。通过点号路径更新单个字段（如 uplink.interval,lorawan.deviceCount）,或传入完整 JSON 片段合并到根。不会覆盖未提及的字段。可选 validate_before_write：为 true 时先跑与 lorawan_sim_config_validate 相同的校验，失败则不写入。`,
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description: '要写入的配置文件路径，相对模拟器目录，默认 configs/config.json',
          },
          path: {
            type: 'string',
            description: '点号路径,例如 uplink.interval 或 lorawan.deviceCount',
          },
          value: {
            description: '要设置的值（数字,字符串,布尔或 JSON 对象/数组）',
          },
          merge: {
            type: 'object',
            description: '要合并到配置根的对象（与 path/value 二选一）',
          },
          validate_before_write: {
            type: 'boolean',
            description: '为 true 时写入前校验；失败则返回校验结果且不保存',
          },
          validate_profile: {
            type: 'string',
            description: `与 lorawan_sim_config_validate 的 profile 相同；默认 openclaw。可选值：${PROFILE_IDS.join(', ')}`,
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.configPath || DEFAULT_CONFIG;
        let data = readConfigFile(projectPath, configPath);

        if (params?.merge && typeof params.merge === 'object') {
          const deepMerge = (target, src) => {
            for (const key of Object.keys(src)) {
              if (
                src[key] &&
                typeof src[key] === 'object' &&
                !Array.isArray(src[key]) &&
                typeof target[key] === 'object' &&
                !Array.isArray(target[key])
              ) {
                deepMerge(target[key], src[key]);
              } else {
                target[key] = src[key];
              }
            }
          };
          deepMerge(data, params.merge);
        } else if (params?.path != null) {
          const keys = String(params.path).split('.');
          let cur = data;
          for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in cur)) cur[k] = {};
            cur = cur[k];
          }
          cur[keys[keys.length - 1]] = params.value;
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: '请提供 path 与 value,或提供 merge 对象',
                }, null, 2),
              },
            ],
          };
        }

        if (params?.validate_before_write === true) {
          const vProfile = params?.validate_profile || 'openclaw';
          const tmpName = `.lorasim-validate-${process.pid}-${Date.now()}.json`;
          const tmpAbs = path.join(projectPath, tmpName);
          try {
            fs.writeFileSync(tmpAbs, JSON.stringify(data, null, 2), 'utf8');
            const v = validateLorasimConfig({
              configPath: tmpName,
              profile: vProfile,
              cwd: projectPath,
            });
            if (!v.ok) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      message: '校验失败，未写入文件',
                      validation: v,
                    }, null, 2),
                  },
                ],
              };
            }
          } finally {
            try {
              if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs);
            } catch { /* ignore */ }
          }
        }

        writeConfigFile(projectPath, configPath, data);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message: '配置已更新',
                configPath,
              }, null, 2),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ---------- 上行自定义负载（有副作用,可选工具）----------
  api.registerTool(
    {
      name: 'lorawan_sim_uplink_payload_set',
      description: '设置模拟器上行应用层负载（LoRaWAN FRMPayload）。不传 device_name/device_index 时改全局 uplink；传则只改该设备（需配置中已有 config.devices）。设为自定义时传 payload + format；传 use_simple: true 则恢复 simple 码。',
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description: '要写入的配置文件路径，相对模拟器目录，默认 configs/config.json',
          },
          payload: {
            type: 'string',
            description: '自定义负载内容。hex 时为偶数长度十六进制（可带 0x 前缀）；base64 时为 Base64 字符串。最长 222 字节。',
          },
          format: {
            type: 'string',
            enum: ['hex', 'base64'],
            description: 'payload 的编码方式：hex 或 base64',
          },
          use_simple: {
            type: 'boolean',
            description: '为 true 时恢复为默认 simple 码,忽略 payload/format',
          },
          device_name: {
            type: 'string',
            description: '可选。设备名称（config.devices[].name）,指定则只改该设备的上行负载；多节点不同负载时用此或 device_index',
          },
          device_index: {
            type: 'number',
            description: '可选。设备下标（从 0 开始）,指定则只改该设备；与 device_name 二选一',
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.configPath || DEFAULT_CONFIG;
        const data = readConfigFile(projectPath, configPath);
        if (!data.uplink) data.uplink = { enabled: true };

        const deviceName = (params?.device_name != null && String(params.device_name).trim() !== '') ? String(params.device_name).trim() : null;
        const deviceIndex = params?.device_index;
        const perDevice = deviceName !== null || (Number.isInteger(deviceIndex) && deviceIndex >= 0);

        let targetUplink = data.uplink;
        if (perDevice) {
          const devices = Array.isArray(data.devices) ? data.devices : [];
          let idx = -1;
          if (deviceName !== null) {
            idx = devices.findIndex((d) => (d && d.name) === deviceName);
          } else {
            idx = deviceIndex < devices.length ? deviceIndex : -1;
          }
          if (idx < 0 || !devices[idx]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    message: '按设备设置负载需要配置中有 config.devices,且 device_name 或 device_index 指向已有设备。当前无 devices 或未找到对应设备,请先用 lorawan_sim_config_set 的 merge 写入 devices 数组（含 name,lorawan,uplink 等）',
                  }, null, 2),
                },
              ],
            };
          }
          if (!devices[idx].uplink) devices[idx].uplink = {};
          targetUplink = devices[idx].uplink;
        }

        if (params?.use_simple === true) {
          targetUplink.codec = 'simple';
          delete targetUplink.payload;
          delete targetUplink.payloadFormat;
          writeConfigFile(projectPath, configPath, data);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  message: perDevice ? `已恢复该设备为 simple 上行负载` : '已恢复为 simple 上行负载（计数器+随机字节）',
                  configPath,
                  codec: 'simple',
                  device: perDevice ? (deviceName || `index ${params.device_index}`) : undefined,
                }, null, 2),
              },
            ],
          };
        }

        const payload = params?.payload != null ? String(params.payload).trim() : '';
        const format = (params?.format || 'hex').toLowerCase();
        if (format !== 'hex' && format !== 'base64') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: 'format 必须为 hex 或 base64',
                }, null, 2),
              },
            ],
          };
        }

        let byteLength = 0;
        if (payload) {
          if (format === 'hex') {
            const hex = payload.replace(/^0x/i, '').replace(/\s/g, '');
            if (hex.length % 2 !== 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      message: '十六进制 payload 长度必须为偶数',
                    }, null, 2),
                  },
                ],
              };
            }
            if (!/^[0-9a-fA-F]*$/.test(hex)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      message: 'payload 包含非十六进制字符',
                    }, null, 2),
                  },
                ],
              };
            }
            byteLength = hex.length / 2;
          } else {
            try {
              byteLength = Buffer.from(payload, 'base64').length;
            } catch {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      message: 'Base64 payload 格式无效',
                    }, null, 2),
                  },
                ],
              };
            }
        }
        }
        if (byteLength > 222) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: 'LoRaWAN FRMPayload 最长 222 字节,当前约 ' + byteLength + ' 字节',
                }, null, 2),
              },
            ],
          };
        }

        targetUplink.codec = 'custom';
        targetUplink.payloadFormat = format;
        targetUplink.payload = payload;
        writeConfigFile(projectPath, configPath, data);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message: '已设置上行自定义负载；下次启动模拟器或使用本配置启动后生效',
                configPath,
                codec: 'custom',
                payloadFormat: format,
                payloadByteLength: byteLength,
                device: perDevice ? (deviceName || `index ${params.device_index}`) : undefined,
              }, null, 2),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ---------- 设备重置（有副作用,可选工具）----------
  api.registerTool(
    {
      name: 'lorawan_sim_reset_device',
      description: '调用模拟器控制接口重置设备：指定 devEui 则重置该 OTAA 设备或 ABP 的 FCnt；不指定则重置所有 OTAA 设备。需要模拟器已开启 controlServer 且正在运行。',
      parameters: {
        type: 'object',
        properties: {
          devEui: {
            type: 'string',
            description: '设备 DevEUI（十六进制,如 0102030405060701）。不传则重置所有 OTAA 设备',
          },
          configPath: {
            type: 'string',
            description: '用于读取 controlServer 端口的配置文件路径,默认 configs/config.json',
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.configPath || DEFAULT_CONFIG;
        const baseUrl = getControlServerUrl(projectPath, configPath);
        if (!baseUrl) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: '当前配置中 controlServer 未启用,无法调用重置接口',
                }, null, 2),
              },
            ],
          };
        }
        const body = params?.devEui ? { devEui: String(params.devEui).trim() } : {};
        try {
          const { statusCode, body: resBody } = await httpPostJson(baseUrl, '/reset', body);
          const ok = statusCode >= 200 && statusCode < 300;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok,
                    statusCode,
                    ...(typeof resBody === 'object' ? resBody : { response: resBody }),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (e) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: `请求失败: ${e.message}。请确认模拟器已启动且 controlServer 已开启`,
                }, null, 2),
              },
            ],
          };
        }
      },
    },
    { optional: true }
  );

  // ---------- 从 ChirpStack 同步设备（关联两插件：ChirpStack 注册的设备 → 模拟器用同一批设备发数据）----------
  api.registerTool(
    {
      name: 'lorawan_sim_sync_from_chirpstack',
      description: '从 ChirpStack 拉取指定应用下的设备列表,生成模拟器可用的 CSV 并更新配置,使模拟器用这批已注册设备发送数据。需在 ChirpStack 创建设备时使用统一的 AppKey（与参数或当前配置中的 app_key 一致）。可指定 application_id,config_path,app_key,app_eui,output_csv。',
      parameters: {
        type: 'object',
        properties: {
          application_id: {
            type: 'string',
            description: 'ChirpStack 应用 ID（UUID）；不传则用插件配置或环境变量 CHIRPSTACK_APPLICATION_ID',
          },
          config_path: {
            type: 'string',
            description: '要更新的模拟器配置文件路径,默认 configs/config.json',
          },
          app_key: {
            type: 'string',
            description: 'OTAA AppKey（32 位十六进制）,与 ChirpStack 中创建设备时一致；不传则用当前配置 lorawan.appKey',
          },
          app_eui: {
            type: 'string',
            description: 'AppEUI（16 位十六进制）,不传则用配置 lorawan.appEuiStart 或 0000000000000001',
          },
          output_csv: {
            type: 'string',
            description: '生成的 CSV 路径（相对模拟器目录），默认 configs/synced-from-chirpstack.csv',
          },
          limit: {
            type: 'number',
            description: '单次拉取设备数量上限,默认 500',
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params, { config } = {}) {
        const projectPath = getProjectPath(config);
        const configPath = params?.config_path || DEFAULT_CONFIG;
        const outputCsv = params?.output_csv || 'configs/synced-from-chirpstack.csv';
        const limit = Math.min(Number(params?.limit) || 500, 2000);

        const csCfg = getChirpstackConfig(config);
        const { result: devices, total_count } = await chirpstackListDevices(csCfg, limit, 0, params?.application_id);

        if (devices.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  message: '该应用下暂无设备,未写入 CSV；可先在 ChirpStack 注册设备后再同步',
                  device_count: 0,
                  total_count,
                }, null, 2),
              },
            ],
          };
        }

        let simConfig = readConfigFile(projectPath, configPath);
        const appKey = (params?.app_key || (simConfig.lorawan && simConfig.lorawan.appKey) || '').replace(/[^a-fA-F0-9]/g, '');
        if (appKey.length !== 32) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: 'AppKey 必须为 32 位十六进制。请传入 app_key 或在模拟器配置中设置 lorawan.appKey（需与 ChirpStack 创建设备时使用的 AppKey 一致）',
                }, null, 2),
              },
            ],
          };
        }
        const appEui = (params?.app_eui || (simConfig.lorawan && (simConfig.lorawan.appEuiStart || simConfig.lorawan.appEui)) || '0000000000000001').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        if (appEui.length !== 16) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  message: 'AppEUI 必须为 16 位十六进制',
                }, null, 2),
              },
            ],
          };
        }

        const csvHeader = 'JoinMode,Group,Name,Profile,AppEUI,DevEUI,AppKey,DevAddr,AppSKey,NwkSKey\n';
        const rows = devices.map((d) => {
          const devEui = String((d.dev_eui || d.devEui || '').replace(/[^a-fA-F0-9]/g, '')).toLowerCase();
          const name = (d.name || `device-${devEui}`).replace(/,/g, '_');
          return ['OTAA', '', name, 'default', appEui, devEui, appKey, '', '', ''].join(',');
        });
        const csvContent = csvHeader + rows.join('\n') + '\n';
        const csvFullPath = path.isAbsolute(outputCsv) ? outputCsv : path.join(projectPath, outputCsv);
        const csvDir = path.dirname(csvFullPath);
        if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
        fs.writeFileSync(csvFullPath, csvContent, 'utf8');

        if (!simConfig.lorawan) simConfig.lorawan = {};
        simConfig.lorawan.activation = 'OTAA';
        simConfig.lorawan.enabled = true;
        simConfig.lorawan.csvImportPath = outputCsv;
        simConfig.lorawan.deviceCount = 0;
        simConfig.lorawan.appKey = appKey;
        if (appEui !== '0000000000000001') simConfig.lorawan.appEuiStart = appEui;
        writeConfigFile(projectPath, configPath, simConfig);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                message: '已从 ChirpStack 同步设备并更新模拟器配置；可用 lorawan_sim_start 启动模拟器,将使用这批设备发送数据',
                device_count: devices.length,
                total_count,
                csv_path: outputCsv,
                config_path: configPath,
              }, null, 2),
            },
          ],
        };
      },
    },
    { optional: true }
  );

  // ---------- ChirpStack v4：网关与设备（与模拟器同插件,共用配置）----------
  api.registerTool(
    {
      name: 'chirpstack_gateway_list',
      description: '列出 ChirpStack v4 某租户下的网关。需 tenant_id 或插件 defaultTenantId。',
      parameters: {
        type: 'object',
        properties: { tenant_id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
        additionalProperties: false,
      },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csListGateways(cfg, params?.tenant_id, params?.limit ?? 100, params?.offset ?? 0);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    },
    { optional: false }
  );

  api.registerTool(
    {
      name: 'chirpstack_gateway_create',
      description: '在 ChirpStack v4 中注册一个网关。需 gateway_id（16 位十六进制 EUI64）,tenant_id 或 defaultTenantId；可选 name,description。',
      parameters: {
        type: 'object',
        properties: { gateway_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, tenant_id: { type: 'string' } },
        required: ['gateway_id'],
        additionalProperties: false,
      },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csCreateGateway(cfg, { gatewayId: params.gateway_id, name: params.name, tenantId: params.tenant_id, description: params.description });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, gateway: result }, null, 2) }] };
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: 'chirpstack_gateway_delete',
      description: '从 ChirpStack v4 中删除指定网关。需 gateway_id（16 位十六进制）。',
      parameters: { type: 'object', properties: { gateway_id: { type: 'string' } }, required: ['gateway_id'], additionalProperties: false },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csDeleteGateway(cfg, params.gateway_id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: 'chirpstack_device_list',
      description: '列出 ChirpStack v4 某应用下的设备。可指定 application_id 或使用 defaultApplicationId。',
      parameters: {
        type: 'object',
        properties: { application_id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
        additionalProperties: false,
      },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csListDevices(cfg, params?.application_id, params?.limit ?? 100, params?.offset ?? 0);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    },
    { optional: false }
  );

  api.registerTool(
    {
      name: 'chirpstack_device_create',
      description: '在 ChirpStack v4 中注册一个 OTAA 设备。需 dev_eui,app_key；application_id/device_profile_id 可省略用默认值。可选 name,description。',
      parameters: {
        type: 'object',
        properties: { dev_eui: { type: 'string' }, app_key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, application_id: { type: 'string' }, device_profile_id: { type: 'string' } },
        required: ['dev_eui', 'app_key'],
        additionalProperties: false,
      },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const created = await csCreateDevice(cfg, { devEui: params.dev_eui, name: params.name, applicationId: params.application_id, deviceProfileId: params.device_profile_id, description: params.description });
        await csCreateDeviceKeys(cfg, params.dev_eui, params.app_key);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device: created, keys_set: true }, null, 2) }] };
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: 'chirpstack_device_delete',
      description: '从 ChirpStack v4 中删除指定设备。需 dev_eui（16 位十六进制）。',
      parameters: { type: 'object', properties: { dev_eui: { type: 'string' } }, required: ['dev_eui'], additionalProperties: false },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csDeleteDevice(cfg, params.dev_eui);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
      },
    },
    { optional: true }
  );

  api.registerTool(
    {
      name: 'chirpstack_downlink_send',
      description: '向 ChirpStack v4 指定设备下行队列入队数据。dev_eui,data（base64/UTF-8/0x 十六进制）；可选 f_port,confirmed。',
      parameters: {
        type: 'object',
        properties: { dev_eui: { type: 'string' }, data: { type: 'string' }, f_port: { type: 'number' }, confirmed: { type: 'boolean' } },
        required: ['dev_eui', 'data'],
        additionalProperties: false,
      },
      async execute(_id, params, ctx = {}) {
        const cfg = getChirpstackConfig(ctx.config);
        const result = await csEnqueueDownlink(cfg, params.dev_eui, { data: params.data, fPort: params.f_port, confirmed: params.confirmed });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
      },
    },
    { optional: true }
  );
}

export { resolveSimulatorRoot };
