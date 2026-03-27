# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Docs

- Documentation alignment for UI integration:
  - added docs navigation index `docs/README.md`
  - reconciled UI wording across root `README.md`, `PROJECT.md`, `simulator/README.md`, and `ui/README.md`
  - updated UI API/freeze/validation/IA specs to include `/resources/simulation` and `/config-profiles/*` coverage
  - normalized validation environment guidance to `.env`-driven `CHIRPSTACK_API_URL`

## [v1.0.0-rc] - 2026-03-27

### Added

- UI orchestration API on simulator control plane:
  - `POST /resources/nodes`
  - `PATCH /resources/nodes/:devEui`
  - `DELETE /resources/nodes/:devEui`
  - `POST /resources/gateways`
  - `PATCH /resources/gateways/:gatewayId`
  - `DELETE /resources/gateways/:gatewayId`
  - `PATCH /resources/simulation`
  - `POST /layout/apply`
  - `POST /sync/retry`
- In-memory orchestration modules under `simulator/src/orchestrator/`:
  - request validation contracts
  - idempotency key store
  - partial-success retry queue with backoff
  - ChirpStack-first dual-write orchestration service
- Profile management endpoints:
  - `GET /config-profiles`
  - `POST /config-profiles/save`
  - `POST /config-profiles/load`
  - `POST /config-profiles/apply`
  - `POST /config-profiles/rename`
- Backward-compatible profile aliases:
  - `/profile/*`
  - `/profiles/*`
- UI v1 web console (`ui/`) integrated with control plane and topology drag/apply flow.
- Release governance assets:
  - `scripts/release-preflight.mjs`
  - `docs/LORAWAN_SIM_UI_RELEASE_SOP.md`
  - `docs/LORAWAN_SIM_UI_ALERTING_SPEC.md`
  - `docs/LORAWAN_SIM_UI_ROLLBACK_PLAYBOOK.md`
  - `docs/LORAWAN_SIM_UI_RELEASE_MILESTONES.md`
- UI design and freeze artifacts:
  - `docs/LORAWAN_SIM_UI_INFORMATION_ARCHITECTURE.md`
  - `docs/LORAWAN_SIM_UI_WIREFRAME_V1.md`
  - `docs/LORAWAN_SIM_UI_API_BINDING_SPEC.md`
  - `docs/LORAWAN_SIM_UI_V1_FREEZE_CHECKLIST.md`

### Changed

- `README.md` updated with:
  - current delivery status
  - GitHub upload readiness checklist
  - release preparation notes
- `ui/README.md` updated with:
  - profile endpoint usage
  - startup and profile-save troubleshooting
- `PROJECT.md` updated to reflect v1.0.0-rc release-preparation phase.
- Simulator control server 404 help text now includes profile route family.

### Fixed

- Resolved UI `save profile` 404 by aligning runtime process to profile-enabled control API.
- Stabilized Vite startup path by forcing dependency re-optimization when cache mismatch occurs.
- Fixed route mismatch between legacy profile URL usage and new `/config-profiles/*` API.

### Compatibility Notes

- UI profile actions require simulator process with profile routes enabled (latest `simulator/index.js`).
- For strict local UI startup, prefer:
  - `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`
- If React DOM export mismatch appears (`createRoot`), run once with:
  - `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort --force`

### Known Limitations

- Retry queue and idempotency storage are in-memory only in this release candidate.
- `main.js` remains experimental; production path is still `simulator/index.js`.
