/**
 * Derived Anomalies Module
 * Generate anomalies from physical conditions rather than direct injection
 */

/**
 * Derived anomaly definition
 * @typedef {Object} DerivedAnomaly
 * @property {string} name - Anomaly name
 * @property {Object} trigger - Trigger conditions
 * @property {Object} effect - Effect description
 * @property {number} probability - Probability of occurrence (0-1)
 */

class DerivedAnomalyEngine {
  constructor(config = {}) {
    this.anomalies = config.anomalies || {};
    this.triggerHistory = new Map(); // deviceId -> trigger events
    this.activeAnomalies = new Map(); // deviceId -> active anomaly list
    this.causalChains = []; // For tracking cause-effect relationships
  }

  /**
   * Evaluate triggers and generate derived anomalies
   * @param {string} deviceId
   * @param {Object} deviceState
   * @param {Object} context - Context including signal, position, movement
   * @returns {Array<Object>} Generated anomalies
   */
  evaluate(deviceId, deviceState, context) {
    const generated = [];
    
    for (const [name, anomaly] of Object.entries(this.anomalies)) {
      if (!anomaly.enabled) continue;
      
      const triggered = this._evaluateTrigger(
        anomaly.trigger,
        deviceState,
        context,
        deviceId
      );
      
      if (triggered) {
        // Check probability
        const prob = anomaly.probability || 1.0;
        if (Math.random() > prob) continue;
        
        // Generate anomaly
        const derived = this._generateAnomaly(name, anomaly, deviceState, context);
        if (derived) {
          generated.push(derived);
          this._recordAnomaly(deviceId, derived, context);
        }
      }
    }
    
    return generated;
  }

  /**
   * Evaluate a trigger condition
   * @private
   */
  _evaluateTrigger(trigger, deviceState, context, deviceId) {
    // Signal-based triggers
    if (trigger.rssi) {
      const rssi = context.signal?.rssi;
      if (rssi === undefined) return false;
      
      if (trigger.rssi.startsWith('<')) {
        const threshold = parseFloat(trigger.rssi.slice(1));
        if (rssi >= threshold) return false;
      } else if (trigger.rssi.startsWith('>')) {
        const threshold = parseFloat(trigger.rssi.slice(1));
        if (rssi <= threshold) return false;
      }
    }
    
    if (trigger.snr) {
      const snr = context.signal?.snr;
      if (snr === undefined) return false;
      
      if (trigger.snr.startsWith('<')) {
        const threshold = parseFloat(trigger.snr.slice(1));
        if (snr >= threshold) return false;
      }
    }
    
    // Movement-based triggers
    if (trigger.velocity) {
      const velocity = context.movement?.velocity;
      if (velocity === undefined) return false;
      
      const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
      
      if (trigger.velocity.startsWith('>')) {
        const threshold = parseFloat(trigger.velocity.slice(1));
        if (speed <= threshold) return false;
      }
    }
    
    // Duration-based triggers
    if (trigger.duration) {
      const condition = trigger.duration.condition;
      const duration = this._getConditionDuration(deviceId, condition);
      const required = this._parseDuration(trigger.duration.value);
      
      if (duration < required) return false;
    }
    
    // Frequency-based triggers (e.g., gateway changes)
    if (trigger.frequency) {
      const { event, count, window } = trigger.frequency;
      const eventCount = this._getEventCount(deviceId, event, window);
      if (eventCount < count) return false;
    }
    
    // Environment-based triggers
    if (trigger.environment) {
      const env = context.environment?.type;
      if (env !== trigger.environment) return false;
    }
    
    return true;
  }

  /**
   * Generate an anomaly from trigger
   * @private
   */
  _generateAnomaly(name, anomaly, deviceState, context) {
    const base = {
      name,
      cause: 'derived',
      timestamp: Date.now(),
      triggerContext: {
        signal: context.signal,
        position: context.position,
        environment: context.environment,
        velocity: context.movement?.velocity
      }
    };
    
    switch (anomaly.effect?.type) {
      case 'adr-request':
        return {
          ...base,
          type: 'adr-reject',
          macCommand: {
            cid: 0x03,
            name: 'LinkADRAns',
            payload: Buffer.from([0x00])
          },
          reason: 'Signal too weak, ADR rejected'
        };
        
      case 'packet-loss':
        return {
          ...base,
          type: 'random-drop',
          dropProbability: 1.0,
          reason: 'Signal below sensitivity threshold'
        };
        
      case 'frequency-offset':
        const speed = context.movement?.velocity ? 
          Math.sqrt(context.movement.velocity.x ** 2 + context.movement.velocity.y ** 2) : 0;
        const offset = this._calculateDopplerOffset(speed, context.signal?.frequency || 923e6);
        return {
          ...base,
          type: 'frequency-drift',
          offset,
          reason: `Doppler effect at ${speed.toFixed(1)} m/s`
        };
        
      case 'session-reset':
        return {
          ...base,
          type: 'rapid-join',
          action: 'force-rejoin',
          reason: `Frequent handover (${trigger.frequency?.count} changes)`
        };
        
      case 'signal-report':
        return {
          ...base,
          type: 'dev-status-ans',
          battery: deviceState.devStatus?.battery || 200,
          margin: Math.max(-32, Math.min(31, Math.floor(context.signal?.snr || 0))),
          reason: 'Periodic device status due to signal degradation'
        };
        
      default:
        return base;
    }
  }

