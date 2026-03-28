# LoRaWAN-SIM UI Rollback Playbook

## Trigger Conditions

Execute rollback when one of these occurs:

- repeated `chirpstack_failed` alerts
- sustained `partial_success` ratio > threshold
- control endpoint unstable (`/status` unavailable)
- unsafe retry queue growth or dead jobs

## Level 1: Feature Rollback (Preferred)

1. Set environment flags:
   - `ENABLE_ORCHESTRATOR_API=false`
   - keep `ENABLE_CHIRPSTACK_SYNC` unchanged
2. Restart simulator process.
3. Validate legacy control endpoints:
   - `GET /status`
   - `POST /start`, `POST /stop`, `POST /reset`
4. Confirm no calls are accepted on `/resources/*`, `/layout/apply`, `/sync/retry`.

Expected result:

- old control plane remains operational
- new orchestration APIs are disabled safely

## Level 2: Version Rollback

1. Checkout frozen baseline commit.
2. Restore `simulator/config.json` from release snapshot.
3. Restore `.env` release snapshot.
4. Restart simulator.
5. Re-run preflight:
   - `node scripts/release-preflight.mjs --env-file .env --control-port 9999`

## Level 3: Data Reconciliation

After any rollback, run reconciliation to address drift:

1. Compare simulator node/gateway inventory with ChirpStack resources.
2. Identify resources created during failed window.
3. For each drift item, decide:
   - keep in ChirpStack and re-sync simulator later
   - remove from ChirpStack and keep simulator baseline
4. Record reconciliation decisions in change log.

## Retry Queue Handling

During rollback:

- stop consuming retry queue
- snapshot pending jobs
- optionally clear queue to avoid replay on old version

After stabilization:

- selectively replay only validated jobs

## Verification Checklist

- legacy endpoints healthy
- simulator running with expected stats updates
- no new orchestrator writes accepted when disabled
- alert levels return below threshold

## Communication Template

- Incident start time
- Trigger metric and threshold breached
- Rollback level executed (L1/L2/L3)
- Current status
- Next validation checkpoint time
