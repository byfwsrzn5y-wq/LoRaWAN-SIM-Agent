# LoRaWAN-SIM UI V1 Freeze Checklist

## Purpose

Use this checklist to approve UI V1 scope and freeze interaction design before development.

## A. Scope Freeze

- [x] V1 includes only:
  - [x] node create/update
  - [x] gateway create/update
  - [x] simulation config update
  - [x] topology drag + layout apply
  - [x] sync retry
  - [x] config profile list/save/load/apply/rename
  - [x] status badges and conflict prompt
- [x] Out-of-scope items are deferred:
  - [x] advanced analytics
  - [x] full replay mode
  - [x] mobile-first redesign

## B. IA And Wireframe Review

- [x] IA document reviewed: `docs/LORAWAN_SIM_UI_INFORMATION_ARCHITECTURE.md`
- [x] Wireframe v1 reviewed: `docs/LORAWAN_SIM_UI_WIREFRAME_V1.md`
- [x] Main layout accepted:
  - [x] header controls
  - [x] left resource panel
  - [x] center topology canvas
  - [x] right inspector
  - [x] bottom timeline

## C. API Binding Review

- [x] API mapping document reviewed: `docs/LORAWAN_SIM_UI_API_BINDING_SPEC.md`
- [x] Endpoint coverage accepted:
  - [x] `POST /resources/nodes`
  - [x] `PATCH /resources/nodes/:devEui`
  - [x] `POST /resources/gateways`
  - [x] `PATCH /resources/gateways/:gatewayId`
  - [x] `PATCH /resources/simulation`
  - [x] `POST /layout/apply`
  - [x] `POST /sync/retry`
  - [x] `GET /config-profiles`
  - [x] `POST /config-profiles/save`
  - [x] `POST /config-profiles/load`
  - [x] `POST /config-profiles/apply`
  - [x] `POST /config-profiles/rename`
- [x] Error-code handling accepted:
  - [x] `validation`
  - [x] `chirpstack_failed`
  - [x] `simulator_failed`
  - [x] `partial_success`
  - [x] `conflict_revision`
  - [x] `feature_disabled`

## D. Interaction Rules Freeze

- [x] Drag behavior:
  - [x] local preview during drag
  - [x] debounced batch apply on drop
  - [x] revision conflict prompt on mismatch
- [x] Save behavior:
  - [x] optimistic state `local_dirty`
  - [x] request state `syncing`
  - [x] result state `synced/partial/error`
- [x] Retry behavior:
  - [x] per-resource retry
  - [x] retry queue status visible

## E. Environment And Flags

- [x] runtime flags confirmed:
  - [x] `ENABLE_ORCHESTRATOR_API`
  - [x] `ENABLE_CHIRPSTACK_SYNC`
- [x] ChirpStack target values validated:
  - [x] `CHIRPSTACK_API_URL`
  - [x] `CHIRPSTACK_TENANT_ID`
  - [x] `CHIRPSTACK_APPLICATION_ID`
  - [x] `CHIRPSTACK_DEVICE_PROFILE_ID`

## F. Test Entry Criteria

- [x] M3 regression baseline is green
- [x] legacy endpoints regression is green
- [x] preflight check script is green
- [x] no blocking design issue open

## G. Freeze Decision

- [x] Decision: `APPROVED`
- [ ] Decision: `APPROVED_WITH_NOTES`
- [ ] Decision: `REJECTED`

## Sign-off

- Product owner: @natsuifufei
- UI/UX reviewer: internal review done
- Backend reviewer: simulator/orchestrator owner
- QA reviewer: regression checklist owner
- Date: 2026-03-27
- Notes: V1 interaction frozen and moved into implementation/verification flow.
