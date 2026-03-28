# LoRaWAN-SIM UI Wireframe V1

## Wireframe Overview

This is a low-fidelity wireframe definition for V1 implementation.
It covers:

- node and gateway create/edit
- drag and drop layout
- sync status badges
- retry and conflict handling

## Topology Screen (Primary)

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ LoRaWAN-SIM | [Running] [API:OK] [Sync:ON] | +Node +Gateway | Start Stop Reset | Search    │
├───────────────────────────────┬──────────────────────────────────────────────┬──────────────┤
│ LEFT PANEL                    │ CANVAS (TOPOLOGY)                            │ INSPECTOR    │
│                               │                                              │              │
│ Nodes                         │  GW-001 ◉────────────◉ GW-002                │ Selected     │
│ [synced] node-a              │      ╲            ╱                           │ Resource     │
│ [partial] node-b             │       ◉ node-a    ◉ node-b                    │              │
│ [error] node-c               │       ◉ node-c    ◉ node-d                    │ Name         │
│ ...                           │                                              │ DevEUI/ID    │
│                               │ [drag select] [zoom] [fit] [heatmap toggle]  │ Position xyz │
│ Gateways                      │                                              │ Radio params │
│ [synced] gw-001              │                                              │ Sync mode    │
│ [synced] gw-002              │                                              │ Save Retry   │
│ ...                           │                                              │              │
├───────────────────────────────┴──────────────────────────────────────────────┴──────────────┤
│ EVENT TIMELINE: [filter route/code] [error only] [resource id]                              │
│ 15:03 sync-xxx POST /resources/nodes ok                                                      │
│ 15:04 sync-yyy POST /layout/apply conflict_revision                                          │
│ 15:05 sync-zzz POST /sync/retry ok                                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Interaction Blocks

## A) Add Node

Entry:

- header `+Node`
- canvas context menu `Add Node`

Dialog fields:

- `name`
- `devEui`
- `x/y/z`
- `intervalMs`, `txPower`, `adr`
- sync mode selector (`simulator_only` / `sync_both`)

Actions:

- `Create`
- `Cancel`

Result:

- new node appears in list and canvas
- badge updates according to response

## B) Add Gateway

Entry:

- header `+Gateway`
- canvas context menu `Add Gateway`

Dialog fields:

- `name`
- `gatewayId`
- `x/y/z`
- `rxGain`, `rxSensitivity`, `cableLoss`
- sync mode selector

## C) Drag and Drop

Behavior:

- drag single or multi-selected resources
- on drop, submit one batch request
- if conflict, show action bar:
  - `Reload`
  - `Apply Latest`
  - `Dismiss`

## D) Inspector Save

Save path:

- node -> `PATCH /resources/nodes/:devEui`
- gateway -> `PATCH /resources/gateways/:gatewayId`

Footer actions:

- `Save`
- `Retry Sync`

## Status Badge Legend

- `synced` (green)
- `syncing` (blue spinner)
- `local_dirty` (gray)
- `partial_success` (orange)
- `error` (red)

## Edge Cases In Wireframe

- resource missing: inline banner `not_found`
- invalid payload: field-level validation
- orchestrator disabled: top banner `feature_disabled`
- retry queue non-empty: alert chip in header

## Mobile/Small Screen Rule

V1 desktop-first.
For small width:

- left panel collapses to drawer
- inspector becomes bottom sheet
- timeline collapses to tab

## Deliverable Note

This wireframe is intentionally low fidelity and implementation-oriented.
Visual style tokens (spacing, typography, color scale) will be finalized in UI review.
