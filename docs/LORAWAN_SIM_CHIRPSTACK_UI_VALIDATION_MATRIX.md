# LoRaWAN-SIM x ChirpStack Validation Matrix

## Objective

Provide a repeatable validation checklist for functional, sync-consistency, runtime, and non-functional quality before implementation rollout.

## Test Environments

- simulator host: local workspace runtime
- ChirpStack API: `.env` -> `CHIRPSTACK_API_URL` (example: `http://127.0.0.1:8090`)
- region baseline: `AS923`
- UDP baseline: `1702`

## Functional Matrix

| ID | Scenario | Precondition | Steps | Expected |
| --- | --- | --- | --- | --- |
| F-01 | Create node (sync both) | valid tenant/app/profile | submit node form | node created in UI + simulator + ChirpStack |
| F-02 | Create gateway (sync both) | valid tenant | submit gateway form | gateway appears in all targets |
| F-03 | Edit node radio params | existing node | change SF/interval and save | simulator runtime reflects new params |
| F-04 | Edit gateway radio params | existing gateway | update rxGain/sensitivity | coverage recalculation reflected |
| F-05 | Delete node simulator only | existing node | delete with `scope=simulator_only` | ChirpStack device remains |
| F-06 | Delete node both | existing node | delete with `scope=both` | both targets remove node |
| F-07 | Batch drag nodes | >=2 nodes | drag and drop and release | one layout batch apply call, all positions persisted |
| F-08 | Drag gateway | existing gateway | move gateway and release | topology and heatmap update |
| F-09 | Update simulation settings | simulator running | save simulation form in top bar | simulation update succeeds and runtime reflects config |
| F-10 | Save/load/apply profile | profile API enabled | save profile then load/apply | UI state and simulator config align to selected profile |

## Sync Consistency Matrix

| ID | Scenario | Injection | Expected |
| --- | --- | --- | --- |
| S-01 | ChirpStack create fails | invalid token | return `chirpstack_failed`, simulator unchanged |
| S-02 | Simulator apply fails | stop simulator control API | return `partial_success`, retry job enqueued |
| S-03 | Retry resolves partial success | restore simulator API | `/sync/retry` leads to `synced` |
| S-04 | Duplicate submit | same `Idempotency-Key` twice | single resource creation, same response replay |
| S-05 | Revision conflict | stale layout revision | return `conflict_revision`, UI asks overwrite/reload |
| S-06 | External drift | edit ChirpStack directly | drift detected and conflict prompt shown |
| S-07 | Profile route unavailable | old simulator process, call profile action | actionable 404 hint and recovery guidance shown |

## Runtime/Protocol Matrix

| ID | Scenario | Expected |
| --- | --- | --- |
| R-01 | OTAA join after node creation | join event observed and node joined state true |
| R-02 | uplink after interval update | interval change visible in packet cadence |
| R-03 | downlink/mac path | command/down reaches simulator and mac status updates |
| R-04 | multi-gateway receive | same uplink can be observed by multiple gateways |
| R-05 | ADR update | SF/TxPower updates reflected in UI badges/events |

## Non-Functional Matrix

| ID | Metric | Target |
| --- | --- | --- |
| N-01 | Drag preview frame rate | >= 50 FPS on target machine |
| N-02 | Layout apply latency | p95 < 500ms |
| N-03 | Create/update API latency | p95 < 1.2s (excluding retries) |
| N-04 | Sync status freshness | event propagation < 300ms median |
| N-05 | Retry reliability | >= 99% recovery for transient errors within max attempts |
| N-06 | Audit completeness | 100% mutating operations with correlationId |

## Regression Pack

Run this set after any orchestrator or UI sync logic change:

1. F-01, F-02, F-07
2. S-01, S-02, S-04
3. R-01, R-03
4. N-02 spot check

## Exit Criteria

Release candidate can move forward only if:

- no critical failures in F/S/R matrices
- non-functional targets N-02/N-03/N-06 are met
- no unresolved `partial_success` jobs older than 24h

## Evidence Artifacts

Required artifacts per run:

- API response logs with correlation IDs
- simulator `sim-state.json` snapshots before/after
- ChirpStack resource screenshots or exported list
- run report linking failed cases to issue IDs
