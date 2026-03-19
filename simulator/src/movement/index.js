/**
 * Movement Engine Module
 * Device movement simulation with various trajectory models
 */

/**
 * Position in 3D space
 * @typedef {Object} Position
 * @property {number} x - X coordinate (meters)
 * @property {number} y - Y coordinate (meters)
 * @property {number} z - Z coordinate (meters, height)
 */

/**
 * Movement configuration
 * @typedef {Object} MovementConfig
 * @property {string} type - 'linear' | 'random' | 'preset' | 'stationary'
 * @property {Object} [linear] - Linear movement config
 * @property {Object} [random] - Random walk config
 * @property {Object} [preset] - Preset waypoints config
 */

class MovementEngine {
  constructor(config) {
    this.config = config || { type: 'stationary' };
    this.startTime = Date.now();
    this.currentPosition = this.getInitialPosition();
    this.velocity = { x: 0, y: 0, z: 0 };
    this.lastUpdateTime = this.startTime;
  }

  /**
   * Get initial position based on movement type
   * @returns {Position}
   */
  getInitialPosition() {
    switch (this.config.type) {
      case 'linear':
        return this.config.linear?.startPosition || { x: 0, y: 0, z: 2 };
      case 'preset':
        const waypoints = this.config.preset?.waypoints;
        return waypoints?.[0] || { x: 0, y: 0, z: 2 };
      case 'random':
        return this.config.random?.initialPosition || { x: 0, y: 0, z: 2 };
      case 'stationary':
      default:
        return this.config.stationary?.position || { x: 0, y: 0, z: 2 };
    }
  }

  /**
   * Update position based on elapsed time
   * @param {number} [timestamp] - Current timestamp (defaults to Date.now())
   * @returns {Position} Current position
   */
  update(timestamp = Date.now()) {
    const elapsed = (timestamp - this.startTime) / 1000; // seconds
    
    switch (this.config.type) {
      case 'linear':
        this.currentPosition = this.calculateLinearPosition(elapsed);
        break;
      case 'random':
        this.currentPosition = this.calculateRandomPosition(elapsed, timestamp);
        break;
      case 'preset':
        this.currentPosition = this.calculatePresetPosition(elapsed);
        break;
      case 'stationary':
      default:
        // Position doesn't change
        break;
    }
    
    this.lastUpdateTime = timestamp;
    return this.currentPosition;
  }

  /**
   * Calculate position for linear movement
   * @param {number} elapsed - Elapsed time in seconds
   * @returns {Position}
   */
  calculateLinearPosition(elapsed) {
    const { startPosition, endPosition, duration, loop } = this.config.linear;
    
    let progress = elapsed / duration;
    
    if (loop) {
      // Ping-pong loop
      const cycles = Math.floor(progress);
      const fraction = progress - cycles;
      progress = cycles % 2 === 0 ? fraction : 1 - fraction;
    } else {
      progress = Math.min(1, Math.max(0, progress));
    }
    
    return {
      x: startPosition.x + (endPosition.x - startPosition.x) * progress,
      y: startPosition.y + (endPosition.y - startPosition.y) * progress,
      z: startPosition.z + (endPosition.z - startPosition.z) * progress
    };
  }

  /**
   * Calculate position for random walk
   * @param {number} elapsed - Elapsed time in seconds
   * @param {number} timestamp - Current timestamp
   * @returns {Position}
   */
  calculateRandomPosition(elapsed, timestamp) {
    const { speed, directionChangeInterval, boundary } = this.config.random;
    
    // Check if we need to change direction
    const timeSinceLastChange = (timestamp - this._lastDirectionChange) / 1000;
    if (!this._lastDirectionChange || timeSinceLastChange >= directionChangeInterval) {
      this._changeDirection();
      this._lastDirectionChange = timestamp;
    }
    
    // Calculate delta time
    const deltaTime = (timestamp - this.lastUpdateTime) / 1000;
    
    // Update position based on velocity
    let newX = this.currentPosition.x + this.velocity.x * deltaTime;
    let newY = this.currentPosition.y + this.velocity.y * deltaTime;
    
    // Apply boundary constraints
    if (boundary) {
      const [xMin, xMax] = boundary.x || [-Infinity, Infinity];
      const [yMin, yMax] = boundary.y || [-Infinity, Infinity];
      
      if (newX < xMin || newX > xMax) {
        this.velocity.x *= -1;
        newX = Math.max(xMin, Math.min(xMax, newX));
      }
      if (newY < yMin || newY > yMax) {
        this.velocity.y *= -1;
        newY = Math.max(yMin, Math.min(yMax, newY));
      }
    }
    
    return {
      x: newX,
      y: newY,
      z: this.currentPosition.z
    };
  }

  /**
   * Change random direction
   * @private
   */
  _changeDirection() {
    const speed = this.config.random?.speed || 1.0;
    const angle = Math.random() * 2 * Math.PI;
    
    this.velocity = {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
      z: 0
    };
  }

  /**
   * Calculate position for preset waypoints
   * @param {number} elapsed - Elapsed time in seconds
   * @returns {Position}
   */
  calculatePresetPosition(elapsed) {
    const waypoints = this.config.preset?.waypoints;
    if (!waypoints || waypoints.length === 0) {
      return this.currentPosition;
    }
    
    // Find current segment
    let currentIndex = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (elapsed >= waypoints[i].time && elapsed < waypoints[i + 1].time) {
        currentIndex = i;
        break;
      }
      if (i === waypoints.length - 2 && elapsed >= waypoints[i + 1].time) {
        return waypoints[waypoints.length - 1];
      }
    }
    
    const start = waypoints[currentIndex];
    const end = waypoints[currentIndex + 1];
    const segmentDuration = end.time - start.time;
    const segmentElapsed = elapsed - start.time;
    const progress = Math.min(1, Math.max(0, segmentElapsed / segmentDuration));
    
    return {
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
      z: start.z + (end.z - start.z) * progress
    };
  }

  /**
   * Get current velocity
   * @returns {Object} Velocity vector { x, y, z } in m/s
   */
  getVelocity() {
    return { ...this.velocity };
  }

  /**
   * Calculate speed (magnitude of velocity)
   * @returns {number} Speed in m/s
   */
  getSpeed() {
    return Math.sqrt(
      this.velocity.x ** 2 + 
      this.velocity.y ** 2 + 
      this.velocity.z ** 2
    );
  }

  /**
   * Reset movement to initial state
   */
  reset() {
    this.startTime = Date.now();
    this.currentPosition = this.getInitialPosition();
    this.velocity = { x: 0, y: 0, z: 0 };
    this._lastDirectionChange = null;
  }

  /**
   * Check if movement has completed (for non-looping types)
   * @returns {boolean}
   */
  isComplete() {
    if (this.config.type === 'linear' && !this.config.linear?.loop) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      return elapsed >= this.config.linear.duration;
    }
    if (this.config.type === 'preset') {
      const waypoints = this.config.preset?.waypoints;
      if (waypoints && waypoints.length > 0) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        return elapsed >= waypoints[waypoints.length - 1].time;
      }
    }
    return false;
  }
}

module.exports = {
  MovementEngine
};
