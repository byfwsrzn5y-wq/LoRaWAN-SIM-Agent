import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { layoutRevisionFromState } from './lib/layoutApply'
import { BottomPanel } from './components/BottomPanel'
import { CanvasBoard } from './components/CanvasBoard'
import { LeftPanel, type PanelTab } from './components/LeftPanel'
import {
  RightPanel,
  type GatewayResourcePayload,
  type NodeResourcePayload,
  type ScenarioResourcePayload,
  type RightView,
} from './components/RightPanel'
import { TopBar } from './components/TopBar'
import {
  applyConfigProfile,
  createConfigProfile,
  deleteJson,
  fetchSimState,
  loadConfigProfile,
  patchJson,
  postChirpstackRefreshInventory,
  postJson,
  postStart,
  postStop,
  renameConfigProfile,
  saveConfigProfile,
  type ProfileConfigState,
} from './api/client'
import type { TopologySource } from './types/simState'
function parseRetryIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function nodeBodyFromPayload(payload: Omit<NodeResourcePayload, 'mode'>) {
  const uplink: Record<string, unknown> = { codec: payload.uplinkCodec }
  if (payload.uplinkCodec === 'custom' && payload.uplinkPayload) {
    uplink.payload = payload.uplinkPayload
    uplink.payloadFormat = payload.uplinkPayloadFormat
  }
  const nodeState =
    payload.nodeStateMode === 'none'
      ? undefined
      : payload.nodeStateMode === 'fixed'
        ? {
            rssi: payload.nodeStateRssi,
            snr: payload.nodeStateSnr,
            txPowerIndex: payload.nodeStateTxPowerIndex,
          }
        : payload.nodeStateMode === 'random'
          ? { random: true }
          : (() => {
              try {
                return payload.nodeStateJson ? JSON.parse(payload.nodeStateJson) : undefined
              } catch {
                return undefined
              }
            })()
  const anomaly = (() => {
    try {
      return payload.anomalyJson ? JSON.parse(payload.anomalyJson) : undefined
    } catch {
      return undefined
    }
  })()
  return {
    name: payload.name,
    position: { x: payload.x, y: payload.y, z: payload.z },
    enabled: payload.enabled,
    radio: {
      intervalMs: payload.intervalMs,
      sf: payload.sf,
      txPower: payload.txPower,
      adr: payload.adr,
      fPort: payload.fPort,
    },
    uplink,
    chirpstack: {
      applicationId: payload.csApplicationId,
      deviceProfileId: payload.csDeviceProfileId,
      appKey: payload.csAppKey,
    },
    ...(nodeState ? { nodeState } : {}),
    ...(anomaly ? { anomaly } : {}),
    adrReject: payload.adrReject,
    devStatus: payload.devStatus,
    duplicateFirstData: payload.duplicateFirstData,
  }
}

function gatewayRadioFromPayload(p: Omit<GatewayResourcePayload, 'mode'>) {
  return {
    rxGain: p.rxGain,
    rxSensitivity: p.rxSensitivity,
    cableLoss: p.cableLoss,
    noiseFloor: p.noiseFloor,
  }
}

function incrementHex16(current: string): string {
  const clean = current.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  if (clean.length !== 16) return current
  const next = (BigInt(`0x${clean}`) + 1n).toString(16).padStart(16, '0')
  return next.slice(-16)
}

function batchNodeName(baseName: string, baseDevEui: string, targetDevEui: string, index: number): string {
  if (index === 0) return baseName
  const base = baseName.trim()
  const baseSuffix = baseDevEui.slice(-4).toLowerCase()
  const targetSuffix = targetDevEui.slice(-4).toLowerCase()
  if (base.endsWith(baseSuffix)) return `${base.slice(0, -4)}${targetSuffix}`
  const match = base.match(/^(.*?)-(\d+)$/)
  if (match) {
    const n = Number(match[2])
    const next = Number.isFinite(n) ? n + index : index + 1
    return `${match[1]}-${String(next).padStart(match[2].length, '0')}`
  }
  return `${base}-${String(index + 1).padStart(2, '0')}`
}

