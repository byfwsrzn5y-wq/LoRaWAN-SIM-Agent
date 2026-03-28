/** Subset of simulator control-plane + sim-state.json shape used by the UI. */

export type SyncState =
  | 'local_dirty'
  | 'syncing'
  | 'synced'
  | 'partial_success'
  | 'error'

export interface SyncStatus {
  state: SyncState
  targets?: string[]
  lastError?: { code?: string; message?: string; retryable?: boolean } | null
  updatedAt?: string
}

/** Simulator-facing device fields mirrored from config.devices / orchestrator (for Inspector). */
export interface NodeSimulatorConfig {
  intervalMs?: number
  /** Spreading factor (maps to config dataRate). */
  sf?: number
  txPower?: number
  adr?: boolean
  fPort?: number
  uplinkCodec?: string
  appKeyConfigured?: boolean
}

export type TopologySource = 'simulator' | 'chirpstack'

export interface SimNode {
  eui: string
  name?: string
  /** simulator = 本机模拟；chirpstack = 来自 ChirpStack 清单/MQTT（只读管理） */
  source?: TopologySource
  liveOnly?: boolean
  enabled?: boolean
  position?: { x: number; y: number; z?: number }
  syncStatus?: SyncStatus
  joined?: boolean
  fCnt?: number
  rssi?: number
  snr?: number
  simulator?: NodeSimulatorConfig
  gatewayReceptions?: Array<{
    gatewayEui: string
    rssi?: number
    snr?: number
    distance?: number
    pathLoss?: number
  }>
  lastSeen?: string | null
  [key: string]: unknown
}

export interface SimGateway {
  eui: string
  name?: string
  source?: TopologySource
  id?: string
  position?: { x: number; y: number; z?: number }
  rxGain?: number
  rxSensitivity?: number
  cableLoss?: number
  noiseFloor?: number
  syncStatus?: SyncStatus
  [key: string]: unknown
}

export interface SimState {
  running?: boolean
  layoutRevision?: number
  /** GET /sim-state 在启用 ChirpStack 拓扑导入时为 true */
  topologyDisplayEnabled?: boolean
  nodes?: SimNode[]
  gateways?: SimGateway[]
  stats?: { uplinks?: number; joins?: number; errors?: number }
  packetLog?: Array<{
    nodeId?: string
    gatewayEui?: string
    time?: string
    type?: string
    fCnt?: number
    sf?: number
    rssi?: number
    snr?: number
    payload?: string
    status?: string
  }>
  lastUpdate?: string
  /** REST 清单缓存（拓扑导入）；错误时 `error.message` 可读 */
  chirpstackInventory?: {
    nodes?: unknown[]
    gateways?: unknown[]
    updatedAt?: string | null
    error?: { message?: string } | null
    skipped?: boolean
  }
  [key: string]: unknown
}

/** API error envelope from control server */
export interface ApiErrorBody {
  ok?: false
  error?: { code?: string; message?: string; retryable?: boolean; jobId?: string }
  correlationId?: string
}

export interface ApiSuccess<T> {
  ok: true
  data?: T
  correlationId?: string
}
