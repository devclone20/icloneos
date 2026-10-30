/**
 * The app updater as the renderer sees it: main's one state machine (electron/iclone-app-update.ts),
 * mirrored from its pushes, plus the toast and the copy the Updates page and About draw from it.
 */

import { atom } from 'nanostores'

import { displayVersion } from '@/iclone-shared/version'
import { persistString, storedString } from '@/lib/storage'
import { dismissNotification, notify } from '@/store/notifications'
import type { AppUpdateLogEntry, AppUpdateRestartResult, AppUpdateState } from '@/types/iclone-app-update'

/** Requested for D2's storage-key registry (owner store/app-update.ts); local until it lands there. */
export const APP_UPDATE_SNOOZE_KEY = 'iclone.appUpdate.snoozedVersion'
export const APP_UPDATE_TOAST_ID = 'app-update'
const UPDATES_PANE_HASH = '#/settings?tab=app-atualisation'

export const $appUpdate = atom<AppUpdateState | null>(null)
export const $appUpdateLog = atom<AppUpdateLogEntry[]>([])

const bridge = () => (typeof window === 'undefined' ? undefined : window.hermesDesktop?.appUpdate)

/** `v0.0.3` — the owner's three-number form. */
export const shownVersion = (semver: string) => `v${displayVersion(semver)}`

function snoozed(version: string): boolean {
  return storedString(APP_UPDATE_SNOOZE_KEY) === version
}

let closingQuietly = false

/** Takes the toast down without counting it as "Later": only the user's own dismissal snoozes a version. */
function closeAppUpdateToast(): void {
  closingQuietly = true

  try {
    dismissNotification(APP_UPDATE_TOAST_ID)
  } finally {
    closingQuietly = false
  }
}

/** One toast per offered version until "Later"; it starts the download itself. */
export function syncAppUpdateToast(state: AppUpdateState | null): void {
  if (!state || state.phase !== 'available' || !state.next) {
    closeAppUpdateToast()

    return
  }

  if (snoozed(state.next)) {
    return
  }

  const next = state.next

  notify({
    action: { label: `Update to ${shownVersion(next)}`, onClick: () => void downloadAppUpdate() },
    durationMs: 0,
    id: APP_UPDATE_TOAST_ID,
    kind: 'info',
    message: `iclone os ${shownVersion(next)} is ready to download.`,
    onDismiss: () => {
      if (!closingQuietly) {
        persistString(APP_UPDATE_SNOOZE_KEY, next)
      }
    },
    title: 'Update available'
  })
}

function ingest(state: AppUpdateState): void {
  const previous = $appUpdate.get()
  $appUpdate.set(state)

  if (previous?.phase !== state.phase || previous?.next !== state.next) {
    syncAppUpdateToast(state)
  }

  if (state.phase === 'installing' || previous?.phase === 'installing') {
    void refreshAppUpdateLog()
  }
}

export async function refreshAppUpdate(): Promise<AppUpdateState | null> {
  const api = bridge()

  if (!api) {
    return null
  }

  try {
    const state = await api.state()
    ingest(state)

    return state
  } catch {
    return $appUpdate.get()
  }
}

export async function refreshAppUpdateLog(): Promise<AppUpdateLogEntry[]> {
  const api = bridge()

  if (!api) {
    return []
  }

  try {
    const rows = await api.log()
    $appUpdateLog.set(rows)

    return rows
  } catch {
    return $appUpdateLog.get()
  }
}

let started = false

/** Once per window: mirror main's pushes; main's "open" lands on Settings → Updates. */
export function startAppUpdateSync(): void {
  const api = bridge()

  if (started || !api) {
    return
  }

  started = true
  api.onChanged(ingest)
  api.onOpen(() => {
    window.location.hash = UPDATES_PANE_HASH
  })
  api.onNotice(payload => {
    if (payload?.text) {
      notify({ durationMs: 12_000, id: 'app-update-notice', kind: 'info', message: payload.text })
    }
  })
  void refreshAppUpdate()
  void refreshAppUpdateLog()
}

const APP_UPDATE_CHECK_FAILED_ID = 'app-update-check-failed'
export const APP_UPDATE_CHECK_FAILED_TEXT = "Can't check for updates right now. Try again later."

/** The bridge itself failing (not the feed: main reports that in the state's own copy). */
export async function checkForAppUpdate(): Promise<void> {
  try {
    await bridge()?.check()
  } catch (error) {
    notify({ id: APP_UPDATE_CHECK_FAILED_ID, kind: 'warning', message: APP_UPDATE_CHECK_FAILED_TEXT })
  }

  await refreshAppUpdate()
}

export async function downloadAppUpdate(): Promise<boolean> {
  closeAppUpdateToast()

  return Boolean(
    await bridge()
      ?.download()
      .catch(() => false)
  )
}

export async function cancelAppUpdate(): Promise<boolean> {
  return Boolean(
    await bridge()
      ?.cancel()
      .catch(() => false)
  )
}

export async function restartToUpdate(confirmed = false): Promise<AppUpdateRestartResult | null> {
  return (
    (await bridge()
      ?.restart({ confirmed })
      .catch(() => null)) ?? null
  )
}

type AppUpdateAction = 'cancel' | 'check' | 'download' | 'restart'

interface AppUpdatePrimary {
  action: AppUpdateAction | null
  busy: boolean
  label: string
}

/** The one primary button for each phase. */
export function appUpdatePrimary(state: AppUpdateState | null): AppUpdatePrimary {
  switch (state?.phase) {
    case 'checking':
      return { action: null, busy: true, label: 'Checking…' }

    case 'available':
      return { action: 'download', busy: false, label: `Update to ${shownVersion(state.next ?? state.current)}` }

    case 'downloading':
      return { action: 'cancel', busy: true, label: 'Cancel' }

    case 'downloaded':
      return { action: 'restart', busy: false, label: 'Restart to update' }

    case 'installing':
      return { action: null, busy: true, label: 'Restarting…' }

    case 'error':
      return { action: 'check', busy: false, label: 'Try again' }

    case 'inactive':
      return { action: null, busy: false, label: 'Check for updates' }

    default:
      return { action: 'check', busy: false, label: 'Check for updates' }
  }
}
