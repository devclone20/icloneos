/**
 * The picker, driven the way the app drives it: a directory pick asked for at
 * the seam, answered by this component's own frame. Each of the three outcomes
 * is asserted end to end, mount included — unmounted, the seam must report the
 * pick as unavailable instead of as a cancel.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesReadDirResult } from '@/global'
import { notify } from '@/store/notifications'
import { $connection } from '@/store/session'
import { stubResizeObserver } from '@/test/jsdom'

import { RemoteFolderPicker } from './remote-picker'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readDesktopDir: vi.fn()
}))

const fs = await import('@/lib/desktop-fs')
const readDesktopDir = vi.mocked(fs.readDesktopDir)

const LISTING: Record<string, HermesReadDirResult> = {
  '/srv/work': {
    entries: [
      { isDirectory: true, name: 'repo', path: '/srv/work/repo' },
      { isDirectory: false, name: 'notes.md', path: '/srv/work/notes.md' }
    ]
  } as never,
  '/srv/work/repo': { entries: [] } as never
}

beforeEach(() => {
  stubResizeObserver()
  vi.stubGlobal('hermesDesktop', { selectPaths: vi.fn(async () => ['/local/pick']) })
  $connection.set({ mode: 'remote' } as never)
  readDesktopDir.mockImplementation(async path => LISTING[path] ?? ({ entries: [] } as never))
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  $connection.set(null)
  fs.setDesktopFsRemotePicker(null)
})

describe('RemoteFolderPicker', () => {
  it('browses the gateway and returns the folder the user selected', async () => {
    render(<RemoteFolderPicker />)

    const pick = fs.selectDesktopPaths({ defaultPath: '/srv/work', directories: true })

    await screen.findByText('Browse folders on the connected backend.')
    expect(readDesktopDir).toHaveBeenCalledWith('/srv/work')

    // Only directories are offered, and the name comes from the path.
    expect(screen.queryByText('notes.md')).toBeNull()
    fireEvent.click(await screen.findByText('repo'))

    await waitFor(() => expect(readDesktopDir).toHaveBeenCalledWith('/srv/work/repo'))
    fireEvent.click(screen.getByText('Select folder'))

    await expect(pick).resolves.toEqual(['/srv/work/repo'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('reports a cancel as an empty selection, with nothing shown to the user', async () => {
    render(<RemoteFolderPicker />)

    const pick = fs.selectDesktopPaths({ defaultPath: '/srv/work', directories: true })

    fireEvent.click(await screen.findByText('Cancel'))

    await expect(pick).resolves.toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('surfaces a folder that cannot be read instead of an empty list', async () => {
    readDesktopDir.mockResolvedValue({ entries: [], error: 'permission denied' } as never)
    render(<RemoteFolderPicker />)

    const pick = fs.selectDesktopPaths({ defaultPath: '/srv/work', directories: true })

    await screen.findByText('Could not read this folder (permission denied).')
    fireEvent.click(screen.getByText('Cancel'))
    await expect(pick).resolves.toEqual([])
  })

  it('leaves no registrant behind when it unmounts — the pick is then unavailable, not cancelled', async () => {
    const view = render(<RemoteFolderPicker />)

    // Mounted: the seam calls THIS component, which answers a cancel.
    const mounted = fs.pickDesktopPaths({ directories: true })

    await screen.findByText('Choose remote folder')
    fireEvent.click(screen.getByText('Cancel'))
    await expect(mounted).resolves.toEqual({ status: 'cancelled' })

    view.unmount()

    await expect(fs.pickDesktopPaths({ directories: true })).resolves.toEqual({
      reason: fs.REMOTE_PICKER_UNAVAILABLE,
      status: 'unavailable'
    })
    await expect(fs.selectDesktopPaths({ directories: true })).resolves.toEqual([])
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: fs.REMOTE_PICKER_UNAVAILABLE })
  })
})
