#!/usr/bin/env node
/**
 * LoRaWAN Simulator Discord Bot - 自然语言版本
 *
 * 支持自然语言交互，自动解析用户意图
 *
 * 环境变量:
 *   DISCORD_TOKEN - Discord Bot Token
 *   SIMULATOR_PATH - 模拟器路径
 *   CHIRPSTACK_API - ChirpStack API URL
 *   CHIRPSTACK_TOKEN - ChirpStack API Token
 */

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActivityType
} = require('discord.js');

const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// 配置
const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN,
  simulatorPath: process.env.SIMULATOR_PATH || path.join(__dirname, '..'),
  chirpstackApi: process.env.CHIRPSTACK_API || 'http://10.5.40.109:8090/api',
  chirpstackToken: process.env.CHIRPSTACK_TOKEN || '',
  controlPort: process.env.CONTROL_PORT || 9999,
  prefix: '!lora' // 命令前缀
};

const STATE_FILE = path.join(CONFIG.simulatorPath, 'sim-state.json');

// 状态
const state = {
  simulatorProcess: null,
  currentConfig: null,
  stats: {
    startTime: null,
    uplinks: 0,
    joins: 0,
    errors: 0
  }
};

// 创建 Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ==================== 意图解析 ====================

/**
 * 解析用户自然语言输入
 */
function parseIntent(message) {
  const text = message.toLowerCase().trim();
  
  // 移除前缀
  const content = text.replace(/^!lora\s*/i, '').trim();
  
  if (!content) {
    return { action: 'help' };
  }

  // ===== 启动模拟器 =====
  if (matchAny(content, ['启动', '开始', '运行', 'start', 'run', 'launch'])) {
    const nodeMatch = content.match(/(\d+)\s*(个|台|nodes?|devices?)/i);
    const nodes = nodeMatch ? parseInt(nodeMatch[1]) : null;
    
    // 提取配置文件名
    let config = 'example-multi-gateway.json';
    const configMatch = content.match(/配置[:\s]*([^\s,，]+)/i) || 
                        content.match(/config[:\s]*([^\s,，]+)/i);
    if (configMatch) {
      config = configMatch[1];
      if (!config.endsWith('.json')) config += '.json';
    }
    
    return {
      action: 'start',
      config,
      nodes,
      original: content
    };
  }

  // ===== 停止模拟器 =====
  if (matchAny(content, ['停止', '结束', '关闭', 'stop', 'kill', 'halt', '终止'])) {
    return { action: 'stop' };
  }

  // ===== 查看状态 =====
  if (matchAny(content, ['状态', '怎么样', '情况', 'status', 'state', '如何', '运行情况'])) {
    return { action: 'status' };
  }

  // ===== 列出节点 =====
  if (matchAny(content, ['节点', '设备', '列出', 'nodes?', 'devices?', 'list', '有哪些'])) {
    return { action: 'nodes' };
  }

  // ===== 注入异常 =====
  if (matchAny(content, ['注入', '异常', 'inject', 'anomaly', '模拟', '故障', '攻击'])) {
    // 提取异常类型
    const anomalyMap = {
      'fcnt重复|fcnt.?dup|重复帧': 'fcnt-duplicate',
      'fcnt跳变|fcnt.?jump|帧计数跳': 'fcnt-jump',
      'mic损坏|mic.?corrupt|mic错误|完整性': 'mic-corrupt',
      'mac损坏|mac.?corrupt|mac命令': 'mac-corrupt',
      'payload损坏|数据损坏|负载损坏': 'payload-corrupt',
      '弱信号|信号弱|signal.?weak|rssi低': 'signal-weak',
      '信号突变|signal.?spike|信号波动': 'signal-spike',
      '信号退化|signal.?degrade|degrade': 'signal-degrade',
      '快速join|rapid.?join|频繁入网|重复入网': 'rapid-join',
      'devnonce重复|devnonce.?repeat|随机数重复': 'devnonce-repeat',
      '丢包|random.?drop|packet.?loss|丢帧': 'random-drop',
      '地址冲突|devaddr|devaddr.?reuse': 'devaddr-reuse',
      '下行损坏|downlink.?corrupt': 'downlink-corrupt',
      '网关离线|gateway.?offline': 'gateway-offline',
      '无确认|confirmed.?no.?ack|无ack': 'confirmed-noack',
      '错误地址|wrong.?addr': 'devaddr-reuse'
    };

    let anomalyType = null;
    for (const [pattern, type] of Object.entries(anomalyMap)) {
      if (new RegExp(pattern, 'i').test(content)) {
        anomalyType = type;
        break;
      }
    }

    // 提取节点
    let targetNode = null;
    const nodeMatch = content.match(/节点[:\s]*(\S+)|node[:\s]*(\S+)|设备[:\s]*(\S+)|device[:\s]*(\S+)/i);
    if (nodeMatch) {
      targetNode = nodeMatch[1] || nodeMatch[2] || nodeMatch[3] || nodeMatch[4];
    }

    // 尝试从数字提取节点
    if (!targetNode) {
      const numMatch = content.match(/第?\s*(\d+)\s*(个|台|号)?/);
      if (numMatch) {
        targetNode = `node-${numMatch[1].padStart(2, '0')}`;
      }
    }

    return {
      action: 'anomaly',
      type: anomalyType || 'mic-corrupt',
      node: targetNode || 'node-01'
    };
  }

  // ===== 诊断网络 =====
  if (matchAny(content, ['诊断', '检查', '诊断网络', '网络健康', 'diagnose', 'check', 'health'])) {
    return { action: 'diagnose' };
  }

  // ===== 列出配置 =====
  if (matchAny(content, ['配置', 'config', '设置', '选项'])) {
    return { action: 'configs' };
  }

  // ===== 帮助 =====
  if (matchAny(content, ['帮助', 'help', '怎么用', '使用方法', '功能', '能做什么'])) {
    return { action: 'help' };
  }

  // ===== 清除/重置 =====
  if (matchAny(content, ['重置', '清除', 'reset', 'clear', '清空'])) {
    return { action: 'reset' };
  }

  // ===== 可视化 =====
  if (matchAny(content, ['可视化', '地图', '界面', 'visuali', 'dashboard', 'web'])) {
    return { action: 'visualizer' };
  }

  // ===== 默认：尝试理解 =====
  return {
    action: 'unknown',
    original: content
  };
}

