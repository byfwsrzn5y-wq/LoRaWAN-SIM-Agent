import { useEffect, useState } from 'react'
import type { ProfileConfigState } from '../api/client'

interface TopBarProps {
  running?: boolean
  layoutRevision?: number
  topologyDisplayEnabled?: boolean
  onStart: () => void
  onStop: () => void
  search: string
  onSearchChange: (v: string) => void
  profileState?: ProfileConfigState
  onLoadProfile?: (name: string, setDefault: boolean) => void
  onApplyProfile?: (name: string, setDefault: boolean) => void
  onSaveProfile?: (name: string, setDefault: boolean, overwrite: boolean) => void
  /** Create a blank profile with auto-generated name; does not overwrite the main -c file on disk. */
  onCreateProfile?: (opts: { setDefault: boolean }) => void
  onRenameProfile?: (from: string, to: string) => void
  busy?: boolean
  leftVisible?: boolean
  rightVisible?: boolean
  bottomVisible?: boolean
  onToggleLeft?: () => void
  onToggleRight?: () => void
  onToggleBottom?: () => void
}

export function TopBar({
  running,
  layoutRevision,
  topologyDisplayEnabled,
  onStart,
  onStop,
  search,
  onSearchChange,
  profileState,
  onLoadProfile,
  onApplyProfile,
  onSaveProfile,
  onCreateProfile,
  onRenameProfile,
  busy,
  leftVisible,
  rightVisible,
  bottomVisible,
  onToggleLeft,
  onToggleRight,
  onToggleBottom,
}: TopBarProps) {
  const currentProfile = profileState?.activeProfile || ''
  const profileList = Array.isArray(profileState?.availableProfiles) ? profileState.availableProfiles : []
  const hasProfiles = profileList.length > 0
  const [profileName, setProfileName] = useState('')
  const [setDefaultOnSave, setSetDefaultOnSave] = useState(false)
  const [overwriteOnSave, setOverwriteOnSave] = useState(false)
  useEffect(() => {
    setProfileName(currentProfile || 'default')
  }, [currentProfile])
  const normalizedName = profileName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
  const invalidName = profileName.trim().length === 0 || normalizedName.length === 0
  const duplicateName = hasProfiles && profileList.includes(normalizedName)
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-700 bg-slate-900 px-4 py-2 text-slate-100">
      <h1 className="text-lg font-semibold tracking-tight">LoRaWAN-SIM</h1>
      <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
        layout rev {layoutRevision ?? 0}
      </span>
      {topologyDisplayEnabled ? (
        <span
          className="rounded border border-teal-600/50 bg-teal-950/60 px-2 py-0.5 text-xs text-teal-200"
          title="已合并 ChirpStack 设备/网关清单与 MQTT rxInfo"
        >
          CS 拓扑
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        {running === false && (
          <span className="max-w-md rounded border border-amber-600/60 bg-amber-950/80 px-2 py-1 text-xs text-amber-200">
            已暂停：不会发送 Join / 上行，请点击 Start 或 POST /start
          </span>
        )}
        <span
          className={`h-2 w-2 rounded-full ${running ? 'bg-emerald-500' : 'bg-slate-500'}`}
          title={running ? 'running' : 'stopped'}
        />
        <button
          type="button"
          className="rounded bg-emerald-700 px-2 py-1 text-sm hover:bg-emerald-600"
          onClick={onStart}
        >
          Start
        </button>
        <button
          type="button"
          className="rounded bg-slate-700 px-2 py-1 text-sm hover:bg-slate-600"
          onClick={onStop}
        >
          Stop
        </button>
        <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600" onClick={onToggleLeft}>
          {leftVisible === false ? '显示左栏' : '隐藏左栏'}
        </button>
        <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600" onClick={onToggleRight}>
          {rightVisible === false ? '显示右栏' : '隐藏右栏'}
        </button>
        <button type="button" className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600" onClick={onToggleBottom}>
          {bottomVisible === false ? '显示下栏' : '隐藏下栏'}
        </button>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2 rounded border border-slate-700 bg-slate-800/60 px-2 py-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-slate-300">配置集</span>
          {profileState?.profilesDirResolved ? (
            <span
              className="max-w-[min(28rem,100%)] cursor-default truncate font-mono text-[10px] leading-tight text-slate-500"
              title={
                profileState.profilesDir
                  ? `profileConfig.profilesDir: ${profileState.profilesDir}\n${profileState.profilesDirResolved}`
                  : profileState.profilesDirResolved
              }
            >
              {profileState.profilesDirResolved}
            </span>
          ) : null}
        </div>
        <select
          className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          value={currentProfile}
          onChange={(e) => {
            const next = e.target.value
            if (!next || !onLoadProfile) return
            onLoadProfile(next, false)
          }}
          disabled={!hasProfiles || busy}
        >
          <option value="">{hasProfiles ? '选择配置' : '无配置'}</option>
          {profileList.map((name) => (
            <option key={name} value={name}>
              {name}
              {name === profileState?.defaultProfile ? ' (default)' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded bg-indigo-700 px-2 py-1 text-xs hover:bg-indigo-600 disabled:opacity-50"
          onClick={() => {
            if (!currentProfile || !onApplyProfile) return
            onApplyProfile(currentProfile, false)
          }}
          disabled={!currentProfile || busy}
          title="应用当前配置并热更新"
        >
          应用并热更新
        </button>
        <input
          className="w-32 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          placeholder="保存/重命名用"
          disabled={busy}
        />
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={setDefaultOnSave}
            onChange={(e) => setSetDefaultOnSave(e.target.checked)}
            disabled={busy}
          />
          默认
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={overwriteOnSave}
            onChange={(e) => setOverwriteOnSave(e.target.checked)}
            disabled={busy}
          />
          覆盖同名
        </label>
        <button
          type="button"
          className="rounded bg-violet-800 px-2 py-1 text-xs hover:bg-violet-700 disabled:opacity-50"
          onClick={() => {
            if (!onCreateProfile) return
            onCreateProfile({ setDefault: setDefaultOnSave })
          }}
          disabled={busy || !onCreateProfile}
          title="自动生成 blank-时间戳 文件名，仅在 profiles 目录新建 JSON；主 -c 配置不写入磁盘。热更新清空画布。"
        >
          新建配置
        </button>
        <button
          type="button"
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
          onClick={() => {
            if (!onSaveProfile || invalidName) return
            onSaveProfile(normalizedName, setDefaultOnSave, overwriteOnSave || duplicateName)
          }}
          disabled={invalidName || busy}
        >
          保存配置
        </button>
        <button
          type="button"
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
          onClick={() => {
            if (!onRenameProfile || !currentProfile || invalidName) return
            onRenameProfile(currentProfile, normalizedName)
          }}
          disabled={!currentProfile || invalidName || normalizedName === currentProfile || busy}
        >
          重命名
        </button>
        {invalidName ? <span className="text-[10px] text-amber-300">名称不能为空</span> : null}
        {!invalidName && duplicateName && !overwriteOnSave ? (
          <span className="text-[10px] text-amber-300">已存在同名，保存时将自动按覆盖处理</span>
        ) : null}
      </div>
      <input
        className="ml-auto min-w-[12rem] flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
        placeholder="Filter by name / EUI…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </header>
  )
}
