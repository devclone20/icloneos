/**
 * The launcher's lifecycle with an injected spawn: a fake child that announces readiness, stays silent, exits or
 * lies about its pid. Real timers never run; the socket directory is a temp folder.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLauncher,
  ensurePrivateDir,
  LAUNCHER_PATH,
  type LauncherChild,
  MAX_RESTARTS,
  READY_TIMEOUT_MS,
  RESTART_BACKOFF_MS,
  STOP_GRACE_MS
} from './launcher'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signals: string[] = []
  /** Whether SIGTERM ends it (a launcher that ignores SIGTERM needs the SIGKILL). */
  constructor(
    readonly pid: number,
    private readonly obeysTerm = true
  ) {
    super()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)

    if (signal === 'SIGKILL' || this.obeysTerm) {
      queueMicrotask(() => this.die(null, signal))
    }

    return true
  }

  ready(pid = this.pid): void {
    this.stdout.emit('data', Buffer.from(`ICLONE-LAUNCHER-READY ${pid}\n`))
  }

  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return
    }

    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

let dir: string
let children: FakeChild[]
let calls: { command: string; args: string[]; options: Record<string, unknown> }[]
let logs: string[]
let nextPid: number
let obeysTerm: boolean

function launcher(spawn?: (child: FakeChild) => void) {
  return createLauncher({
    home: '/Users/owner',
    hermesHome: '/Users/owner/.hermes',
    python: '/rt/venv/bin/python',
    script: '/rt/plugins/iclone-confinement/launcher.py',
    socketPath: path.join(dir, 'run', 'launcher.sock'),
    journalDir: path.join(dir, 'run'),
    spec: () => '{"v":5}',
    roots: () => ({ reads: ['/rt', '/rt/venv'], writes: ['/Users/owner/.hermes', '/scratch'], grants: ['/scratch'] }),
    log: line => logs.push(line),
    now: () => Date.now(),
    spawn: (command, args, options) => {
      const child = new FakeChild((nextPid += 1), obeysTerm)

      calls.push({ command, args, options: options as Record<string, unknown> })
      children.push(child)
      spawn?.(child)

      return child as unknown as LauncherChild
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-launcher-'))
  children = []
  calls = []
  logs = []
  nextPid = 4000
  obeysTerm = true
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the launcher env names the runtime roots', () => {
  it('passes the read roots and the write roots as JSON lists, beside the spec, the socket and the ledger', async () => {
    const target = launcher(child => queueMicrotask(() => child.ready()))

    await expect(target.start()).resolves.toBe('up')

    const env = calls[0].options.env as Record<string, string>

    expect(JSON.parse(env.ICLONE_LAUNCHER_READ_ROOTS)).toEqual(['/rt', '/rt/venv'])
    expect(JSON.parse(env.ICLONE_LAUNCHER_WRITE_ROOTS)).toEqual(['/Users/owner/.hermes', '/scratch'])
    expect(JSON.parse(env.ICLONE_LAUNCHER_GRANT_ROOTS)).toEqual(['/scratch'])
    expect(Object.keys(env).sort()).toEqual([
      'ICLONE_CONFINEMENT_SPEC',
      'ICLONE_LAUNCHER_GRANT_ROOTS',
      'ICLONE_LAUNCHER_HERMES_HOME',
      'ICLONE_LAUNCHER_HOME',
      'ICLONE_LAUNCHER_JOURNAL_DIR',
      'ICLONE_LAUNCHER_READ_ROOTS',
      'ICLONE_LAUNCHER_SOCKET',
      'ICLONE_LAUNCHER_WRITE_ROOTS',
      'LANG',
      'PATH'
    ])
    await target.stop()
  })
})

describe('start', () => {
  it('spawns the runtime python -I -S with the contract env only and resolves up on the ready line', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await expect(layer.start()).resolves.toBe('up')
    expect(layer.state()).toBe('up')
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/rt/venv/bin/python')
    expect(calls[0].args).toEqual(['-I', '-S', '/rt/plugins/iclone-confinement/launcher.py'])
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(calls[0].options.env).toEqual({
      ICLONE_CONFINEMENT_SPEC: '{"v":5}',
      ICLONE_LAUNCHER_SOCKET: path.join(dir, 'run', 'launcher.sock'),
      ICLONE_LAUNCHER_JOURNAL_DIR: path.join(dir, 'run'),
      ICLONE_LAUNCHER_READ_ROOTS: '["/rt","/rt/venv"]',
      ICLONE_LAUNCHER_WRITE_ROOTS: '["/Users/owner/.hermes","/scratch"]',
      ICLONE_LAUNCHER_GRANT_ROOTS: '["/scratch"]',
      ICLONE_LAUNCHER_HOME: '/Users/owner',
      ICLONE_LAUNCHER_HERMES_HOME: '/Users/owner/.hermes',
      PATH: LAUNCHER_PATH,
      LANG: 'C'
    })
  })

  it('nothing from main env is inherited', async () => {
    process.env.ICLONE_SHOULD_NOT_LEAK = '1'

    try {
      const layer = launcher(child => queueMicrotask(() => child.ready()))

      await layer.start()
      expect(Object.keys(calls[0].options.env as object)).not.toContain('ICLONE_SHOULD_NOT_LEAK')
      expect(Object.keys(calls[0].options.env as object)).not.toContain('HOME')
    } finally {
      delete process.env.ICLONE_SHOULD_NOT_LEAK
    }
  })

  it('creates the socket directory 0700, and re-tightens one that exists wider', async () => {
    fs.mkdirSync(path.join(dir, 'run'), { mode: 0o755 })
    fs.chmodSync(path.join(dir, 'run'), 0o755)

    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()
    expect(fs.statSync(path.join(dir, 'run')).mode & 0o777).toBe(0o700)
  })

  it('a symlink where the socket directory goes refuses the start (down, nothing spawned)', async () => {
    fs.mkdirSync(path.join(dir, 'elsewhere'))
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'run'))

    const layer = launcher()

    await expect(layer.start()).resolves.toBe('down')
    expect(calls).toHaveLength(0)
    expect(() => ensurePrivateDir(path.join(dir, 'run'))).toThrow(/not a directory/)
  })

  it('accepts the ready line split across chunks', async () => {
    const layer = launcher(child =>
      queueMicrotask(() => {
        child.stdout.emit('data', 'starting\nICLONE-LAUNCHER-')
        child.stdout.emit('data', `READY ${child.pid}\n`)
      })
    )

    await expect(layer.start()).resolves.toBe('up')
  })

  it('no ready line within 5 s ⇒ killed and down', async () => {
    const layer = launcher()
    const started = layer.start()

    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)

    await expect(started).resolves.toBe('down')
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(layer.state()).toBe('down')
  })

  it('a ready line naming another pid is not ready: killed and down', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready(child.pid + 1)))

    await expect(layer.start()).resolves.toBe('down')
    expect(children[0].signals).toContain('SIGTERM')
  })

  it('exit before ready ⇒ down', async () => {
    const layer = launcher(child => queueMicrotask(() => child.die(2)))

    await expect(layer.start()).resolves.toBe('down')
  })

  it('never two launchers: concurrent starts share one spawn, and a start while up spawns nothing', async () => {
    const layer = launcher()
    const first = layer.start()
    const second = layer.start()

    children[0].ready()
    await expect(Promise.all([first, second])).resolves.toEqual(['up', 'up'])
    await expect(layer.start()).resolves.toBe('up')
    expect(calls).toHaveLength(1)
  })

  it('stderr lines are logged', async () => {
    const layer = launcher(child =>
      queueMicrotask(() => {
        child.stderr.emit('data', 'bad spec\n')
        child.ready()
      })
    )

    await layer.start()
    expect(logs).toContain('[confinement] launcher: bad spec')
  })
})

