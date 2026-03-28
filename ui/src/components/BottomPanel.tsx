import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

interface BottomPanelProps {
  message: string | null
  packetLog: Array<{
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
  retryIds: string
  onRetryIdsChange: (v: string) => void
  onRetry: () => void
  busy?: boolean
}

interface PacketRow {
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

function rowKey(r: PacketRow): string {
  return [r.time || '', r.nodeId || '', r.gatewayEui || '', r.payload || '', r.type || '', r.status || ''].join('|')
}

function frameGroupKey(r: PacketRow): string {
  const node = String(r.nodeId || '')
  const fCnt = r.fCnt != null ? String(r.fCnt) : ''
  const type = String(r.type || 'data')
  if (node && fCnt) return `${node}|${fCnt}|${type}`
  return `${node}|${String(r.time || '').slice(0, 19)}|${type}`
}

export function BottomPanel({ message, packetLog, retryIds, onRetryIdsChange, onRetry, busy }: BottomPanelProps) {
  const [nodeFilter, setNodeFilter] = useState('')
  const [gwFilter, setGwFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const logContainerRef = useRef<HTMLDivElement>(null)
  const prevLatestKeyRef = useRef<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rows = useMemo(() => {
    const base = packetLog.slice(-500)
    return base
      .filter((r) => {
        if (nodeFilter && !String(r.nodeId || '').toLowerCase().includes(nodeFilter.toLowerCase())) return false
        if (gwFilter && !String(r.gatewayEui || '').toLowerCase().includes(gwFilter.toLowerCase())) return false
        if (statusFilter !== 'all' && String(r.status || 'ok').toLowerCase() !== statusFilter) return false
        if (keyword) {
          const hay = `${r.nodeId || ''} ${r.gatewayEui || ''} ${r.payload || ''} ${r.type || ''} ${r.status || ''}`.toLowerCase()
          if (!hay.includes(keyword.toLowerCase())) return false
        }
        return true
      })
      .slice(-120)
  }, [packetLog, nodeFilter, gwFilter, statusFilter, keyword])

  const groupedRows = useMemo(() => {
    const groups = new Map<string, PacketRow[]>()
    rows.forEach((r) => {
      const k = frameGroupKey(r)
      const list = groups.get(k)
      if (list) list.push(r)
      else groups.set(k, [r])
    })
    const out = Array.from(groups.entries()).map(([key, group]) => {
      const sorted = [...group].sort((a, b) => (Number(b.rssi ?? -999) - Number(a.rssi ?? -999)))
      return { key, primary: sorted[0]!, group: sorted, multi: sorted.length > 1 }
    })
    return out.reverse()
  }, [rows])

  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    packetLog.forEach((r) => set.add(String(r.status || 'ok').toLowerCase()))
    return ['all', ...Array.from(set)]
  }, [packetLog])

