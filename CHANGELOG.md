# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Repository

- Root [`.gitignore`](.gitignore): ignore `.cursor/` local IDE settings; keep `.env` / `memory/` / `.openclaw/` exclusions documented in README.
- Docs: Git/CI workflow in root [`README.md`](README.md) (section「Git 与持续集成」); [`docs/README.md`](docs/README.md) index table for `.github/workflows/ci.yml` and ignore rules.
- `simulator/package.json`: add `npm test` (`tests/orchestrator.test.js`, `tests/chirpstack-rxinfo.test.js`); [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs it after root smoke steps (matches README pre-push checklist).

### Changed

- **UI**: Top bar shows resolved profile save directory (`profilesDirResolved` + tooltip with `profileConfig.profilesDir`) from `/sim-state` `config.profileConfig`.
- **Profile directory cleanup**: UI snapshots live under `simulator/configs/profiles/` only; moved `default.json` out of removed `simulator/configs/configs/profiles/`. `index.js` default profile path now uses sibling `profiles/` when the main config file sits in `simulator/configs/`. `example-extends-chirpstack.json` uses `"profileConfig.profilesDir": "profiles"`.
- **Merge v2 motion/environment/derived anomalies into `index.js`**: new [`simulator/src/runtime/motion-environment.js`](simulator/src/runtime/motion-environment.js) wires `MovementEngine`, `EnvironmentManager`, and `DerivedAnomalyEngine` on the uplink path when config opts in (`environment` zones/events, `devices[].movement`, `derivedAnomalies`, or `v2DerivedAnomalies: true`). [`simulator/main.js`](simulator/main.js) is deprecated and only loads `index.js`. Hot-add can register `movement` when runtime is already active. Docs: [`docs/PROJECT_ANALYSIS.md`](docs/PROJECT_ANALYSIS.md) §7.1, [`PROJECT.md`](PROJECT.md), [`simulator/README.md`](simulator/README.md).

### Docs

- Documentation alignment for UI integration:
  - added docs navigation index `docs/README.md`
  - reconciled UI wording across root `README.md`, `PROJECT.md`, `simulator/README.md`, and `ui/README.md`
  - updated UI API/freeze/validation/IA specs to include `/resources/simulation` and `/config-profiles/*` coverage
  - normalized validation environment guidance to `.env`-driven `CHIRPSTACK_API_URL`
- Maintainability pass: merged `PROJECT_GOALS_REVIEW.md` into `PROJECT.md` (北极星与交付边界); expanded `docs/README.md` with CONFIG_MAP, state machine, anomaly cross-links; fixed `simulator/docs/PROJECT_GOALS.md` doc index link; removed stale “UI removed” wording in `PROJECT_ANALYSIS.md`.
- `simulator/docs/使用指南.md`: de-duplicated CLI blocks in favor of root `README.md` + `simulator/README.md`; kept ChirpStack checklist and config tables; fixed `docs/README.md` link target; aligned Node guidance with `PROJECT.md`.

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
- `main.js` is deprecated and forwards to `simulator/index.js`; use `index.js` or `lorasim-cli.mjs run`.
