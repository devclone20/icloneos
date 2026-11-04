// Once a quit's teardown has begun (main's before-quit, past any remote-update wait), the `ssh -G` behind every SSH dial is refused before anything is spawned.
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as backendClaim from '../backend-claim'

const h = vi.hoisted(() => ({
  execText: vi.fn<(command: string, args: string[], options?: unknown) => Promise<string>>(
    async () => 'hostname example.test'
  )
}))

const userData = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  return mkdtempSync(join(tmpdir(), 'quit-refusals-ssh-'))
})

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: () => undefined },
    getAppPath: () => userData,
    getPath: () => userData,
    isPackaged: false,
    isReady: () => false
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../backend-claim', async () => ({
  ...(await vi.importActual<typeof backendClaim>('../backend-claim')),
  execText: h.execText
}))

const { effectiveSshConfigFingerprint } = await import('./managed-ssh')
const { beginQuitTeardown, QuitInProgressError, quitState, refuseWhileQuitting } = await import('./state')

afterEach(() => {
  quitState.quitting = false
  h.execText.mockClear()
})

describe('no `ssh -G` while quitting', () => {
  it('refuseWhileQuitting throws only while a quit is under way', () => {
    expect(() => refuseWhileQuitting('ssh dial')).not.toThrow()
    beginQuitTeardown()
    expect(() => refuseWhileQuitting('ssh dial')).toThrow(new QuitInProgressError('ssh dial'))
    expect(() => refuseWhileQuitting('ssh dial')).toThrow('quitting: ssh dial refused')
  })

  it('a dial requested once the quit teardown began: effectiveSshConfigFingerprint rejects and spawns no ssh -G', async () => {
    beginQuitTeardown()
    await expect(effectiveSshConfigFingerprint({ host: 'example.test', user: 'me' })).rejects.toBeInstanceOf(
      QuitInProgressError
    )
    expect(h.execText).not.toHaveBeenCalled()
  })

  it('control: with no quit under way the same call runs ssh -G once', async () => {
    await expect(effectiveSshConfigFingerprint({ host: 'example.test', user: 'me' })).resolves.toMatch(/^[0-9a-f]{64}$/)
    expect(h.execText).toHaveBeenCalledTimes(1)
    expect(h.execText.mock.calls[0]?.[1]).toEqual(['-G', '--', 'me@example.test'])
  })
})
