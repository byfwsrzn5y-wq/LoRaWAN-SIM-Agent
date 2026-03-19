/**
 * LoRaWAN 多网关高级功能 - Multi-Gateway Advanced Features
 *
 * 网关状态管理、切换逻辑、负载均衡
 */

const PHYSICAL_LAYER = require('./physical_layer');

// ==================== 网关状态管理 ====================

class GatewayManager {
  constructor(config) {
    this.gateways = new Map();
    this.config = config;
    this.stats = {
      totalHandovers: 0,
      totalUplinks: 0,
      gatewayDistribution: {}
    };

    // 初始化网关
    if (config.multiGateway?.gateways) {
      config.multiGateway.gateways.forEach(gw => {
        this.addGateway(gw);
      });
    }
  }

  addGateway(gwConfig) {
    const gateway = {
      eui: gwConfig.eui,
      name: gwConfig.name || gwConfig.eui,
      position: gwConfig.position || { x: 0, y: 0, z: 30 },
      rxGain: gwConfig.rxGain || 5,
      rxSensitivity: gwConfig.rxSensitivity || -137,
      antenna: gwConfig.antenna || { pattern: 'omnidirectional', gain: gwConfig.rxGain || 5 },
      status: 'online',
      uptime: Date.now(),
      stats: {
        uplinks: 0,
        downlinks: 0,
        joinRequests: 0,
        errors: 0,
        avgRssi: 0,
        avgSnr: 0
      },
      load: 0,  // 当前负载 (0-1)
      lastSeen: Date.now()
    };

    this.gateways.set(gwConfig.eui, gateway);
    this.stats.gatewayDistribution[gwConfig.eui] = 0;

    console.log(`[GatewayManager] Added gateway: ${gateway.name} (${gateway.eui})`);
    return gateway;
  }

  removeGateway(eui) {
    const gateway = this.gateways.get(eui);
    if (gateway) {
      this.gateways.delete(eui);
      console.log(`[GatewayManager] Removed gateway: ${gateway.name}`);
      return true;
    }
    return false;
  }

  updateGatewayStatus(eui, status) {
    const gateway = this.gateways.get(eui);
    if (gateway) {
      gateway.status = status;
      gateway.lastSeen = Date.now();
    }
  }

  recordUplink(gatewayEui, signal) {
    const gateway = this.gateways.get(gatewayEui);
    if (gateway) {
      gateway.stats.uplinks++;
      gateway.lastSeen = Date.now();

      // 更新平均 RSSI/SNR
      const n = gateway.stats.uplinks;
      gateway.stats.avgRssi = ((gateway.stats.avgRssi * (n - 1)) + signal.rssi) / n;
      gateway.stats.avgSnr = ((gateway.stats.avgSnr * (n - 1)) + signal.snr) / n;

      this.stats.totalUplinks++;
      this.stats.gatewayDistribution[gatewayEui]++;
    }
  }

  getOnlineGateways() {
    return Array.from(this.gateways.values()).filter(gw => gw.status === 'online');
  }

  getGatewayStats() {
    return Array.from(this.gateways.values()).map(gw => ({
      eui: gw.eui,
      name: gw.name,
      status: gw.status,
      uptime: Math.round((Date.now() - gw.uptime) / 1000),
      stats: gw.stats,
      load: gw.load
    }));
  }
}

// ==================== 切换决策 ====================

class HandoverManager {
  constructor(gatewayManager, config) {
    this.gatewayManager = gatewayManager;
    this.config = config;
    this.deviceState = new Map(); // 设备当前连接的网关
    this.hysteresisMargin = config.multiGateway?.hysteresisMargin || 3; // dB
    this.handoverThreshold = config.multiGateway?.handoverThreshold || -120; // RSSI 阈值
    this.minHandoverInterval = config.multiGateway?.minHandoverInterval || 30000; // 最小切换间隔 (ms)
  }