function matchAny(text, patterns) {
  return patterns.some(p => new RegExp(p, 'i').test(text));
}

// ==================== 执行动作 ====================

async function executeAction(intent, message) {
  switch (intent.action) {
    case 'start':
      return await handleStart(intent, message);
    case 'stop':
      return await handleStop(message);
    case 'status':
      return await handleStatus(message);
    case 'nodes':
      return await handleNodes(message);
    case 'anomaly':
      return await handleAnomaly(intent, message);
    case 'diagnose':
      return await handleDiagnose(message);
    case 'configs':
      return await handleConfigs(message);
    case 'help':
      return await handleHelp(message);
    case 'reset':
      return await handleReset(message);
    case 'visualizer':
      return await handleVisualizer(message);
    default:
      return `🤔 不太理解你的意思："${intent.original}"\n\n试试说：\n• 启动模拟器\n• 查看状态\n• 注入 MIC 损坏异常\n• 帮助`;
  }
}

// ===== 各动作处理函数 =====

async function handleStart(intent, message) {
  if (state.simulatorProcess) {
    return '⚠️ 模拟器已在运行，请先停止';
  }

  const configPath = path.join(CONFIG.simulatorPath, 'configs', intent.config);
  if (!fs.existsSync(configPath)) {
    return `❌ 配置文件不存在: ${intent.config}\n使用 \`!lora 配置\` 查看可用配置`;
  }

  try {
    const args = ['-c', configPath];
    if (intent.nodes) {
      args.push('-n', intent.nodes.toString());
    }

    state.simulatorProcess = spawn('node', ['index.js', ...args], {
      cwd: CONFIG.simulatorPath,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    state.stats.startTime = Date.now();
    state.currentConfig = intent.config;

    let output = '';
    state.simulatorProcess.stdout.on('data', (data) => {
      output += data.toString();
      const uplinkMatch = output.match(/Uplink #(\d+)/g);
      if (uplinkMatch) {
        state.stats.uplinks = parseInt(uplinkMatch[uplinkMatch.length - 1].match(/\d+/)[0]);
      }
    });

    state.simulatorProcess.on('close', () => {
      state.simulatorProcess = null;
      state.stats.startTime = null;
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    return `📡 **模拟器已启动**\n\n` +
           `• 配置: \`${intent.config}\`\n` +
           `• 节点: ${intent.nodes || '配置文件定义'}\n` +
         `• 状态文件: ${STATE_FILE}`;
  } catch (error) {
    return `❌ 启动失败: ${error.message}`;
  }
}

async function handleStop(message) {
  if (!state.simulatorProcess) {
    return '⚠️ 模拟器未运行';
  }

  state.simulatorProcess.kill('SIGTERM');
  state.simulatorProcess = null;

  const duration = state.stats.startTime
    ? Math.round((Date.now() - state.stats.startTime) / 1000)
    : 0;

  const msg = `🛑 **模拟器已停止**\n\n` +
              `• 运行时长: ${duration}秒\n` +
              `• 上行总数: ${state.stats.uplinks}`;

  state.stats = { startTime: null, uplinks: 0, joins: 0, errors: 0 };
  return msg;
}

async function handleStatus(message) {
  const running = state.simulatorProcess !== null;
  const duration = state.stats.startTime
    ? Math.round((Date.now() - state.stats.startTime) / 1000)
    : 0;

  let nodeCount = 0;
  try {
    const res = await fetchState();
    nodeCount = res.nodes?.length || 0;
  } catch (e) {
    nodeCount = 0;
  }

  const emoji = running ? '🟢' : '⚫';
  return `${emoji} **模拟器状态**\n\n` +
         `• 状态: ${running ? '运行中' : '已停止'}\n` +
         `• 配置: ${state.currentConfig || '-'}\n` +
         `• 运行时长: ${duration}秒\n` +
         `• 节点数: ${nodeCount}\n` +
         `• 上行计数: ${state.stats.uplinks}`;
}

async function handleNodes(message) {
  try {
    const res = await fetchState();
    const nodes = res.nodes || [];

    if (nodes.length === 0) {
      return '📋 暂无活跃节点';
    }

    const lines = nodes.slice(0, 15).map((n, i) => {
      const anomaly = n.anomaly?.enabled ? ` ⚠️${n.anomaly.scenario}` : '';
      const signal = n.rssi ? ` (${n.rssi.toFixed(0)}dBm)` : '';
      return `\`${i + 1}\` **${n.name || n.eui?.slice(-4)}**${anomaly}${signal}`;
    });

    return `📋 **节点列表** (${nodes.length}个)\n\n${lines.join('\n')}` +
           (nodes.length > 15 ? `\n\n_...还有 ${nodes.length - 15} 个_` : '');
  } catch (error) {
    return `❌ 获取节点失败: ${error.message}`;
  }
}

async function handleAnomaly(intent, message) {
  if (!state.simulatorProcess) {
    return '⚠️ 模拟器未运行，请先启动';
  }

  try {
    await httpPost(`http://localhost:${CONFIG.controlPort}/anomaly`, {
      node: intent.node,
      anomaly: { enabled: true, scenario: intent.type, trigger: 'always' }
    });

    return `⚠️ **异常已注入**\n\n• 节点: \`${intent.node}\`\n• 类型: \`${intent.type}\``;
  } catch (error) {
    return `❌ 注入失败: ${error.message}`;
  }
}

async function handleDiagnose(message) {
  try {
    const diagnosePath = path.join(CONFIG.simulatorPath, 'diagnose.js');
    const result = await new Promise((resolve, reject) => {
      exec(
        `node ${diagnosePath} --api ${CONFIG.chirpstackApi}`,
        { timeout: 10000 },
        (error, stdout) => error ? reject(error) : resolve(stdout)
      );
    });

    const lines = result.split('\n').filter(l => l.trim()).slice(0, 12);
    return `🔍 **网络诊断结果**\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
  } catch (error) {
    return `❌ 诊断失败: ${error.message}`;
  }
}

async function handleConfigs(message) {
  const configsDir = path.join(CONFIG.simulatorPath, 'configs');
  try {
    const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      return '📁 配置目录为空';
    }

    const lines = files.map((f, i) => `\`${i + 1}\` ${f}`);
    return `📁 **可用配置** (${files.length}个)\n\n${lines.join('\n')}\n\n_使用: 启动模拟器 配置 xxx.json_`;
  } catch (error) {
    return `❌ 读取失败: ${error.message}`;
  }
}

async function handleHelp(message) {
  return `📡 **LoRaWAN 模拟器助手**\n\n` +
         `你可以这样跟我说：\n\n` +
         `**控制模拟器**\n` +
         `• 启动模拟器\n` +
         `• 启动10个节点\n` +
         `• 停止模拟器\n` +
         `• 查看状态\n\n` +
         `**异常注入**\n` +
         `• 注入 MIC 损坏异常\n` +
         `• 给第3个节点注入弱信号\n` +
         `• 模拟 FCnt 重复攻击\n\n` +
         `**诊断与监控**\n` +
         `• 列出所有节点\n` +
         `• 诊断网络\n` +
         `**支持的异常类型**\n` +
         `MIC损坏、FCnt重复、弱信号、丢包、错误地址等18种\n\n` +
         `_前缀: !lora (可选)_`;
}

async function handleReset(message) {
  if (!state.simulatorProcess) {
    return '⚠️ 模拟器未运行';
  }

  try {
    await httpPost(`http://localhost:${CONFIG.controlPort}/reset`, {});
    return '🔄 已重置所有 OTAA 设备，设备将重新入网';
  } catch (error) {
    return `❌ 重置失败: ${error.message}`;
  }
}

async function handleVisualizer(message) {
  return `🧭 **调试状态**\n\n本仓库已移除前端可视化（不再提供浏览器可视化服务）。\n` +
         `你仍可通过 \`/sim-status\` 与 \`/sim-nodes\`（读取 \`${STATE_FILE}\`）查看状态与节点列表。`;
}

// ==================== 辅助函数 ====================

function fetchState() {
  return new Promise((resolve, reject) => {
    fs.readFile(STATE_FILE, 'utf8', (err, raw) => {
      if (err) {
        // 保持 bot 可用：即使还没启动模拟器，也要返回一个空状态结构
        return resolve({
          running: false,
          gateways: [],
          nodes: [],
          stats: { uplinks: 0, joins: 0, errors: 0 },
          packetLog: [],
          lastUpdate: null,
          schemaVersion: 1,
        });
      }

      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ==================== Discord 事件 ====================

client.once('ready', async () => {
  console.log(`✅ Discord Bot 已登录: ${client.user.tag}`);
  client.user.setActivity('!lora 帮助', { type: ActivityType.Watching });

  // 注册简化的斜杠命令
  try {
    await client.application.commands.set([
      new SlashCommandBuilder()
        .setName('lora')
        .setDescription('LoRaWAN 模拟器')
        .addStringOption(opt =>
          opt.setName('command')
            .setDescription('命令内容')
            .setRequired(true)
        )
    ]);
    console.log('✅ 斜杠命令已注册');
  } catch (error) {
    console.error('❌ 注册命令失败:', error);
  }
});

// 处理消息
client.on('messageCreate', async (message) => {
  // 忽略机器人消息
  if (message.author.bot) return;

  // 检查是否以 !lora 开头 或 @提及
  const isPrefix = message.content.toLowerCase().startsWith('!lora');
  const isMention = message.mentions.has(client.user);

  if (!isPrefix && !isMention) return;

  try {
    const intent = parseIntent(message.content);
    const response = await executeAction(intent, message);
    await message.reply(response);
  } catch (error) {
    console.error('处理消息出错:', error);
    await message.reply(`❌ 出错了: ${error.message}`);
  }
});

// 处理斜杠命令
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'lora') {
    const command = interaction.options.getString('command');
    const intent = parseIntent(command);
    const response = await executeAction(intent, interaction);
    await interaction.reply(response);
  }
});

// ==================== 启动 ====================

if (!CONFIG.discordToken) {
  console.error('❌ 请设置环境变量 DISCORD_TOKEN');
  console.log('\n创建步骤:');
  console.log('1. 访问 https://discord.com/developers/applications');
  console.log('2. 创建应用 → Bot → Add Bot → 复制 Token');
  console.log('3. export DISCORD_TOKEN="your-token"');
  console.log('4. 邀请 Bot: OAuth2 > URL Generator > bot + applications.commands');
  process.exit(1);
}

client.login(CONFIG.discordToken);
