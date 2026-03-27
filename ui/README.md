# LoRaWAN-SIM Web Console (v1)

React + TypeScript + Vite + Tailwind. Talks to the **simulator control HTTP server** (same process as `node simulator/index.js` when `controlServer.enabled` is true).

## Prerequisites

- Simulator running with control plane enabled and orchestrator API enabled, for example:
  - `controlServer.enabled: true` and `controlServer.port` (default `9999`) in config
  - `ENABLE_ORCHESTRATOR_API=true` (default) so `/resources/*`, `/layout/apply`, `/sync/retry` are active

### ChirpStack sync vs local-only

Inspector forms default to **`simulator_only`** so PATCH/POST work without ChirpStack credentials. Switch to **`sync_both`** only when the simulator process has `CHIRPSTACK_API_URL` and `CHIRPSTACK_API_TOKEN` set (see repository [`.env.example`](../.env.example)).

If **Save** still returns `500 Missing CHIRPSTACK_API_URL or CHIRPSTACK_API_TOKEN`, you selected **`sync_both`** without those variables. Either configure ChirpStack env vars, use **`simulator_only`**, or set `ENABLE_CHIRPSTACK_SYNC=false` on the simulator process.

## Dev

From `ui/`:

```bash
npm install
npm run dev
```

Vite proxies API paths to `VITE_CONTROL_PROXY_TARGET` (default `http://127.0.0.1:9999`). Copy `.env.example` to `.env` if you need another host/port.

The UI calls:

- `GET /sim-state` — snapshot for lists and canvas
- `POST /resources/nodes`, `PATCH /resources/nodes/:devEui`
- `POST /resources/gateways`, `PATCH /resources/gateways/:gatewayId`
- `POST /layout/apply` — after drag (debounced)
- `POST /sync/retry` — manual retry queue
- `POST /start`, `POST /stop` — optional transport controls
- `GET/POST /config-profiles*` — profile list/save/load/apply/rename

## Profile save / refresh troubleshooting

If you see:

- `save profile error: 404 ... Not found. Use /start ... /sync/retry`

then your UI is connected to an old simulator process that has no `/config-profiles/*` routes. Restart the simulator process from `simulator/`:

```bash
lsof -ti tcp:9999 | xargs kill
cd ../simulator
node index.js -c config.json
```

If you see:

- `The requested module '/node_modules/react-dom/client.js' does not provide an export named 'createRoot'`

force Vite dependency re-optimization once:

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort --force
```

## Production build

```bash
npm run build
npm run preview
```

Set `VITE_CONTROL_API_BASE` to the full origin of the control server if the static UI is hosted on another origin (CORS is enabled on the control server).
