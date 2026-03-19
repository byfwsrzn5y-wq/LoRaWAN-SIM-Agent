#!/usr/bin/env node
/**
 * LoRaWAN 网络诊断工具
 *
 * 用法: node diagnose.js [options]
 *
 * 选项:
 *   --api <url>      ChirpStack API 地址
 *   --token <token>  API Token
 *   --gateway <eui>  网关 EUI
 *   --device <eui>   设备 EUI
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 解析命令行参数
function parseArgs() {
  const args = {
    api: process.env.CHIRPSTACK_API_URL || 'http://10.5.40.109:8090/api',
    token: process.env.CHIRPSTACK_API_TOKEN || '',
    gateway: null,
    device: null
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--api' && i + 1 < process.argv.length) {
      args.api = process.argv[++i];
    } else if (arg === '--token' && i + 1 < process.argv.length) {
      args.token = process.argv[++i];
    } else if (arg === '--gateway' && i + 1 < process.argv.length) {
      args.gateway = process.argv[++i];
    } else if (arg === '--device' && i + 1 < process.argv.length) {
      args.device = process.argv[++i];
    }
  }

  return args;
}

// HTTP 请求
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { 'Authorization': `Bearer ${options.token}` } : {}),
        ...options.headers
      }
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// 诊断函数
async function diagnose(args) {
  console.log('\n🔍 LoRaWAN 网络诊断');
  console.log('='.repeat(50));
  console.log(`API: ${args.api}`);
  console.log('');

  const results = {
    healthy: true,
    issues: [],
    recommendations: []
  };

  try {
    // 1. 检查 API 连接
    console.log('📡 检查 ChirpStack API...');
    try {
      const health = await request(`${args.api}/health`, { token: args.token });
      if (health.status === 200) {
        console.log('   ✅ API 连接正常');
      } else {
        console.log(`   ❌ API 返回状态码: ${health.status}`);
        results.healthy = false;
        results.issues.push('API 连接异常');
      }
    } catch (e) {
      console.log(`   ❌ API 连接失败: ${e.message}`);
      results.healthy = false;
      results.issues.push('API 连接失败');
    }

    // 2. 检查网关
    if (args.gateway) {
      console.log(`\n📡 检查网关 ${args.gateway}...`);
      try {
        const gw = await request(`${args.api}/gateways/${args.gateway}`, { token: args.token });
        if (gw.status === 200 && gw.data) {
          const lastSeen = gw.data.lastSeenAt ? new Date(gw.data.lastSeenAt) : null;
          const ago = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 1000) : null;

          console.log(`   名称: ${gw.data.name || args.gateway}`);
          console.log(`   状态: ${gw.data.status || 'unknown'}`);
          console.log(`   最后上线: ${lastSeen ? lastSeen.toISOString() : 'never'} ${ago ? `(${ago}s ago)` : ''}`);

          if (!lastSeen || ago > 300) {
            console.log('   ⚠️  网关长时间未上线');
            results.issues.push('网关离线或长时间未上报');
            results.recommendations.push('检查网关电源和网络连接');
          }
        } else {
          console.log(`   ❌ 网关不存在或无法访问`);
          results.issues.push('网关不存在');
        }
      } catch (e) {
        console.log(`   ❌ 网关查询失败: ${e.message}`);
      }
    } else {
      // 列出所有网关
      console.log('\n📡 检查所有网关...');
      try {
        const gateways = await request(`${args.api}/gateways?limit=100`, { token: args.token });
        if (gateways.status === 200 && gateways.data?.result) {
          console.log(`   找到 ${gateways.data.totalCount || gateways.data.result.length} 个网关`);
          gateways.data.result.forEach(gw => {
            const lastSeen = gw.lastSeenAt ? new Date(gw.lastSeenAt) : null;
            const ago = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 1000) : null;
            const status = (!lastSeen || ago > 300) ? '❌' : '✅';
            console.log(`   ${status} ${gw.name || gw.gatewayId} (${ago ? ago + 's ago' : 'never'})`);
          });
        }
      } catch (e) {
        console.log(`   ❌ 网关列表查询失败: ${e.message}`);
      }
    }

    // 3. 检查设备
    if (args.device) {
      console.log(`\n📱 检查设备 ${args.device}...`);
      try {
        const dev = await request(`${args.api}/devices/${args.device}`, { token: args.token });
        if (dev.status === 200 && dev.data) {
          console.log(`   名称: ${dev.data.name || args.device}`);
          console.log(`   DevEUI: ${dev.data.devEui}`);
          console.log(`   设备配置: ${dev.data.deviceProfileId || 'unknown'}`);

          // 检查激活状态
          const activation = await request(`${args.api}/devices/${args.device}/activation`, { token: args.token });
          if (activation.status === 200 && activation.data) {
            console.log(`   状态: 已激活`);
            console.log(`   DevAddr: ${activation.data.devAddr || 'unknown'}`);
            console.log(`   FCntUp: ${activation.data.fCntUp || 0}`);
            console.log(`   FCntDown: ${activation.data.fCntDown || 0}`);
          } else {
            console.log(`   状态: 未激活`);
            results.issues.push('设备未激活');
            results.recommendations.push('检查 OTAA Join 流程');
          }
        } else {
          console.log(`   ❌ 设备不存在`);
          results.issues.push('设备不存在');
        }
      } catch (e) {
        console.log(`   ❌ 设备查询失败: ${e.message}`);
      }
    }

    // 4. 检查应用
    console.log('\n📱 检查应用...');
    try {
      const apps = await request(`${args.api}/applications?limit=100`, { token: args.token });
      if (apps.status === 200 && apps.data?.result) {
        console.log(`   找到 ${apps.data.totalCount || apps.data.result.length} 个应用`);
      }
    } catch (e) {
      console.log(`   ❌ 应用列表查询失败: ${e.message}`);
    }

  } catch (e) {
    console.log(`\n❌ 诊断过程出错: ${e.message}`);
    results.healthy = false;
  }

  // 输出诊断结果
  console.log('\n' + '='.repeat(50));
  console.log('📋 诊断结果');
  console.log('='.repeat(50));

  if (results.healthy) {
    console.log('✅ 网络状态健康');
  } else {
    console.log('❌ 发现以下问题:');
    results.issues.forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue}`);
    });

    if (results.recommendations.length > 0) {
      console.log('\n💡 建议:');
      results.recommendations.forEach((rec, i) => {
        console.log(`   ${i + 1}. ${rec}`);
      });
    }
  }

  console.log('');
  return results;
}

// 运行诊断
const args = parseArgs();
diagnose(args).catch(console.error);