describe('stop', () => {
  it('SIGTERM, and the launcher is down', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()
    await layer.stop()
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(layer.state()).toBe('down')
  })

  it('SIGKILL after 2 s when SIGTERM is ignored', async () => {
    obeysTerm = false

    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()

    const stopped = layer.stop()

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1)
    expect(children[0].signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    await stopped
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('idempotent: a second stop sends nothing more, a stop with nothing running is a no-op', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.stop()
    await layer.start()
    await Promise.all([layer.stop(), layer.stop()])
    await layer.stop()
    expect(children[0].signals).toEqual(['SIGTERM'])
  })

  it('a stopped launcher is not restarted, and can be started again', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()
    await layer.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    await expect(layer.start()).resolves.toBe('up')
    expect(calls).toHaveLength(2)
  })
})

describe('restart', () => {
  it('an unexpected exit is restarted after the backoff', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()
    children[0].die(1)
    expect(layer.state()).toBe('down')
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS)
    expect(calls).toHaveLength(2)
    expect(layer.state()).toBe('up')
  })

  it('at most 3 restarts a minute, with growing delays; then it stays down and says so once', async () => {
    const layer = launcher(child => queueMicrotask(() => child.ready()))

    await layer.start()

    for (let restart = 0; restart < MAX_RESTARTS; restart += 1) {
      children.at(-1)?.die(1)
      await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS * 2 ** restart - 1)
      expect(calls).toHaveLength(restart + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(restart + 2)
    }

    children.at(-1)?.die(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(MAX_RESTARTS + 1)
    expect(layer.state()).toBe('down')
    expect(logs.filter(line => line.includes('stays down'))).toHaveLength(1)

    // An explicit start brings it back with a fresh budget.
    await expect(layer.start()).resolves.toBe('up')
    expect(calls).toHaveLength(MAX_RESTARTS + 2)
  })

  it('a launcher that never gets ready is retried within the same budget, then left down', async () => {
    const layer = launcher()

    await Promise.all([layer.start(), vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // The first launch and three restarts, each killed for silence.
    expect(calls).toHaveLength(MAX_RESTARTS + 1)
    expect(children.every(child => child.signals.includes('SIGTERM'))).toBe(true)
    expect(layer.state()).toBe('down')
  })
})
