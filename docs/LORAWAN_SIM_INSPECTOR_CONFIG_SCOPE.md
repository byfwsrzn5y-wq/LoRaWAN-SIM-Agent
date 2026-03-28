# LoRaWAN-SIM Inspector Config Scope

This document describes which simulator fields can be edited in UI Inspector and whether changes apply immediately.

## Node Fields

- Identity and keys:
  - `devEui` (create only)
  - `appKey` (optional)
  - `joinEui` / `appEui` (optional)
  - `nwkKey` (optional)
- Radio:
  - `intervalMs`
  - `sf` (`dataRate` in `config.devices`)
  - `txPower`
  - `adr`
  - `fPort`
- Uplink:
  - `uplink.codec` (`simple` or `custom`)
  - `uplink.payload`
  - `uplink.payloadFormat` (`hex` or `base64`)
- Behavior:
  - `adrReject`
  - `devStatus`
  - `duplicateFirstData`
- Anomaly:
  - `anomaly` JSON
- Node state:
  - fixed: `rssi`, `snr`, `txPowerIndex`
  - random: `{ random: true }`
  - full JSON mode

## Gateway Fields

- `name`
- `position` (`x`, `y`, `z`)
- `rxGain`
- `rxSensitivity`
- `cableLoss`
- `noiseFloor`

## Scenario Fields

- `multiGateway.mode`
- `multiGateway.primaryGateway`
- `signalModel.txPower`
- `signalModel.txGain`
- `signalModel.environment`
- `signalModel.shadowFadingStd`
- `signalModel.fastFadingEnabled`

## Runtime Behavior

- Config is persisted through orchestrator `persistConfig`.
- Layout position changes apply to runtime immediately.
- Most device behavior fields are read during device initialization; for deterministic behavior after changing node-level behavior fields, restart simulation (`POST /start` after stop) is recommended.
- Scenario/global signal model changes affect reception calculation logic on subsequent packets.

## Compatibility Notes

- UI writes primarily to flat `config.devices[]` fields.
- Legacy nested `lorawan`/`uplink` structures are still recognized by simulator.
- Mixed flat and nested configuration can coexist; simulator prefers explicit per-device fields where available.
