/**
 * The seam the E3c regression lived in: with no picker registered, a remote
 * directory pick answered `[]`, which every reader already used for "the user
 * cancelled". These tests fail if the three outcomes ever collapse into two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  pickDesktopPaths,
  REMOTE_PICKER_UNAVAILABLE,
  selectDesktopPaths,
  setDesktopFsRemotePicker
} from '@/lib/desktop-fs'
import { notify } from '@/store/notifications'
import { $connection } from '@/store/session'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

const nativeSelect = vi.fn(async () => ['/local/pick'])

beforeEach(() => {
  vi.stubGlobal('hermesDesktop', { selectPaths: nativeSelect })
  $connection.set({ mode: 'remote' } as never)
  setDesktopFsRemotePicker(null)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  $connection.set(null)
  setDesktopFsRemotePicker(null)
})

describe('a remote directory pick has three answers', () => {
  it('selected — the picker resolved a path', async () => {
    setDesktopFsRemotePicker({ selectPaths: async () => ['/srv/work/repo'] })

    await expect(pickDesktopPaths({ directories: true })).resolves.toEqual({
      paths: ['/srv/work/repo'],
      status: 'selected'
    })
    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual(['/srv/work/repo'])
    expect(notify).not.toHaveBeenCalled()
    expect(nativeSelect).not.toHaveBeenCalled()
  })

  it('cancelled — the picker resolved nothing, and nothing is reported', async () => {
    setDesktopFsRemotePicker({ selectPaths: async () => [] })

    await expect(pickDesktopPaths({ directories: true })).resolves.toEqual({ status: 'cancelled' })
    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('unavailable — no picker is mounted, and the user is told', async () => {
    await expect(pickDesktopPaths({ directories: true })).resolves.toEqual({
      reason: REMOTE_PICKER_UNAVAILABLE,
      status: 'unavailable'
    })
    expect(notify).not.toHaveBeenCalled()

    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual([])
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: REMOTE_PICKER_UNAVAILABLE })
  })

  it('a cancel and a missing picker are never the same answer', async () => {
    const cancelled = await pickDesktopPaths({ directories: true })

    setDesktopFsRemotePicker({ selectPaths: async () => [] })

    const unavailable = await pickDesktopPaths({ directories: true })

    expect(cancelled.status).toBe('unavailable')
    expect(unavailable.status).toBe('cancelled')
  })

  it('local mode and file picks still go to the native dialog', async () => {
    await expect(selectDesktopPaths({ directories: false })).resolves.toEqual(['/local/pick'])

    $connection.set({ mode: 'local' } as never)

    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual(['/local/pick'])
    expect(notify).not.toHaveBeenCalled()
  })
})
