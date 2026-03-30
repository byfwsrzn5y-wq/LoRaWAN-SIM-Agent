# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **UI**: Top bar shows resolved profile save directory (`profilesDirResolved` + tooltip with `profileConfig.profilesDir`) from `/sim-state` `config.profileConfig`.
- **UI**: Scenario adds UDP protocol/port selection and auto-aligns UDP forwarding host from `chirpstack.baseUrl`; Node/Gateway/Inspector forms default to `sync_both`.
- **Runtime/UDP**: UDP target host/port can be updated via scenario; changing `udp.protocol` may require simulator restart due to socket family.
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

## [1.0.0] - 2026-03-29

### Published

- **GitHub**: default branch `main` carries the full tree; [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on `main`/`master` push and PRs.
- **License**: root [`LICENSE`](LICENSE) (MIT) for repository detection.
- **Hygiene**: example configs, [`.env.example`](.env.example), docs, and code defaults use **127.0.0.1** / RFC 5737-style placeholders instead of lab-specific hosts and UUIDs; UI scratch profiles `configs/profiles/blank-*.json` are gitignored; tracked `blank-*.json` removed.
- **Repository**: root [`.gitignore`](.gitignore) (`.env`, `.cursor/`, `memory/`, `.openclaw/`, etc.); Git/CI documented in [`README.md`](README.md) and [`docs/README.md`](docs/README.md); `simulator/package.json` `npm test` in CI; `simulator/sim-state.json` untracked (runtime output).

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
