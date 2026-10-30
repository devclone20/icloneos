import { afterEach, describe, expect, it, vi } from 'vitest'

import { $notifications } from '@/store/notifications'
import type { AppUpdateState } from '@/types/iclone-app-update'

import {
  $appUpdate,
  APP_UPDATE_CHECK_FAILED_TEXT,
  APP_UPDATE_SNOOZE_KEY,
  APP_UPDATE_TOAST_ID,
  appUpdatePrimary,
  checkForAppUpdate,
  downloadAppUpdate,
  syncAppUpdateToast
} from './app-update'

const base: AppUpdateState = {
  checkedAt: null,
  current: '0.0.2',
  error: null,
  next: null,
  phase: 'idle',
  progress: null,
  releaseUrl: null
}

const at = (phase: AppUpdateState['phase'], over: Partial<AppUpdateState> = {}): AppUpdateState => ({
  ...base,
  phase,
  ...over
})

const PHASES: AppUpdateState['phase'][] = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
  'inactive'
]

afterEach(() => {
  $notifications.set([])
  $appUpdate.set(null)
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('app-update copy', () => {
  it('one primary button per phase', () => {
    const next = { next: '0.0.3' }
    expect(PHASES.map(p => appUpdatePrimary(at(p, next)).label)).toEqual([
      'Check for updates',
      'Checking…',
      'Check for updates',
      'Update to v0.0.3',
      'Cancel',
      'Restart to update',
      'Restarting…',
      'Try again',
      'Check for updates'
    ])
    expect(appUpdatePrimary(at('inactive')).action).toBeNull()
    expect(appUpdatePrimary(at('available', next)).action).toBe('download')
    expect(appUpdatePrimary(at('downloaded', next)).action).toBe('restart')
  })
})

describe('the update toast', () => {
  it('shows once for an offered version, stays until acted on, and "Later" snoozes that version only', () => {
    syncAppUpdateToast(at('available', { next: '0.0.3' }))
    const toast = $notifications.get().find(n => n.id === APP_UPDATE_TOAST_ID)
    expect(toast?.action?.label).toBe('Update to v0.0.3')
    toast?.onDismiss?.()
    expect(window.localStorage.getItem(APP_UPDATE_SNOOZE_KEY)).toContain('0.0.3')
    $notifications.set([])
    syncAppUpdateToast(at('available', { next: '0.0.3' }))
    expect($notifications.get().some(n => n.id === APP_UPDATE_TOAST_ID)).toBe(false)
    syncAppUpdateToast(at('available', { next: '0.0.4' }))
    expect($notifications.get().some(n => n.id === APP_UPDATE_TOAST_ID)).toBe(true)
  })

  it('leaves once the update is no longer on offer, without snoozing that version', () => {
    window.localStorage.removeItem(APP_UPDATE_SNOOZE_KEY)
    syncAppUpdateToast(at('available', { next: '0.0.3' }))
    syncAppUpdateToast(at('downloading', { next: '0.0.3' }))
    expect($notifications.get().some(n => n.id === APP_UPDATE_TOAST_ID)).toBe(false)
    syncAppUpdateToast(at('checking'))
    syncAppUpdateToast(at('available', { next: '0.0.3' }))
    expect($notifications.get().some(n => n.id === APP_UPDATE_TOAST_ID)).toBe(true)
    expect(window.localStorage.getItem(APP_UPDATE_SNOOZE_KEY)).toBeNull()
  })

  it('starting the download from the toast closes it without snoozing', async () => {
    window.localStorage.removeItem(APP_UPDATE_SNOOZE_KEY)
    syncAppUpdateToast(at('available', { next: '0.0.5' }))
    const toast = $notifications.get().find(n => n.id === APP_UPDATE_TOAST_ID)
    await downloadAppUpdate()
    expect(toast).toBeDefined()
    expect($notifications.get().some(n => n.id === APP_UPDATE_TOAST_ID)).toBe(false)
    expect(window.localStorage.getItem(APP_UPDATE_SNOOZE_KEY)).toBeNull()
  })
})

describe('checkForAppUpdate', () => {
  it('a failing bridge is one plain sentence, never the raw error', async () => {
    const appUpdate = {
      check: vi.fn(async () => {
        throw new Error("Error invoking remote method 'iclone:app-update:check': /private/var/folders/xy/secret")
      }),
      state: vi.fn(async () => at('idle'))
    }

    const host = window as unknown as { hermesDesktop?: unknown }
    host.hermesDesktop = { appUpdate }

    try {
      await checkForAppUpdate()
      expect($notifications.get().map(n => n.message)).toEqual([APP_UPDATE_CHECK_FAILED_TEXT])
      expect(APP_UPDATE_CHECK_FAILED_TEXT).toBe("Can't check for updates right now. Try again later.")
      expect(appUpdate.state).toHaveBeenCalledTimes(1)
      await checkForAppUpdate()
      expect($notifications.get()).toHaveLength(1)
    } finally {
      delete host.hermesDesktop
    }
  })
})
