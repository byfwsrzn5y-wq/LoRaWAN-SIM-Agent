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

- `GET /sim-state` — snapshot for lists and canvas（启用 ChirpStack 拓扑时响应中含合并后的 `nodes`/`gateways`、`topologyDisplayEnabled`、`chirpstackInventory` 等，见仓库 [`schemas/sim-state-v1.schema.json`](../schemas/sim-state-v1.schema.json)）
- `POST /resources/nodes`, `PATCH /resources/nodes/:devEui`
- `POST /resources/gateways`, `PATCH /resources/gateways/:gatewayId`
- `PATCH /resources/simulation` — Scenario 表单（含 `chirpstack` 下的 `topologyEnabled`、`inventoryPollSec`、`rxStalenessSec`、`applicationIds`、`integrationMqtt` 等）
- `POST /layout/apply` — after drag (debounced)；CS 仅存在实体时坐标写入服务端 `topologyOverlay`
- `POST /chirpstack/refresh-inventory` — 立即从 ChirpStack REST 拉取设备/网关清单（需已配置 token 且启用拓扑）
- `POST /sync/retry` — manual retry queue
- `POST /start`, `POST /stop` — optional transport controls
- `GET/POST /config-profiles*` — profile list/save/load/apply/rename

Dev 代理（Vite）除上述路径外，还代理 `^/chirpstack` 与 `^/topology`（见 [`vite.config.ts`](vite.config.ts)）。

### ChirpStack 拓扑（UI 行为摘要）

- **Scenario**：展开 **ChirpStack 拓扑（UI 画布）**，勾选 `topologyEnabled` 并填写轮询间隔、rx 过期时间、多 `applicationIds`（可选）、UDP 场景下的 `integrationMqtt` 等。**保存后**若修改 `inventoryPollSec`，需**重启模拟器**定时器才按新间隔拉取；可先使用左栏 **刷新** 立即同步清单。
- **顶栏**：显示 **CS 拓扑** 表示当前 `GET /sim-state` 已合并 ChirpStack 视图。
- **左栏**：**来源** 筛选「全部 / 模拟 / CS」；拓扑启用时显示清单统计、错误信息与 **刷新** 按钮。来自 ChirpStack 的节点/网关 **无 Del**，Inspector 为只读说明。

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
