import type { SimGateway, SimNode, SimState, TopologySource } from '../types/simState'
import { syncStatusToBadge } from '../lib/syncBadge'

export type PanelTab = 'nodes' | 'gateways'

interface LeftPanelProps {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  nodes: SimNode[]
  gateways: SimGateway[]
  packetLog?: Array<{ gatewayEui?: string; nodeId?: string; type?: string; time?: string }>
  filter: string
  selectedKey: string | null
  onSelectNode: (eui: string) => void
  onSelectGateway: (eui: string) => void
  onDeleteNode: (eui: string) => void
  onDeleteGateway: (eui: string) => void
  onAddNode: () => void
  onAddGateway: () => void
  onScenario: () => void
  sourceFilter: 'all' | TopologySource
  onSourceFilterChange: (v: 'all' | TopologySource) => void
  topologyDisplayEnabled?: boolean
  chirpstackInventory?: SimState['chirpstackInventory']
  onRefreshChirpstackInventory?: () => void
  refreshChirpstackBusy?: boolean
  offlineThresholdSec: number
  onOfflineThresholdSecChange: (sec: number) => void
  busy?: boolean
  className?: string
}

function matchFilter(n: { name?: string; eui?: string }, f: string) {
  if (!f.trim()) return true
  const q = f.trim().toLowerCase()
  return (
    (n.name && n.name.toLowerCase().includes(q)) ||
    (n.eui && n.eui.toLowerCase().includes(q))
  )
}

function signalClass(rssi?: number, snr?: number): string {
  if (snr !== undefined && snr < -7) return 'text-orange-400'
  if (snr !== undefined && snr < 0) return 'text-amber-400'
  if (rssi !== undefined) {
    if (rssi >= -95) return 'text-emerald-400'
    if (rssi >= -110) return 'text-amber-400'
    return 'text-orange-400'
  }
  return 'text-slate-500'
}

function nodeStatusBadge(node: SimNode, offlineThresholdSec: number): { label: string; className: string } {
  if (!node.joined) return { label: '入网', className: 'text-violet-300' }
  const lastSeen = typeof node.lastSeen === 'string' ? Date.parse(node.lastSeen) : NaN
  const recentMs = Math.max(1, Math.floor(offlineThresholdSec || 30)) * 1000
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen <= recentMs) {
    return { label: '在线', className: 'text-emerald-300' }
  }
  return { label: '离线', className: 'text-slate-400' }
}

