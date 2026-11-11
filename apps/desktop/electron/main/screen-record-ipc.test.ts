/**
 * G16: AI record has no quit handler of its own. A recording stops on the ONE teardown, which will-quit and every forced
 * exit run (teardown-registry.ts), and a window closed before that follows the quit's own mark. The electron half is real
 * here: the recorder's timer, its frames on disk, the registry.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg?: unknown) => unknown>(),
  closes: [] as (() => void)[],
  userData: '',
  getSources: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  app: { dock: { setBadge: vi.fn() }, getPath: () => fake.userData, on: fake.on },
  BrowserWindow: {
    fromWebContents: () => ({ on: (_name: string, listener: () => void) => fake.closes.push(listener) }),
    getAllWindows: () => []
  },
  desktopCapturer: { getSources: fake.getSources },
  ipcMain: { handle: (channel: string, run: (event: unknown, arg?: unknown) => unknown) => fake.handlers.set(channel, run) },
  screen: { getPrimaryDisplay: () => ({ id: 1, scaleFactor: 1, size: { height: 16, width: 16 } }) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' }
}))

vi.mock('../iclone-consent', () => ({ consentAllows: () => true }))
vi.mock('./setup-ipc', () => ({ freshScreenStatus: async () => 'granted' }))

const { appTeardown } = await import('../teardown-registry')
const { framesRoot, registerScreenRecordIpc } = await import('./screen-record-ipc')
const { quitState } = await import('./state')

const noisy = () => Buffer.from(Array.from({ length: 16 * 16 * 4 }, (_, i) => (i * 37 + Math.floor(Math.random() * 200)) % 256))

const image = {
  isEmpty: () => false,
  resize: () => ({ getSize: () => ({ height: 16, width: 16 }), toBitmap: noisy }),
  toPNG: () => Buffer.from('png')
}

const start = () => fake.handlers.get('iclone:screen-record:start')!({ sender: {} }) as Promise<{ ok: boolean }>

beforeEach(() => {
  fake.userData = mkdtempSync(path.join(os.tmpdir(), 'sr-ipc-'))
  fake.closes.length = 0
  fake.on.mockClear()
  fake.getSources.mockReset().mockResolvedValue([{ display_id: '1', thumbnail: image }])
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  quitState.quitting = false
})

afterEach(() => {
  vi.useRealTimers()
  quitState.quitting = false
  rmSync(fake.userData, { force: true, recursive: true })
})

describe('AI record on quit', () => {
  it('adds no quit handler, and the app teardown stops a running recording: no timer, no capture after it, no frames', async () => {
    const recorder = registerScreenRecordIpc(() => true)

    expect((await start()).ok).toBe(true)
    expect(recorder.status().recording).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(readdirSync(framesRoot())).toHaveLength(1)
    expect(fake.on).not.toHaveBeenCalled()

    appTeardown.run()

    expect(recorder.status().recording).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(readdirSync(framesRoot())).toEqual([])

    const captures = fake.getSources.mock.calls.length

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(fake.getSources.mock.calls.length).toBe(captures)
    expect((await start()).ok).toBe(false)
  })

  it('a window closing in a quit leaves the recording to the teardown', async () => {
    const recorder = registerScreenRecordIpc(() => true)

    await start()
    quitState.quitting = true
    fake.closes.forEach(close => close())
    await vi.advanceTimersByTimeAsync(0)
    expect(recorder.status().recording).toBe(true)
    appTeardown.run()
    expect(recorder.status().recording).toBe(false)
    expect(readdirSync(framesRoot())).toEqual([])
  })

  it('a window closing with no quit under way ("Keep Running" included) stops it, and the frames wait', async () => {
    const recorder = registerScreenRecordIpc(() => true)

    await start()
    fake.closes.forEach(close => close())
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorder.status().recording).toBe(false)
    expect(recorder.status().pending).toBe(true)
    expect(readdirSync(framesRoot())).toHaveLength(1)
    appTeardown.run()
  })
})
