/**
 * Environment Manager Module
 * Zone-based environment simulation with transition effects
 */

/**
 * Environment zone definition
 * @typedef {Object} Zone
 * @property {string} id - Zone identifier
 * @property {string} type - 'urban' | 'suburban' | 'rural' | 'indoor' | 'free-space'
 * @property {Object} geometry - Zone geometry
 * @property {number} geometry.type - 0: circle, 1: rectangle, 2: polygon
 * @property {Position} [geometry.center] - Center position (for circle)
 * @property {number} [geometry.radius] - Radius (for circle)
 * @property {Object} [geometry.bounds] - Bounds (for rectangle)
 * @property {Array<Position>} [geometry.vertices] - Vertices (for polygon)
 */

/**
 * Environment event
 * @typedef {Object} EnvironmentEvent
 * @property {string} type - Event type
 * @property {Object} trigger - Trigger condition
 * @property {Object} effect - Event effect
 */

const { calculateDistance } = require('../physical');

class EnvironmentManager {
  constructor(config = {}) {
    this.zones = config.zones || [];
    this.events = config.events || [];
    this.defaultEnvironment = config.defaultEnvironment || 'urban';
    this.transitions = new Map(); // Active transitions
  }

  /**
   * Add a zone
   * @param {Zone} zone
   */
  addZone(zone) {
    this.zones.push(zone);
  }

  /**
   * Remove a zone
   * @param {string} zoneId
   */
  removeZone(zoneId) {
    this.zones = this.zones.filter(z => z.id !== zoneId);
  }

  /**
   * Get current environment at a position
   * @param {Position} position
   * @returns {string} Environment type
   */
  getEnvironmentAt(position) {
    for (const zone of this.zones) {
      if (this.isPositionInZone(position, zone)) {
        return zone.type;
      }
    }
    return this.defaultEnvironment;
  }

  /**
   * Check if position is inside a zone
   * @param {Position} position
   * @param {Zone} zone
   * @returns {boolean}
   */
  isPositionInZone(position, zone) {
    const { geometry } = zone;
    
    switch (geometry.type) {
      case 0: // Circle
        const dist = calculateDistance(position, geometry.center);
        return dist <= geometry.radius;
        
      case 1: // Rectangle
        return (
          position.x >= geometry.bounds.xMin &&
          position.x <= geometry.bounds.xMax &&
          position.y >= geometry.bounds.yMin &&
          position.y <= geometry.bounds.yMax
        );
        
      case 2: // Polygon (simplified - using bounding box)
        // For proper polygon containment, use ray casting algorithm
        return this._pointInPolygon(position, geometry.vertices);
        
      default:
        return false;
    }
  }

  /**
   * Point in polygon test using ray casting
   * @private
   */
  _pointInPolygon(point, vertices) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].x, yi = vertices[i].y;
      const xj = vertices[j].x, yj = vertices[j].y;
      
      const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Check for environment events
   * @param {string} deviceId
   * @param {Position} position
   * @param {number} timestamp
   * @returns {Array<EnvironmentEvent>} Triggered events
   */
  checkEvents(deviceId, position, timestamp) {
    const triggered = [];
    
    for (const event of this.events) {
      if (this._checkTrigger(event.trigger, deviceId, position, timestamp)) {
        triggered.push(event);
      }
    }
    
    return triggered;
  }

  /**
   * Check if trigger condition is met
   * @private
   */
  _checkTrigger(trigger, deviceId, position, timestamp) {
    // Check position-based trigger
    if (trigger.position) {
      const dist = calculateDistance(position, trigger.position);
      const threshold = trigger.radius || 10; // meters
      if (dist > threshold) return false;
    }
    
    // Check time-based trigger
    if (trigger.time !== undefined) {
      const elapsed = (timestamp - this._startTime) / 1000;
      // Simple check - more sophisticated logic needed for repeated triggers
      if (Math.abs(elapsed - trigger.time) > 1) return false;
    }
    
    // Check zone-based trigger
    if (trigger.zone) {
      const zone = this.zones.find(z => z.id === trigger.zone);
      if (!zone || !this.isPositionInZone(position, zone)) return false;
    }
    
    return true;
  }

  /**
   * Start an environment transition
   * @param {string} deviceId
   * @param {string} fromEnv
   * @param {string} toEnv
   * @param {number} duration - Transition duration in seconds
   */
  startTransition(deviceId, fromEnv, toEnv, duration) {
    this.transitions.set(deviceId, {
      from: fromEnv,
      to: toEnv,
      startTime: Date.now(),
      duration: duration * 1000
    });
  }

  /**
   * Get current environment with transition blending
   * @param {string} deviceId
   * @param {Position} position
   * @returns {Object} Environment info
   */
  getBlendedEnvironment(deviceId, position) {
    const baseEnv = this.getEnvironmentAt(position);
    const transition = this.transitions.get(deviceId);
    
    if (!transition) {
      return { type: baseEnv, blend: 1.0, transitioning: false };
    }
    
    const elapsed = Date.now() - transition.startTime;
    const progress = Math.min(1, Math.max(0, elapsed / transition.duration));
    
    // Transition complete
    if (progress >= 1) {
      this.transitions.delete(deviceId);
      return { type: transition.to, blend: 1.0, transitioning: false };
    }
    
    return {
      type: transition.to,
      from: transition.from,
      blend: progress,
      transitioning: true
    };
  }

  /**
   * Get signal modifier for environment
   * @param {string} environment
   * @returns {Object} Signal modifiers
   */
  getSignalModifiers(environment) {
    const modifiers = {
      'free-space': { pathLossFactor: 1.0, shadowFadingStd: 2 },
      'suburban': { pathLossFactor: 1.2, shadowFadingStd: 6 },
      'urban': { pathLossFactor: 1.4, shadowFadingStd: 8 },
      'indoor': { pathLossFactor: 2.0, shadowFadingStd: 12 },
      'dense-urban': { pathLossFactor: 1.6, shadowFadingStd: 10 }
    };
    
    return modifiers[environment] || modifiers['urban'];
  }

  /**
   * Initialize start time
   */
  initialize() {
    this._startTime = Date.now();
  }

  /**
   * Reset all state
   */
  reset() {
    this.transitions.clear();
    this.initialize();
  }
}

module.exports = {
  EnvironmentManager
};
