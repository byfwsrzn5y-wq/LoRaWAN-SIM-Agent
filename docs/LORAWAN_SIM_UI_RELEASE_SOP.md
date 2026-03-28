# LoRaWAN-SIM UI Release SOP

## Purpose

Operational checklist for releasing UI orchestration APIs safely with gray rollout and hard gates.

## Feature Flags

- `ENABLE_ORCHESTRATOR_API=true|false`
- `ENABLE_CHIRPSTACK_SYNC=true|false`

Defaults:

- pre-release validation: both `true`
- emergency rollback: `ENABLE_ORCHESTRATOR_API=false`

## Stage A: Pre-release Gates (T-2 to T-1)

1. Freeze release baseline:
   - `simulator/index.js`
   - `simulator/src/orchestrator/*`
   - `simulator/config.json`
2. Run preflight checks:
   - `node scripts/release-preflight.mjs --env-file .env --control-port 9999`
3. Run simulator config validation:
   - `node scripts/lorasim-cli.mjs validate -c simulator/config.json -p multigw`
4. Run ChirpStack alignment checks:
   - `node scripts/lorasim-cli.mjs cs-gw-check -c simulator/config.json --env-file .env`
   - `node scripts/lorasim-cli.mjs cs-dev-dry -c simulator/config.json --env-file .env`
5. Store rollback baseline:
   - git commit hash
   - `.env` flag values snapshot
   - config checksum

## Stage B: Gray Release (T0)

1. Enable flags:
   - `ENABLE_ORCHESTRATOR_API=true`
   - `ENABLE_CHIRPSTACK_SYNC=true`
2. Restrict scope:
   - one test tenant
   - one test application
   - whitelist DevEUI/GatewayEUI only
3. Gray verification sequence:
   - `POST /resources/nodes` (`mode=simulator_only`)
   - `POST /resources/nodes` (`mode=sync_both`)
   - `POST /layout/apply`
   - `POST /sync/retry`
4. Observe metrics for 30-60 minutes.

## Stage C: Expand (T0+1)

1. Expand traffic to full testing application.
2. Run regression pack:
   - create/update/drag/conflict/retry
   - old endpoints `/start /stop /status /reset`
3. Confirm no sustained alert threshold breaches.

## Stage D: Full Rollout (T0+2)

1. Remove whitelist gating.
2. Keep flags enabled.
3. Publish day-1 report.

## Blocker Conditions

Stop rollout immediately if any are true:

- `chirpstack_failed` > 5 in 5 minutes
- `partial_success` ratio > 5% for 10 minutes
- `/status` unavailable > 1 minute
- retry queue keeps growing for 15 minutes

## Emergency Rollback

1. Set `ENABLE_ORCHESTRATOR_API=false`.
2. Restart simulator process.
3. Validate `/status` and legacy endpoints.
4. Execute rollback playbook in `docs/LORAWAN_SIM_UI_ROLLBACK_PLAYBOOK.md`.
