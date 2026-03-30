import { useMemo, useState } from 'react'
import type { SimGateway, SimNode } from '../types/simState'
import { syncStatusToBadge } from '../lib/syncBadge'

const ANOMALY_SCENARIOS: Array<{ key: string; label: string }> = [
  { key: 'fcnt-duplicate', label: 'FCnt 重复' },
  { key: 'fcnt-jump', label: 'FCnt 跳变' },
  { key: 'mic-corrupt', label: 'MIC 损坏' },
  { key: 'payload-corrupt', label: 'Payload 损坏' },
  { key: 'signal-weak', label: '弱信号' },
  { key: 'signal-spike', label: '信号突变' },
  { key: 'rapid-join', label: '快速 Join' },
  { key: 'devnonce-repeat', label: 'DevNonce 重复' },
  { key: 'confirmed-noack', label: 'Confirmed 不 ACK' },
  { key: 'random-drop', label: '随机丢包' },
  { key: 'downlink-corrupt', label: '下行损坏' },
  { key: 'devaddr-reuse', label: 'DevAddr 冲突/复用' },
  { key: 'rapid-uplink', label: '上行突发' },
  { key: 'network-delay', label: '网络延迟' },
  { key: 'gateway-offline', label: '网关离线' },
  { key: 'signal-degrade', label: '信号持续降级' },
  { key: 'freq-hop-abnormal', label: '异常频率跳变' },
  { key: 'sf-switch-abnormal', label: '异常 SF 切换' },
  { key: 'time-desync', label: '设备时间不同步' },
  { key: 'ack-suppress', label: 'ACK 抑制' },
  { key: 'mac-corrupt', label: 'MAC 命令损坏' },
]

const ANOMALY_TRIGGERS: string[] = [
  'always',
  'every-2nd-uplink',
  'every-3rd-uplink',
  'every-5th-uplink',
  'random-10-percent',
  'random-30-percent',
  'once',
  'on-join-accept',
]

export type RightView =
  | { type: 'none' }
  | { type: 'addNode' }
  | { type: 'addGateway' }
  | { type: 'scenario' }
  | { type: 'node'; node: SimNode }
  | { type: 'gateway'; gateway: SimGateway }

export interface NodeResourcePayload {
  mode: string
  name: string
  x: number
  y: number
  z: number
  enabled: boolean
  intervalMs: number
  sf: number
  txPower: number
  adr: boolean
  fPort: number
  uplinkCodec: 'simple' | 'custom'
  uplinkPayload: string
  uplinkPayloadFormat: 'hex' | 'base64'
  adrReject: boolean
  devStatus: boolean
  duplicateFirstData: boolean
  csApplicationId: string
  csDeviceProfileId: string
  csAppKey: string
  anomalyJson: string
  nodeStateMode: 'none' | 'fixed' | 'random' | 'json'
  nodeStateRssi: number
  nodeStateSnr: number
  nodeStateTxPowerIndex: number
  nodeStateJson: string
  batchCount?: number
}

export interface GatewayResourcePayload {
  mode: string
  name: string
  x: number
  y: number
  z: number
  rxGain: number
  rxSensitivity: number
  cableLoss: number
  noiseFloor: number
  csTenantId: string
}

export interface ScenarioResourcePayload {
  mode: string
  multiGatewayMode: string
  primaryGateway: string
  txPower: number
  txGain: number
  environment: string
  shadowFadingStd: number
  fastFadingEnabled: boolean
  chirpstackBaseUrl: string
  chirpstackApiToken: string
  chirpstackAuthHeader: string
  chirpstackApplicationId: string
  chirpstackDeviceProfileId: string
  chirpstackTenantId: string
  /** 在 UI 合并 ChirpStack 真实设备/网关与 MQTT rxInfo 拓扑 */
  chirpstackTopologyEnabled: boolean
  chirpstackInventoryPollSec: number
  chirpstackRxStalenessSec: number
  /** 多个 application UUID，逗号或空格分隔；留空则只用 applicationId */
  chirpstackApplicationIdsCsv: string
  chirpstackIntegrationMqttEnabled: boolean
  chirpstackIntegrationMqttServer: string
  chirpstackIntegrationMqttUsername: string
  chirpstackIntegrationMqttPassword: string
}

