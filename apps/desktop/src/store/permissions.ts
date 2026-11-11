import { atom } from 'nanostores'

import type { IclonePermissionsBridge } from '@/components/consent/types'
import type {
  AuditRecordView,
  ChoiceScope,
  FunctionLevel,
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

/** Watchers that show the audit records. The Message bar reads only the state, on every record of every tool call. */
let recordReaders = 0

/** `dir` is the project the window has open; main resolves it to the key the plugin uses. */
async function loadPermissions(dir: string | null = openProject): Promise<void> {
  openProject = dir
  const bridge = permissionsBridge()

  if (!bridge) {
    $permissions.set({ status: 'unavailable', state: null, records: [] })

    return
  }

  const mine = (generation += 1)
  const [state, records] = await Promise.all([bridge.state(dir), recordReaders > 0 ? bridge.tail(0) : null])

  if (mine === generation) {
    $permissions.set({
      status: 'ready',
      state,
      records: records ? records.slice(-RECORDS_SHOWN) : $permissions.get().records
    })
  }
}

/** Main pushes a sequence number on every audit record; the view re-reads (it never folds a counter itself). */
export function watchPermissions(dir: string | null, { records = true }: { records?: boolean } = {}): () => void {
  recordReaders += records ? 1 : 0

  const off = permissionsBridge()?.onChanged(refreshPermissions)

  void loadPermissions(dir).catch(() => undefined)

  return () => {
    recordReaders -= records ? 1 : 0
    off?.()
  }
}

let refreshing = false
let refreshAgain = false

/** A burst of records costs one read at a time, and the last read always starts after the last record. */
function refreshPermissions(): void {
  if (refreshing) {
    refreshAgain = true

    return
  }

  refreshing = true
  void loadPermissions()
    .catch(() => undefined)
    .finally(() => {
      refreshing = false

      if (refreshAgain) {
        refreshAgain = false
        refreshPermissions()
      }
    })
}

/**
 * What decides for the open project, and where a change to it goes: the project's own mode if it has one, else the
 * standing one, so the Message bar and Settings › Agent › Permissions write the same record and can never disagree. `chosen` is
 * the stored choice, `inForce` what main enforces (an unsealed launch clamps every mode to Manual).
 */
export function barMode(
  state: PermissionStateView,
  sessionId: null | string = null
): {
  chosen: PermissionMode
  inForce: PermissionMode
  project: string | null
  target: { scope: ChoiceScope; key: string | null }
} {
  const project = state.project
  const own = project ? state.mode.projects[project] : undefined
  const session = sessionId ? state.mode.sessions[sessionId] : undefined
  const chosen = session ?? own ?? state.mode.standing

  // F40 detail: an open session's choice is its own; with none open the choice is the Setting, the default for new ones.
  // A session with no choice of its own shows and follows the Setting, so the two never disagree.
  if (sessionId) {
    return {
      chosen,
      inForce: chosen,
      project,
      target: { scope: 'session', key: sessionId }
    }
  }

  // S11: an empty chat shows what main holds for this window, else the default its session would take, and a choice
  // here goes to main for this window, never to the Setting.
  const held = state.pendingMode ?? chosen

  return { chosen: held, inForce: held, project, target: { scope: 'new-session', key: null } }
}

/** S11: awaited after a session is created and before its first prompt. A refusal leaves the session on its default. */
export async function claimWindowChoice(sessionId: string): Promise<void> {
  await permissionsBridge()
    ?.claimWindowChoice?.(sessionId)
    .catch(() => undefined)
}

/**
 * Call SYNCHRONOUSLY from the click handler of a control carrying `data-perm-mode-confirm`: the preload attaches the
 * proof of that click, and main refuses the change without it.
 */
export function requestPermissionMode(input: {
  mode: PermissionMode
  scope: ChoiceScope
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

/** Same rule: only from the Remove button's own click handler. */
export function removePermissionFolder(folder: string): Promise<{ ok: boolean }> {
  return permissionsBridge()?.removeFolder?.(folder) ?? Promise.resolve({ ok: false })
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