  /**
   * 选择最佳网关
   */
  selectBestGateway(device, devicePos, mode = 'handover') {
    const onlineGateways = this.gatewayManager.getOnlineGateways();
    if (onlineGateways.length === 0) {
      return null;
    }

    // 计算每个网关的接收情况
    const receptions = onlineGateways.map(gw => {
      const signal = PHYSICAL_LAYER.calculateSignal(devicePos, gw.position, {
        ...this.config.signalModel,
        rxAntenna: gw.antenna,
        rxSensitivity: gw.rxSensitivity
      });

      return {
        gateway: gw,
        signal: signal,
        score: this.calculateScore(gw, signal)
      };
    }).filter(r => r.signal.canReceive);

    if (receptions.length === 0) {
      return null;
    }

    // 按分数排序
    receptions.sort((a, b) => b.score - a.score);

    const deviceEui = device.devEui?.toString('hex') || device.name;
    const currentState = this.deviceState.get(deviceEui);

    switch (mode) {
      case 'overlapping':
        // 所有能接收的网关
        return receptions;

      case 'handover':
        // 带滞后的切换
        return this.decideHandover(deviceEui, receptions);

      case 'failover':
        // 主备模式
        return this.decideFailover(receptions);

      case 'load-balance':
        // 负载均衡
        return this.decideLoadBalance(receptions);

      default:
        return receptions[0];
    }
  }

  calculateScore(gateway, signal) {
    // 综合评分：信号强度 + 负载 + 稳定性
    let score = signal.rssi;

    // 负载惩罚
    score -= gateway.load * 10;

    // 稳定性奖励（基于历史错误率）
    const errorRate = gateway.stats.uplinks > 0
      ? gateway.stats.errors / gateway.stats.uplinks
      : 0;
    score -= errorRate * 20;

    return score;
  }

  decideHandover(deviceEui, receptions) {
    const best = receptions[0];
    const current = this.deviceState.get(deviceEui);

    if (!current) {
      // 首次连接
      this.deviceState.set(deviceEui, {
        gatewayEui: best.gateway.eui,
        connectedAt: Date.now(),
        lastHandover: Date.now()
      });
      return best;
    }

    // 检查是否需要切换
    const currentReception = receptions.find(r => r.gateway.eui === current.gatewayEui);
    const timeSinceLastHandover = Date.now() - current.lastHandover;

    if (timeSinceLastHandover < this.minHandoverInterval) {
      // 切换间隔太短，保持当前连接
      return currentReception || best;
    }

    // 滞后比较
    if (currentReception && best.gateway.eui !== current.gatewayEui) {
      const improvement = best.signal.rssi - currentReception.signal.rssi;

      if (improvement > this.hysteresisMargin) {
        // 信号改善超过滞后裕量，执行切换
        this.deviceState.set(deviceEui, {
          gatewayEui: best.gateway.eui,
          connectedAt: Date.now(),
          lastHandover: Date.now()
        });
        this.gatewayManager.stats.totalHandovers++;
        console.log(`[Handover] Device ${deviceEui}: ${current.gatewayEui} -> ${best.gateway.eui} (Δ${improvement.toFixed(1)}dB)`);
        return best;
      }
    }

    return currentReception || best;
  }

  decideFailover(receptions) {
    // 优先使用主网关
    const primaryEui = this.config.multiGateway?.primaryGateway;
    const primary = receptions.find(r => r.gateway.eui === primaryEui);

    if (primary && primary.signal.canReceive) {
      return primary;
    }

    // 主网关不可用，选择最佳的备用网关
    console.log(`[Failover] Primary gateway ${primaryEui} unavailable, using fallback`);
    return receptions[0];
  }

  decideLoadBalance(receptions) {
    // 选择负载最低且信号可接受的网关
    const acceptable = receptions.filter(r => r.signal.rssi > this.handoverThreshold);

    if (acceptable.length === 0) {
      return receptions[0];
    }

    acceptable.sort((a, b) => a.gateway.load - b.gateway.load);
    return acceptable[0];
  }

  getDeviceConnections() {
    return Array.from(this.deviceState.entries()).map(([eui, state]) => ({
      deviceEui: eui,
      gatewayEui: state.gatewayEui,
      connectedDuration: Math.round((Date.now() - state.connectedAt) / 1000),
      lastHandover: state.lastHandover
    }));
  }
}

// ==================== 导出 ====================

module.exports = {
  GatewayManager,
  HandoverManager
};