  /**
   * Calculate Doppler frequency offset
   * @private
   */
  _calculateDopplerOffset(velocity, frequency) {
    const c = 299792458; // Speed of light
    return (velocity / c) * frequency;
  }

  /**
   * Get duration a condition has been met
   * @private
   */
  _getConditionDuration(deviceId, condition) {
    const history = this.triggerHistory.get(deviceId);
    if (!history) return 0;
    
    // Find last occurrence of condition
    const last = history.filter(h => h.condition === condition).pop();
    if (!last) return 0;
    
    return (Date.now() - last.timestamp) / 1000;
  }

  /**
   * Get count of events in time window
   * @private
   */
  _getEventCount(deviceId, eventType, windowSeconds) {
    const history = this.triggerHistory.get(deviceId);
    if (!history) return 0;
    
    const cutoff = Date.now() - (windowSeconds * 1000);
    return history.filter(h => 
      h.event === eventType && h.timestamp > cutoff
    ).length;
  }

  /**
   * Parse duration string to seconds
   * @private
   */
  _parseDuration(durationStr) {
    const match = durationStr.match(/(\d+)(s|m|h)/);
    if (!match) return parseFloat(durationStr);
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      default: return value;
    }
  }

  /**
   * Record an anomaly occurrence
   * @private
   */
  _recordAnomaly(deviceId, anomaly, context) {
    // Add to active anomalies
    if (!this.activeAnomalies.has(deviceId)) {
      this.activeAnomalies.set(deviceId, []);
    }
    this.activeAnomalies.get(deviceId).push(anomaly);
    
    // Record causal chain
    this.causalChains.push({
      timestamp: Date.now(),
      deviceId,
      anomaly: anomaly.name,
      cause: {
        signal: context.signal,
        position: context.position,
        environment: context.environment?.type,
        velocity: context.movement?.velocity
      },
      effect: anomaly.type
    });
    
    // Trim history if too long
    if (this.causalChains.length > 1000) {
      this.causalChains = this.causalChains.slice(-500);
    }
  }

  /**
   * Record a trigger event
   * @param {string} deviceId
   * @param {string} eventType
   * @param {Object} data
   */
  recordEvent(deviceId, eventType, data = {}) {
    if (!this.triggerHistory.has(deviceId)) {
      this.triggerHistory.set(deviceId, []);
    }
    
    this.triggerHistory.get(deviceId).push({
      event: eventType,
      timestamp: Date.now(),
      ...data
    });
    
    // Trim old history
    const cutoff = Date.now() - (3600 * 1000); // Keep 1 hour
    const history = this.triggerHistory.get(deviceId);
    const trimmed = history.filter(h => h.timestamp > cutoff);
    if (trimmed.length < history.length) {
      this.triggerHistory.set(deviceId, trimmed);
    }
  }

  /**
   * Get causal chain for analysis
   * @returns {Array} Causal chain events
   */
  getCausalChains() {
    return [...this.causalChains];
  }

  /**
   * Get active anomalies for a device
   * @param {string} deviceId
   * @returns {Array}
   */
  getActiveAnomalies(deviceId) {
    return this.activeAnomalies.get(deviceId) || [];
  }

  /**
   * Clear active anomalies for a device
   * @param {string} deviceId
   */
  clearActiveAnomalies(deviceId) {
    this.activeAnomalies.delete(deviceId);
  }

  /**
   * Reset all state
   */
  reset() {
    this.triggerHistory.clear();
    this.activeAnomalies.clear();
    this.causalChains = [];
  }
}

// Predefined derived anomaly configurations
const DEFAULT_ANOMALIES = {
  'signal-weak': {
    enabled: true,
    trigger: { rssi: '< -120', duration: { condition: 'rssi-weak', value: '30s' } },
    effect: { type: 'adr-request' },
    probability: 0.8
  },
  'signal-critical': {
    enabled: true,
    trigger: { rssi: '< -135' },
    effect: { type: 'packet-loss' },
    probability: 0.9
  },
  'doppler-shift': {
    enabled: true,
    trigger: { velocity: '> 10m/s' },
    effect: { type: 'frequency-offset' },
    probability: 1.0
  },
  'rapid-handover': {
    enabled: true,
    trigger: { frequency: { event: 'gateway-change', count: 3, window: 60 } },
    effect: { type: 'session-reset' },
    probability: 0.7
  },
  'periodic-status': {
    enabled: true,
    trigger: { duration: { condition: 'joined', value: '300s' } },
    effect: { type: 'signal-report' },
    probability: 0.3
  }
};

module.exports = {
  DerivedAnomalyEngine,
  DEFAULT_ANOMALIES
};
