# LoRaWAN-SIM UI Observability And Alerting

## Metrics

### API Layer

- `request_total{route,method,code}`
- `request_latency_ms{route,quantile=p50|p95|p99}`
- `error_total{code}`

Error code labels:

- `validation`
- `chirpstack_failed`
- `simulator_failed`
- `partial_success`
- `conflict_revision`
- `feature_disabled`

### Sync Layer

- `sync_success_total`
- `sync_partial_success_total`
- `retry_queue_size`
- `retry_dead_total`
- `retry_attempt_total`

### Runtime Layer

- `sim_state_uplinks`
- `sim_state_joins`
- `sim_state_errors`
- `control_api_up` (`/status` health)

## Alert Rules

### Critical

- `control_api_up == 0` for 60s
- `retry_dead_total > 0` in 10m window

### High

- `error_total{code="chirpstack_failed"} > 5` in 5m
- `sync_partial_success_total / request_total{route=~"/resources/.*"} > 0.05` over 10m

### Medium

- `retry_queue_size` monotonic increase for 15m
- `request_latency_ms{quantile="p95"} > 1200` for 10m

## Dashboard Panels

1. API request rate and error ratio by route.
2. Latency p50/p95/p99 for `/resources/*`.
3. Sync result counters (`success` vs `partial_success`).
4. Retry queue size and dead jobs.
5. Runtime stats from `sim-state.json` (`joins/uplinks/errors`).

## Log Requirements

Each mutating request log must contain:

- `timestamp`
- `correlationId`
- `route`
- `resourceId`
- `mode`
- `resultCode`
- `durationMs`

## Alert Notification Routing

- Critical: immediate paging channel
- High: on-call + team channel
- Medium: team channel summary

## SLO Suggestions

- API availability: >= 99.9%
- Mutating API success (non-validation): >= 99.0%
- Retry queue drain time p95: < 10 minutes
