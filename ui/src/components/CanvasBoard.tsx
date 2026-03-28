import { useCallback, useMemo, useRef, useState } from 'react'
import type { SimGateway, SimNode } from '../types/simState'
import { syncStatusToBadge } from '../lib/syncBadge'

const DEBOUNCE_MS = 300
const PATH_LOSS_DISTANCE_MULTIPLIER = 10

function defaultNodePos(i: number): { x: number; y: number; z: number } {
  const col = i % 6
  const row = Math.floor(i / 6)
  return { x: 80 + col * 140, y: 80 + row * 120, z: 2 }
}

function defaultGwPos(i: number): { x: number; y: number; z: number } {
  const col = i % 3
  return { x: 100 + col * 200, y: 40, z: 30 }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

function nodeCenter(p: { x: number; y: number }) {
  return { x: p.x + 28, y: p.y + 24 }
}

function gwCenter(p: { x: number; y: number }) {
  return { x: p.x + 48, y: p.y + 28 }
}

const PATH_LOSS_EXPONENT: Record<string, number> = {
  'free-space': 2.0,
  suburban: 2.7,
  urban: 3.5,
  'dense-urban': 4.0,
  indoor: 4.0,
}

interface SignalModelLike {
  enabled?: boolean
  environment?: string
  txPower?: number
  txGain?: number
  rxGain?: number
  cableLoss?: number
}

interface RankedGatewayLink {
  gateway: SimGateway
  position: { x: number; y: number; z: number }
  estRssi: number
  actualRssi?: number
}

function estimateRssiByPathLoss(
  nodePos: { x: number; y: number; z?: number },
  gwPos: { x: number; y: number; z?: number },
  signalModel?: SignalModelLike,
  gateway?: SimGateway,
): number {
  const dx = (nodePos.x ?? 0) - (gwPos.x ?? 0)
  const dy = (nodePos.y ?? 0) - (gwPos.y ?? 0)
  const dz = (nodePos.z ?? 2) - (gwPos.z ?? 30)
  const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) * PATH_LOSS_DISTANCE_MULTIPLIER)
  const dKm = distance / 1000
  const fMhz = 923.2

  const fspl = 20 * Math.log10(dKm) + 20 * Math.log10(fMhz) + 32.44
  const env = String(signalModel?.environment ?? 'urban').toLowerCase()
  const exponent = PATH_LOSS_EXPONENT[env] ?? 3.5
  const envLoss = Math.max(0, (exponent - 2) * 10 * Math.log10(Math.max(0.1, dKm)))

  const gwRxGain = typeof gateway?.rxGain === 'number' ? gateway.rxGain : undefined
  const gwCableLoss = typeof gateway?.cableLoss === 'number' ? gateway.cableLoss : undefined
  const txPower = signalModel?.txPower ?? 16
  const txGain = signalModel?.txGain ?? 2.15
  const rxGain = gwRxGain ?? signalModel?.rxGain ?? 5
  const cableLoss = gwCableLoss ?? signalModel?.cableLoss ?? 0.5
  const totalLoss = fspl + envLoss + cableLoss
  return Math.round((txPower + txGain + rxGain - totalLoss) * 10) / 10
}

function estimateDistanceMeters(
  nodePos: { x: number; y: number; z?: number },
  gwPos: { x: number; y: number; z?: number },
): number {
  const dx = (nodePos.x ?? 0) - (gwPos.x ?? 0)
  const dy = (nodePos.y ?? 0) - (gwPos.y ?? 0)
  const dz = (nodePos.z ?? 2) - (gwPos.z ?? 30)
  return Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) * PATH_LOSS_DISTANCE_MULTIPLIER)
}

function formatDistance(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters)) return 'N/A'
  if (distanceMeters >= 1000) return `${(distanceMeters / 1000).toFixed(2)} km`
  return `${Math.round(distanceMeters)} m`
}

function rssiStrokeClass(rssi: number | undefined): string {
  if (rssi === undefined || Number.isNaN(rssi)) return 'stroke-slate-500'
  if (rssi >= -90) return 'stroke-emerald-500/80'
  if (rssi >= -105) return 'stroke-amber-500/70'
  return 'stroke-orange-600/70'
}

