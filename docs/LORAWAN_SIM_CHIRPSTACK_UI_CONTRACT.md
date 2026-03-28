# LoRaWAN-SIM x ChirpStack UI Contract

## Scope

This contract defines the API and data model for:

- node and gateway create/update/delete
- drag-and-drop layout apply
- synchronization status and retry

The orchestration layer is the single write entrypoint from UI. UI must not call ChirpStack directly.

## Resource Model

### Node

```json
{
  "id": "18d3bf0000000001",
  "type": "node",
  "name": "sim-node-001",
  "enabled": true,
  "region": "AS923",
  "activation": "OTAA",
  "position": { "x": 700, "y": 446, "z": 2 },
  "radio": {
    "sf": 7,
    "bw": 125,
    "frequency": 923200000,
    "txPower": 14,
    "intervalMs": 10000,
    "adr": true
  },
  "chirpstack": {
    "tenantId": "uuid",
    "applicationId": "uuid",
    "deviceProfileId": "uuid",
    "devEui": "18d3bf0000000001",
    "appKeyRef": "env://CHIRPSTACK_APP_KEY_DEFAULT"
  },
  "syncStatus": {
    "state": "synced",
    "targets": ["chirpstack", "simulator"],
    "lastError": null,
    "updatedAt": "2026-03-26T15:00:00.000Z"
  }
}
```

### Gateway

```json
{
  "id": "19023c6b00000000",
  "type": "gateway",
  "name": "gw-apex-sw",
  "enabled": true,
  "region": "AS923",
  "position": { "x": 100, "y": 100, "z": 30 },
  "radio": {
    "rxGain": 5,
    "rxSensitivity": -137,
    "cableLoss": 0.5
  },
  "chirpstack": {
    "tenantId": "uuid",
    "gatewayId": "19023c6b00000000"
  },
  "syncStatus": {
    "state": "synced",
    "targets": ["chirpstack", "simulator"],
    "lastError": null,
    "updatedAt": "2026-03-26T15:00:00.000Z"
  }
}
```

### LayoutItem

```json
{
  "id": "18d3bf0000000001",
  "kind": "node",
  "position": { "x": 760, "y": 520, "z": 2 },
  "revision": 12
}
```

### SyncStatus

```json
{
  "state": "local_dirty",
  "targets": ["chirpstack", "simulator"],
  "lastError": {
    "code": "simulator_failed",
    "message": "PATCH /node failed",
    "retryable": true
  },
  "updatedAt": "2026-03-26T15:00:00.000Z"
}
```

Allowed `state` values:

- `local_dirty`
- `syncing`
- `synced`
- `error`
- `partial_success`

## API Contract

Logical API prefix in documentation is `/api/v1`. The **running simulator control HTTP server** exposes these routes at the **root of the control port** (for example `http://127.0.0.1:9999/resources/nodes`), not under a literal `/api/v1` path. A reverse proxy or future gateway may mount the same handlers under `/api/v1`.

### GET `/sim-state`

Read-only snapshot of the current `simState` object (same shape as `simulator/sim-state.json`), including `nodes`, `gateways`, `layoutRevision`, and `running`. Used by the browser UI for initial load and polling.

### POST `/resources/nodes`

Creates a node in ChirpStack and simulator (default).

Request:

```json
{
  "mode": "sync_both",
  "node": {
    "name": "sim-node-006",
    "devEui": "18d3bf0000000006",
    "region": "AS923",
    "activation": "OTAA",
    "position": { "x": 400, "y": 300, "z": 2 },
    "radio": { "sf": 10, "bw": 125, "frequency": 923200000, "txPower": 14, "intervalMs": 15000, "adr": true },
    "chirpstack": { "tenantId": "uuid", "applicationId": "uuid", "deviceProfileId": "uuid", "appKey": "hex32" }
  }
}
```

### PATCH `/resources/nodes/{devEui}`

Partially updates node runtime and resource settings.

### DELETE `/resources/nodes/{devEui}`

Supports:

- `scope=simulator_only`
- `scope=both`

### POST `/resources/gateways`

Creates a gateway in ChirpStack and simulator.

### PATCH `/resources/gateways/{gatewayId}`

Updates gateway metadata and simulator radio parameters.

### DELETE `/resources/gateways/{gatewayId}`

Supports:

- `scope=simulator_only`
- `scope=both`

### POST `/layout/apply`

Batch position update after drag operation.

Request:

```json
{
  "revision": 102,
  "items": [
    { "id": "18d3bf0000000001", "kind": "node", "position": { "x": 750, "y": 520, "z": 2 }, "revision": 13 },
    { "id": "19023c6b00000000", "kind": "gateway", "position": { "x": 130, "y": 120, "z": 30 }, "revision": 8 }
  ]
}
```

