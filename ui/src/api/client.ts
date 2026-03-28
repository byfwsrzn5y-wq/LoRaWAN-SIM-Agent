import type { SimState } from '../types/simState'

/**
 * In dev, Vite proxies to the simulator control server (see vite.config.ts).
 * For production, set VITE_CONTROL_API_BASE to the full origin (no trailing slash).
 */
function apiOrigin(): string {
  const base = import.meta.env.VITE_CONTROL_API_BASE as string | undefined
  if (base && base.length > 0) return base.replace(/\/$/, '')
  return ''
}

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const o = apiOrigin()
  return o ? `${o}${p}` : p
}

export async function fetchSimState(signal?: AbortSignal): Promise<SimState> {
  const res = await fetch(apiUrl('/sim-state'), { signal })
  if (!res.ok) throw new Error(`GET /sim-state failed: ${res.status}`)
  return res.json() as Promise<SimState>
}

async function readJsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const errObj =
      json && typeof json === 'object' && json !== null && 'error' in json
        ? (json as { error?: { message?: string; code?: string } }).error
        : null
    const msg = errObj?.message || (typeof json === 'object' && json !== null ? JSON.stringify(json) : text) || res.statusText
    const err = new Error(`${res.status} ${msg}`)
    ;(err as Error & { status?: number; body?: unknown }).status = res.status
    ;(err as Error & { body?: unknown }).body = json
    throw err
  }
  return json
}

export async function postJson<T>(
  path: string,
  body: unknown,
  opts?: { idempotencyKey?: string; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: opts?.signal,
  })
  return readJsonOrThrow(res) as Promise<T>
}

export async function patchJson<T>(
  path: string,
  body: unknown,
  opts?: { idempotencyKey?: string; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  const res = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: opts?.signal,
  })
  return readJsonOrThrow(res) as Promise<T>
}

export async function deleteJson<T>(
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  const res = await fetch(apiUrl(path), {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: opts?.signal,
  })
  return readJsonOrThrow(res) as Promise<T>
}

export async function postStart(): Promise<{ ok?: boolean }> {
  const res = await fetch(apiUrl('/start'), { method: 'POST' })
  return res.json() as Promise<{ ok?: boolean }>
}

export async function postStop(): Promise<{ ok?: boolean }> {
  const res = await fetch(apiUrl('/stop'), { method: 'POST' })
  return res.json() as Promise<{ ok?: boolean }>
}

/** 立即从 ChirpStack REST 拉取设备/网关清单（需模拟器已启用拓扑导入且配置 token）。 */
export async function postChirpstackRefreshInventory(signal?: AbortSignal): Promise<{
  ok?: boolean
  data?: { ok?: boolean; skipped?: boolean; error?: { message?: string } }
}> {
  return postJson('/chirpstack/refresh-inventory', {}, { signal })
}

export interface ProfileConfigState {
  activeProfile?: string
  defaultProfile?: string
  availableProfiles?: string[]
  /** Relative path from main config file dir (JSON `profileConfig.profilesDir`), if set */
  profilesDir?: string
  /** Absolute directory where profile *.json files are read/written */
  profilesDirResolved?: string
  reloadRequired?: boolean
  message?: string
  /** Set on POST /config-profiles/create — absolute path to the new *.json file */
  path?: string
  applied?: { added?: number; updated?: number; removed?: number }
  reasons?: string[]
}

export async function saveConfigProfile(
  name: string,
  setDefault = false,
  overwrite = false,
): Promise<{ ok: boolean; data?: ProfileConfigState }> {
  return postJson<{ ok: boolean; data?: ProfileConfigState }>('/config-profiles/save', { name, setDefault, overwrite })
}

/**
 * Create an empty profile under profilesDir and hot-apply (does not write the main -c config file).
 * Use `autoName: true` to allocate `blank-<timestamp>` (UI default); otherwise pass `name` (+ optional `overwrite`).
 */
export async function createConfigProfile(opts: {
  autoName?: boolean
  name?: string
  setDefault?: boolean
  overwrite?: boolean
}): Promise<{ ok: boolean; data?: ProfileConfigState }> {
  return postJson<{ ok: boolean; data?: ProfileConfigState }>('/config-profiles/create', {
    autoName: opts.autoName === true,
    name: opts.name ?? '',
    setDefault: opts.setDefault === true,
    overwrite: opts.overwrite === true,
  })
}

export async function loadConfigProfile(
  name: string,
  setDefault?: boolean,
): Promise<{ ok: boolean; data?: ProfileConfigState }> {
  return postJson<{ ok: boolean; data?: ProfileConfigState }>('/config-profiles/load', { name, setDefault })
}

export async function applyConfigProfile(
  name: string,
  setDefault?: boolean,
): Promise<{ ok: boolean; data?: ProfileConfigState & { applied?: { added?: number; updated?: number; removed?: number }; reasons?: string[] } }> {
  return postJson('/config-profiles/apply', { name, setDefault })
}

export async function renameConfigProfile(
  from: string,
  to: string,
): Promise<{ ok: boolean; data?: ProfileConfigState }> {
  return postJson('/config-profiles/rename', { from, to })
}
