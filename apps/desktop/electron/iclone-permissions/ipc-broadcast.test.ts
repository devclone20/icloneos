/**
 * V-2 — `iclone:permissions:changed` is one message per burst of audit records (100 ms), carrying the newest seq, so a
 * mode change costs each window one re-read instead of one per record.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { registerPermissions } from './ipc'
import { CLICK } from './ipc.test-helpers'

let dir: string
const broadcast = vi.fn<(seq: number) => void>()
const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
let authority: ReturnType<typeof registerPermissions>

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-bcast-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  authority = registerPermissions({
    ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => unknown) => void handlers.set(channel, handler) },
    isTrustedSender: () => true,
    userDataDir: path.join(dir, 'ud'),
    paths: { hermesHome: path.join(dir, 'hermes'), home: path.join(dir, 'home'), hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => Date.now(),
    sealer: null,
    pickFolderDialog: async () => [],
    broadcast
  } as never)
})

afterEach(() => {
  broadcast.mockClear()
})

afterAll(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const setStanding = (mode: string) =>
  handlers.get('iclone:permissions:set-mode')?.({}, { scope: 'standing', mode, gesture: CLICK }) as Promise<{ ok: boolean }>

describe('the changed broadcast', () => {
  it('three mode changes in a burst reach the windows once, with the newest seq, after the coalescing delay', async () => {
    vi.advanceTimersByTime(200)
    broadcast.mockClear()

    for (const mode of ['plan', 'automatic', 'manual']) {
      expect(await setStanding(mode)).toMatchObject({ ok: true })
    }

    expect(broadcast).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenLastCalledWith(authority.tail(0, 10_000).at(-1)?.seq_main)
  })

  it('a later change is a new message (nothing is swallowed after a burst)', async () => {
    expect(await setStanding('plan')).toMatchObject({ ok: true })
    vi.advanceTimersByTime(100)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})
