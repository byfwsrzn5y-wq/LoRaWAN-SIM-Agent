/**
 * State Manager Module
 * Simulation state export for local debugging/tools
 */

const fs = require('fs');
const path = require('path');

/** Default state file is `simulator/sim-state.json`, not process.cwd(). */
function defaultStateFile() {
  return path.join(__dirname, '..', '..', 'sim-state.json');
}

class StateManager {
  constructor(stateFilePath) {
    this.stateFile = stateFilePath || defaultStateFile();
    this.state = {
      running: false,
      gateways: [],
      nodes: [],
      config: {},
      stats: { uplinks: 0, joins: 0, errors: 0 },
      lastUpdate: null
    };
    this.intervalId = null;
  }

  update(updates) {
    Object.assign(this.state, updates);
    this.state.lastUpdate = new Date().toISOString();
  }

  write() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) {
      // Ignore write errors
    }
  }

  startExporter(intervalMs = 1000) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.write();
    }, intervalMs);
  }

  stopExporter() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  incrementStat(key, value = 1) {
    if (this.state.stats[key] !== undefined) {
      this.state.stats[key] += value;
    }
  }

  setGateways(gateways) {
    this.state.gateways = gateways;
  }

  setNodes(nodes) {
    this.state.nodes = nodes;
  }

  getState() {
    return { ...this.state };
  }
}

module.exports = { StateManager };
