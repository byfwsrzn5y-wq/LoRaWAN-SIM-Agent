# LoRaWAN-SIM UI Release Milestones And Templates

## Milestone Acceptance

## M1: Pre-release Complete

Acceptance criteria:

- `release-preflight` passes
- config validation and dry-run checks pass
- rollback baseline snapshot recorded

Required artifacts:

- Preflight output log
- Gate checks result sheet
- Baseline snapshot (commit/config/env flags)

## M2: Gray Release Complete

Acceptance criteria:

- gray sequence for 4 API flows passes
- `/start|/stop|/status|/reset` no regression
- new API success rate >= 95% in gray window

Required artifacts:

- Gray execution checklist
- API success/error summary
- Incident-free observation notes (30-60 minutes)

## M3: Expanded Scope Complete

Acceptance criteria:

- full regression pack pass in target test application
- retry queue stable and bounded
- no unresolved critical alerts

Required artifacts:

- Regression run report
- Retry queue trend snapshot
- Alert panel export

## M4: Full Rollout Complete

Acceptance criteria:

- 24h stable operation with no P1 incidents
- error ratio and latency within thresholds
- rollback drill verified as executable

Required artifacts:

- Day-1 run report
- SLO/SLA summary
- rollback drill record

## UI v1 Freeze Decision

Freeze objective:

- lock interaction behavior for implementation handoff
- avoid scope drift during frontend/backend integration

Freeze scope (v1 locked):

- page partition: `TopBar`, `LeftPanel`, `Canvas`, `RightPanel`, `BottomPanel`
- core user flows: add node, add gateway, edit resource, drag-and-drop batch apply, sync retry
- sync badge semantics: `Pending`, `Syncing`, `Synced`, `PartiallySynced`, `SyncFailed`
- error handling baseline: `validation`, `conflict_revision`, `partial_success`, `chirpstack_failed`, `simulator_failed`
- API interaction baseline: `/resources/*`, `/layout/apply`, `/sync/retry`

Out of scope for v1 (candidate for v1.1+):

- replay mode and advanced timeline analytics
- advanced heatmap and custom visualization presets
- non-blocking product enhancements that do not affect core release criteria

Change admission after freeze:

- allowed without re-freeze:
  - P0/P1 defect fixes
  - blocking implementation mismatch with existing API contract
  - mandatory compatibility updates caused by backend breaking change
- requires explicit review and sign-off:
  - any new user flow
  - badge semantics changes
  - payload shape changes for `/resources/*`, `/layout/apply`, `/sync/retry`

Review record template:

```markdown
# UI v1 Freeze Record
- Review date:
- Owner:
- Participants:
- Scope reviewed:
  - [ ] page partition
  - [ ] key user flows
  - [ ] badge semantics
  - [ ] API interaction mapping
- Decision: GO / NO-GO
- Exceptions approved:
- Follow-up actions:
```

## Template: Gate Check Sheet

```markdown
# Gate Check Sheet
- Date:
- Release owner:
- Build/commit:
- Env file snapshot id:
- Control port check: PASS/FAIL
- ChirpStack reachability: PASS/FAIL
- Config validate: PASS/FAIL
- Gateway check: PASS/FAIL
- Device dry-run: PASS/FAIL
- Decision: GO / NO-GO
```

## Template: Gray Execution Checklist

```markdown
# Gray Execution Checklist
- Window start:
- Tenant/Application:
- Whitelist resources:
- Step1 simulator_only create: PASS/FAIL
- Step2 sync_both create: PASS/FAIL
- Step3 layout apply: PASS/FAIL
- Step4 sync retry: PASS/FAIL
- Legacy endpoint smoke test: PASS/FAIL
- Observation end:
- Expand decision: YES/NO
```

## Template: Day-1 Run Report

```markdown
# Day-1 Run Report
- Time window:
- Total requests:
- Success rate:
- Error breakdown:
  - validation:
  - chirpstack_failed:
  - simulator_failed:
  - partial_success:
  - conflict_revision:
- Retry queue:
  - max size:
  - dead jobs:
- Runtime stats:
  - joins:
  - uplinks:
  - errors:
- Incidents:
- Follow-up actions:
```
