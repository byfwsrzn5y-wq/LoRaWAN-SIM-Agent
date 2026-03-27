# LoRaWAN-SIM UI Information Architecture (V1)

## Scope

This document defines the first UI design deliverable:

- information architecture
- page regions and component ownership
- critical user flows

The design is aligned with existing control APIs:

- `POST /resources/nodes`
- `PATCH /resources/nodes/:devEui`
- `POST /resources/gateways`
- `PATCH /resources/gateways/:gatewayId`
- `POST /layout/apply`
- `POST /sync/retry`

## Product Navigation Structure

V1 is delivered as a single-shell workspace (no multi-page top navigation).

Primary interaction zones:

1. `Header` (global actions and profile/simulation controls)
2. `LeftPanel` (resource explorer)
3. `CenterCanvas` (topology interaction plane)
4. `RightInspector` (resource editor)
5. `BottomTimeline` (events and diagnostics)

This structure maps directly to `ui/src/App.tsx` and component regions.

## Main Page Layout (Topology)

`Header + LeftPanel + CenterCanvas + RightInspector + BottomTimeline`

### Header (global control strip)

- simulation controls: start / stop / reset
- simulation config save (`PATCH /resources/simulation`)
- environment indicator: API reachability, sync mode, flags
- create entry: add node, add gateway
- profile controls: list/save/load/apply/rename (`/config-profiles/*`)
- save indicator: dirty/syncing/synced

### LeftPanel (resource explorer)

- node tree (group/filter by status)
- gateway list
- search, status filter, conflict badges

### CenterCanvas (topology interaction plane)

- draggable nodes and gateways
- signal/coverage overlays
- multi-select rectangle and move
- edge quality highlights from runtime events

### RightInspector (context editor)

- selected resource details
- node/gateway form sections
- sync controls: simulator_only vs sync_both
- submit and retry actions

### BottomTimeline (events and diagnostics)

- API operation stream
- protocol events (join/uplink/downlink/adr/mac)
- error slices by code

## Domain Objects In UI

## Node

- identity: `name`, `devEui`
- placement: `x/y/z`
- radio: `sf`, `bw`, `frequency`, `txPower`, `intervalMs`, `adr`
- sync status: `local_dirty/syncing/synced/error/partial_success`

## Gateway

- identity: `name`, `gatewayId`
- placement: `x/y/z`
- radio: `rxGain`, `rxSensitivity`, `cableLoss`
- sync status and conflict marker

## LayoutItem

- `id`, `kind`, `position`, `revision`

## Critical User Flows

## Flow 1: Create Node

1. user clicks `Add Node`
2. fills form in inspector
3. chooses sync mode
4. submits to `POST /resources/nodes`
5. sees status badge and event log

Expected end state:

- node appears in left panel and canvas
- sync status updates to `synced` or `partial_success/error`

## Flow 2: Drag Topology

1. user drags one or multiple resources
2. UI updates ghost position during drag
3. on drop, debounced batch call to `POST /layout/apply`
4. revision accepted or conflict shown

Expected end state:

- positions persist
- `layoutRevision` increments

## Flow 3: Edit Resource

1. select node/gateway on canvas or list
2. update fields in inspector
3. submit to `PATCH /resources/...`
4. receive response and update sync badge

## Flow 4: Retry Failed Sync

1. user opens failed resources filter
2. clicks retry on one or many resources
3. UI calls `POST /sync/retry`
4. queue and result states refresh

## Status Badge Semantics

- `Pending` for `local_dirty`
- `Syncing` for request in flight
- `Synced` for successful dual-target apply
- `Partial` for simulator/chirpstack split result
- `Error` for hard failure

## Design Constraints

- no direct UI call to ChirpStack
- all writes go through simulator control API
- no blocking full-page refresh for normal operations
- conflict handling must be explicit and recoverable

## Deliverable Boundary (This Stage)

Included:

- IA and region ownership
- flow definitions
- status semantics

Not included yet:

- visual wireframes
- exact UI component library choices
- final copywriting
