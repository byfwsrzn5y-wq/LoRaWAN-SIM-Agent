/**
 * LoRaWAN-SIM 自定义 ADR 插件（ChirpStack v4 / QuickJS）
 *
 * 设计目标（相对内置 default 算法）：
 * - 在 SNR 余量明显为正时，用较少上行样本即可抬 DR（默认算法在部分路径上强依赖 20 条历史）。
 * - 在 SNR 余量为负、需要降 DR / 调功率时，仍要求少量连续同 txPowerIndex 样本，避免抖动。
 *
 * Device Profile → ADR algorithm 请选择本插件 id：lorawan_sim_adr_v1
 *
 * 可选设备变量（ChirpStack UI Device variables）覆盖：
 *   adr_step_divisor     默认 3，对应 SNR 余量每 3dB 一步（与内置思路接近）
 *   adr_neg_min_samples  默认 5，负余量时要求的最少上行条数（同当前 txPowerIndex）
 */

export function name() {
  return 'LoRaWAN-SIM ADR (fast ramp)';
}

export function id() {
  return 'lorawan_sim_adr_v1';
}

function numVar(vars, key, def) {
  if (!vars || vars[key] === undefined || vars[key] === null || vars[key] === '') return def;
  const n = Number(vars[key]);
  return Number.isFinite(n) ? n : def;
}

function maxSnrFromHistory(uplinkHistory) {
  if (!uplinkHistory || uplinkHistory.length === 0) return null;
  let m = -999.0;
  for (let i = 0; i < uplinkHistory.length; i++) {
    const v = uplinkHistory[i].maxSnr;
    if (v > m) m = v;
  }
  return m;
}

function countHistorySameTxPower(uplinkHistory, txPowerIndex) {
  if (!uplinkHistory || uplinkHistory.length === 0) return 0;
  let c = 0;
  const tp = txPowerIndex;
  for (let i = 0; i < uplinkHistory.length; i++) {
    if (uplinkHistory[i].txPowerIndex === tp) c += 1;
  }
  return c;
}

/**
 * 与 ChirpStack 内置 default ADR 同结构的步进（见 chirpstack/src/adr/default.rs）
 */
function getIdealTxPowerIndexAndDr(nbStep, txPowerIndex, dr, maxTxPowerIndex, maxDr) {
  let n = nbStep;
  let tp = txPowerIndex;
  let d = dr;
  while (n !== 0) {
    if (n > 0) {
      if (d < maxDr) {
        d += 1;
      } else if (tp < maxTxPowerIndex) {
        tp += 1;
      }
      n -= 1;
    } else {
      tp = tp > 0 ? tp - 1 : 0;
      n += 1;
    }
  }
  return { dr: d, txPowerIndex: tp };
}

export function handle(req) {
  const resp = {
    dr: req.dr,
    txPowerIndex: req.txPowerIndex,
    nbTrans: req.nbTrans,
  };

  if (!req.adr) {
    return resp;
  }

  const minDr = req.minDr;
  let maxDr = req.maxDr;
  const maxTxPowerIndex = req.maxTxPowerIndex;

  if (resp.dr > maxDr) {
    resp.dr = maxDr;
  }

  const vars = req.deviceVariables || {};
  const stepDiv = Math.max(1.0, numVar(vars, 'adr_step_divisor', 3.0));
  const negMinSamples = Math.max(1, Math.floor(numVar(vars, 'adr_neg_min_samples', 5)));

  const hist = req.uplinkHistory || [];
  const snrMax = maxSnrFromHistory(hist);
  if (snrMax === null) {
    return resp;
  }

  const requiredSnr = req.requiredSnrForDr;
  const installM = req.installationMargin;
  const snrMargin = snrMax - requiredSnr - installM;
  // 与内置 Rust 算法一致：向零取整 (trunc)
  const nStepInt = Math.trunc(snrMargin / stepDiv);

  if (nStepInt < 0 && countHistorySameTxPower(hist, req.txPowerIndex) < negMinSamples) {
    return resp;
  }

  const ideal = getIdealTxPowerIndexAndDr(nStepInt, resp.txPowerIndex, resp.dr, maxTxPowerIndex, maxDr);
  let dr = ideal.dr;
  if (dr < minDr) dr = minDr;
  if (dr > maxDr) dr = maxDr;
  let tp = ideal.txPowerIndex;
  if (tp < 0) tp = 0;
  if (tp > maxTxPowerIndex) tp = maxTxPowerIndex;

  resp.dr = dr;
  resp.txPowerIndex = tp;
  return resp;
}