  const latestRowKey = groupedRows.length > 0 ? rowKey(groupedRows[groupedRows.length - 1]!.primary) : null

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!latestRowKey) {
      prevLatestKeyRef.current = null
      return
    }
    const prev = prevLatestKeyRef.current
    if (prev && prev !== latestRowKey) {
      setHighlightedKey(latestRowKey)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedKey((k) => (k === latestRowKey ? null : k))
      }, 1500)
    }
    prevLatestKeyRef.current = latestRowKey
  }, [latestRowKey])

  useEffect(() => {
    const el = logContainerRef.current
    if (!el) return
    if (!autoScroll || !isAtBottom) return
    el.scrollTop = el.scrollHeight
  }, [groupedRows, autoScroll, isAtBottom])

  const onLogScroll = () => {
    const el = logContainerRef.current
    if (!el) return
    const threshold = 24
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= threshold
    setIsAtBottom(atBottom)
  }

  const jumpToLatest = () => {
    const el = logContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setIsAtBottom(true)
  }

  return (
    <footer className="border-t border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-slate-500">Recent Packets</div>
          <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-4">
            <input
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
              placeholder="Filter Node (eui)"
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
            />
            <input
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
              placeholder="Filter Gateway (eui)"
              value={gwFilter}
              onChange={(e) => setGwFilter(e.target.value)}
            />
            <select
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs"
              placeholder="Keyword payload/type/status"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="mb-1 flex items-center justify-end gap-3 text-xs text-slate-400">
            <label className="inline-flex items-center gap-1">
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              Auto-scroll
            </label>
            {(!autoScroll || !isAtBottom) && (
              <button
                type="button"
                className="rounded border border-slate-700 px-2 py-0.5 text-slate-200 hover:bg-slate-800"
                onClick={jumpToLatest}
              >
                Jump to latest
              </button>
            )}
          </div>
          <div ref={logContainerRef} onScroll={onLogScroll} className="max-h-52 overflow-auto rounded border border-slate-800">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-900 text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Time</th>
                  <th className="px-2 py-1 text-left font-medium">Node</th>
                  <th className="px-2 py-1 text-left font-medium">Gateway</th>
                  <th className="px-2 py-1 text-left font-medium">RSSI</th>
                  <th className="px-2 py-1 text-left font-medium">SNR</th>
                  <th className="px-2 py-1 text-left font-medium">SF</th>
                  <th className="px-2 py-1 text-left font-medium">FCnt</th>
                  <th className="px-2 py-1 text-left font-medium">Payload</th>
                  <th className="px-2 py-1 text-left font-medium">Type</th>
                  <th className="px-2 py-1 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.length === 0 ? (
                  <tr>
                    <td className="px-2 py-2 text-slate-600" colSpan={10}>
                      No packet data yet.
                    </td>
                  </tr>
                ) : (
                  groupedRows.map((g, i) => {
                    const r = g.primary
                    const expanded = Boolean(expandedGroups[g.key])
                    return (
                      <Fragment key={`${g.key}-${i}`}>
                        <tr
                          className={`border-t border-slate-800/70 ${highlightedKey === rowKey(r) ? 'bg-cyan-900/30 transition-colors' : ''}`}
                        >
                          <td className="px-2 py-1 font-mono text-[11px] text-slate-400">{r.time ? new Date(r.time).toISOString().slice(11, 23) : '—'}</td>
                          <td className="px-2 py-1 font-mono text-[11px]">{r.nodeId?.slice(-8) || '—'}</td>
                          <td className="px-2 py-1 font-mono text-[11px] text-violet-300">
                            {r.gatewayEui?.slice(-8) || '—'}
                            {g.multi && (
                              <button
                                type="button"
                                className="ml-2 rounded border border-slate-700 px-1 text-[10px] text-slate-300 hover:bg-slate-800"
                                onClick={() => setExpandedGroups((prev) => ({ ...prev, [g.key]: !expanded }))}
                              >
                                {expanded ? `hide ${g.group.length - 1}` : `+${g.group.length - 1}`}
                              </button>
                            )}
                          </td>
                          <td className={`px-2 py-1 font-mono text-[11px] ${signalClass(r.rssi, r.snr)}`}>
                            {typeof r.rssi === 'number' ? r.rssi.toFixed(1) : '—'}
                          </td>
                          <td className={`px-2 py-1 font-mono text-[11px] ${signalClass(r.rssi, r.snr)}`}>
                            {typeof r.snr === 'number' ? r.snr.toFixed(1) : '—'}
                          </td>
                          <td className="px-2 py-1 font-mono text-[11px] text-slate-300">{typeof r.sf === 'number' ? `SF${r.sf}` : '—'}</td>
                          <td className="px-2 py-1 font-mono text-[11px] text-slate-300">{typeof r.fCnt === 'number' ? r.fCnt : '—'}</td>
                          <td className="max-w-36 truncate px-2 py-1 font-mono text-[11px] text-slate-400">{r.payload || '—'}</td>
                          <td className="px-2 py-1 uppercase text-[11px] text-slate-300">{r.type || 'data'}</td>
                          <td className="px-2 py-1 text-[11px] text-slate-300">{r.status || 'ok'}</td>
                        </tr>
                        {g.multi && expanded &&
                          g.group.slice(1).map((x, j) => (
                            <tr key={`${g.key}-sub-${j}`} className="border-t border-slate-800/40 bg-slate-900/60">
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-500">{x.time ? new Date(x.time).toISOString().slice(11, 23) : '—'}</td>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-500">{x.nodeId?.slice(-8) || '—'}</td>
                              <td className="px-2 py-1 font-mono text-[11px] text-violet-300">{x.gatewayEui?.slice(-8) || '—'}</td>
                              <td className={`px-2 py-1 font-mono text-[11px] ${signalClass(x.rssi, x.snr)}`}>{typeof x.rssi === 'number' ? x.rssi.toFixed(1) : '—'}</td>
                              <td className={`px-2 py-1 font-mono text-[11px] ${signalClass(x.rssi, x.snr)}`}>{typeof x.snr === 'number' ? x.snr.toFixed(1) : '—'}</td>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-500">{typeof x.sf === 'number' ? `SF${x.sf}` : '—'}</td>
                              <td className="px-2 py-1 font-mono text-[11px] text-slate-500">{typeof x.fCnt === 'number' ? x.fCnt : '—'}</td>
                              <td className="max-w-36 truncate px-2 py-1 font-mono text-[11px] text-slate-500">{x.payload || '—'}</td>
                              <td className="px-2 py-1 uppercase text-[11px] text-slate-500">{x.type || 'data'}</td>
                              <td className="px-2 py-1 text-[11px] text-slate-500">{x.status || 'ok'}</td>
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-xs font-medium text-slate-500">Activity</div>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-400">
            {message || '—'}
          </pre>

          <label className="text-xs text-slate-500">
            Retry resource IDs (comma-separated, empty = all queued)
            <input
              className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs"
              value={retryIds}
              onChange={(e) => onRetryIdsChange(e.target.value)}
              placeholder="18d3bf0000000001,19023c6b00000000"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            className="self-end rounded bg-amber-700 px-3 py-1 text-white hover:bg-amber-600 disabled:opacity-50"
            onClick={onRetry}
          >
            POST /sync/retry
          </button>
        </div>
      </div>
    </footer>
  )
}