function ChirpstackNodeInspector({ node }: { node: SimNode }) {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-400">
        ChirpStack 设备（只读）。密钥、Profile 与删除请在 ChirpStack 控制台操作。画布上的位置会写入本机 <code className="text-slate-300">sim-state.json</code> 的{' '}
        <code className="text-slate-300">topologyOverlay</code>。
      </p>
      <dl className="grid grid-cols-1 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">DevEUI</dt>
          <dd className="font-mono">{node.eui}</dd>
        </div>
        <div>
          <dt className="text-slate-500">名称</dt>
          <dd>{node.name || '—'}</dd>
        </div>
        {node.lastSeen ? (
          <div>
            <dt className="text-slate-500">lastSeen</dt>
            <dd className="break-all font-mono text-[10px] text-slate-300">{node.lastSeen}</dd>
          </div>
        ) : null}
        {node.liveOnly ? (
          <p className="text-[11px] text-amber-300/90">仅由 MQTT 上行发现（REST 清单中可能尚未出现）。</p>
        ) : null}
        {Array.isArray(node.gatewayReceptions) && node.gatewayReceptions.length > 0 ? (
          <div>
            <dt className="text-slate-500">rxInfo / 网关</dt>
            <dd className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-300">
              {node.gatewayReceptions.map((rx) => (
                <div key={rx.gatewayEui}>
                  {rx.gatewayEui}
                  {typeof rx.rssi === 'number' ? ` · ${rx.rssi} dBm` : ''}
                  {typeof rx.snr === 'number' ? ` · SNR ${rx.snr}` : ''}
                </div>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}

function ChirpstackGatewayInspector({ gateway }: { gateway: SimGateway }) {
  const id = gateway.eui || gateway.id || ''
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-400">
        ChirpStack 网关（只读）。在 ChirpStack 控制台管理网关记录。画布位置保存在 <code className="text-slate-300">topologyOverlay</code>。
      </p>
      <dl className="grid grid-cols-1 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">Gateway ID</dt>
          <dd className="font-mono">{id}</dd>
        </div>
        <div>
          <dt className="text-slate-500">名称</dt>
          <dd>{gateway.name || '—'}</dd>
        </div>
      </dl>
    </div>
  )
}

interface RightPanelProps {
  view: RightView
  busy?: boolean
  nodes?: SimNode[]
  gateways?: SimGateway[]
  configSnapshot?: {
    multiGatewayMode?: string
    primaryGateway?: string
    txPower?: number
    txGain?: number
    environment?: string
    shadowFadingStd?: number
    fastFadingEnabled?: boolean
    chirpstackBaseUrl?: string
    chirpstackApiToken?: string
    chirpstackAuthHeader?: string
    chirpstackApplicationId?: string
    chirpstackDeviceProfileId?: string
    chirpstackTenantId?: string
    chirpstackTopologyEnabled?: boolean
    chirpstackInventoryPollSec?: number
    chirpstackRxStalenessSec?: number
    chirpstackApplicationIdsCsv?: string
    chirpstackIntegrationMqttEnabled?: boolean
    chirpstackIntegrationMqttServer?: string
    chirpstackIntegrationMqttUsername?: string
  }
  onCreateNode: (payload: NodeResourcePayload & { devEui: string; batchCount?: number }) => Promise<void>
  onCreateGateway: (payload: GatewayResourcePayload & { gatewayId: string }) => Promise<void>
  onUpdateNode: (devEui: string, payload: NodeResourcePayload) => Promise<void>
  onUpdateGateway: (gatewayId: string, payload: GatewayResourcePayload) => Promise<void>
  onDeleteNode: (devEui: string, mode: string) => Promise<void>
  onDeleteGateway: (gatewayId: string, mode: string) => Promise<void>
  onUpdateScenario: (payload: ScenarioResourcePayload) => Promise<void>
  className?: string
}

export function RightPanel({
  view,
  busy,
  nodes = [],
  gateways = [],
  configSnapshot,
  onCreateNode,
  onCreateGateway,
  onUpdateNode,
  onUpdateGateway,
  onDeleteNode,
  onDeleteGateway,
  onUpdateScenario,
  className,
}: RightPanelProps) {
  return (
    <aside className={`flex shrink-0 flex-col border-l border-slate-700 bg-slate-900 text-slate-100 ${className || 'w-80'}`}>
      <div className="border-b border-slate-700 px-3 py-2 text-sm font-medium">Inspector</div>
      <div className="flex-1 overflow-auto p-3 text-sm">
        {view.type === 'none' && (
          <p className="text-slate-500">Select a node or gateway, or add a new resource from the left panel.</p>
        )}
        {view.type === 'addNode' && (
          <NodeForm
            busy={busy}
            nodes={nodes}
            onSubmit={onCreateNode}
            defaultCsApplicationId={configSnapshot?.chirpstackApplicationId || ''}
            defaultCsDeviceProfileId={configSnapshot?.chirpstackDeviceProfileId || ''}
          />
        )}
        {view.type === 'addGateway' && (
          <GatewayForm
            busy={busy}
            gateways={gateways}
            onSubmit={onCreateGateway}
            defaultCsTenantId={configSnapshot?.chirpstackTenantId ?? ''}
          />
        )}
        {view.type === 'node' &&
          ((view.node.source || 'simulator') === 'chirpstack' ? (
            <ChirpstackNodeInspector node={view.node} />
          ) : (
            <NodeForm
              key={view.node.eui}
              busy={busy}
              nodes={nodes}
              node={view.node}
              onSubmit={(payload) => onUpdateNode(view.node.eui, payload)}
              onDelete={(mode) => onDeleteNode(view.node.eui, mode)}
              defaultCsApplicationId={configSnapshot?.chirpstackApplicationId || ''}
              defaultCsDeviceProfileId={configSnapshot?.chirpstackDeviceProfileId || ''}
            />
          ))}
        {view.type === 'gateway' &&
          ((view.gateway.source || 'simulator') === 'chirpstack' ? (
            <ChirpstackGatewayInspector gateway={view.gateway} />
          ) : (
            <GatewayForm
              key={view.gateway.eui}
              busy={busy}
              gateways={gateways}
              gateway={view.gateway}
              onSubmit={(payload) => onUpdateGateway(view.gateway.eui || view.gateway.id || '', payload)}
              onDelete={(mode) => onDeleteGateway(view.gateway.eui || view.gateway.id || '', mode)}
              defaultCsTenantId={configSnapshot?.chirpstackTenantId ?? ''}
            />
          ))}
        {view.type === 'scenario' && (
          <ScenarioForm
            busy={busy}
            gateways={gateways}
            config={configSnapshot}
            onSubmit={onUpdateScenario}
          />
        )}
      </div>
    </aside>
  )
}

function parseJson(text: string): unknown | undefined {
  const raw = text.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function toJsonText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

function incrementHex16(current: string): string {
  const clean = current.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  if (clean.length !== 16) return current
  const next = (BigInt(`0x${clean}`) + 1n).toString(16).padStart(16, '0')
  return next.slice(-16)
}

function nextNodeDevEui(nodes: SimNode[]): string {
  const euIs = nodes
    .map((n) => String(n.eui || '').toLowerCase().replace(/[^0-9a-f]/g, ''))
    .filter((v) => v.length === 16)
  if (euIs.length === 0) return '18d3bf0000000001'
  euIs.sort()
  return incrementHex16(euIs[euIs.length - 1])
}

function nextGatewayEui(gateways: SimGateway[]): string {
  const euIs = gateways
    .map((g) => String(g.eui || g.id || '').toLowerCase().replace(/[^0-9a-f]/g, ''))
    .filter((v) => v.length === 16)
  if (euIs.length === 0) return '19023c6b00000001'
  euIs.sort()
  return incrementHex16(euIs[euIs.length - 1])
}

function NodeForm({
  nodes = [],
  node,
  busy,
  onSubmit,
  onDelete,
  defaultCsApplicationId,
  defaultCsDeviceProfileId,
}: {
  nodes?: SimNode[]
  node?: SimNode
  busy?: boolean
  onSubmit: (payload: NodeResourcePayload & { devEui: string; batchCount?: number }) => Promise<void>
  onDelete?: (mode: string) => Promise<void>
  defaultCsApplicationId?: string
  defaultCsDeviceProfileId?: string
}) {
  const b = syncStatusToBadge(node?.syncStatus)
  const p = node?.position || { x: 400, y: 300, z: 2 }
  const sim = node?.simulator
  const [mode, setMode] = useState('simulator_only')
  const suggestedDevEui = useMemo(() => nextNodeDevEui(nodes), [nodes])
  const [devEui, setDevEui] = useState(node?.eui || suggestedDevEui)
  const [name, setName] = useState(node?.name || `sim-node-${suggestedDevEui.slice(-4)}`)
  const [enabled, setEnabled] = useState(node?.enabled !== false)
  const [x, setX] = useState(p.x)
  const [y, setY] = useState(p.y)
  const [z, setZ] = useState(p.z ?? 2)
  const [intervalMs, setIntervalMs] = useState(sim?.intervalMs ?? 10000)
  const [sf, setSf] = useState(typeof sim?.sf === 'number' ? sim.sf : 7)
  const [txPower, setTxPower] = useState(typeof sim?.txPower === 'number' ? sim.txPower : 16)
  const [adr, setAdr] = useState(sim?.adr !== false)
  const [fPort, setFPort] = useState(typeof sim?.fPort === 'number' ? sim.fPort : 2)
  const [uplinkCodec, setUplinkCodec] = useState<'simple' | 'custom'>(
    sim?.uplinkCodec === 'custom' ? 'custom' : 'simple',
  )
  const [uplinkPayload, setUplinkPayload] = useState('')
  const [uplinkPayloadFormat, setUplinkPayloadFormat] = useState<'hex' | 'base64'>('hex')
  const [adrReject, setAdrReject] = useState(Boolean(node?.adrReject))
  const [devStatus, setDevStatus] = useState(Boolean(node?.devStatus))
  const [duplicateFirstData, setDuplicateFirstData] = useState(Boolean(node?.duplicateFirstData))
  const [csApplicationId, setCsApplicationId] = useState(defaultCsApplicationId || '')
  const [csDeviceProfileId, setCsDeviceProfileId] = useState(defaultCsDeviceProfileId || '')
  const [csAppKey, setCsAppKey] = useState('')
  const [anomalyJson, setAnomalyJson] = useState(toJsonText(node?.anomaly))
  const anomalyObj = (parseJson(anomalyJson) as Record<string, unknown> | undefined) || {}
  const [anomalyEnabled, setAnomalyEnabled] = useState(Boolean(anomalyObj.enabled))
  const [anomalyScenario, setAnomalyScenario] = useState(
    typeof anomalyObj.scenario === 'string' ? anomalyObj.scenario : ANOMALY_SCENARIOS[0]?.key || 'fcnt-duplicate',
  )
  const [anomalyTrigger, setAnomalyTrigger] = useState(
    typeof anomalyObj.trigger === 'string' ? anomalyObj.trigger : 'always',
  )
  const [anomalyParamsJson, setAnomalyParamsJson] = useState(
    anomalyObj.params && typeof anomalyObj.params === 'object' ? JSON.stringify(anomalyObj.params, null, 2) : '{}',
  )
  const riskHint = useMemo(() => {
    if (!anomalyEnabled) return ''
    if (anomalyScenario === 'fcnt-jump' && anomalyTrigger === 'always') {
      return '高风险：fcnt-jump + always 会导致 FCNT 持续跳变，可能被误判为计数异常。建议仅用于专项压测。'
    }
    if (anomalyScenario === 'rapid-join' && anomalyTrigger === 'always') {
      return '高风险：rapid-join + always 会频繁重入网，业务上行可能长时间不稳定。'
    }
    if (anomalyScenario === 'random-drop' && (anomalyTrigger === 'always' || anomalyTrigger === 'random-30-percent')) {
      return '注意：当前组合会产生明显丢包，可能影响端到端验证结论。'
    }
    return ''
  }, [anomalyEnabled, anomalyScenario, anomalyTrigger])
  const [nodeStateMode, setNodeStateMode] = useState<'none' | 'fixed' | 'random' | 'json'>('none')
  const [nodeStateRssi, setNodeStateRssi] = useState(-85)
  const [nodeStateSnr, setNodeStateSnr] = useState(5)
  const [nodeStateTxPowerIndex, setNodeStateTxPowerIndex] = useState(0)
  const [nodeStateJson, setNodeStateJson] = useState('')
  const [jsonHint, setJsonHint] = useState('')
  const [batchCount, setBatchCount] = useState(1)

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const anomalyParams = parseJson(anomalyParamsJson)
        const anomalyFromControls =
          anomalyParams && typeof anomalyParams === 'object'
            ? {
                enabled: anomalyEnabled,
                scenario: anomalyScenario,
                trigger: anomalyTrigger,
                params: anomalyParams,
              }
            : undefined
        const nodeState =
          nodeStateMode === 'fixed'
            ? { rssi: nodeStateRssi, snr: nodeStateSnr, txPowerIndex: nodeStateTxPowerIndex }
            : nodeStateMode === 'random'
              ? { random: true }
              : nodeStateMode === 'json'
                ? parseJson(nodeStateJson)
                : undefined
        if (nodeStateMode === 'json' && nodeStateJson.trim() && !nodeState) {
          setJsonHint('nodeState JSON invalid')
          return
        }
        if (!anomalyFromControls) {
          setJsonHint('anomaly params JSON invalid')
          return
        }
        setAnomalyJson(JSON.stringify(anomalyFromControls, null, 2))
        setJsonHint('')
        void onSubmit({
          devEui: devEui.trim(),
          batchCount: node ? 1 : Math.max(1, Math.floor(batchCount || 1)),
          mode,
          name: name.trim(),
          enabled,
          x,
          y,
          z,
          intervalMs,
          sf,
          txPower,
          adr,
          fPort,
          uplinkCodec,
          uplinkPayload: uplinkPayload.trim(),
          uplinkPayloadFormat,
          adrReject,
          devStatus,
          duplicateFirstData,
          csApplicationId: csApplicationId.trim(),
          csDeviceProfileId: csDeviceProfileId.trim(),
          csAppKey: csAppKey.trim(),
          anomalyJson: JSON.stringify(anomalyFromControls),
          nodeStateMode,
          nodeStateRssi,
          nodeStateSnr,
          nodeStateTxPowerIndex,
          nodeStateJson: nodeState ? JSON.stringify(nodeState) : '',
        })
      }}
    >
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-white">{node ? 'Node' : 'New node'}</h3>
        {node && <span className={`rounded px-1.5 text-[10px] ${b.className}`}>{b.label}</span>}
      </div>
      {node && <p className="font-mono text-xs text-slate-400">{node.eui}</p>}
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">mode</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="sync_both">sync_both</option>
          <option value="simulator_only">simulator_only</option>
        </select>
      </label>
      {!node && (
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-400">devEui (16 hex)</span>
          <input className="rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs" value={devEui} onChange={(e) => setDevEui(e.target.value)} required />
        </label>
      )}
      {!node && <Num label="count (batch create)" value={batchCount} onChange={setBatchCount} min={1} max={200} step={1} />}
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">name</span>
        <input className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        enabled
      </label>
      <div className="grid grid-cols-3 gap-2">
        <Num label="x" value={x} onChange={setX} />
        <Num label="y" value={y} onChange={setY} />
        <Num label="z" value={z} onChange={setZ} />
      </div>
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Radio & uplink</div>
      <Num label="intervalMs" value={intervalMs} onChange={setIntervalMs} />
      <Num label="SF" value={sf} onChange={setSf} />
      <Num label="txPower (dBm)" value={txPower} onChange={setTxPower} />
      <Num label="fPort (1-223)" value={fPort} onChange={setFPort} min={1} max={223} />
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={adr} onChange={(e) => setAdr(e.target.checked)} />
        ADR enabled
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">uplink codec</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={uplinkCodec} onChange={(e) => setUplinkCodec(e.target.value as 'simple' | 'custom')}>
          <option value="simple">simple</option>
          <option value="custom">custom</option>
        </select>
      </label>
      {uplinkCodec === 'custom' && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-slate-400">payload format</span>
            <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={uplinkPayloadFormat} onChange={(e) => setUplinkPayloadFormat(e.target.value as 'hex' | 'base64')}>
              <option value="hex">hex</option>
              <option value="base64">base64</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-slate-400">payload</span>
            <input className="rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs" value={uplinkPayload} onChange={(e) => setUplinkPayload(e.target.value)} />
          </label>
        </>
      )}
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Behavior flags</div>
      <Check label="adrReject" value={adrReject} onChange={setAdrReject} />
      <Check label="devStatus" value={devStatus} onChange={setDevStatus} />
      <Check label="duplicateFirstData" value={duplicateFirstData} onChange={setDuplicateFirstData} />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">ChirpStack</div>
      <Text label="chirpstack.applicationId (UUID)" value={csApplicationId} setValue={setCsApplicationId} />
      <Text label="chirpstack.deviceProfileId (UUID)" value={csDeviceProfileId} setValue={setCsDeviceProfileId} />
      <Text label="chirpstack.appKey (32 hex, optional)" value={csAppKey} setValue={setCsAppKey} mono />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">anomaly</div>
      <Check label="anomaly.enabled" value={anomalyEnabled} onChange={setAnomalyEnabled} />
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">anomaly.scenario</span>
        <select
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
          value={anomalyScenario}
          onChange={(e) => setAnomalyScenario(e.target.value)}
        >
          {ANOMALY_SCENARIOS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.key} - {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">anomaly.trigger</span>
        <select
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
          value={anomalyTrigger}
          onChange={(e) => setAnomalyTrigger(e.target.value)}
        >
          {ANOMALY_TRIGGERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">anomaly.params (JSON)</span>
        <textarea
          className="min-h-[72px] rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs"
          value={anomalyParamsJson}
          onChange={(e) => setAnomalyParamsJson(e.target.value)}
        />
      </label>
      {riskHint ? (
        <div className="rounded border border-amber-500/50 bg-amber-900/20 px-2 py-1 text-xs text-amber-200">
          {riskHint}
        </div>
      ) : null}
      <div className="text-[11px] text-slate-500">anomaly.raw JSON（展示用，提交按上面的可视化配置）</div>
      <textarea className="min-h-[88px] rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs" value={anomalyJson} onChange={(e) => setAnomalyJson(e.target.value)} />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">nodeState</div>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">mode</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={nodeStateMode} onChange={(e) => setNodeStateMode(e.target.value as 'none' | 'fixed' | 'random' | 'json')}>
          <option value="none">none</option>
          <option value="fixed">fixed(rssi/snr/txPowerIndex)</option>
          <option value="random">random</option>
          <option value="json">full JSON</option>
        </select>
      </label>
      {nodeStateMode === 'fixed' && (
        <div className="grid grid-cols-3 gap-2">
          <Num label="rssi" value={nodeStateRssi} onChange={setNodeStateRssi} />
          <Num label="snr" value={nodeStateSnr} onChange={setNodeStateSnr} />
          <Num label="txPowerIdx" value={nodeStateTxPowerIndex} onChange={setNodeStateTxPowerIndex} />
        </div>
      )}
      {nodeStateMode === 'json' && (
        <textarea className="min-h-[88px] rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs" value={nodeStateJson} onChange={(e) => setNodeStateJson(e.target.value)} />
      )}
      {jsonHint ? <p className="text-xs text-red-300">{jsonHint}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="submit" disabled={busy} className="flex-1 rounded bg-blue-600 py-2 text-white disabled:opacity-50">
          {node ? 'Save' : 'Create node'}
        </button>
        {node && onDelete ? (
          <button
            type="button"
            disabled={busy}
            className="rounded border border-slate-600 bg-slate-800 px-3 py-2 text-slate-200 hover:border-slate-500 hover:text-white disabled:opacity-50"
            onClick={() => {
              if (window.confirm(`Delete node ${node.eui}?`)) {
                void onDelete(mode)
              }
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  )
}

function GatewayForm({
  gateways = [],
  gateway,
  busy,
  onSubmit,
  onDelete,
  defaultCsTenantId,
}: {
  gateways?: SimGateway[]
  gateway?: SimGateway
  busy?: boolean
  onSubmit: (payload: GatewayResourcePayload & { gatewayId: string }) => Promise<void>
  onDelete?: (mode: string) => Promise<void>
  defaultCsTenantId?: string
}) {
  const b = syncStatusToBadge(gateway?.syncStatus)
  const p = gateway?.position || { x: 200, y: 120, z: 30 }
  const [mode, setMode] = useState('sync_both')
  const suggestedGatewayId = useMemo(() => nextGatewayEui(gateways), [gateways])
  const [gatewayId, setGatewayId] = useState(gateway?.eui || gateway?.id || suggestedGatewayId)
  const [name, setName] = useState(gateway?.name || `gw-${suggestedGatewayId.slice(-4)}`)
  const [x, setX] = useState(p.x)
  const [y, setY] = useState(p.y)
  const [z, setZ] = useState(p.z ?? 30)
  const [rxGain, setRxGain] = useState(typeof gateway?.rxGain === 'number' ? gateway.rxGain : 5)
  const [rxSensitivity, setRxSensitivity] = useState(typeof gateway?.rxSensitivity === 'number' ? gateway.rxSensitivity : -137)
  const [cableLoss, setCableLoss] = useState(typeof gateway?.cableLoss === 'number' ? gateway.cableLoss : 0.5)
  const [noiseFloor, setNoiseFloor] = useState(typeof gateway?.noiseFloor === 'number' ? gateway.noiseFloor : -100)
  const [csTenantId, setCsTenantId] = useState(defaultCsTenantId ?? '')

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit({
          gatewayId: gatewayId.trim(),
          mode,
          name: name.trim(),
          x,
          y,
          z,
          rxGain,
          rxSensitivity,
          cableLoss,
          noiseFloor,
          csTenantId: csTenantId.trim(),
        })
      }}
    >
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-white">{gateway ? 'Gateway' : 'New gateway'}</h3>
        {gateway ? <span className={`rounded px-1.5 text-[10px] ${b.className}`}>{b.label}</span> : null}
      </div>
      {gateway ? <p className="font-mono text-xs text-slate-400">{gateway.eui}</p> : null}
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">mode</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="sync_both">sync_both</option>
          <option value="simulator_only">simulator_only</option>
        </select>
      </label>
      {!gateway && <Text label="gatewayId (16 hex)" value={gatewayId} setValue={setGatewayId} mono />}
      <Text label="name" value={name} setValue={setName} />
      <div className="grid grid-cols-3 gap-2">
        <Num label="x" value={x} onChange={setX} />
        <Num label="y" value={y} onChange={setY} />
        <Num label="z" value={z} onChange={setZ} />
      </div>
      <Num label="rxGain (dBi)" value={rxGain} onChange={setRxGain} />
      <Num label="rxSensitivity (dBm)" value={rxSensitivity} onChange={setRxSensitivity} />
      <Num label="cableLoss (dB)" value={cableLoss} onChange={setCableLoss} step={0.1} />
      <Num label="noiseFloor (dBm)" value={noiseFloor} onChange={setNoiseFloor} />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">ChirpStack</div>
      <Text label="chirpstack.tenantId (UUID)" value={csTenantId} setValue={setCsTenantId} />
      <div className="mt-2 flex gap-2">
        <button type="submit" disabled={busy} className="flex-1 rounded bg-blue-600 py-2 text-white disabled:opacity-50">
          {gateway ? 'Save' : 'Create gateway'}
        </button>
        {gateway && onDelete ? (
          <button
            type="button"
            disabled={busy}
            className="rounded border border-slate-600 bg-slate-800 px-3 py-2 text-slate-200 hover:border-slate-500 hover:text-white disabled:opacity-50"
            onClick={() => {
              const id = gateway.eui || gateway.id || ''
              if (window.confirm(`Delete gateway ${id}?`)) {
                void onDelete(mode)
              }
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  )
}

function ScenarioForm({
  busy,
  gateways,
  config,
  onSubmit,
}: {
  busy?: boolean
  gateways: SimGateway[]
  config?: RightPanelProps['configSnapshot']
  onSubmit: (payload: ScenarioResourcePayload) => Promise<void>
}) {
  const [mode, setMode] = useState('sync_both')
  const [multiGatewayMode, setMultiGatewayMode] = useState(config?.multiGatewayMode || 'overlapping')
  const [primaryGateway, setPrimaryGateway] = useState(config?.primaryGateway || gateways[0]?.eui || '')
  const [txPower, setTxPower] = useState(config?.txPower ?? 16)
  const [txGain, setTxGain] = useState(config?.txGain ?? 2.15)
  const [environment, setEnvironment] = useState(config?.environment || 'urban')
  const [shadowFadingStd, setShadowFadingStd] = useState(config?.shadowFadingStd ?? 8)
  const [fastFadingEnabled, setFastFadingEnabled] = useState(config?.fastFadingEnabled !== false)
  const [chirpstackBaseUrl, setChirpstackBaseUrl] = useState(config?.chirpstackBaseUrl || 'http://127.0.0.1:8090')
  const [chirpstackApiToken, setChirpstackApiToken] = useState(config?.chirpstackApiToken || '')
  const [chirpstackAuthHeader, setChirpstackAuthHeader] = useState(config?.chirpstackAuthHeader || 'Grpc-Metadata-Authorization')
  const [chirpstackApplicationId, setChirpstackApplicationId] = useState(config?.chirpstackApplicationId ?? '540a999c-9eeb-4c5c-bed1-778dacddaf46')
  const [chirpstackDeviceProfileId, setChirpstackDeviceProfileId] = useState(config?.chirpstackDeviceProfileId ?? 'a1b2c3d4-1111-2222-3333-444444444444')
  const [chirpstackTenantId, setChirpstackTenantId] = useState(config?.chirpstackTenantId ?? '81d48efb-6216-4c7f-8c21-46a5eac9d737')
  const [chirpstackTopologyEnabled, setChirpstackTopologyEnabled] = useState(Boolean(config?.chirpstackTopologyEnabled))
  const [chirpstackInventoryPollSec, setChirpstackInventoryPollSec] = useState(
    config?.chirpstackInventoryPollSec != null ? Number(config.chirpstackInventoryPollSec) : 60,
  )
  const [chirpstackRxStalenessSec, setChirpstackRxStalenessSec] = useState(
    config?.chirpstackRxStalenessSec != null ? Number(config.chirpstackRxStalenessSec) : 120,
  )
  const [chirpstackApplicationIdsCsv, setChirpstackApplicationIdsCsv] = useState(config?.chirpstackApplicationIdsCsv || '')
  const [chirpstackIntegrationMqttEnabled, setChirpstackIntegrationMqttEnabled] = useState(
    Boolean(config?.chirpstackIntegrationMqttEnabled),
  )
  const [chirpstackIntegrationMqttServer, setChirpstackIntegrationMqttServer] = useState(
    config?.chirpstackIntegrationMqttServer || '',
  )
  const [chirpstackIntegrationMqttUsername, setChirpstackIntegrationMqttUsername] = useState(
    config?.chirpstackIntegrationMqttUsername || '',
  )
  const [chirpstackIntegrationMqttPassword, setChirpstackIntegrationMqttPassword] = useState('')
  const gatewayOptions = useMemo(() => gateways.map((g) => g.eui).filter(Boolean), [gateways])

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit({
          mode,
          multiGatewayMode,
          primaryGateway: primaryGateway.trim(),
          txPower,
          txGain,
          environment,
          shadowFadingStd,
          fastFadingEnabled,
          chirpstackBaseUrl: chirpstackBaseUrl.trim(),
          chirpstackApiToken: chirpstackApiToken.trim(),
          chirpstackAuthHeader: chirpstackAuthHeader.trim(),
          chirpstackApplicationId: chirpstackApplicationId.trim(),
          chirpstackDeviceProfileId: chirpstackDeviceProfileId.trim(),
          chirpstackTenantId: chirpstackTenantId.trim(),
          chirpstackTopologyEnabled,
          chirpstackInventoryPollSec: Math.max(5, Math.floor(chirpstackInventoryPollSec) || 60),
          chirpstackRxStalenessSec: Math.max(10, Math.floor(chirpstackRxStalenessSec) || 120),
          chirpstackApplicationIdsCsv: chirpstackApplicationIdsCsv.trim(),
          chirpstackIntegrationMqttEnabled,
          chirpstackIntegrationMqttServer: chirpstackIntegrationMqttServer.trim(),
          chirpstackIntegrationMqttUsername: chirpstackIntegrationMqttUsername.trim(),
          chirpstackIntegrationMqttPassword: chirpstackIntegrationMqttPassword.trim(),
        })
      }}
    >
      <h3 className="font-medium text-white">Simulation scenario</h3>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">mode</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="simulator_only">simulator_only</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">multiGateway.mode</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={multiGatewayMode} onChange={(e) => setMultiGatewayMode(e.target.value)}>
          <option value="overlapping">overlapping</option>
          <option value="handover">handover</option>
          <option value="failover">failover</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">primaryGateway</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={primaryGateway} onChange={(e) => setPrimaryGateway(e.target.value)}>
          {gatewayOptions.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
      <Num label="signalModel.txPower" value={txPower} onChange={setTxPower} />
      <Num label="signalModel.txGain" value={txGain} onChange={setTxGain} step={0.1} />
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-slate-400">signalModel.environment</span>
        <select className="rounded border border-slate-600 bg-slate-800 px-2 py-1" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          <option value="free-space">free-space</option>
          <option value="suburban">suburban</option>
          <option value="urban">urban</option>
          <option value="dense-urban">dense-urban</option>
          <option value="indoor">indoor</option>
        </select>
      </label>
      <Num label="signalModel.shadowFadingStd" value={shadowFadingStd} onChange={setShadowFadingStd} step={0.1} />
      <Check label="signalModel.fastFadingEnabled" value={fastFadingEnabled} onChange={setFastFadingEnabled} />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">ChirpStack defaults</div>
      <Text label="chirpstack.baseUrl" value={chirpstackBaseUrl} setValue={setChirpstackBaseUrl} />
      <Text label="chirpstack.apiToken" value={chirpstackApiToken} setValue={setChirpstackApiToken} type="password" />
      <Text label="chirpstack.authHeader" value={chirpstackAuthHeader} setValue={setChirpstackAuthHeader} />
      <Text label="chirpstack.applicationId" value={chirpstackApplicationId} setValue={setChirpstackApplicationId} />
      <Text label="chirpstack.deviceProfileId" value={chirpstackDeviceProfileId} setValue={setChirpstackDeviceProfileId} />
      <Text label="chirpstack.tenantId" value={chirpstackTenantId} setValue={setChirpstackTenantId} />
      <div className="border-t border-slate-700 pt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        ChirpStack 拓扑（UI 画布）
      </div>
      <Check label="chirpstack.topologyEnabled（合并 REST 清单 + MQTT rxInfo）" value={chirpstackTopologyEnabled} onChange={setChirpstackTopologyEnabled} />
      <p className="text-[10px] text-slate-500">保存后定时拉取间隔需重启模拟器进程才会按新 inventoryPollSec 生效；可先点左侧「刷新」拉清单。</p>
      <Num label="chirpstack.inventoryPollSec" value={chirpstackInventoryPollSec} onChange={setChirpstackInventoryPollSec} min={5} max={3600} />
      <Num label="chirpstack.rxStalenessSec（过期不画边）" value={chirpstackRxStalenessSec} onChange={setChirpstackRxStalenessSec} min={10} max={3600} />
      <Text
        label="chirpstack.applicationIds（可选，逗号分隔 UUID；留空仅用 applicationId）"
        value={chirpstackApplicationIdsCsv}
        setValue={setChirpstackApplicationIdsCsv}
      />
      <p className="text-[10px] leading-snug text-slate-500">UDP 网关模式时，可单独订阅应用集成 MQTT：</p>
      <Check label="chirpstack.integrationMqtt.enabled" value={chirpstackIntegrationMqttEnabled} onChange={setChirpstackIntegrationMqttEnabled} />
      <Text label="integrationMqtt.server（如 mqtt://127.0.0.1:1883）" value={chirpstackIntegrationMqttServer} setValue={setChirpstackIntegrationMqttServer} />
      <Text label="integrationMqtt.username" value={chirpstackIntegrationMqttUsername} setValue={setChirpstackIntegrationMqttUsername} />
      <Text label="integrationMqtt.password（留空则保留已保存）" value={chirpstackIntegrationMqttPassword} setValue={setChirpstackIntegrationMqttPassword} type="password" />
      <button type="submit" disabled={busy} className="mt-2 rounded bg-blue-600 py-2 text-white disabled:opacity-50">
        Save scenario
      </button>
    </form>
  )
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className="rounded border border-slate-600 bg-slate-800 px-2 py-1"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-300">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function Text({
  label,
  value,
  setValue,
  mono,
  type,
}: {
  label: string
  value: string
  setValue: (value: string) => void
  mono?: boolean
  type?: 'text' | 'password'
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        type={type || 'text'}
        className={`rounded border border-slate-600 bg-slate-800 px-2 py-1 ${mono ? 'font-mono text-xs' : ''}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </label>
  )
}
