import { atom, computed } from 'nanostores'

import type { PermissionModeResetView, PermissionStateView } from '@/iclone-shared/permissions'

import { $permissions } from './permissions'

/**
 * CF4 (B2-m1): the mode-reset notices the owner has dismissed, by the id of the audit record main gave each. Kept in
 * this window's storage so a notice shows once: dismissed in the chat menu, it is gone from Settings too, and after a
 * restart. Only ids are kept (the newest few), never a mode or a path.
 *
 * CF5 (B3-n1): main holds a reset for the launch that made it only (the next launch reads the rewritten mode.json and
 * has nothing to tell). So every reset a window sees is also kept here, pending, until the owner dismisses it: the
 * notice and the main window's banner show it on later launches too. A pending reset is dropped without a dismissal
 * only when the owner chose that layer again: main stopped listing it during the run, or the default it names is no
 * longer the one in force. What is kept is the view main sent (scope, the layer's key, two mode names), nothing more.
 */
const STORAGE_KEY = 'iclone.permissions.modeReset.dismissed'
const PENDING_KEY = 'iclone.permissions.modeReset.pending'
const KEPT = 64
const SCOPES = new Set(['project', 'session', 'standing'])

function readStored<T>(key: string, keep: (item: unknown) => item is T): T[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')

    return Array.isArray(raw) ? raw.filter(keep) : []
  } catch {
    return []
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage refused (private mode, quota): kept for this window's life only
  }
}

const isResetView = (item: unknown): item is PermissionModeResetView => {
  const view = item as Partial<PermissionModeResetView> | null

  return (
    typeof view === 'object' &&
    view !== null &&
    typeof view.id === 'string' &&
    typeof view.scope === 'string' &&
    SCOPES.has(view.scope) &&
    (view.key === null || typeof view.key === 'string') &&
    typeof view.was === 'string' &&
    (view.now === null || typeof view.now === 'string')
  )
}

export const $dismissedModeResets = atom<ReadonlySet<string>>(
  new Set(readStored(STORAGE_KEY, (id): id is string => typeof id === 'string'))
)

/** CF5 (B3-n1): every reset seen and not yet dismissed, across launches. */
export const $pendingModeResets = atom<readonly PermissionModeResetView[]>(readStored(PENDING_KEY, isResetView))

function setPending(next: readonly PermissionModeResetView[]): void {
  const kept = next.slice(-KEPT)

  $pendingModeResets.set(kept)
  writeStored(PENDING_KEY, kept)
}

export function dismissModeResets(ids: readonly string[]): void {
  const next = [...new Set([...$dismissedModeResets.get(), ...ids])].slice(-KEPT)

  $dismissedModeResets.set(new Set(next))
  writeStored(STORAGE_KEY, next)
  setPending($pendingModeResets.get().filter(reset => !ids.includes(reset.id)))
}

/** The ids main listed at its last state this window read (null: none read yet). */
let lastLive: ReadonlySet<string> | null = null

/** CF5 (B3-n1): folds main's state into the pending resets (header). Exported for tests; the store calls it. */
export function syncModeResets(state: PermissionStateView | null): void {
  if (!state) {
    return
  }

  const live = state.modeReset ?? []
  const liveIds = new Set(live.map(reset => reset.id))
  const dismissed = $dismissedModeResets.get()
  const pending = $pendingModeResets.get()
  const known = new Set(pending.map(reset => reset.id))

  const kept = pending.filter(
    reset =>
      !(lastLive?.has(reset.id) && !liveIds.has(reset.id)) &&
      !(reset.scope === 'standing' && reset.now !== null && state.mode.standing !== reset.now)
  )

  const added = live.filter(reset => !known.has(reset.id) && !dismissed.has(reset.id))

  lastLive = liveIds

  if (added.length > 0 || kept.length !== pending.length) {
    setPending([...kept, ...added])
  }
}

$permissions.subscribe(store => syncModeResets(store.state))

/** The resets to tell the owner: pending and not dismissed (main's live list is folded into pending above). */
export const $shownModeResets = computed([$pendingModeResets, $dismissedModeResets], (pending, dismissed) =>
  pending.filter(reset => !dismissed.has(reset.id))
)

/** Test seam: forget what the last state listed (a new launch). */
export function resetModeResetSync(): void {
  lastLive = null
}