### POST `/sync/retry`

Retries failed sync items by id.

Request:

```json
{
  "resourceIds": ["18d3bf0000000001", "19023c6b00000000"]
}
```

## Error Model

Standard error payload:

```json
{
  "error": {
    "code": "chirpstack_failed",
    "message": "Device create failed",
    "retryable": true,
    "correlationId": "sync-20260326-000123",
    "details": { "status": 409 }
  }
}
```

Error codes:

- `validation`
- `chirpstack_failed`
- `simulator_failed`
- `partial_success`
- `conflict_revision`
- `not_found`

## UI API Interaction Mapping v1

| UI action | Trigger point | API | Key request fields | Success write-back | Failure write-back | Badge transition | Retry strategy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Add node | `LeftPanel/AddNode` then `RightPanel/Save` | `POST /resources/nodes` | `mode`, `node.name`, `node.devEui`, `node.position`, `node.radio.*`, `node.chirpstack.*` | Add row in Nodes list, render on canvas, persist `syncStatus.updatedAt` | Show inline form error for `validation`; show side-panel error for sync failures | `local_dirty -> syncing -> synced` | For `retryable=true`: expose retry CTA and allow manual call to `/sync/retry` |
| Edit node | `RightPanel/Save` on selected node | `PATCH /resources/nodes/{devEui}` | partial patch fields (`position`, `radio`, `enabled`, `name`) | Merge server response to local cache and refresh details panel | Show field-level error on `validation`; keep draft for `chirpstack_failed` or `simulator_failed` | `local_dirty -> syncing -> synced/partial_success/error` | Keep retry CTA visible until resolved |
| Add gateway | `LeftPanel/AddGateway` then `RightPanel/Save` | `POST /resources/gateways` | `mode`, `gateway.name`, `gateway.gatewayId`, `gateway.position`, `gateway.radio.*`, `gateway.chirpstack.tenantId` | Add row in Gateways list and render gateway icon on canvas | Same pattern as node create | `local_dirty -> syncing -> synced` | Same as node create |
| Edit gateway | `RightPanel/Save` on selected gateway | `PATCH /resources/gateways/{gatewayId}` | partial patch fields (`position`, `radio`, `enabled`, `name`) | Refresh gateway list row and selected detail panel | Show blocking error in side panel when patch fails | `local_dirty -> syncing -> synced/partial_success/error` | Manual retry through `/sync/retry` using `gatewayId` |
| Drag layout batch apply | `Canvas/DragEnd` after 300ms debounce | `POST /layout/apply` | `revision`, `items[].id`, `items[].kind`, `items[].position`, `items[].revision` | Update local positions and clear dirty markers for moved items | On `conflict_revision`, show conflict prompt (`ReloadRemote` default for layout) | `local_dirty -> syncing -> synced/error` | On conflict, reload remote snapshot then re-apply; on retryable error allow `/sync/retry` |
| Retry failed sync | `BottomPanel/Retry` or `RightPanel/Retry` | `POST /sync/retry` | `resourceIds[]` | Update each resource `syncStatus` and clear last error when synced | Keep unresolved items in retry queue, surface `lastError.message` | `error/partial_success -> syncing -> synced or error` | Supports single and batch retry; exponential backoff is handled server-side |

Error-code UX mapping:

- `validation`: field-level message, do not leave editor context
- `conflict_revision`: conflict dialog with `OverwriteRemote`, `ReloadRemote`, `CompareAndMerge`
- `partial_success`: non-blocking toast + keep retry CTA
- `chirpstack_failed` / `simulator_failed`: preserve draft and show retryable status from payload

## Field Mapping

### UI -> Simulator

- `node.position` -> `devices[].position`
- `gateway.position` -> `multiGateway.gateways[].position`
- `node.radio.intervalMs` -> `device uplink interval`
- `gateway.radio.*` -> `multiGateway.gateways[].rxGain/rxSensitivity/cableLoss`

### UI -> ChirpStack

- `node.devEui` -> device `dev_eui`
- `node.name` -> device `name`
- `applicationId/deviceProfileId` -> device relation
- `gateway.id` -> gateway `gateway_id`
- `gateway.name` -> gateway `name`

## Existing Project Anchors

- runtime config: `simulator/config.json`
- gateway sync script: `scripts/chirpstack-ensure-gateways-from-config.mjs`
- otaa sync script: `scripts/chirpstack-provision-otaa-from-config.mjs`
