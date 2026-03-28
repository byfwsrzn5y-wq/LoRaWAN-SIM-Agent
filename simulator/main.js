#!/usr/bin/env node
/**
 * Deprecated entry point. The former v2 modular simulator (movement / environment zones /
 * derived anomalies) is integrated into `index.js` when the config opts in — see
 * `src/runtime/motion-environment.js` and `docs/PROJECT_ANALYSIS.md` §7.1.
 *
 * Use: `node index.js` or repo root `node scripts/lorasim-cli.mjs run`.
 * `--legacy` is accepted for compatibility and behaves the same (loads index.js).
 */

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--legacy')) {
    console.log('[main.js] --legacy: loading index.js (same as default).');
  } else {
    console.warn(
      '[main.js] Deprecated: use `node index.js` or `node scripts/lorasim-cli.mjs run`. Loading index.js…',
    );
  }
}

require('./index.js');
