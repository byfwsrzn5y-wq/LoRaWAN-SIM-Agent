# LoRaWAN-SIM UI API Binding Spec

## Purpose

Define exact mapping between UI actions and backend endpoints for V1 implementation.

Base URL:

- `http://127.0.0.1:9999`

Common headers:

- `Content-Type: application/json`
- `Idempotency-Key: <unique-key-per-action>`

Common response shape:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "correlationId": "sync-..."
}
```

## Action Mapping Table

| UI Action | Method + Path | Request Source | Success Handling | Failure Handling |
| --- | --- | --- | --- | --- |
| Create Node | `POST /resources/nodes` | Add Node dialog submit | add resource to list/canvas; badge=Synced | show inline error, badge=Error/Partial |
| Update Node | `PATCH /resources/nodes/:devEui` | Inspector Save | update fields and badge | keep dirty state + retry CTA |
| Create Gateway | `POST /resources/gateways` | Add Gateway dialog submit | add gateway to list/canvas | show inline error |
| Update Gateway | `PATCH /resources/gateways/:gatewayId` | Inspector Save | update fields and badge | keep dirty state + retry CTA |
| Update Simulation | `PATCH /resources/simulation` | TopBar simulation form save | update simulation config snapshot | keep dirty state + error banner |
| Drag Apply | `POST /layout/apply` | Drag drop debounce | commit new positions and revision | conflict banner and rollback/reload options |
| Retry Sync | `POST /sync/retry` | Retry button/header alert chip | refresh badge and queue indicators | keep in retry queue, show reason |
| List Profiles | `GET /config-profiles` | TopBar profile selector open/refresh | render profile options | show profile load error |
| Save Profile | `POST /config-profiles/save` | TopBar save profile action | profile appears in selector | keep unsaved state + error toast |
| Load Profile | `POST /config-profiles/load` | TopBar load profile action | form/canvas values refreshed | keep previous snapshot + error toast |
| Apply Profile | `POST /config-profiles/apply` | TopBar apply profile action | simulator config and view sync | show apply failure and retry hint |
| Rename Profile | `POST /config-profiles/rename` | TopBar rename profile action | selector label updated | keep old label + error toast |
| Save Scenario（含 ChirpStack 拓扑） | `PATCH /resources/simulation` | Scenario 表单：除 `signalModel`/`multiGateway` 外可合并 `simulation.chirpstack`（`topologyEnabled`、`inventoryPollSec`、`applicationIds`、`integrationMqtt` 等） | 配置持久化；拓扑需 token 与合法 ID | 校验失败或 500 时记录日志 |
| Refresh ChirpStack inventory | `POST /chirpstack/refresh-inventory`（或 `/topology/refresh-inventory`） | 左栏「刷新」 | `GET /sim-state` 中 `chirpstackInventory` 更新 | 显示 REST 错误于左栏 |
| Poll sim state（拓扑） | `GET /sim-state` | React Query 定时拉取 | 列表/画布显示合并后的 `nodes`/`gateways`、`topologyDisplayEnabled` | 与模拟器断连时现有错误条 |

## Endpoint Request Contracts (UI-facing)

## 1) Create Node

```json
{
  "mode": "sync_both",
  "node": {
    "name": "ui-node-001",
    "devEui": "18d3bf00000000d1",
    "position": { "x": 420, "y": 520, "z": 2 },
    "radio": { "intervalMs": 8000, "adr": true, "txPower": 14 },
    "chirpstack": {
      "tenantId": "81d48efb-6216-4c7f-8c21-46a5eac9d737",
      "applicationId": "540a999c-9eeb-4c5c-bed1-778dacddaf46",
      "deviceProfileId": "a1b2c3d4-1111-2222-3333-444444444444",
      "appKey": "00112233445566778899AABBCCDDEEFF"
    }
  }
}
```

## 2) Update Node

```json
{
  "mode": "sync_both",
  "node": {
    "name": "ui-node-001-updated",
    "position": { "x": 460, "y": 560, "z": 2 },
    "radio": { "intervalMs": 6000, "adr": true, "txPower": 16 },
    "chirpstack": {
      "tenantId": "81d48efb-6216-4c7f-8c21-46a5eac9d737",
      "applicationId": "540a999c-9eeb-4c5c-bed1-778dacddaf46",
      "deviceProfileId": "a1b2c3d4-1111-2222-3333-444444444444",
      "appKey": "00112233445566778899AABBCCDDEEFF"
    }
  }
}
```

## 3) Create Gateway

```json
{
  "mode": "sync_both",
  "gateway": {
    "name": "ui-gateway-001",
    "gatewayId": "19023c6b00000011",
    "position": { "x": 300, "y": 120, "z": 30 },
    "radio": { "rxGain": 5, "rxSensitivity": -137, "cableLoss": 0.5 },
    "chirpstack": { "tenantId": "81d48efb-6216-4c7f-8c21-46a5eac9d737" }
  }
}
```

## 4) Update Gateway

```json
{
  "mode": "sync_both",
  "gateway": {
    "name": "ui-gateway-001-updated",
    "position": { "x": 360, "y": 160, "z": 30 },
    "radio": { "rxGain": 6, "rxSensitivity": -136, "cableLoss": 0.5 },
    "chirpstack": { "tenantId": "81d48efb-6216-4c7f-8c21-46a5eac9d737" }
  }
}
```

## 5) Layout Apply

```json
{
  "revision": 2,
  "items": [
    { "id": "18d3bf00000000d1", "kind": "node", "position": { "x": 500, "y": 620, "z": 2 }, "revision": 1 },
    { "id": "19023c6b00000011", "kind": "gateway", "position": { "x": 380, "y": 190, "z": 30 }, "revision": 1 }
  ]
}
```

## 6) Retry Sync

```json
{
  "resourceIds": ["18d3bf00000000d1", "19023c6b00000011"]
}
```

## 7) Update Simulation

```json
{
  "mode": "simulator_only",
  "simulation": {
    "region": "AS923",
    "tickMs": 1000,
    "uplinkIntervalMs": 8000
  }
}
```

## 8) Profile APIs

```json
// GET /config-profiles
{
  "ok": true,
  "profiles": ["default", "lab-as923", "demo-7node3gw"]
}
```

```json
// POST /config-profiles/save
{
  "name": "lab-as923"
}
```

```json
// POST /config-profiles/load
{
  "name": "lab-as923"
}
```

```json
// POST /config-profiles/apply
{
  "name": "lab-as923"
}
```

```json
// POST /config-profiles/rename
{
  "from": "lab-as923",
  "to": "lab-as923-v2"
}
```

## Error To UI Behavior Mapping

| `error.code` | UI Behavior |
| --- | --- |
| `validation` | highlight invalid fields and keep dialog open |
| `chirpstack_failed` | show toast + inspector error + retry option |
| `simulator_failed` | mark resource as partial/error and retry option |
| `partial_success` | orange badge + show retry CTA |
| `conflict_revision` | show conflict banner with reload/apply latest actions |
| `feature_disabled` | top banner, disable write buttons |

## Idempotency Key Rule

Format recommendation:

- `ui-<action>-<resourceId>-<timestamp>-<random>`

Examples:

- `ui-create-node-18d3bf00000000d1-1770000000-ab12`
- `ui-layout-apply-1770000001-cd34`

## Client State Update Rule

UI store should update in this order:

1. optimistic local change -> `local_dirty`
2. request sent -> `syncing`
3. response:
   - `ok=true` -> `synced`
   - `error=partial_success` -> `partial_success`
   - other error -> `error`

## Polling / Refresh Strategy

- no polling for normal writes
- refresh on:
  - write response
  - explicit retry result
  - manual refresh action
- optional reconcile from `sim-state.json` every 30-60s in debug mode
