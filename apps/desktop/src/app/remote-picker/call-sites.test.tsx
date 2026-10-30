/**
 * The two readers of a remote directory pick, through the REAL seam and the
 * REAL picker registry — no mock of desktop-fs here, because the regression
 * was exactly that both readers believed an empty array.
 *
 * ⌘O / palette "Open folder…"  → store/projects pickProjectFolder
 * home files island "+"        → app/home/files-island pinNewRoot
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $filesIslandOpen, FilesIsland } from '@/app/home/files-island'
import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { REMOTE_PICKER_UNAVAILABLE, setDesktopFsRemotePicker } from '@/lib/desktop-fs'
import { notify } from '@/store/notifications'
import { pickProjectFolder } from '@/store/projects'
import { $connection } from '@/store/session'
import { stubResizeObserver } from '@/test/jsdom'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

vi.mock('@/api/client', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  hermesApi: vi.fn(async () => ({ branch: 'main', cwd: '/srv/work', entries: [] }))
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: vi.fn(),
  ensureActiveGatewayOpen: vi.fn()
}))

vi.mock('@/hermes', () => ({
  getHermesConfig: vi.fn(),
  getProfiles: vi.fn(),
  hermesApi: vi.fn(),
  setApiRequestProfile: vi.fn(),
  STARTUP_REQUEST_TIMEOUT_MS: 1000
}))

const ROOTS_KEY = ICLONE_STORAGE.filesRoots.key

function pickerAnswering(paths: string[]) {
  setDesktopFsRemotePicker({ selectPaths: async () => paths })
}

beforeEach(() => {
  stubResizeObserver()
  vi.stubGlobal('hermesDesktop', { readDir: vi.fn(async () => ({ entries: [] })), selectPaths: vi.fn(async () => []) })
  window.localStorage.clear()
  $connection.set({ mode: 'remote' } as never)
  setDesktopFsRemotePicker(null)
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  $filesIslandOpen.set(false)
  vi.unstubAllGlobals()
  $connection.set(null)
  setDesktopFsRemotePicker(null)
})

describe('pickProjectFolder (⌘O, palette "Open folder…")', () => {
  it('opens the folder the user selected', async () => {
    pickerAnswering(['/srv/work/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/srv/work/repo')
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing, quietly, when the user cancels', async () => {
    pickerAnswering([])

    await expect(pickProjectFolder()).resolves.toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('says so when no picker is mounted instead of doing nothing (the E3c regression)', async () => {
    await expect(pickProjectFolder()).resolves.toBeNull()
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: REMOTE_PICKER_UNAVAILABLE })
  })
})

describe('home files island "Pin a folder as a new tree"', () => {
  async function clickPin() {
    $filesIslandOpen.set(true)
    render(<FilesIsland />)
    fireEvent.click(await screen.findByLabelText('Pin a folder as a new tree'))
  }

  it('pins the folder the user selected', async () => {
    pickerAnswering(['/srv/work/repo'])
    await clickPin()

    await waitFor(() => expect(window.localStorage.getItem(ROOTS_KEY)).toContain('/srv/work/repo'))
    expect(notify).not.toHaveBeenCalled()
  })

  it('pins nothing, quietly, when the user cancels', async () => {
    pickerAnswering([])
    await clickPin()

    await waitFor(() => expect(notify).not.toHaveBeenCalled())
    expect(window.localStorage.getItem(ROOTS_KEY)).toBeNull()
  })

  it('says so when no picker is mounted instead of pinning nothing in silence', async () => {
    await clickPin()

    await waitFor(() => expect(notify).toHaveBeenCalledWith({ kind: 'error', message: REMOTE_PICKER_UNAVAILABLE }))
    expect(window.localStorage.getItem(ROOTS_KEY)).toBeNull()
  })
})