export function LeftPanel({
  tab,
  onTab,
  nodes,
  gateways,
  packetLog = [],
  filter,
  selectedKey,
  onSelectNode,
  onSelectGateway,
  onDeleteNode,
  onDeleteGateway,
  onAddNode,
  onAddGateway,
  onScenario,
  sourceFilter,
  onSourceFilterChange,
  topologyDisplayEnabled,
  chirpstackInventory,
  onRefreshChirpstackInventory,
  refreshChirpstackBusy,
  offlineThresholdSec,
  onOfflineThresholdSecChange,
  busy,
  className,
}: LeftPanelProps) {
  const fnodes = nodes.filter((n) => matchFilter(n, filter))
  const fgateways = gateways.filter((g) => matchFilter(g, filter))
  const gatewayRxCount = new Map<string, number>()
  packetLog.forEach((p) => {
    const key = String(p.gatewayEui || '').toLowerCase()
    if (!key) return
    gatewayRxCount.set(key, (gatewayRxCount.get(key) || 0) + 1)
  })

  const gatewayCoverageCount = new Map<string, number>()
  nodes.forEach((n) => {
    if (!Array.isArray(n.gatewayReceptions)) return
    n.gatewayReceptions.forEach((rx) => {
      const key = String(rx.gatewayEui || '').toLowerCase()
      if (!key) return
      gatewayCoverageCount.set(key, (gatewayCoverageCount.get(key) || 0) + 1)
    })
  })

  return (
    <aside className={`flex shrink-0 flex-col border-r border-slate-700 bg-slate-900 text-slate-100 ${className || 'w-72'}`}>
      <div className="flex border-b border-slate-700">
        <button
          type="button"
          className={`flex-1 py-2 text-sm font-medium ${tab === 'nodes' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
          onClick={() => onTab('nodes')}
        >
          Nodes
        </button>
        <button
          type="button"
          className={`flex-1 py-2 text-sm font-medium ${tab === 'gateways' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
          onClick={() => onTab('gateways')}
        >
          Gateways
        </button>
      </div>
      <div className="flex gap-2 border-b border-slate-700 p-2">
        {tab === 'nodes' ? (
          <button
            type="button"
            className="flex-1 rounded bg-blue-700 py-1.5 text-sm hover:bg-blue-600"
            onClick={onAddNode}
          >
            + Node
          </button>
        ) : (
          <button
            type="button"
            className="flex-1 rounded bg-blue-700 py-1.5 text-sm hover:bg-blue-600"
            onClick={onAddGateway}
          >
            + Gateway
          </button>
        )}
        <button
          type="button"
          className="rounded bg-slate-700 px-2 py-1.5 text-xs hover:bg-slate-600"
          onClick={onScenario}
        >
          Scenario
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-slate-800 px-2 py-1.5 text-[10px]">
        <span className="w-full text-slate-500">来源</span>
        {(['all', 'simulator', 'chirpstack'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`rounded px-1.5 py-0.5 ${
              sourceFilter === k ? 'bg-teal-800 text-teal-100' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
            onClick={() => onSourceFilterChange(k)}
          >
            {k === 'all' ? '全部' : k === 'simulator' ? '模拟' : 'CS'}
          </button>
        ))}
      </div>
      {topologyDisplayEnabled ? (
        <div className="space-y-1 border-b border-slate-800 px-2 py-1.5 text-[10px] text-slate-400">
          <div className="flex items-center justify-between gap-1">
            <span className="text-teal-400/90">ChirpStack 清单</span>
            <button
              type="button"
              disabled={Boolean(refreshChirpstackBusy || busy)}
              className="rounded bg-teal-900/80 px-1.5 py-0.5 text-teal-100 hover:bg-teal-800 disabled:opacity-50"
              onClick={() => onRefreshChirpstackInventory?.()}
            >
              {refreshChirpstackBusy ? '…' : '刷新'}
            </button>
          </div>
          {chirpstackInventory?.skipped ? (
            <p className="text-slate-500">拓扑未启用（请在 Scenario 打开 topologyEnabled）</p>
          ) : null}
          {chirpstackInventory?.error?.message ? (
            <p className="text-amber-300/90">{chirpstackInventory.error.message}</p>
          ) : null}
          {!chirpstackInventory?.skipped ? (
            <p className="font-mono text-[9px] text-slate-500">
              设备 {chirpstackInventory?.nodes?.length ?? 0} · 网关 {chirpstackInventory?.gateways?.length ?? 0}
              {chirpstackInventory?.updatedAt ? ` · ${chirpstackInventory.updatedAt.slice(11, 19)}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-b border-slate-800 px-2 py-1.5 text-xs">
        <span className="text-slate-500">离线阈值(s)</span>
        <input
          type="number"
          min={5}
          max={600}
          step={5}
          className="w-20 rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-slate-200"
          value={offlineThresholdSec}
          onChange={(e) => onOfflineThresholdSecChange(Math.max(5, Number(e.target.value) || 30))}
        />
      </div>
      <ul className="max-h-[40vh] overflow-auto text-sm">
        {tab === 'nodes'
          ? fnodes.map((n) => {
              const b = syncStatusToBadge(n.syncStatus)
              const key = `n:${n.eui}`
              const status = nodeStatusBadge(n, offlineThresholdSec)
              return (
                <li key={n.eui}>
                  <div className={`flex items-start gap-1 px-2 py-2 hover:bg-slate-800 ${selectedKey === key ? 'bg-slate-800' : ''}`}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelectNode(n.eui)}>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 rounded px-1.5 text-[10px] ${b.className}`}>{b.label}</span>
                        <span className={`shrink-0 rounded px-1.5 text-[10px] ${status.className}`}>{status.label}</span>
                        {(n.source || 'simulator') === 'chirpstack' ? (
                          <span className="shrink-0 rounded bg-teal-900/80 px-1 text-[9px] text-teal-200">CS</span>
                        ) : null}
                        <span className="truncate font-mono text-xs">{n.eui}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-slate-400">{n.name || 'node'}</span>
                        <span className={`font-mono ${signalClass(n.rssi, n.snr)}`}>
                          {typeof n.rssi === 'number' ? `${n.rssi.toFixed(1)} dBm` : '—'}
                        </span>
                      </div>
                    </button>
                    {(n.source || 'simulator') === 'chirpstack' ? (
                      <span className="px-1 text-[9px] text-slate-600" title="在 ChirpStack 中管理">
                        —
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
                        onClick={() => {
                          if (window.confirm(`Delete node ${n.eui}?`)) onDeleteNode(n.eui)
                        }}
                      >
                        Del
                      </button>
                    )}
                  </div>
                </li>
              )
            })
          : fgateways.map((g) => {
              const b = syncStatusToBadge(g.syncStatus)
              const key = `g:${g.eui}`
              return (
                <li key={g.eui}>
                  <div className={`flex items-start gap-1 px-2 py-2 hover:bg-slate-800 ${selectedKey === key ? 'bg-slate-800' : ''}`}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelectGateway(g.eui)}>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 rounded px-1.5 text-[10px] ${b.className}`}>{b.label}</span>
                        {(g.source || 'simulator') === 'chirpstack' ? (
                          <span className="shrink-0 rounded bg-teal-900/80 px-1 text-[9px] text-teal-200">CS</span>
                        ) : null}
                        <span className="truncate font-mono text-xs">{g.eui}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-slate-400">{g.name || 'gateway'}</span>
                        <span className="font-mono text-slate-500">RX {gatewayRxCount.get(g.eui.toLowerCase()) || 0}</span>
                        <span className="font-mono text-slate-500">Cover {gatewayCoverageCount.get(g.eui.toLowerCase()) || 0}</span>
                      </div>
                    </button>
                    {(g.source || 'simulator') === 'chirpstack' ? (
                      <span className="px-1 text-[9px] text-slate-600" title="在 ChirpStack 中管理">
                        —
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
                        onClick={() => {
                          if (window.confirm(`Delete gateway ${g.eui}?`)) onDeleteGateway(g.eui)
                        }}
                      >
                        Del
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
      </ul>
    </aside>
  )
}
