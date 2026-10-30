import fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPrivySignInRecord,
  createPrivyStatusReader,
  hasPartitionData,
  PRIVY_STATUS_TIMEOUT_MS,
  type PrivyStatusProbeDeps,
  probePrivySession,
  shouldProbePrivyPartition,
  SIGNED_OUT_PAYLOAD,
  signedOutByUpdate
} from './iclone-privy'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent', isPackaged: false, once: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn() }) }
}))

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

type Listener = (event: { sender: unknown }, payload: unknown) => void

/** A fake hidden window + the page preload's relay channel. */
function harness(load: () => Promise<void> = () => Promise.resolve()) {
  const listeners = new Set<Listener>()
  const webContents = { id: 'probe' }
  let destroyed = false

  const win = {
    webContents,
    loadURL: vi.fn(load),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    })
  }

  const deps: PrivyStatusProbeDeps = {
    createWindow: () => win,
    onWindowEvent: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    url: 'http://127.0.0.1:47831/privy.html'
  }

  const emit = (payload: unknown, sender: unknown = webContents) => listeners.forEach(l => l({ sender }, payload))

  return { deps, emit, listeners, win }
}

describe('privy partition status probe', () => {
  it("returns the page's first signed-in report and destroys the hidden window", async () => {
    const h = harness()
    const pending = probePrivySession(h.deps)

    h.emit({ type: 'auth', status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })

    await expect(pending).resolves.toEqual({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    expect(h.win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:47831/privy.html')
    expect(h.win.destroy).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(0)
  })

  it("returns 'out' when the partition holds no session", async () => {
    const h = harness()
    const pending = probePrivySession(h.deps)

    h.emit({ type: 'logout', status: 'out', address: null, userId: null, label: null })

    await expect(pending).resolves.toMatchObject({ status: 'out' })
    expect(h.win.destroy).toHaveBeenCalled()
  })

  it('ignores another window and malformed payloads', async () => {
    vi.useFakeTimers()
    const h = harness()
    const pending = probePrivySession({ ...h.deps, timeoutMs: 1_000 })

    h.emit({ status: 'in', address: ADDRESS, userId: 'u', label: null }, { id: 'login-window' })
    h.emit({ status: 'maybe' })
    h.emit(null)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pending).resolves.toBeNull()
    vi.useRealTimers()
  })

  it('never answers: null (unknown, never a false out) after the deadline, window destroyed', async () => {
    vi.useFakeTimers()
    const h = harness()
    let result: unknown = 'pending'

    void probePrivySession(h.deps).then(r => (result = r))
    await vi.advanceTimersByTimeAsync(PRIVY_STATUS_TIMEOUT_MS - 1)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
    expect(h.win.destroy).toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
    vi.useRealTimers()
  })

  it('an address-less sign-in waits briefly for the wallet, then settles for it', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = probePrivySession({ ...h.deps, addressGraceMs: 500 })

    h.emit({ status: 'in', address: null, userId: 'u', label: 'owner' })
    h.emit({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await expect(first).resolves.toMatchObject({ address: ADDRESS })

    const h2 = harness()
    const second = probePrivySession({ ...h2.deps, addressGraceMs: 500 })

    h2.emit({ status: 'in', address: null, userId: 'u', label: 'owner' })
    await vi.advanceTimersByTimeAsync(500)
    await expect(second).resolves.toMatchObject({ status: 'in', address: null })
    vi.useRealTimers()
  })

  it('a page that fails to load answers null at once', async () => {
    const h = harness(() => Promise.reject(new Error('ERR_CONNECTION_REFUSED')))

    await expect(probePrivySession(h.deps)).resolves.toBeNull()
    expect(h.win.destroy).toHaveBeenCalled()
  })

  it('an aborted probe answers null at once, destroys its window and ignores a late report', async () => {
    const h = harness()
    const abort = new AbortController()
    const pending = probePrivySession({ ...h.deps, signal: abort.signal })

    abort.abort()
    h.emit({ type: 'auth', status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })

    await expect(pending).resolves.toBeNull()
    expect(h.win.destroy).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(0)
  })

  it('a probe whose signal is already aborted opens no window', async () => {
    const h = harness()
    const abort = new AbortController()
    const createWindow = vi.fn(h.deps.createWindow)

    abort.abort()

    await expect(probePrivySession({ ...h.deps, createWindow, signal: abort.signal })).resolves.toBeNull()
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('a window that cannot be created answers null', async () => {
    const h = harness()

    await expect(
      probePrivySession({
        ...h.deps,
        createWindow: () => {
          throw new Error('no window')
        }
      })
    ).resolves.toBeNull()
  })
})

describe('privy status reader', () => {
  it('shares one probe between overlapping asks and starts a fresh one afterwards', async () => {
    let answer: (value: null) => void = () => undefined
    const probe = vi.fn(() => new Promise<null>(resolve => (answer = resolve)))
    const read = createPrivyStatusReader(probe)

    const a = read()
    const b = read()

    expect(probe).toHaveBeenCalledTimes(1)
    answer(null)
    await expect(Promise.all([a, b])).resolves.toEqual([null, null])
    void read()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a probe that throws answers null', async () => {
    const read = createPrivyStatusReader(() => Promise.reject(new Error('boom')))

    await expect(read()).resolves.toBeNull()
  })
})

describe('never-signed-in wallet store: no Privy page, no network', () => {
  const dirs: string[] = []

  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-privy-'))

    dirs.push(dir)

    return dir
  }

  afterEach(() => {
    dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
  })

  it('a fresh partition storage path holds no data; a used one does', () => {
    const storage = tmp()

    expect(hasPartitionData(null)).toBe(false)
    expect(hasPartitionData(path.join(storage, 'missing'))).toBe(false)
    expect(hasPartitionData(storage)).toBe(false)

    fs.mkdirSync(path.join(storage, 'Local Storage'))
    expect(hasPartitionData(storage)).toBe(false)

    fs.mkdirSync(path.join(storage, 'Local Storage', 'leveldb'))
    expect(hasPartitionData(storage)).toBe(true)

    const indexed = tmp()

    fs.mkdirSync(path.join(indexed, 'IndexedDB', 'http_127.0.0.1_47831.indexeddb.leveldb'), { recursive: true })
    expect(hasPartitionData(indexed)).toBe(true)
  })

  it('probes only for a recorded sign-in or an unrecorded partition that holds data', () => {
    const touched = vi.fn(() => true)

    expect(shouldProbePrivyPartition('in', touched)).toBe(true)
    expect(shouldProbePrivyPartition('out', touched)).toBe(false)
    expect(touched).not.toHaveBeenCalled()

    expect(shouldProbePrivyPartition(null, () => false)).toBe(false)
    expect(shouldProbePrivyPartition(null, () => true)).toBe(true)
  })

  it('a never-signed-in store answers out without creating the hidden window', async () => {
    const storage = tmp()
    const record = createPrivySignInRecord(path.join(tmp(), 'iclone-privy-signin.json'))
    const h = harness()
    const createWindow = vi.fn(h.deps.createWindow)

    const read = createPrivyStatusReader(() =>
      shouldProbePrivyPartition(record.read(), () => hasPartitionData(storage))
        ? probePrivySession({ ...h.deps, createWindow })
        : Promise.resolve({ ...SIGNED_OUT_PAYLOAD })
    )

    await expect(read()).resolves.toEqual({ status: 'out', address: null, userId: null, label: null })
    await expect(read()).resolves.toMatchObject({ status: 'out' })
    expect(createWindow).not.toHaveBeenCalled()
    expect(h.win.loadURL).not.toHaveBeenCalled()
  })

  it('the sign-in record mirrors definitive answers, ignores unknown, survives garbage', () => {
    const dir = tmp()
    const file = path.join(dir, 'nested', 'iclone-privy-signin.json')
    const record = createPrivySignInRecord(file)

    expect(record.read()).toBeNull()

    record.record({ status: 'in', address: ADDRESS, userId: 'u', label: null })
    expect(record.read()).toBe('in')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    record.record(null)
    expect(record.read()).toBe('in')

    record.write('out')
    expect(record.read()).toBe('out')
    expect(fs.readdirSync(path.dirname(file))).toEqual(['iclone-privy-signin.json'])

    fs.writeFileSync(file, '{not json')
    expect(record.read()).toBeNull()

    fs.writeFileSync(file, JSON.stringify({ state: 'maybe' }))
    expect(record.read()).toBeNull()
  })

  it('a record that cannot be written is removed, so the partition check decides', () => {
    const dir = tmp()
    const file = path.join(dir, 'iclone-privy-signin.json')
    const record = createPrivySignInRecord(file)

    record.write('out')
    expect(record.read()).toBe('out')

    // A rename that fails midway (full disk, EIO) must not leave the stale answer behind.
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
    })

    record.write('in')
    rename.mockRestore()

    expect(record.read()).toBeNull()
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('signedOutByUpdate (V3-0b item 3)', () => {
  const OUT = { status: 'out' as const, address: null, userId: null, label: null }
  const IN = { ...OUT, status: 'in' as const }
  const UPDATED = { current: '0.0.0.3', previous: '0.0.0.2' }

  it('holds only for a recorded sign-in, a known earlier version and an out answer', () => {
    expect(signedOutByUpdate({ marker: 'in', versionChange: UPDATED }, OUT)).toBe(true)
    expect(signedOutByUpdate({ marker: 'in', versionChange: UPDATED }, IN)).toBe(false)
    expect(signedOutByUpdate({ marker: 'in', versionChange: UPDATED }, null)).toBe(false)
    expect(signedOutByUpdate({ marker: 'out', versionChange: UPDATED }, OUT)).toBe(false)
    expect(signedOutByUpdate({ marker: null, versionChange: UPDATED }, OUT)).toBe(false)
    expect(signedOutByUpdate({ marker: 'in', versionChange: { current: '0.0.0.3', previous: null } }, OUT)).toBe(false)
    expect(signedOutByUpdate({ marker: 'in', versionChange: { current: '0.0.0.3', previous: '0.0.0.3' } }, OUT)).toBe(
      false
    )
    expect(signedOutByUpdate({ marker: 'in' }, OUT)).toBe(false)
  })
})