function signalClass(rssi?: number, snr?: number): string {
  if (snr !== undefined && snr < -7) return 'text-orange-300'
  if (snr !== undefined && snr < 0) return 'text-amber-300'
  if (rssi !== undefined) {
    if (rssi >= -95) return 'text-emerald-300'
    if (rssi >= -110) return 'text-amber-300'
    return 'text-orange-300'
  }
  return 'text-slate-400'
}

function frameTypeBadge(typeRaw?: string): { label: string; className: string } {
  const t = String(typeRaw || 'data').toLowerCase()
  if (t === 'join') return { label: '入网', className: 'text-violet-300' }
  if (t === 'confirmed' || t === 'confirmed-data') return { label: '确认', className: 'text-amber-300' }
  if (t === 'data' || t === 'unconfirmed') return { label: '数据', className: 'text-cyan-300' }
  return { label: '未知', className: 'text-slate-400' }
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

interface CanvasBoardProps {
  nodes: SimNode[]
  gateways: SimGateway[]
  packetLog?: Array<{ nodeId?: string; gatewayEui?: string; type?: string; time?: string }>
  offlineThresholdSec: number
  multiGatewayMode?: string
  signalModel?: SignalModelLike
  layoutRevision: number
  selectedKey: string | null
  onSelectNode: (eui: string) => void
  onSelectGateway: (eui: string) => void
  onApplyLayout: (args: {
    revision: number
    items: Array<{ id: string; kind: 'node' | 'gateway'; position: { x: number; y: number; z: number }; revision: number }>
  }) => Promise<unknown>
}

export function CanvasBoard({
  nodes,
  gateways,
  packetLog = [],
  offlineThresholdSec,
  multiGatewayMode,
  signalModel,
  layoutRevision,
  selectedKey,
  onSelectNode,
  onSelectGateway,
  onApplyLayout,
}: CanvasBoardProps) {
  const [localPos, setLocalPos] = useState<Record<string, { x: number; y: number; z: number }>>({})
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [showNodeInfo, setShowNodeInfo] = useState(true)
  const [hoveredNodeEui, setHoveredNodeEui] = useState<string | null>(null)
  const panDragRef = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  const dragRef = useRef<{
    id: string
    kind: 'node' | 'gateway'
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingApplyRef = useRef<{
    revision: number
    items: Array<{ id: string; kind: 'node' | 'gateway'; position: { x: number; y: number; z: number }; revision: number }>
  } | null>(null)
  const dragPosRef = useRef<{ id: string; kind: 'node' | 'gateway'; position: { x: number; y: number; z: number } } | null>(
    null,
  )

  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; z: number }>()
    nodes.forEach((n, i) => {
      const p = localPos[`n:${n.eui}`] ?? n.position ?? defaultNodePos(i)
      map.set(n.eui, { x: p.x, y: p.y, z: p.z ?? 2 })
    })
    return map
  }, [nodes, localPos])

  const gwPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number; z: number }>()
    gateways.forEach((g, i) => {
      const p = localPos[`g:${g.eui}`] ?? g.position ?? defaultGwPos(i)
      map.set(g.eui, { x: p.x, y: p.y, z: p.z ?? 30 })
    })
    return map
  }, [gateways, localPos])

  const worldSize = useMemo(() => {
    let maxX = 400
    let maxY = 400
    const bump = (x: number, y: number, w: number, h: number) => {
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    }
    nodes.forEach((n, i) => {
      const p = nodePositions.get(n.eui) ?? defaultNodePos(i)
      bump(p.x, p.y, 240, 88)
    })
    gateways.forEach((g, i) => {
      const p = gwPositions.get(g.eui) ?? defaultGwPos(i)
      bump(p.x, p.y, 160, 100)
    })
    return { width: maxX + 160, height: maxY + 160 }
  }, [nodes, gateways, nodePositions, gwPositions])

  const linkSegments = useMemo(() => {
    const segs: Array<{
      x1: number
      y1: number
      x2: number
      y2: number
      labelX: number
      labelY: number
      rssi?: number
      snr?: number
      distanceMeters: number
      secondary?: boolean
      gatewayEui: string
      nodeEui: string
      key: string
    }> = []
    const isOverlapping = multiGatewayMode === 'overlapping'
    nodes.forEach((n, i) => {
      const npRaw = nodePositions.get(n.eui) ?? defaultNodePos(i)
      const np = npRaw
      const a = nodeCenter(np)
      const rxByGw = new Map<string, { rssi?: number; snr?: number }>()
      if (Array.isArray(n.gatewayReceptions)) {
        n.gatewayReceptions.forEach((rx) => {
          const key = String(rx.gatewayEui || '').toLowerCase()
          if (key) rxByGw.set(key, { rssi: rx.rssi, snr: rx.snr })
        })
      }
      const ranked: RankedGatewayLink[] = gateways
        .map((g, gi) => {
          const gpRaw = gwPositions.get(g.eui) ?? defaultGwPos(gi)
          const gp = gpRaw
          const actual = rxByGw.get(g.eui.toLowerCase())
          return {
            gateway: g,
            position: gp,
            estRssi: estimateRssiByPathLoss(npRaw, gpRaw, signalModel, g),
            actualRssi: typeof actual?.rssi === 'number' ? actual.rssi : undefined,
          }
        })
        .sort((x, y) => (y.actualRssi ?? y.estRssi) - (x.actualRssi ?? x.estRssi))
      if (isOverlapping) {
        const primaryGwEui = ranked[0]?.gateway.eui
        ranked.forEach((item) => {
          const b = gwCenter(item.position)
          const isPrimary = item.gateway.eui === primaryGwEui
          const distanceMeters = estimateDistanceMeters(npRaw, item.position)
          segs.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            labelX: (a.x + b.x) / 2,
            labelY: (a.y + b.y) / 2,
            rssi: item.actualRssi ?? item.estRssi,
            snr: rxByGw.get(item.gateway.eui.toLowerCase())?.snr,
            distanceMeters,
            secondary: !isPrimary,
            gatewayEui: item.gateway.eui,
            nodeEui: n.eui,
            key: `link-${n.eui}-${item.gateway.eui}`,
          })
        })
        return
      }
      const best = ranked[0]
      if (!best) return
      const b = gwCenter(best.position)
      const distanceMeters = estimateDistanceMeters(npRaw, best.position)
      segs.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        labelX: (a.x + b.x) / 2,
        labelY: (a.y + b.y) / 2,
        rssi: best.actualRssi ?? best.estRssi,
        snr: rxByGw.get(best.gateway.eui.toLowerCase())?.snr,
        distanceMeters,
        secondary: false,
        gatewayEui: best.gateway.eui,
        nodeEui: n.eui,
        key: `link-${n.eui}-${best.gateway.eui}`,
      })
    })
    return segs
  }, [nodes, gateways, nodePositions, gwPositions, multiGatewayMode, signalModel])

  const latestFrameTypeByNode = useMemo(() => {
    const map = new Map<string, string>()
    packetLog.forEach((p) => {
      const key = String(p.nodeId || '').toLowerCase()
      const type = String(p.type || '').trim().toLowerCase()
      if (key && type) map.set(key, type)
    })
    return map
  }, [packetLog])

  const gatewayRxCount = useMemo(() => {
    const map = new Map<string, number>()
    packetLog.forEach((p) => {
      const key = String(p.gatewayEui || '').toLowerCase()
      if (!key) return
      map.set(key, (map.get(key) || 0) + 1)
    })
    return map
  }, [packetLog])

  const gatewayCoverageCount = useMemo(() => {
    const map = new Map<string, number>()
    nodes.forEach((n) => {
      if (!Array.isArray(n.gatewayReceptions)) return
      const seen = new Set<string>()
      n.gatewayReceptions.forEach((rx) => {
        const key = String(rx.gatewayEui || '').toLowerCase()
        if (!key || seen.has(key)) return
        seen.add(key)
        map.set(key, (map.get(key) || 0) + 1)
      })
    })
    return map
  }, [nodes])

  const gatewayOnlineCount = useMemo(() => {
    const map = new Map<string, number>()
    const recentMs = Math.max(1, Math.floor(offlineThresholdSec || 30)) * 1000
    nodes.forEach((n) => {
      const lastSeen = typeof n.lastSeen === 'string' ? Date.parse(n.lastSeen) : NaN
      const online = Boolean(n.joined) && Number.isFinite(lastSeen) && Date.now() - lastSeen <= recentMs
      if (!online || !Array.isArray(n.gatewayReceptions)) return
      const seen = new Set<string>()
      n.gatewayReceptions.forEach((rx) => {
        const key = String(rx.gatewayEui || '').toLowerCase()
        if (!key || seen.has(key)) return
        seen.add(key)
        map.set(key, (map.get(key) || 0) + 1)
      })
    })
    return map
  }, [nodes, offlineThresholdSec])

  const linkHint = multiGatewayMode === 'overlapping'
    ? '连线：每个节点到全部网关（优先真实RSSI，缺失时按路径衰减估算）'
    : '连线：节点到最优网关（优先真实RSSI，缺失时按路径衰减估算）'

  const flushApply = useCallback(async () => {
    const pending = pendingApplyRef.current
    pendingApplyRef.current = null
    if (!pending?.items.length) return
    await onApplyLayout(pending)
  }, [onApplyLayout])

  const scheduleApply = useCallback(
    (payload: {
      revision: number
      items: Array<{ id: string; kind: 'node' | 'gateway'; position: { x: number; y: number; z: number }; revision: number }>
    }) => {
      pendingApplyRef.current = payload
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void flushApply()
      }, DEBOUNCE_MS)
    },
    [flushApply],
  )

  const onPointerDownItem =
    (kind: 'node' | 'gateway', id: string) => (e: React.PointerEvent) => {
      e.stopPropagation()
      const pos = kind === 'node' ? nodePositions.get(id) : gwPositions.get(id)
      if (!pos) return
      dragRef.current = {
        id,
        kind,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (d) {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      const nx = d.origX + dx / zoom
      const ny = d.origY + dy / zoom
      const key = d.kind === 'node' ? `n:${d.id}` : `g:${d.id}`
      const z = d.kind === 'node' ? 2 : 30
      dragPosRef.current = { id: d.id, kind: d.kind, position: { x: nx, y: ny, z } }
      setLocalPos((prev) => ({ ...prev, [key]: { x: nx, y: ny, z } }))
      return
    }
    const p = panDragRef.current
    if (p) {
      setPan({
        x: p.px + (e.clientX - p.cx),
        y: p.py + (e.clientY - p.cy),
      })
    }
  }

  const endPanOrDrag = (e: React.PointerEvent) => {
    const wasPanning = Boolean(panDragRef.current)
    const d = dragRef.current
    dragRef.current = null
    panDragRef.current = null
    if (wasPanning && viewportRef.current) {
      try {
        viewportRef.current.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    if (d) {
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const pos = dragPosRef.current
      dragPosRef.current = null
      if (!pos || pos.id !== d.id) return
      scheduleApply({
        revision: layoutRevision,
        items: [
          {
            id: pos.id.toLowerCase(),
            kind: pos.kind,
            position: pos.position,
            revision: 0,
          },
        ],
      })
    }
  }

  const onViewportPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-canvas-item]')) return
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    panDragRef.current = { cx: e.clientX, cy: e.clientY, px: pan.x, py: pan.y }
    viewportRef.current?.setPointerCapture(e.pointerId)
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    setZoom((z) => clamp(z + delta, 0.2, 3))
  }

  const fitAll = useCallback(() => {
    setPan({ x: 24, y: 24 })
    setZoom(1)
  }, [])

  return (
    <div className="flex min-h-[360px] min-w-0 flex-1 flex-col bg-slate-950">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 px-2 py-1.5 text-xs text-slate-400">
        <span>拖拽节点/网关更新布局（{DEBOUNCE_MS}ms 防抖）</span>
        <span className="text-slate-600">|</span>
        <span>在空白处按住左键拖拽平移地图</span>
        <span className="text-slate-600">|</span>
        <span>Ctrl/⌘ + 滚轮缩放</span>
        <span className="text-slate-600">|</span>
        <span className="text-slate-500">{linkHint}</span>
        <span className="text-slate-600">|</span>
        <span className="text-slate-500">路径损耗计算距离倍率 x{PATH_LOSS_DISTANCE_MULTIPLIER}</span>
        <button
          type="button"
          className="ml-auto rounded bg-slate-700 px-2 py-0.5 text-slate-200 hover:bg-slate-600"
          onClick={fitAll}
        >
          重置视图
        </button>
        <button
          type="button"
          className={`rounded px-2 py-0.5 ${showNodeInfo ? 'bg-cyan-700 text-cyan-100 hover:bg-cyan-600' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'}`}
          onClick={() => setShowNodeInfo((v) => !v)}
        >
          节点信息：{showNodeInfo ? '全显' : '隐藏'}
        </button>
        <span className="font-mono text-slate-500">{Math.round(zoom * 100)}%</span>
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-[320px] flex-1 overflow-hidden"
        onPointerDown={onViewportPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPanOrDrag}
        onPointerLeave={endPanOrDrag}
        onWheel={onWheel}
      >
        <div
          className="pointer-events-none absolute left-0 top-0 will-change-transform"
          style={{
            width: worldSize.width,
            height: worldSize.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={worldSize.width}
            height={worldSize.height}
            aria-hidden
          >
            {linkSegments.map((s) => (
              <line
                key={s.key}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                stroke="currentColor"
                strokeWidth={s.secondary ? 1 : 1.8}
                strokeDasharray={s.secondary ? '3 7' : '6 4'}
                className={`${rssiStrokeClass(s.rssi)} ${s.secondary ? 'opacity-50' : ''}`}
              >
                <title>{`Node ${s.nodeEui} -> Gateway ${s.gatewayEui} | RSSI ${
                  typeof s.rssi === 'number' ? s.rssi.toFixed(1) : 'N/A'
                } dBm | SNR ${typeof s.snr === 'number' ? s.snr.toFixed(1) : 'N/A'} dB | Distance ${formatDistance(s.distanceMeters)}`}</title>
              </line>
            ))}
            {linkSegments.map((s) => (
              <g key={`${s.key}-distance`} className={s.secondary ? 'opacity-60' : ''}>
                <rect
                  x={s.labelX - 20}
                  y={s.labelY - 8}
                  width={40}
                  height={14}
                  rx={4}
                  fill="rgb(15 23 42 / 0.85)"
                  stroke="rgb(51 65 85 / 0.8)"
                  strokeWidth={0.6}
                />
                <text
                  x={s.labelX}
                  y={s.labelY + 2}
                  textAnchor="middle"
                  className="fill-slate-200 text-[9px] font-mono"
                >
                  {formatDistance(s.distanceMeters)}
                </text>
              </g>
            ))}
          </svg>

          {gateways.map((g, i) => {
            const pRaw = gwPositions.get(g.eui) ?? defaultGwPos(i)
            const p = pRaw
            const b = syncStatusToBadge(g.syncStatus)
            const key = `g:${g.eui}`
            return (
              <button
                key={g.eui}
                type="button"
                data-canvas-item
                className={`pointer-events-auto absolute flex h-24 w-36 cursor-grab flex-col rounded-xl border bg-gradient-to-br p-2 text-left text-xs shadow-lg active:cursor-grabbing ${
                  (g.source || 'simulator') === 'chirpstack'
                    ? 'border-teal-500/70 from-teal-950/95 to-slate-900/90 shadow-teal-950/40'
                    : 'border-violet-500/70 from-violet-950/95 to-slate-900/90 shadow-violet-950/50'
                } ${selectedKey === key ? 'ring-2 ring-amber-400' : ''}`}
                style={{ left: p.x, top: p.y, zIndex: 20 }}
                onPointerDown={onPointerDownItem('gateway', g.eui)}
                onPointerMove={onPointerMove}
                onPointerUp={endPanOrDrag}
                onPointerCancel={endPanOrDrag}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectGateway(g.eui)
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-1">
                  <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-200">GW</span>
                  <span className={`rounded px-1 text-[9px] ${b.className}`}>{b.label}</span>
                </div>
                <span className="truncate text-[11px] font-medium text-violet-100">{g.name || 'gateway'}</span>
                <span className="font-mono text-[10px] text-violet-300/90">{g.eui.slice(-8)}</span>
                <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-300">
                  <span>RX {gatewayRxCount.get(g.eui.toLowerCase()) || 0}</span>
                  <span>覆盖 {gatewayCoverageCount.get(g.eui.toLowerCase()) || 0}</span>
                  <span className="col-span-2 text-emerald-300">在线节点 {gatewayOnlineCount.get(g.eui.toLowerCase()) || 0}</span>
                </div>
              </button>
            )
          })}
          {nodes.map((n, i) => {
            const pRaw = nodePositions.get(n.eui) ?? defaultNodePos(i)
            const p = pRaw
            const key = `n:${n.eui}`
            const frame = frameTypeBadge(latestFrameTypeByNode.get(n.eui.toLowerCase()))
            const status = nodeStatusBadge(n, offlineThresholdSec)
            const dr = typeof n.simulator?.sf === 'number' ? n.simulator.sf : undefined
            const frameTail = frame.label === '数据' ? '' : ` ${frame.label}`
            const infoVisible = showNodeInfo || hoveredNodeEui === n.eui
            const anomaly = n.anomaly && typeof n.anomaly === 'object' ? (n.anomaly as { enabled?: boolean; scenario?: string }) : null
            const anomalyEnabled = Boolean(anomaly && anomaly.enabled)
            const anomalyScenario = anomalyEnabled ? String(anomaly?.scenario || 'unknown') : ''
            return (
              <div
                key={n.eui}
                className="pointer-events-none absolute"
                style={{ left: p.x, top: p.y, zIndex: 10 }}
              >
                <button
                  type="button"
                  data-canvas-item
                  className={`pointer-events-auto flex h-11 w-11 cursor-grab items-center justify-center rounded-full border-2 text-[10px] font-mono shadow-lg active:cursor-grabbing ${
                    (n.source || 'simulator') === 'chirpstack'
                      ? 'border-teal-400/85 bg-teal-950/90 text-teal-100 shadow-teal-950/50'
                      : 'border-cyan-500/80 bg-cyan-900/90 text-cyan-100 shadow-cyan-950/50'
                  } ${selectedKey === key ? 'ring-2 ring-amber-400' : ''}`}
                  onPointerDown={onPointerDownItem('node', n.eui)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endPanOrDrag}
                  onPointerCancel={endPanOrDrag}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectNode(n.eui)
                  }}
                  onMouseEnter={() => setHoveredNodeEui(n.eui)}
                  onMouseLeave={() => setHoveredNodeEui((prev) => (prev === n.eui ? null : prev))}
                >
                  {n.eui.slice(-4)}
                </button>
                {anomalyEnabled ? (
                  <span className="pointer-events-none absolute -right-1 -top-1 rounded-full border border-amber-400/70 bg-amber-500/20 px-1 text-[10px] font-bold leading-4 text-amber-200">
                    !
                  </span>
                ) : null}
                {infoVisible ? (
                  <div
                    className={`pointer-events-none absolute left-14 top-[-6px] min-w-[168px] rounded-lg border bg-slate-900/88 px-2 py-1.5 text-[11px] shadow-lg backdrop-blur-[1px] ${
                      selectedKey === key ? 'border-amber-400/60' : 'border-slate-700/80'
                    }`}
                  >
                    <div className="mb-0.5 flex items-center gap-2">
                      <span className={`rounded px-1 text-[10px] ${status.className}`}>{status.label}</span>
                      <span className="truncate text-slate-200">{n.name || `node-${n.eui.slice(-4)}`}</span>
                    </div>
                    <div className="font-mono text-[10px] text-slate-400">{n.eui}</div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono">
                      <span className={`text-[10px] ${frame.className}`}>F{n.fCnt ?? 0}{frameTail}</span>
                      <span className="text-[10px] text-slate-300">DR {dr ?? '--'}</span>
                      <span className={`text-[10px] ${signalClass(n.rssi, n.snr)}`}>
                        {typeof n.rssi === 'number' ? `${n.rssi.toFixed(1)} dBm` : 'RSSI —'}
                      </span>
                      <span className={`text-[10px] ${signalClass(n.rssi, n.snr)}`}>
                        {typeof n.snr === 'number' ? `${n.snr.toFixed(1)} dB` : 'SNR —'}
                      </span>
                    </div>
                    {anomalyEnabled ? (
                      <div className="mt-0.5 text-[10px] text-amber-300">异常: {anomalyScenario}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
