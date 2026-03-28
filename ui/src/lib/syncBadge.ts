import type { SyncStatus } from '../types/simState'

export type BadgeLabel =
  | 'Pending'
  | 'Syncing'
  | 'Synced'
  | 'PartiallySynced'
  | 'SyncFailed'
  | '—'

export function syncStatusToBadge(s?: SyncStatus | null): {
  label: BadgeLabel
  className: string
} {
  if (!s?.state) return { label: '—', className: 'bg-slate-600 text-slate-200' }
  switch (s.state) {
    case 'local_dirty':
      return { label: 'Pending', className: 'bg-slate-500 text-white' }
    case 'syncing':
      return { label: 'Syncing', className: 'bg-blue-600 text-white' }
    case 'synced':
      return { label: 'Synced', className: 'bg-emerald-600 text-white' }
    case 'partial_success':
      return { label: 'PartiallySynced', className: 'bg-amber-600 text-white' }
    case 'error':
      return { label: 'SyncFailed', className: 'bg-red-600 text-white' }
    default:
      return { label: '—', className: 'bg-slate-600 text-slate-200' }
  }
}