export default function App() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<PanelTab>('nodes')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [rightMode, setRightMode] = useState<'auto' | 'addNode' | 'addGateway' | 'scenario'>('auto')
  const [log, setLog] = useState<string | null>(null)
  const [retryIds, setRetryIds] = useState('')
  const [offlineThresholdSec, setOfflineThresholdSec] = useState(30)
  const [leftVisible, setLeftVisible] = useState(true)
  const [rightVisible, setRightVisible] = useState(true)
  const [bottomVisible, setBottomVisible] = useState(true)
  const [leftWidth, setLeftWidth] = useState(288)
  const [rightWidth, setRightWidth] = useState(320)
  const [bottomHeight, setBottomHeight] = useState(220)
  const [dragging, setDragging] = useState<null | 'left' | 'right' | 'bottom'>(null)
  const [sourceFilter, setSourceFilter] = useState<'all' | TopologySource>('all')

  const q = useQuery({
    queryKey: ['sim-state'],
    queryFn: ({ signal }) => fetchSimState(signal),
    refetchInterval: 4000,
  })

  const data = q.data
  const nodesAll = data?.nodes ?? []
  const gatewaysAll = data?.gateways ?? []
  const multiGatewayMode = useMemo(() => {
    const cfg = data?.config as { multiGateway?: { mode?: string } } | undefined
    return String(cfg?.multiGateway?.mode ?? '').toLowerCase()
  }, [data?.config])
  const signalModel = useMemo(() => {
    const cfg = data?.config as { signalModel?: Record<string, unknown> } | undefined
    return cfg?.signalModel as
      | {
          enabled?: boolean
          environment?: string
          txPower?: number
          txGain?: number
          rxGain?: number
          cableLoss?: number
          shadowFadingStd?: number
          fastFadingEnabled?: boolean
        }
      | undefined
  }, [data?.config])
  const profileState = useMemo(() => {
    const cfg = data?.config as { profileConfig?: ProfileConfigState } | undefined
    return cfg?.profileConfig
  }, [data?.config])

  const chirpCfg = useMemo(() => {
    const c = (data?.config as { chirpstack?: Record<string, unknown> } | undefined)?.chirpstack
    return c && typeof c === 'object' ? c : {}
  }, [data?.config])

  const selectedNode = useMemo(() => {
    if (!selectedKey?.startsWith('n:')) return undefined
    const eui = selectedKey.slice(2)
    return nodesAll.find((n) => n.eui === eui)
  }, [nodesAll, selectedKey])

  const selectedGateway = useMemo(() => {
    if (!selectedKey?.startsWith('g:')) return undefined
    const eui = selectedKey.slice(2)
    return gatewaysAll.find((g) => g.eui === eui)
  }, [gatewaysAll, selectedKey])

  const rightView: RightView = useMemo(() => {
    if (rightMode === 'addNode') return { type: 'addNode' }
    if (rightMode === 'addGateway') return { type: 'addGateway' }
    if (rightMode === 'scenario') return { type: 'scenario' }
    if (selectedNode) return { type: 'node', node: selectedNode }
    if (selectedGateway) return { type: 'gateway', gateway: selectedGateway }
    return { type: 'none' }
  }, [rightMode, selectedNode, selectedGateway])

  const pushLog = (msg: string) => {
    setLog(`${new Date().toISOString().slice(11, 23)} ${msg}`)
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sim-state'] })

  const createNodeMu = useMutation({
    mutationFn: async (payload: NodeResourcePayload & { mode: string; devEui: string; batchCount?: number }) => {
      pushLog(
        `POST /resources/nodes -> devEui=${payload.devEui.replace(/\s/g, '')} mode=${payload.mode} appId=${payload.csApplicationId} profileId=${payload.csDeviceProfileId}`,
      )
      const body = {
        mode: payload.mode,
        node: {
          devEui: payload.devEui.replace(/\s/g, ''),
          ...nodeBodyFromPayload(payload),
        },
      }
      return postJson<unknown>('/resources/nodes', body, {
        idempotencyKey: `create-node-${payload.devEui}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`create node: ${JSON.stringify(res)}`)
      setRightMode('auto')
      void invalidate()
    },
    onError: (e: unknown) => {
      const err: any = e
      const msg = err?.message || String(e)
      pushLog(`create node error: ${msg}`)
      // Also print rich error details for debugging.
      console.error('create node error:', err)
      if (err?.body) pushLog(`create node error body: ${JSON.stringify(err.body).slice(0, 1500)}`)
      else if (err?.status) pushLog(`create node error status: ${String(err.status)}`)
    },
  })

  const createGwMu = useMutation({
    mutationFn: async (payload: GatewayResourcePayload & { mode: string; gatewayId: string }) => {
      pushLog(
        `POST /resources/gateways -> gatewayId=${payload.gatewayId.replace(/\s/g, '')} mode=${payload.mode} tenantId=${payload.csTenantId}`,
      )
      const body = {
        mode: payload.mode,
        gateway: {
          gatewayId: payload.gatewayId.replace(/\s/g, ''),
          name: payload.name,
          position: { x: payload.x, y: payload.y, z: payload.z },
          radio: gatewayRadioFromPayload(payload),
          chirpstack: { tenantId: payload.csTenantId },
        },
      }
      return postJson<unknown>('/resources/gateways', body, {
        idempotencyKey: `create-gw-${payload.gatewayId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`create gateway: ${JSON.stringify(res)}`)
      setRightMode('auto')
      void invalidate()
    },
    onError: (e: unknown) => {
      const err: any = e
      const msg = err?.message || String(e)
      pushLog(`create gateway error: ${msg}`)
      console.error('create gateway error:', err)
      if (err?.body) pushLog(`create gateway error body: ${JSON.stringify(err.body).slice(0, 1500)}`)
    },
  })

  const patchNodeMu = useMutation({
    mutationFn: async (args: NodeResourcePayload & { devEui: string; mode: string }) => {
      const { devEui, mode, ...payload } = args
      const body = {
        mode,
        node: nodeBodyFromPayload(payload),
      }
      return patchJson<unknown>(`/resources/nodes/${devEui.replace(/\s/g, '')}`, body, {
        idempotencyKey: `patch-node-${devEui}-${Date.now()}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`patch node: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: (e: unknown) => {
      const err: any = e
      const msg = err?.message || String(e)
      pushLog(`patch node error: ${msg}`)
      console.error('patch node error:', err)
      if (err?.body) pushLog(`patch node error body: ${JSON.stringify(err.body).slice(0, 1500)}`)
    },
  })

  const patchGwMu = useMutation({
    mutationFn: async (args: GatewayResourcePayload & { gatewayId: string; mode: string }) => {
      const { gatewayId, mode, ...payload } = args
      const body = {
        mode,
        gateway: {
          name: payload.name,
          position: { x: payload.x, y: payload.y, z: payload.z },
          radio: gatewayRadioFromPayload(payload),
          chirpstack: { tenantId: payload.csTenantId },
        },
      }
      return patchJson<unknown>(`/resources/gateways/${gatewayId.replace(/\s/g, '')}`, body, {
        idempotencyKey: `patch-gw-${gatewayId}-${Date.now()}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`patch gateway: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: (e: unknown) => {
      const err: any = e
      const msg = err?.message || String(e)
      pushLog(`patch gateway error: ${msg}`)
      console.error('patch gateway error:', err)
      if (err?.body) pushLog(`patch gateway error body: ${JSON.stringify(err.body).slice(0, 1500)}`)
    },
  })

  const patchScenarioMu = useMutation({
    mutationFn: async (payload: ScenarioResourcePayload) => {
      const body = {
        mode: payload.mode,
        simulation: {
          multiGateway: {
            mode: payload.multiGatewayMode,
            primaryGateway: payload.primaryGateway,
          },
          udp: {
            protocol: payload.udpSocketFamily,
            port: payload.udpPort,
          },
          signalModel: {
            txPower: payload.txPower,
            txGain: payload.txGain,
            environment: payload.environment,
            shadowFadingStd: payload.shadowFadingStd,
            fastFadingEnabled: payload.fastFadingEnabled,
          },
          chirpstack: (() => {
            const ids = payload.chirpstackApplicationIdsCsv
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean)
            const cs: Record<string, unknown> = {
              baseUrl: payload.chirpstackBaseUrl,
              ...(payload.chirpstackApiToken ? { apiToken: payload.chirpstackApiToken } : {}),
              authHeader: payload.chirpstackAuthHeader,
              applicationId: payload.chirpstackApplicationId,
              deviceProfileId: payload.chirpstackDeviceProfileId,
              tenantId: payload.chirpstackTenantId,
              topologyEnabled: payload.chirpstackTopologyEnabled,
              inventoryPollSec: payload.chirpstackInventoryPollSec,
              rxStalenessSec: payload.chirpstackRxStalenessSec,
            }
            if (ids.length) cs.applicationIds = ids
            if (payload.chirpstackIntegrationMqttEnabled) {
              cs.integrationMqtt = {
                enabled: true,
                server: payload.chirpstackIntegrationMqttServer,
                username: payload.chirpstackIntegrationMqttUsername,
                ...(payload.chirpstackIntegrationMqttPassword
                  ? { password: payload.chirpstackIntegrationMqttPassword }
                  : {}),
              }
            } else {
              cs.integrationMqtt = { enabled: false }
            }
            return cs
          })(),
        },
      }
      return patchJson<unknown>('/resources/simulation', body, {
        idempotencyKey: `patch-sim-${Date.now()}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`patch scenario: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`patch scenario error: ${e.message}`),
  })

  const refreshCsInvMu = useMutation({
    mutationFn: () => postChirpstackRefreshInventory(),
    onSuccess: (res) => {
      pushLog(`chirpstack inventory refresh: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`chirpstack inventory refresh error: ${e.message}`),
  })

  const deleteNodeMu = useMutation({
    mutationFn: async (args: { devEui: string; mode: string }) => {
      return deleteJson<unknown>(`/resources/nodes/${args.devEui.replace(/\s/g, '')}`, { mode: args.mode }, {
        idempotencyKey: `delete-node-${args.devEui}-${Date.now()}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`delete node: ${JSON.stringify(res)}`)
      setRightMode('auto')
      setSelectedKey(null)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`delete node error: ${e.message}`),
  })

  const deleteGwMu = useMutation({
    mutationFn: async (args: { gatewayId: string; mode: string }) => {
      return deleteJson<unknown>(`/resources/gateways/${args.gatewayId.replace(/\s/g, '')}`, { mode: args.mode }, {
        idempotencyKey: `delete-gw-${args.gatewayId}-${Date.now()}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`delete gateway: ${JSON.stringify(res)}`)
      setRightMode('auto')
      setSelectedKey(null)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`delete gateway error: ${e.message}`),
  })

  const layoutMu = useMutation({
    mutationFn: async (payload: {
      revision: number
      items: Array<{
        id: string
        kind: 'node' | 'gateway'
        position: { x: number; y: number; z: number }
        revision: number
      }>
    }) => {
      return postJson<unknown>('/layout/apply', payload, {
        idempotencyKey: `layout-${payload.revision}-${payload.items.map((i) => i.id).join(',')}`,
      })
    },
    onSuccess: (res) => {
      pushLog(`layout apply: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: async (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      pushLog(`layout error: ${msg}`)
      const st =
        e && typeof e === 'object' && 'status' in e ? (e as { status?: number }).status : undefined
      if (st === 409) {
        pushLog('409 conflict — refetching /sim-state (reload remote)')
        await qc.invalidateQueries({ queryKey: ['sim-state'] })
      }
    },
  })

  const retryMu = useMutation({
    mutationFn: async (ids: string[]) => {
      return postJson<unknown>('/sync/retry', { resourceIds: ids })
    },
    onSuccess: (res) => {
      pushLog(`sync retry: ${JSON.stringify(res)}`)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`sync retry error: ${e.message}`),
  })
  const saveProfileMu = useMutation({
    mutationFn: async (args: { name: string; setDefault: boolean; overwrite?: boolean }) =>
      saveConfigProfile(args.name, args.setDefault, args.overwrite === true),
    onSuccess: () => {
      pushLog('save profile ok')
      void invalidate()
    },
    onError: (e: Error) => pushLog(`save profile error: ${e.message}`),
  })
  const loadProfileMu = useMutation({
    mutationFn: async (args: { name: string; setDefault?: boolean }) =>
      loadConfigProfile(args.name, args.setDefault),
    onSuccess: (res) => {
      const msg = res?.data?.message || 'profile loaded (restart simulator to fully apply runtime nodes/gateways)'
      pushLog(msg)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`load profile error: ${e.message}`),
  })
  const applyProfileMu = useMutation({
    mutationFn: async (args: { name: string; setDefault?: boolean }) =>
      applyConfigProfile(args.name, args.setDefault),
    onSuccess: (res) => {
      const msg = res?.data?.message || 'profile applied'
      pushLog(msg)
      void invalidate()
    },
    onError: (e: Error) => pushLog(`apply profile error: ${e.message}`),
  })
  const renameProfileMu = useMutation({
    mutationFn: async (args: { from: string; to: string }) => renameConfigProfile(args.from, args.to),
    onSuccess: (res) => {
      pushLog(res?.data?.message || 'profile renamed')
      void invalidate()
    },
    onError: (e: Error) => pushLog(`rename profile error: ${e.message}`),
  })
  const createProfileMu = useMutation({
    mutationFn: async (args: { setDefault: boolean }) =>
      createConfigProfile({ autoName: true, setDefault: args.setDefault }),
    onSuccess: (res) => {
      const p = res?.data?.path
      const msg = res?.data?.message
      const ap = res?.data?.applied as { added?: number; updated?: number; removed?: number } | undefined
      const lines = [
        msg || (p ? `新建配置已写入 — ${p}` : '新建配置完成'),
        ap != null ? `运行时: +${ap.added ?? 0} / ~${ap.updated ?? 0} / -${ap.removed ?? 0}` : null,
      ].filter(Boolean)
      pushLog(lines.join(' | '))
      setSelectedKey(null)
      void invalidate()
    },
    onError: (e: Error) => {
      const st = (e as Error & { status?: number }).status
      pushLog(
        st === 404
          ? '新建配置 404：控制面进程仍是旧版本。请停止后重新启动 simulator（需含 POST /config-profiles/create）；临时可用 POST /config-profiles/save 且 JSON 含 "mode":"blank"。'
          : `create profile error: ${e.message}`,
      )
    },
  })

  const busy =
    createNodeMu.isPending ||
    createGwMu.isPending ||
    patchNodeMu.isPending ||
    patchGwMu.isPending ||
    patchScenarioMu.isPending ||
    deleteNodeMu.isPending ||
    deleteGwMu.isPending ||
    layoutMu.isPending ||
    retryMu.isPending ||
    saveProfileMu.isPending ||
    loadProfileMu.isPending ||
    applyProfileMu.isPending ||
    renameProfileMu.isPending ||
    createProfileMu.isPending ||
    refreshCsInvMu.isPending

  const onStart = async () => {
    try {
      await postStart()
      pushLog('POST /start ok')
      void invalidate()
    } catch (e) {
      pushLog(`POST /start failed: ${(e as Error).message}`)
    }
  }

  const onStop = async () => {
    try {
      await postStop()
      pushLog('POST /stop ok')
      void invalidate()
    } catch (e) {
      pushLog(`POST /stop failed: ${(e as Error).message}`)
    }
  }

  const nodes = useMemo(() => {
    if (sourceFilter === 'all') return nodesAll
    return nodesAll.filter((n) => (n.source || 'simulator') === sourceFilter)
  }, [nodesAll, sourceFilter])
  const gateways = useMemo(() => {
    if (sourceFilter === 'all') return gatewaysAll
    return gatewaysAll.filter((g) => (g.source || 'simulator') === sourceFilter)
  }, [gatewaysAll, sourceFilter])
  const layoutRevision = layoutRevisionFromState(data?.layoutRevision)
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      if (dragging === 'left') {
        setLeftWidth(Math.min(520, Math.max(220, e.clientX)))
      } else if (dragging === 'right') {
        const w = window.innerWidth - e.clientX
        setRightWidth(Math.min(560, Math.max(260, w)))
      } else if (dragging === 'bottom') {
        const h = window.innerHeight - e.clientY
        setBottomHeight(Math.min(420, Math.max(140, h - 4)))
      }
    }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <TopBar
        running={data?.running}
        layoutRevision={layoutRevision}
        topologyDisplayEnabled={data?.topologyDisplayEnabled}
        onStart={onStart}
        onStop={onStop}
        search={search}
        onSearchChange={setSearch}
        profileState={profileState}
        busy={busy}
        onSaveProfile={(name, setDefault, overwrite) => {
          const n = name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
          if (!n) return
          void saveProfileMu.mutateAsync({ name: n, setDefault, overwrite })
        }}
        onCreateProfile={(opts) => {
          void createProfileMu.mutateAsync({ setDefault: opts.setDefault })
        }}
        onLoadProfile={(name, setDefault) => {
          void loadProfileMu.mutateAsync({ name, setDefault })
        }}
        onApplyProfile={(name, setDefault) => {
          void applyProfileMu.mutateAsync({ name, setDefault })
        }}
        onRenameProfile={(from, to) => {
          const src = from.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
          const dst = to.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
          if (!src || !dst || src === dst) return
          void renameProfileMu.mutateAsync({ from: src, to: dst })
        }}
        leftVisible={leftVisible}
        rightVisible={rightVisible}
        bottomVisible={bottomVisible}
        onToggleLeft={() => setLeftVisible((v) => !v)}
        onToggleRight={() => setRightVisible((v) => !v)}
        onToggleBottom={() => setBottomVisible((v) => !v)}
      />
      {q.isError && (
        <div className="bg-red-900/50 px-4 py-2 text-sm text-red-200">
          Cannot load /sim-state — is the simulator control server running? ({(q.error as Error).message})
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-row">
        {leftVisible ? <div style={{ width: leftWidth }} className="shrink-0 overflow-hidden"><LeftPanel
          tab={tab}
          onTab={(t) => {
            setTab(t)
            setRightMode('auto')
          }}
          nodes={nodes}
          gateways={gateways}
          packetLog={data?.packetLog ?? []}
          filter={search}
          selectedKey={selectedKey}
          onSelectNode={(eui) => {
            setSelectedKey(`n:${eui}`)
            setRightMode('auto')
          }}
          onSelectGateway={(eui) => {
            setSelectedKey(`g:${eui}`)
            setRightMode('auto')
          }}
          onAddNode={() => {
            setRightMode('addNode')
            setSelectedKey(null)
          }}
          onAddGateway={() => {
            setRightMode('addGateway')
            setSelectedKey(null)
          }}
          onScenario={() => {
            setRightMode('scenario')
            setSelectedKey(null)
          }}
          offlineThresholdSec={offlineThresholdSec}
          onOfflineThresholdSecChange={setOfflineThresholdSec}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          topologyDisplayEnabled={data?.topologyDisplayEnabled}
          chirpstackInventory={data?.chirpstackInventory}
          onRefreshChirpstackInventory={() => void refreshCsInvMu.mutate()}
          refreshChirpstackBusy={refreshCsInvMu.isPending}
          onDeleteNode={(eui) => {
            void deleteNodeMu.mutateAsync({ devEui: eui, mode: 'simulator_only' })
          }}
          onDeleteGateway={(eui) => {
            void deleteGwMu.mutateAsync({ gatewayId: eui, mode: 'simulator_only' })
          }}
          busy={busy}
          className="h-full w-full"
        /></div> : null}
        {leftVisible ? (
          <div
            className="w-1 shrink-0 cursor-col-resize bg-slate-800 hover:bg-slate-600"
            onMouseDown={() => setDragging('left')}
            title="拖拽调整左栏宽度"
          />
        ) : null}
        <CanvasBoard
          nodes={nodes}
          gateways={gateways}
          packetLog={data?.packetLog ?? []}
          offlineThresholdSec={offlineThresholdSec}
          multiGatewayMode={multiGatewayMode}
          signalModel={signalModel}
          layoutRevision={layoutRevision}
          selectedKey={selectedKey}
          onSelectNode={(eui) => {
            setSelectedKey(`n:${eui}`)
            setRightMode('auto')
          }}
          onSelectGateway={(eui) => {
            setSelectedKey(`g:${eui}`)
            setRightMode('auto')
          }}
          onApplyLayout={async (payload) => {
            await layoutMu.mutateAsync(payload)
          }}
        />
        {rightVisible ? (
          <div
            className="w-1 shrink-0 cursor-col-resize bg-slate-800 hover:bg-slate-600"
            onMouseDown={() => setDragging('right')}
            title="拖拽调整右栏宽度"
          />
        ) : null}
        {rightVisible ? <div style={{ width: rightWidth }} className="shrink-0 overflow-hidden"><RightPanel
          view={rightView}
          busy={busy}
          onCreateNode={async (p) => {
            const count = Math.max(1, Math.floor(p.batchCount || 1))
            let nextDevEui = p.devEui
            for (let i = 0; i < count; i += 1) {
              const name = batchNodeName(p.name, p.devEui, nextDevEui, i)
              await createNodeMu.mutateAsync({
                ...p,
                batchCount: 1,
                devEui: nextDevEui,
                name,
              })
              nextDevEui = incrementHex16(nextDevEui)
            }
          }}
          onCreateGateway={async (p) => {
            await createGwMu.mutateAsync(p)
          }}
          onUpdateNode={async (devEui, p) => {
            await patchNodeMu.mutateAsync({ devEui, ...p })
          }}
          onUpdateGateway={async (gatewayId, p) => {
            await patchGwMu.mutateAsync({ gatewayId, ...p })
          }}
          onDeleteNode={async (devEui, mode) => {
            await deleteNodeMu.mutateAsync({ devEui, mode })
          }}
          onDeleteGateway={async (gatewayId, mode) => {
            await deleteGwMu.mutateAsync({ gatewayId, mode })
          }}
          onUpdateScenario={async (payload) => {
            await patchScenarioMu.mutateAsync(payload)
          }}
          gateways={gatewaysAll}
          nodes={nodesAll}
          configSnapshot={{
            multiGatewayMode,
            primaryGateway: String(
              (data as { config?: { multiGateway?: { primaryGateway?: string } } } | undefined)?.config
                ?.multiGateway?.primaryGateway || '',
            ),
            txPower: signalModel?.txPower,
            txGain: signalModel?.txGain,
            environment: signalModel?.environment,
            shadowFadingStd: Number(signalModel?.shadowFadingStd ?? 8),
            fastFadingEnabled: Boolean(signalModel?.fastFadingEnabled ?? true),
            udpSocketFamily: String(
              (data as { config?: { udpSocketFamily?: string; udpFamily?: string } } | undefined)?.config
                ?.udpSocketFamily || (data as { config?: { udpFamily?: string } } | undefined)?.config?.udpFamily || 'udp4',
            ),
            udpPort: Number(
              (data as { config?: { lnsPort?: number } } | undefined)?.config?.lnsPort ??
                (data as { config?: { simulation?: { gateway?: { port?: number } } } } | undefined)?.config
                  ?.simulation?.gateway?.port ??
                1702,
            ),
            chirpstackBaseUrl: String((data as { config?: { chirpstack?: { baseUrl?: string } } } | undefined)?.config?.chirpstack?.baseUrl || 'http://127.0.0.1:8090'),
            chirpstackApiToken: '',
            chirpstackAuthHeader: String((data as { config?: { chirpstack?: { authHeader?: string } } } | undefined)?.config?.chirpstack?.authHeader || 'Grpc-Metadata-Authorization'),
            chirpstackApplicationId: String(
              (data as { config?: { chirpstack?: { applicationId?: string } } } | undefined)?.config?.chirpstack?.applicationId ?? '540a999c-9eeb-4c5c-bed1-778dacddaf46',
            ),
            chirpstackDeviceProfileId: String(
              (data as { config?: { chirpstack?: { deviceProfileId?: string } } } | undefined)?.config?.chirpstack?.deviceProfileId ?? 'a1b2c3d4-1111-2222-3333-444444444444',
            ),
            chirpstackTenantId: String(
              (data as { config?: { chirpstack?: { tenantId?: string } } } | undefined)?.config?.chirpstack?.tenantId ?? '81d48efb-6216-4c7f-8c21-46a5eac9d737',
            ),
            chirpstackTopologyEnabled: Boolean(chirpCfg.topologyEnabled),
            chirpstackInventoryPollSec:
              chirpCfg.inventoryPollSec != null ? Number(chirpCfg.inventoryPollSec) || 60 : 60,
            chirpstackRxStalenessSec: chirpCfg.rxStalenessSec != null ? Number(chirpCfg.rxStalenessSec) || 120 : 120,
            chirpstackApplicationIdsCsv: Array.isArray(chirpCfg.applicationIds)
              ? (chirpCfg.applicationIds as string[]).join(', ')
              : '',
            chirpstackIntegrationMqttEnabled: Boolean(
              chirpCfg.integrationMqtt && typeof chirpCfg.integrationMqtt === 'object'
                ? (chirpCfg.integrationMqtt as { enabled?: boolean }).enabled
                : false,
            ),
            chirpstackIntegrationMqttServer: String(
              chirpCfg.integrationMqtt && typeof chirpCfg.integrationMqtt === 'object'
                ? String((chirpCfg.integrationMqtt as { server?: string }).server || '')
                : '',
            ),
            chirpstackIntegrationMqttUsername: String(
              chirpCfg.integrationMqtt && typeof chirpCfg.integrationMqtt === 'object'
                ? String((chirpCfg.integrationMqtt as { username?: string }).username || '')
                : '',
            ),
          }}
          className="h-full w-full"
        /></div> : null}
        </div>
        {bottomVisible ? (
          <>
            <div
              className="h-1 shrink-0 cursor-row-resize bg-slate-800 hover:bg-slate-600"
              onMouseDown={() => setDragging('bottom')}
              title="拖拽调整下栏高度"
            />
            <div style={{ height: bottomHeight }} className="shrink-0 overflow-hidden">
              <BottomPanel
                message={log}
                packetLog={data?.packetLog ?? []}
                retryIds={retryIds}
                onRetryIdsChange={setRetryIds}
                busy={retryMu.isPending}
                onRetry={() => {
                  const ids = parseRetryIds(retryIds)
                  void retryMu.mutate(ids)
                }}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
