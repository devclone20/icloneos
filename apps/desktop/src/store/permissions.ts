import { atom } from 'nanostores'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import type {
  AuditRecordView,
  FunctionLevel,
  ModeScope,
  PermissionFunction,
  PermissionMode,
  PermissionStateView,
  SetFunctionLevelResultView,
  SetModeResultView
} from '@/iclone-shared/permissions'

/**
 * V3-F — the window's cache of main's permission state (Settings › Agent › Permissions). Main is the authority: this
 * store never decides, never writes a mode by itself, and refreshes from main on every change main announces.
 */
interface PermissionsStore {
  status: 'loading' | 'ready' | 'unavailable'
  state: PermissionStateView | null
  records: AuditRecordView[]
}

const RECORDS_SHOWN = 200

export const $permissions = atom<PermissionsStore>({ status: 'loading', state: null, records: [] })

function permissionsBridge(): IclonePermissionsBridge | undefined {
  return window.hermesDesktop?.icloneConsent?.permissions
}

let generation = 0

let openProject: string | null = null

/** `dir` is the project the window has open; main resolves it to the key the plugin uses. */
async function loadPermissions(dir: string | null = openProject): Promise<void> {
  openProject = dir
  const bridge = permissionsBridge()

  if (!bridge) {
    $permissions.set({ status: 'unavailable', state: null, records: [] })

    return
  }

  const mine = (generation += 1)
  const [state, records] = await Promise.all([bridge.state(dir), bridge.tail(0)])

  if (mine === generation) {
    $permissions.set({ status: 'ready', state, records: records.slice(-RECORDS_SHOWN) })
  }
}

/** Main pushes a sequence number on every audit record; the view re-reads (it never folds a counter itself). */
export function watchPermissions(dir: string | null): () => void {
  const off = permissionsBridge()?.onChanged(() => void loadPermissions().catch(() => undefined))

  void loadPermissions(dir).catch(() => undefined)

  return () => off?.()
}

/**
 * Call SYNCHRONOUSLY from the click handler of a control carrying `data-perm-mode-confirm`: the preload attaches the
 * proof of that click, and main refuses the change without it.
 */
export function requestPermissionMode(input: {
  mode: PermissionMode
  scope: ModeScope
  key?: string | null
}): Promise<SetModeResultView> {
  const bridge = permissionsBridge()

  if (!bridge) {
    return Promise.resolve({ ok: false, error: 'invalid', message: 'unavailable' })
  }

  return bridge.setMode(input)
}

/** Same rule as `requestPermissionMode`: only from the revoke button's own click handler. */
export function revokePermissionGrant(id: string): Promise<boolean> {
  return permissionsBridge()?.revoke(id) ?? Promise.resolve(false)
}

/**
 * V3-F2 — same rule as `requestPermissionMode`: only from the matrix cell's own click handler. A raise is confirmed on
 * a system dialog main shows; a lowering applies at once.
 */
export function requestFunctionLevel(input: {
  fn: PermissionFunction
  level: FunctionLevel
}): Promise<SetFunctionLevelResultView> {
  const bridge = permissionsBridge()

  if (!bridge) {
    return Promise.resolve({ ok: false, error: 'invalid', message: 'unavailable' })
  }

  return bridge.setFunctionLevel(input)
}
