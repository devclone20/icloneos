import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QuitSteps } from './main/shutdown-signals-app'
import { quitPromptFor } from './quit-guard'

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

function rig(options: { activeWork?: number; deadlineMs?: number; holdUntil?: () => null | number } = {}) {
  const events: string[] = []
  const lines: string[] = []
  const timers: { ms: number; run: () => void }[] = []
  const cleared: unknown[] = []
  const proc = new EventEmitter()
  const appEvents = new EventEmitter()
  const quitState = { isQuittingForHandoff: false }
  const dialogs: string[] = []
  let clock = 1_000
  let pending = ['backends', 'windows 1']

  let ready: () => void = () => {}

  const whenReady = new Promise<void>(resolve => {
    ready = resolve
  })

  const app = {
    exits: [] as number[],
    quits: 0,
    on: (event: 'quit', listener: () => void) => appEvents.on(event, listener),
    prependListener: (event: 'before-quit', listener: () => void) => appEvents.prependListener(event, listener),
    whenReady: () => whenReady,
    // What main.ts's before-quit does first: ask before a quit that would kill work in flight.
    quit() {
      app.quits += 1
      events.push('quit')
      const prompt = quitPromptFor({ count: options.activeWork ?? 0, titles: [] }, quitState.isQuittingForHandoff)

      if (prompt) {
        dialogs.push(prompt.message)
      }

      // Like Electron: app.quit() runs every before-quit listener before it returns.
      appEvents.emit('before-quit')
    },
    exit(code: number) {
      app.exits.push(code)
      events.push(`exit ${code}`)
      // Like Electron: app.exit() still emits 'quit' (without before-quit or will-quit).
      appEvents.emit('quit')
    }
  }

  const deps = {
    app,
    process: proc,
    quitState,
    log: (line: string) => {
      lines.push(line)
      events.push('log')
    },
    beginTeardown: (signal: string) => events.push(`teardown ${signal}`),
    saveMinimumState: () => events.push('save'),
    stopOwnedChildren: () => {
      events.push('stop')

      return ['backend 4242']
    },
    pendingTeardown: () => pending,
    now: () => clock,
    holdUntil: options.holdUntil,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { ms, run }

      timers.push(timer)

      return timer
    },
    clearTimeout: (timer: unknown) => cleared.push(timer),
    deadlineMs: options.deadlineMs
  }

  return {
    advance: (ms: number) => {
      clock += ms
    },
    app,
    appEvents,
    clock: () => clock,
    cleared,
    deps,
    dialogs,
    events,
    lines,
    proc,
    quitState,
    ready: () => ready(),
    setPending: (next: string[]) => {
      pending = next
    },
    timers
  }
}

/**
 * The OS side of a signal, as measured on a packed build: Node sets its handler (sigaction) when a signal gets its
 * first listener and drops it when the last one goes; Chromium sets its own one-shot handler during browser start-up,
 * replacing Node's; when Chromium's fires it resets the signal to the default and asks the app to quit (before-quit).
 */
function osSignals(r: ReturnType<typeof rig>) {
  const owner: Record<string, 'chromium' | 'default' | 'node'> = {
    SIGTERM: 'default',
    SIGINT: 'default',
    SIGHUP: 'default'
  }

  let chromiumQuits = 0

  r.proc.on('newListener', (event: string) => {
    if (event in owner && r.proc.listenerCount(event) === 0) {
      owner[event] = 'node'
    }
  })
  r.proc.on('removeListener', (event: string) => {
    if (event in owner && r.proc.listenerCount(event) === 0) {
      owner[event] = 'default'
    }
  })

  return {
    owner: (signal: string) => owner[signal],
    chromiumStarts: () => {
      for (const signal of SIGNALS) {
        owner[signal] = 'chromium'
      }
    },
    chromiumQuits: () => chromiumQuits,
    deliver(signal: (typeof SIGNALS)[number]) {
      if (owner[signal] === 'node') {
        r.proc.emit(signal, signal)
      } else if (owner[signal] === 'chromium') {
        owner[signal] = 'default'
        chromiumQuits += 1
        r.appEvents.emit('before-quit')
      } else {
        throw new Error(`${signal}: default action, the process is killed`)
      }
    }
  }
}

async function load() {
  return import('./shutdown-signals')
}

async function loadApp() {
  return import('./main/shutdown-signals-app')
}

describe('shutdown signals: the OS or the user is leaving, so the app quits cleanly and in bounded time', () => {
  it('importing the module installs nothing', async () => {
    const before = SIGNALS.map(signal => process.listenerCount(signal))

    await load()

    expect(SIGNALS.map(signal => process.listenerCount(signal))).toEqual(before)
  })

  it('a handler for SIGTERM, SIGINT and SIGHUP, installed once however often install runs', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const first = installShutdownSignals(r.deps)
    const again = installShutdownSignals(r.deps)

    expect(again).toBe(first)

    for (const signal of SIGNALS) {
      expect(r.proc.listenerCount(signal)).toBe(1)
    }
  })

  it.each(SIGNALS)('%s starts the normal quit once: teardown first, then app.quit(), deadline 8 s', async signal => {
    const { installShutdownSignals, SIGNAL_QUIT_DEADLINE_MS } = await load()
    const r = rig()

    const handle = installShutdownSignals(r.deps)
    r.proc.emit(signal, signal)

    expect(SIGNAL_QUIT_DEADLINE_MS).toBe(8_000)
    expect(r.app.quits).toBe(1)
    // app.quit() runs before-quit at once: its line says the signal is already recorded, and no quit cap is armed.
    expect(r.events).toEqual(['log', 'log', `teardown ${signal}`, 'quit', 'log'])
    expect(r.timers.map(timer => timer.ms)).toEqual([8_000])
    expect(r.app.exits).toEqual([])
    expect(handle.signalled()).toBe(signal)
    expect(r.lines).toEqual([
      '[shutdown] handlers installed (early)',
      `[shutdown] ${signal} received: quitting (deadline 8000 ms)`,
      '[shutdown] before-quit seen (signal=yes)'
    ])
  })

  it('no confirmation dialog on a signal, even with work in flight (a plain quit would ask)', async () => {
    const { installShutdownSignals } = await load()
    const r = rig({ activeWork: 2 })

    r.app.quit()
    expect(r.dialogs).toHaveLength(1)

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')

    expect(r.quitState.isQuittingForHandoff).toBe(true)
    expect(r.dialogs).toHaveLength(1)
    expect(r.app.quits).toBe(2)
  })

  it('the deadline forces the exit: children stopped, one line naming what did not finish, state saved, 128+n', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const handle = installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.events.length = 0
    r.lines.length = 0
    r.advance(8_000)
    r.timers[0]!.run()

    expect(r.events).toEqual(['stop', 'log', 'save', 'exit 143'])
    expect(r.lines).toEqual([
      '[shutdown] deadline: forcing exit after 8000 ms; not finished: backends, windows 1; stopped: backend 4242'
    ])
    expect(handle.forced()).toBe(true)
  })

  it('a second signal accelerates to the exit, but only after the minimum state is saved and children stopped', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.proc.emit('SIGINT', 'SIGINT')
    r.events.length = 0
    r.advance(800)
    r.proc.emit('SIGTERM', 'SIGTERM')

    expect(r.events).toEqual(['stop', 'log', 'save', 'exit 130'])
    expect(r.lines.at(-1)).toMatch(/^\[shutdown\] second SIGTERM: forcing exit after 800 ms; not finished: backends/)
    expect(r.app.quits).toBe(1)

    // The deadline that fires later, and a third signal, change nothing.
    r.timers[0]!.run()
    r.proc.emit('SIGHUP', 'SIGHUP')
    expect(r.app.exits).toEqual([130])
  })

  it('a clean quit before the deadline is logged with its time and never forced', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const handle = installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.advance(270)
    r.setPending([])
    r.appEvents.emit('quit')

    expect(r.lines.at(-1)).toBe('[shutdown] SIGTERM: clean quit after 270 ms')
    expect(handle.forced()).toBe(false)
    expect(r.app.exits).toEqual([])
  })

  it('a failing teardown step never stops the quit or the forced exit', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const boom = () => {
      throw new Error('boom')
    }

    installShutdownSignals({ ...r.deps, beginTeardown: boom, stopOwnedChildren: boom, saveMinimumState: boom })
    r.proc.emit('SIGTERM', 'SIGTERM')
    expect(r.app.quits).toBe(1)
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([143])
    expect(r.lines.some(line => line.includes('saving state failed: boom'))).toBe(true)
  })

  it('a log that throws never stops the quit, the forced exit or the clean-quit path', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const log = () => {
      r.events.push('log throws')
      throw new Error('disk full')
    }

    installShutdownSignals({ ...r.deps, log })

    expect(() => r.proc.emit('SIGTERM', 'SIGTERM')).not.toThrow()
    expect(r.app.quits).toBe(1)
    expect(r.events).toContain('teardown SIGTERM')
    expect(r.timers.map(timer => timer.ms)).toEqual([8_000])

    r.events.length = 0
    expect(() => r.timers[0]!.run()).not.toThrow()
    expect(r.events.filter(event => event !== 'log throws')).toEqual(['stop', 'save', 'exit 143'])
    expect(r.app.exits).toEqual([143])
  })

  it('a log that throws never stops a second signal from exiting, nor throws out of the quit event', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    const log = () => {
      throw new Error('disk full')
    }

    installShutdownSignals({ ...r.deps, log, saveMinimumState: log })

    expect(() => r.appEvents.emit('before-quit')).not.toThrow()
    r.proc.emit('SIGINT', 'SIGINT')
    expect(() => r.appEvents.emit('before-quit')).not.toThrow()
    expect(() => r.appEvents.emit('quit')).not.toThrow()
    expect(() => r.proc.emit('SIGTERM', 'SIGTERM')).not.toThrow()
    expect(r.app.exits).toEqual([130])
  })

  it('a quit no signal started is left alone', async () => {
    const { installShutdownSignals } = await load()
    const r = rig({ activeWork: 1 })

    installShutdownSignals(r.deps)
    r.appEvents.emit('quit')

    expect(r.lines).toEqual(['[shutdown] handlers installed (early)'])
    expect(r.quitState.isQuittingForHandoff).toBe(false)
  })
})

describe('shutdown signals: installed early, then again once the app is ready, so ours is the OS handler', () => {
  const settle = () => new Promise(resolve => setImmediate(resolve))

  it('early install, then at ready every listener comes off and goes back in order (Node sets its handler again)', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const seen: string[] = []
    const other = () => seen.push('other')
    const trail: string[] = []

    r.proc.on('SIGTERM', other)
    r.proc.on('newListener', (event: string, listener: unknown) => {
      if (event === 'SIGTERM') {
        trail.push(`add ${listener === other ? 'other' : 'ours'}`)
      }
    })
    r.proc.on('removeListener', (event: string, listener: unknown) => {
      if (event === 'SIGTERM') {
        trail.push(`remove ${listener === other ? 'other' : 'ours'} (${r.proc.listenerCount('SIGTERM')} left)`)
      }
    })

    const handle = installShutdownSignals(r.deps)

    expect(trail).toEqual(['remove other (0 left)', 'add other', 'add ours'])
    expect(r.lines).toEqual(['[shutdown] handlers installed (early)'])

    trail.length = 0
    r.ready()
    await settle()

    expect(trail).toEqual(['remove other (1 left)', 'remove ours (0 left)', 'add other', 'add ours'])
    expect(r.lines).toEqual(['[shutdown] handlers installed (early)', '[shutdown] handlers installed (ready)'])

    for (const signal of SIGNALS) {
      expect(r.proc.listeners(signal).filter(listener => listener !== other)).toHaveLength(1)
    }

    // Once per phase.
    handle.install('ready')
    handle.install('early')
    expect(r.lines).toHaveLength(2)

    r.proc.emit('SIGTERM', 'SIGTERM')
    expect(seen).toEqual(['other'])
    expect(r.app.quits).toBe(1)
    expect(r.lines.slice(-2)).toEqual([
      '[shutdown] SIGTERM received: quitting (deadline 8000 ms)',
      '[shutdown] before-quit seen (signal=yes)'
    ])
  })

  it('start-up as measured (early install, Chromium takes the signals, ready): ONE SIGTERM is ours, ONE clean quit', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const os = osSignals(r)

    const handle = installShutdownSignals(r.deps)
    os.chromiumStarts()
    r.ready()
    await settle()

    expect(SIGNALS.map(signal => os.owner(signal))).toEqual(['node', 'node', 'node'])
    os.deliver('SIGTERM')
    r.appEvents.emit('quit')

    expect(os.chromiumQuits()).toBe(0)
    expect(r.app.quits).toBe(1)
    expect(r.lines.filter(line => line.startsWith('[shutdown] SIGTERM received'))).toHaveLength(1)
    expect(r.lines.filter(line => line.includes('clean quit'))).toEqual(['[shutdown] SIGTERM: clean quit after 0 ms'])
    // No forced exit: Electron's own quit ends the process with status 0.
    expect(r.app.exits).toEqual([])
    expect(handle.forced()).toBe(false)
    // Node's handler is not one-shot: TERM stays caught after the first signal.
    expect(os.owner('SIGTERM')).toBe('node')
  })

  it('two SIGTERMs in a row after ready: one shutdown, no second quit, a non-zero exit and one line saying so', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const os = osSignals(r)

    installShutdownSignals(r.deps)
    os.chromiumStarts()
    r.ready()
    await settle()
    os.deliver('SIGTERM')
    r.advance(500)
    expect(() => os.deliver('SIGTERM')).not.toThrow()

    expect(r.app.quits).toBe(1)
    expect(r.app.exits).toEqual([143])
    expect(r.lines.filter(line => line.includes('forcing exit'))).toEqual([
      '[shutdown] second SIGTERM: forcing exit after 500 ms; not finished: backends, windows 1; stopped: backend 4242'
    ])
    expect(r.lines.filter(line => line.includes('clean quit'))).toEqual([])
  })

  it("SIGTERM before ready: ours until Chromium takes the signal; in the gap before ready the quit is Chromium's", async () => {
    const { installShutdownSignals } = await load()

    // Before Chromium sets its handler: the early install handles it, with the deadline armed.
    const early = rig()
    const earlyOs = osSignals(early)

    installShutdownSignals(early.deps)
    earlyOs.deliver('SIGTERM')
    expect(early.app.quits).toBe(1)
    expect(early.timers.map(timer => timer.ms)).toEqual([8_000])

    // Between Chromium's start-up and ready: Chromium's one-shot handler quits; ours never saw a signal. The code
    // cannot tell it from a user quit: the diagnostic line names it, and the quit cap bounds it like a user quit.
    const gap = rig()
    const gapOs = osSignals(gap)

    installShutdownSignals(gap.deps)
    gapOs.chromiumStarts()
    gapOs.deliver('SIGTERM')

    expect(gapOs.chromiumQuits()).toBe(1)
    expect(gap.timers.map(timer => timer.ms)).toEqual([12_000])
    expect(gap.lines.slice(-2)).toEqual([
      '[shutdown] before-quit seen (signal=no)',
      '[shutdown] quit cap armed (12000 ms)'
    ])

    // ready still puts ours back, so a later signal is ours.
    gap.ready()
    await settle()
    gapOs.deliver('SIGTERM')
    expect(gap.app.quits).toBe(1)
    // The signal's deadline replaces the cap of the quit already under way.
    expect(gap.timers.map(timer => timer.ms)).toEqual([12_000, 8_000])
    expect(gap.cleared).toEqual([gap.timers[0]])
  })

  it('ONE SIGTERM after both installs gives exactly ONE quit and ONE clean-quit line (no double handling)', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.ready()
    await settle()
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.appEvents.emit('quit')

    expect(r.app.quits).toBe(1)
    expect(r.timers).toHaveLength(1)
    expect(r.app.exits).toEqual([])
    expect(r.lines.filter(line => line.includes('received'))).toHaveLength(1)
    expect(r.lines.filter(line => line.includes('clean quit'))).toEqual(['[shutdown] SIGTERM: clean quit after 0 ms'])
  })

  it('a signal before ready quits at once; the reinstall at ready keeps that quit and its deadline', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.ready()
    await settle()

    expect(r.app.quits).toBe(1)
    expect(r.timers).toHaveLength(1)
    r.proc.emit('SIGINT', 'SIGINT')
    expect(r.app.exits).toEqual([143])
  })

  it('a ready that never comes, or fails, leaves the early handlers in place', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals({ ...r.deps, app: { ...r.app, whenReady: () => Promise.reject(new Error('no ready')) } })
    await settle()

    expect(r.lines).toEqual(['[shutdown] handlers installed (early)'])
    r.proc.emit('SIGHUP', 'SIGHUP')
    expect(r.app.quits).toBe(1)
  })

  it('before-quit: one line ahead of every other listener, saying whether a signal started the quit', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const order: string[] = []

    r.appEvents.on('before-quit', () => order.push(`main after ${r.lines.length} lines`))
    installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    expect(r.lines.slice(1)).toEqual([
      '[shutdown] before-quit seen (signal=no)',
      '[shutdown] quit cap armed (12000 ms)'
    ])
    expect(order).toEqual(['main after 3 lines'])

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.appEvents.emit('before-quit')
    expect(r.lines.at(-1)).toBe('[shutdown] before-quit seen (signal=yes)')
  })
})

describe('shutdown signals: exit codes, the deadline hold and a clean quit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129]
  ] as const)('a forced exit after %s uses 128 + n = %i', async (signal, code) => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.proc.emit(signal, signal)
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([code])
  })

  it('while a step with a hold runs (the SSH teardown), the deadline waits for it and then exits with one line', async () => {
    const { installShutdownSignals } = await load()
    let hold: null | number = null
    const r = rig({ holdUntil: () => hold })

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    const start = r.clock()
    // The SSH teardown began 3 s in (after a remote-update wait), with a 7 s hold: it may run until 10 s.
    hold = start + 10_000
    r.lines.length = 0
    r.advance(8_000)
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([])
    expect(r.lines).toEqual([])
    expect(r.timers.map(timer => timer.ms)).toEqual([8_000, 2_000])

    r.setPending(['ssh'])
    r.advance(2_000)
    r.timers[1]!.run()

    expect(r.app.exits).toEqual([143])
    expect(r.lines).toEqual([
      '[shutdown] deadline: forcing exit after 10000 ms; not finished: ssh; stopped: backend 4242'
    ])
  })

  it('the hold never passes the hard cap', async () => {
    const { installShutdownSignals, SIGNAL_QUIT_HARD_CAP_MS } = await load()
    const r = rig({ holdUntil: () => r.clock() + 60_000 })

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.advance(8_000)
    r.timers[0]!.run()
    expect(r.timers.map(timer => timer.ms)).toEqual([8_000, SIGNAL_QUIT_HARD_CAP_MS - 8_000])

    r.advance(SIGNAL_QUIT_HARD_CAP_MS - 8_000)
    r.timers[1]!.run()

    expect(r.app.exits).toEqual([143])
    expect(r.timers).toHaveLength(2)
  })

  it('the wall clock stepping back during the quit (NTP) moves neither the hold nor the cap: the clock is monotonic', async () => {
    const { installShutdownSignals, SIGNAL_QUIT_HARD_CAP_MS } = await load()
    const { createQuitSteps, SSH_QUIT_TEARDOWN_HOLD_MS } = await loadApp()
    let wall = 1_800_000_000_000
    let mono = 50_000

    vi.spyOn(Date, 'now').mockImplementation(() => wall)
    vi.spyOn(performance, 'now').mockImplementation(() => mono)

    const tick = (ms: number) => {
      wall += ms
      mono += ms
    }

    // Both defaults: the app's step registry and the signal handler read the same clock.
    const steps = createQuitSteps()
    const r = rig({ holdUntil: () => steps.holdUntil() })

    installShutdownSignals({ ...r.deps, now: undefined })
    r.proc.emit('SIGTERM', 'SIGTERM')
    tick(3_000)
    // The SSH teardown begins 3 s in: it may run until 10 s.
    void steps.track('ssh', new Promise<void>(() => undefined), SSH_QUIT_TEARDOWN_HOLD_MS)
    tick(2_000)
    wall -= 3_600_000
    tick(3_000)
    r.lines.length = 0
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([])
    expect(r.timers.map(timer => timer.ms)).toEqual([8_000, 2_000])

    tick(2_000)
    r.setPending(['ssh'])
    r.timers[1]!.run()
    expect(r.app.exits).toEqual([143])
    expect(r.lines).toEqual([
      '[shutdown] deadline: forcing exit after 10000 ms; not finished: ssh; stopped: backend 4242'
    ])

    // A hold far past the cap, with the wall clock stepping back: still at most 12 s after the signal.
    const capped = rig({ holdUntil: () => steps.holdUntil() })
    const start = mono

    installShutdownSignals({ ...capped.deps, now: undefined })
    capped.proc.emit('SIGHUP', 'SIGHUP')
    void steps.track('slow', new Promise<void>(() => undefined), 60_000)
    wall -= 3_600_000
    mono = start + 8_000
    capped.timers[0]!.run()

    expect(capped.timers.map(timer => timer.ms)).toEqual([8_000, SIGNAL_QUIT_HARD_CAP_MS - 8_000])
  })

  it('a hold that already ended does not delay the deadline', async () => {
    const { installShutdownSignals } = await load()
    const r = rig({ holdUntil: () => r.clock() - 1 })

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([143])
  })

  it('a second signal does not wait for a hold', async () => {
    const { installShutdownSignals } = await load()
    const r = rig({ holdUntil: () => r.clock() + 5_000 })

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.proc.emit('SIGTERM', 'SIGTERM')

    expect(r.app.exits).toEqual([143])
  })

  it('a clean quit clears the deadline: a slow Chromium shutdown afterwards is not logged as a deadline', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.advance(300)
    r.appEvents.emit('quit')

    expect(r.cleared).toEqual([r.timers[0]])

    // Even if the timer fired anyway, it is a no-op.
    r.advance(9_000)
    r.timers[0]!.run()
    expect(r.app.exits).toEqual([])
    expect(r.lines.filter(line => line.includes('deadline:'))).toEqual([])
    expect(r.lines.at(-1)).toBe('[shutdown] SIGTERM: clean quit after 300 ms')
  })

  it('a second signal after a clean quit still forces the exit (a hung Chromium shutdown)', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.proc.emit('SIGTERM', 'SIGTERM')
    r.appEvents.emit('quit')
    r.proc.emit('SIGINT', 'SIGINT')

    expect(r.app.exits).toEqual([143])
    expect(r.events.slice(-4)).toEqual(['stop', 'log', 'save', 'exit 143'])
  })

  it('the default timer is unref-ed and cleared on quit', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const unref = vi.fn()
    const timer = { unref }
    const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => timer) as never)
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined)

    installShutdownSignals({ ...r.deps, setTimeout: undefined, clearTimeout: undefined })
    r.proc.emit('SIGTERM', 'SIGTERM')

    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]![1]).toBe(8_000)
    expect(unref).toHaveBeenCalledTimes(1)

    r.appEvents.emit('quit')
    expect(clear).toHaveBeenCalledWith(timer)
  })
})

describe('the app side: quit steps', () => {
  it('a tracked step is pending until it settles, resolved or rejected, and its hold ends with it', async () => {
    const { createQuitSteps } = await loadApp()
    let clock = 100
    const steps = createQuitSteps(() => clock)

    let resolveSsh: () => void = () => {}

    let rejectUpdates: (error: Error) => void = () => {}

    const ssh = new Promise<void>(resolve => {
      resolveSsh = resolve
    })

    const updates = new Promise<void>((_, reject) => {
      rejectUpdates = reject
    })

    expect(steps.track('ssh', ssh, 7_000)).toBe(ssh)
    clock = 400
    void steps.track('remote updates', updates).catch(() => undefined)

    expect(steps.pending()).toEqual(['ssh', 'remote updates'])
    expect(steps.holdUntil()).toBe(7_100)

    resolveSsh()
    rejectUpdates(new Error('gone'))
    await new Promise(resolve => setImmediate(resolve))

    expect(steps.pending()).toEqual([])
    expect(steps.holdUntil()).toBeNull()
  })
})

describe('the app side: a quit step that fails says why', () => {
  it('the reason of a rejected step is reported once, earlier failures first, and the step is no longer pending', async () => {
    const { createQuitSteps } = await loadApp()
    const steps = createQuitSteps(() => 0)
    const lines: string[] = []

    void steps.track('ssh', Promise.reject(new Error('host unreachable')), 7_000).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))
    steps.reportFailures(line => lines.push(line))
    expect(lines).toEqual(['[shutdown] quit step ssh failed: host unreachable'])

    void steps.track('remote updates', Promise.reject('timeout')).catch(() => undefined)
    void steps.track('fine', Promise.resolve())
    await new Promise(resolve => setImmediate(resolve))

    expect(lines).toEqual([
      '[shutdown] quit step ssh failed: host unreachable',
      '[shutdown] quit step remote updates failed: timeout'
    ])
    expect(steps.pending()).toEqual([])
    expect(steps.holdUntil()).toBeNull()
  })

  it('a sink that throws is not a new unhandled rejection', async () => {
    const { createQuitSteps } = await loadApp()
    const steps = createQuitSteps(() => 0)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)

    process.on('unhandledRejection', onUnhandled)

    try {
      steps.reportFailures(() => {
        throw new Error('disk full')
      })
      void steps.track('ssh', Promise.reject(new Error('gone'))).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
    expect(steps.pending()).toEqual([])
  })
})

function child(pid: unknown, overrides: Partial<{ exitCode: null | number; signalCode: null | string }> = {}) {
  const kills: string[] = []

  return {
    pid: pid as number,
    exitCode: null as null | number,
    signalCode: null as null | string,
    kills,
    killResult: true,
    kill(signal: 'SIGKILL') {
      kills.push(signal)

      return this.killResult
    },
    ...overrides
  }
}

describe('the app side: owned children', () => {
  it.each([
    ['pid 0', 0],
    ['a negative pid', -4242],
    ['NaN', Number.NaN],
    ['pid 1', 1],
    ['a fraction', 42.5],
    ['no pid', undefined]
  ])('%s is never captured or killed', async (_name, pid) => {
    const { createOwnedChildren, ownedChildRunning } = await loadApp()
    const kills: number[] = []
    const bad = child(pid)

    const children = createOwnedChildren({
      list: () => [['backend', bad]],
      kill: target => kills.push(target),
      isWindows: false,
      killTree: target => kills.push(target)
    })

    expect(ownedChildRunning(bad)).toBe(false)
    children.capture()
    expect(children.stop()).toEqual([])
    expect(kills).toEqual([])
    expect(bad.kills).toEqual([])
  })

  it('kills the whole group of each child captured at the signal, even after its handle is gone', async () => {
    const { createOwnedChildren } = await loadApp()
    const kills: [number, string][] = []
    const primary = child(4242)
    const pooled = child(5151)

    let listed: [string, null | ReturnType<typeof child>][] = [
      ['backend', primary],
      ['pool work', pooled]
    ]

    const children = createOwnedChildren({
      list: () => listed,
      kill: (pid, signal) => kills.push([pid, signal]),
      isWindows: false,
      killTree: () => undefined
    })

    children.capture()
    listed = [['backend', null]]

    expect(children.stop()).toEqual(['backend 4242', 'pool work 5151'])
    expect(kills).toEqual([
      [-4242, 'SIGKILL'],
      [-5151, 'SIGKILL']
    ])
  })

  it.each([
    ['exitCode', { exitCode: 0 }],
    ['signalCode', { signalCode: 'SIGTERM' }]
  ])('a child that exited after the capture (%s set) is left alone and not reported', async (_name, exited) => {
    const { createOwnedChildren } = await loadApp()
    const kills: number[] = []
    const gone = child(4242)

    const children = createOwnedChildren({
      list: () => [['backend', gone]],
      kill: pid => kills.push(pid),
      isWindows: false,
      killTree: () => undefined
    })

    children.capture()
    Object.assign(gone, exited)

    expect(children.stop()).toEqual([])
    expect(kills).toEqual([])
    expect(gone.kills).toEqual([])
  })

  it('a gone group (ESRCH) falls back to the child itself; a child that cannot be signalled is not reported', async () => {
    const { createOwnedChildren } = await loadApp()
    const solo = child(4242)
    const stuck = child(5151)

    stuck.killResult = false

    const children = createOwnedChildren({
      list: () => [
        ['backend', solo],
        ['pool x', stuck]
      ],
      kill: () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      },
      isWindows: false,
      killTree: () => undefined
    })

    expect(children.stop()).toEqual(['backend 4242'])
    expect(solo.kills).toEqual(['SIGKILL'])
    expect(stuck.kills).toEqual(['SIGKILL'])
  })

  it('on Windows the tree kill runs instead of a group signal', async () => {
    const { createOwnedChildren } = await loadApp()
    const kills: number[] = []
    const trees: number[] = []
    const primary = child(4242)

    const children = createOwnedChildren({
      list: () => [['backend', primary]],
      kill: pid => kills.push(pid),
      isWindows: true,
      killTree: pid => trees.push(pid)
    })

    expect(children.stop()).toEqual(['backend 4242'])
    expect(trees).toEqual([4242])
    expect(kills).toEqual([])
    expect(primary.kills).toEqual([])
  })
})

function appEnv() {
  const calls: string[] = []
  let primary: null | ReturnType<typeof child> = child(4242)
  const kills: number[] = []
  const state = { cleanups: 0, sshOpen: 0, remoteUpdates: 0, windows: 0, installer: false }

  let finishBackends: () => void = () => {}

  let failBackends: (error: Error) => void = () => {}

  return {
    calls,
    kills,
    state,
    finishBackends: () => finishBackends(),
    failBackends: (error: Error) => failBackends(error),
    async build(steps?: QuitSteps) {
      const { buildAppShutdownDeps, createOwnedChildren, createQuitSteps } = await loadApp()

      const children = createOwnedChildren({
        list: () => [['backend', primary]],
        kill: pid => kills.push(pid),
        isWindows: false,
        killTree: () => undefined
      })

      return buildAppShutdownDeps({
        remember: line => calls.push(`remember ${line}`),
        flushLogSync: () => calls.push('flush'),
        clearLogFlushTimer: () => calls.push('clear log timer'),
        flushPendingAppearance: () => calls.push('appearance'),
        persistWindowState: () => calls.push('window state'),
        stopBackends: () => {
          calls.push('stop backends')
          // The backend stop invalidates the primary's handle.
          primary = null

          return new Promise<void>((resolve, reject) => {
            finishBackends = resolve
            failBackends = reject
          })
        },
        children,
        abortInstaller: () => state.installer,
        sshBootstrap: {
          cleanups: () => state.cleanups,
          forceCleanupAll: async () => {
            calls.push('force ssh cleanup')
          }
        },
        sshOpen: () => state.sshOpen,
        remoteUpdates: () => state.remoteUpdates,
        openWindows: () => state.windows,
        steps: steps ?? createQuitSteps()
      })
    }
  }
}

describe('the app side: what a signal tracks, saves and stops', () => {
  it('every log line is flushed to desktop.log synchronously', async () => {
    const env = appEnv()
    const deps = await env.build()

    deps.log('[shutdown] SIGTERM: clean quit after 12 ms')

    expect(env.calls).toEqual(['remember [shutdown] SIGTERM: clean quit after 12 ms', 'flush'])
  })

  it('the children are captured before the backend stop invalidates them, and killed at the deadline', async () => {
    const env = appEnv()
    const deps = await env.build()

    deps.beginTeardown('SIGTERM')
    expect(env.calls).toEqual(['stop backends'])

    expect(deps.stopOwnedChildren()).toEqual(['backend 4242'])
    expect(env.kills).toEqual([-4242])
  })

  it('a backend stop that fails leaves "backends" unfinished and logs why', async () => {
    const env = appEnv()
    const deps = await env.build()

    deps.beginTeardown('SIGTERM')
    env.failBackends(new Error('port busy'))
    await new Promise(resolve => setImmediate(resolve))

    expect(deps.pendingTeardown()).toEqual(['backends'])
    expect(env.calls).toEqual(['stop backends', 'remember [shutdown] stopping the backends failed: port busy', 'flush'])
  })

  it('a quit step that fails (the SSH force cleanup) reaches desktop.log with its reason', async () => {
    const { createQuitSteps } = await loadApp()
    const steps = createQuitSteps(() => 0)
    const env = appEnv()

    await env.build(steps)
    void steps.track('ssh', Promise.reject(new Error('cleanup refused')), 7_000).catch(() => undefined)
    await new Promise(resolve => setImmediate(resolve))

    expect(env.calls).toEqual(['remember [shutdown] quit step ssh failed: cleanup refused', 'flush'])
  })

  it('the minimum state: appearance, window bounds, then the log buffer written last', async () => {
    const env = appEnv()
    const deps = await env.build()

    deps.saveMinimumState()

    expect(env.calls).toEqual(['appearance', 'window state', 'clear log timer', 'flush'])
  })

  it('SSH: a bootstrap with cleanups is force-cleaned and named; an established connection is never claimed stopped', async () => {
    const env = appEnv()
    const deps = await env.build()

    env.state.sshOpen = 2
    expect(deps.stopOwnedChildren()).toEqual(['backend 4242'])
    expect(env.calls).not.toContain('force ssh cleanup')
    expect(deps.pendingTeardown()).toContain('ssh')

    env.state.cleanups = 2
    expect(deps.stopOwnedChildren()).toEqual(['backend 4242', 'ssh bootstrap 2'])
    expect(env.calls).toContain('force ssh cleanup')
  })

  it('a running installer is aborted and named', async () => {
    const env = appEnv()
    const deps = await env.build()

    env.state.installer = true

    expect(deps.stopOwnedChildren()).toEqual(['backend 4242', 'installer'])
  })

  it('the SSH teardown before-quit started is pending even after it removed the connection from the map', async () => {
    const { createQuitSteps, SSH_QUIT_TEARDOWN_HOLD_MS } = await loadApp()
    const steps = createQuitSteps(() => 50)
    const env = appEnv()
    const deps = await env.build(steps)

    let done: () => void = () => {}

    deps.beginTeardown('SIGTERM')
    env.finishBackends()
    await new Promise(resolve => setImmediate(resolve))
    void steps.track(
      'ssh',
      new Promise<void>(resolve => {
        done = resolve
      }),
      SSH_QUIT_TEARDOWN_HOLD_MS
    )
    env.state.sshOpen = 0

    expect(deps.pendingTeardown()).toEqual(['ssh'])
    expect(deps.holdUntil?.()).toBe(50 + SSH_QUIT_TEARDOWN_HOLD_MS)

    done()
    await new Promise(resolve => setImmediate(resolve))
    expect(deps.pendingTeardown()).toEqual([])
    expect(deps.holdUntil?.()).toBeNull()
  })

  it('a remote-update wait cut by the deadline is named "remote updates" in the one line', async () => {
    const { installShutdownSignals } = await load()
    const { createQuitSteps } = await loadApp()
    const steps = createQuitSteps()
    const env = appEnv()
    const r = rig()
    const appDeps = await env.build(steps)

    installShutdownSignals({ ...r.deps, ...appDeps, now: r.deps.now, setTimeout: r.deps.setTimeout })
    r.proc.emit('SIGTERM', 'SIGTERM')
    // before-quit joins the remote update first; it never settles here.
    void steps.track('remote updates', new Promise<void>(() => undefined))
    env.state.remoteUpdates = 0
    r.advance(8_000)
    r.timers[0]!.run()

    expect(r.app.exits).toEqual([143])
    const line = env.calls.find(call => call.includes('deadline:'))

    expect(line).toBe(
      'remember [shutdown] deadline: forcing exit after 8000 ms; not finished: backends, remote updates; stopped: backend 4242'
    )
  })
})

describe('main.ts wiring', () => {
  const electronDir = __dirname
  const main = fs.readFileSync(path.join(electronDir, 'main.ts'), 'utf8')

  it('main.ts installs the handlers with exactly one call, at top level before the app is ready', () => {
    const calls = main.split('\n').filter(line => line.includes('installAppShutdownSignals('))

    expect(calls).toEqual(['installAppShutdownSignals()'])
    expect(main).toMatch(
      /import \{\s*capQuitForInstall,\s*capQuitForRemoteUpdates,\s*holdQuitForChoice,\s*installAppShutdownSignals,\s*quitRemoteUpdatesJoined,\s*quitTeardownSealed,\s*quitTrace,\s*relaunchOnForcedQuit,\s*requitAfter,\s*sealQuitTeardown,\s*SSH_QUIT_TEARDOWN_HOLD_MS,\s*type SshQuitTeardown,\s*sshQuitTeardownStep,\s*trackQuitStep\s*\} from '\.\/main\/shutdown-signals-wiring'/
    )
    expect(main.indexOf('installAppShutdownSignals()')).toBeLessThan(main.indexOf('app.whenReady()'))
  })

  it('the flag the signal sets is the one main.ts reads to skip the quit confirmation', () => {
    // fx21 added a third argument, the background count. The flag stays the second one, and quit-guard.test.ts proves
    // it answers first, whatever the count says.
    expect(main).toMatch(
      /quitPromptFor\(\s*mergeActiveWork\(activeWorkByWebContents\.values\(\)\),\s*quitState\.isQuittingForHandoff,/
    )
  })

  it('before-quit records its remote-update wait and its SSH teardown, so the deadline sees them', () => {
    expect(main).toMatch(
      /managedUpdateQuitWait = trackQuitStep\(\s*'remote updates',\s*waitForManagedUpdateOperations\(/
    )
    expect(main).toMatch(
      /void trackQuitStep\(\s*'ssh',\s*Promise\.race\(\[pending, new Promise\(resolve => setTimeout\(resolve, 6_000\)\)\]\)[\s\S]{0,200}forceCleanupAll\(\)[\s\S]{0,120}SSH_QUIT_TEARDOWN_HOLD_MS\s*\)/
    )
  })

  it('the deadline outlasts the SSH teardown budget before-quit gives it (6 s race), and the cap outlasts the hold', async () => {
    const { SIGNAL_QUIT_DEADLINE_MS, SIGNAL_QUIT_HARD_CAP_MS } = await load()
    const { SSH_QUIT_TEARDOWN_HOLD_MS } = await loadApp()

    expect(SSH_QUIT_TEARDOWN_HOLD_MS).toBeGreaterThan(6_000)
    expect(SIGNAL_QUIT_DEADLINE_MS).toBeGreaterThan(SSH_QUIT_TEARDOWN_HOLD_MS)
    expect(SIGNAL_QUIT_HARD_CAP_MS).toBeGreaterThan(SIGNAL_QUIT_DEADLINE_MS)
    expect(SIGNAL_QUIT_HARD_CAP_MS).toBeLessThanOrEqual(15_000)
  })

  it('the wiring tracks the backends, saves the minimum state and kills owned groups', () => {
    const wiring = fs.readFileSync(path.join(electronDir, 'main', 'shutdown-signals-wiring.ts'), 'utf8')

    expect(wiring).toContain('stopBackends: () => backendShutdown.run()')
    expect(wiring).toContain('flushLogSync: flushDesktopLogBufferSync')
    expect(wiring).toContain('persistWindowState: () => schedulePersistWindowState.flush()')
    expect(wiring).toContain('kill: (pid, signal) => process.kill(pid, signal)')
    expect(wiring).toContain('killTree: forceKillProcessTree')
    expect(wiring).toContain('forceCleanupAll: () => sshBootstrapCoordinator.forceCleanupAll()')
    expect(wiring).toContain('steps: quitSteps')
  })
})

describe('the quit cap: every quit no signal started is bounded too', () => {
  const cap = (r: ReturnType<typeof rig>) => r.timers.filter(timer => timer.ms === 12_000 || timer.ms === 60_000)

  it('a user quit arms the 12 s cap once per quit; one that never finishes is forced at 12 s with one line', async () => {
    const { installShutdownSignals, QUIT_HARD_CAP_MS, QUIT_CAP_EXIT_CODE } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    // The re-entered passes of the same quit (after each teardown step) do not re-arm it.
    r.appEvents.emit('before-quit')
    r.appEvents.emit('before-quit')

    expect(QUIT_HARD_CAP_MS).toBe(12_000)
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000])

    r.advance(12_000)
    r.timers[0].run()

    expect(r.app.exits).toEqual([QUIT_CAP_EXIT_CODE])
    expect(QUIT_CAP_EXIT_CODE).not.toBe(0)
    expect(r.events.slice(-3)).toEqual(['log', 'save', `exit ${QUIT_CAP_EXIT_CODE}`])
    expect(r.lines.filter(line => line.includes('forcing exit'))).toEqual([
      '[shutdown] quit cap: forcing exit after 12000 ms; not finished: backends, windows 1; stopped: backend 4242'
    ])
    // app.exit() emits 'quit': a forced exit is never also reported as a clean one.
    expect(r.lines.some(line => line.includes('clean quit'))).toBe(false)
  })

  it('"Keep Running" stands the cap down; the confirmed quit that follows arms it again', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.holdForChoice()

    expect(r.cleared).toEqual([r.timers[0]])
    expect(r.lines.at(-1)).toBe('[shutdown] quit held for the active-work choice: cap off')
    // A cap timer that fires anyway (already queued) forces nothing while the choice is on screen.
    r.advance(60_000)
    r.timers[0].run()
    expect(r.app.exits).toEqual([])

    // "Quit Anyway": app.quit() again; this quit is bounded from its own first before-quit.
    r.appEvents.emit('before-quit')
    expect(cap(r)).toHaveLength(2)
    expect(r.timers[1].ms).toBe(12_000)
    r.advance(12_000)
    r.timers[1].run()
    expect(r.app.exits).toEqual([1])
  })

  it('a clean user quit clears the cap and says so', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    r.advance(40)
    r.appEvents.emit('quit')

    expect(r.cleared).toEqual([r.timers[0]])
    expect(r.lines.at(-1)).toBe('[shutdown] quit: clean quit after 40 ms (signal=no)')
    r.timers[0].run()
    expect(r.app.exits).toEqual([])
  })

  it('the app-update install gets its own cap (60 s from its first before-quit), never none and never 12 s', async () => {
    const { installShutdownSignals, INSTALL_QUIT_CAP_MS } = await load()
    const { APP_UPDATE_INSTALL_WATCHDOG_MS } = await import('./iclone-app-update')
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    expect(INSTALL_QUIT_CAP_MS).toBe(60_000)
    expect(INSTALL_QUIT_CAP_MS).toBeLessThan(APP_UPDATE_INSTALL_WATCHDOG_MS)

    r.appEvents.emit('before-quit')
    r.advance(5)
    handle.capForInstall()

    expect(r.cleared).toEqual([r.timers[0]])
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, 59_995])
    expect(r.lines.at(-1)).toBe('[shutdown] quit cap armed (60000 ms, app-update install)')

    r.advance(12_000)
    r.timers[0].run()
    expect(r.app.exits).toEqual([])

    r.advance(48_000)
    r.timers[1].run()
    expect(r.app.exits).toEqual([1])
  })

  it('a signal during a user quit replaces the cap with its own deadline', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    r.proc.emit('SIGTERM', 'SIGTERM')

    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, 8_000])
    expect(r.cleared).toEqual([r.timers[0]])
    r.timers[0].run()
    expect(r.app.exits).toEqual([])
    r.advance(8_000)
    r.timers[1].run()
    expect(r.app.exits).toEqual([143])
    expect(r.lines.some(line => line.includes('clean quit'))).toBe(false)
  })

  it('a user quit is never cut inside a running hold (the SSH teardown): the cap waits for it, then forces', async () => {
    const { installShutdownSignals } = await load()
    let hold: null | number = null
    const r = rig({ holdUntil: () => hold })

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    // The SSH teardown started at 10 s with its 7 s hold: it may run until 17 s.
    r.advance(10_000)
    hold = r.clock() + 7_000
    r.advance(2_000)
    r.timers[0].run()

    expect(r.app.exits).toEqual([])
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, 5_000])
    expect(r.lines.at(-1)).toBe('[shutdown] quit cap: waiting 5000 ms for the teardown hold')

    r.advance(5_000)
    hold = null
    r.timers[1].run()
    expect(r.app.exits).toEqual([1])
    expect(r.lines.filter(line => line.includes('forcing exit'))).toEqual([
      '[shutdown] quit cap: forcing exit after 17000 ms; not finished: backends, windows 1; stopped: backend 4242'
    ])
  })

  it('a hold never keeps a user quit past the cap plus the hold ceiling', async () => {
    const { installShutdownSignals, QUIT_CAP_HOLD_CEILING_MS } = await load()
    const r = rig({ holdUntil: () => r.clock() + 60_000 })

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    r.advance(12_000)
    r.timers[0].run()

    expect(QUIT_CAP_HOLD_CEILING_MS).toBe(12_000)
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, 12_000])
    r.advance(12_000)
    r.timers[1].run()
    expect(r.app.exits).toEqual([1])
  })

  it('a quit waiting for a remote update that finishes at 30 s is not cut at 12 s and ends clean', async () => {
    const { installShutdownSignals, REMOTE_UPDATE_QUIT_CAP_MS } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.capForRemoteUpdates()

    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, REMOTE_UPDATE_QUIT_CAP_MS])
    expect(r.cleared).toEqual([r.timers[0]])
    expect(r.lines.at(-1)).toBe(`[shutdown] quit cap armed (${REMOTE_UPDATE_QUIT_CAP_MS} ms, remote updates)`)

    // The 12 s cap that was replaced fires anyway (already queued): nothing.
    r.advance(12_000)
    r.timers[0].run()
    expect(r.app.exits).toEqual([])

    // The wait ends at 30 s: the SSH teardown and the rest of the quit get 12 s from now.
    r.advance(18_000)
    handle.remoteUpdatesJoined()
    expect(r.cleared).toEqual([r.timers[0], r.timers[1]])
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, REMOTE_UPDATE_QUIT_CAP_MS, 12_000])
    expect(r.lines.slice(-2)).toEqual(['[shutdown] remote updates joined', '[shutdown] quit cap armed (12000 ms)'])

    r.advance(100)
    r.appEvents.emit('quit')
    expect(r.lines.at(-1)).toBe('[shutdown] quit: clean quit after 30100 ms (signal=no)')

    for (const timer of r.timers) {
      timer.run()
    }

    expect(r.app.exits).toEqual([])
    expect(r.lines.some(line => line.includes('forcing exit'))).toBe(false)
  })

  it('after the remote updates joined, the rest of the quit is still bounded at 12 s from the join', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.capForRemoteUpdates()
    // A second prevented pass of the same wait does not re-arm or move the long cap.
    handle.capForRemoteUpdates()
    expect(r.timers).toHaveLength(2)
    r.advance(30_000)
    handle.remoteUpdatesJoined()
    handle.remoteUpdatesJoined()
    expect(r.timers).toHaveLength(3)
    r.advance(12_000)
    r.timers[2].run()
    expect(r.app.exits).toEqual([1])
    expect(r.lines.filter(line => line.includes('forcing exit'))).toEqual([
      '[shutdown] quit cap: forcing exit after 42000 ms; not finished: backends, windows 1; stopped: backend 4242'
    ])
  })

  it('a remote update that never finishes: the long cap forces the exit with its own named line', async () => {
    const { installShutdownSignals, REMOTE_UPDATE_QUIT_CAP_MS } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.capForRemoteUpdates()
    r.setPending(['backends', 'remote updates', 'windows 1'])
    r.advance(REMOTE_UPDATE_QUIT_CAP_MS)
    r.timers[1].run()

    expect(r.app.exits).toEqual([1])
    expect(r.lines.filter(line => line.includes('forcing exit'))).toEqual([
      `[shutdown] quit cap (remote updates): forcing exit after ${REMOTE_UPDATE_QUIT_CAP_MS} ms; ` +
        'not finished: backends, remote updates, windows 1; stopped: backend 4242'
    ])
  })

  it('"Keep Running" during the remote-update wait stands the long cap down; the next quit gets 12 s', async () => {
    const { installShutdownSignals, REMOTE_UPDATE_QUIT_CAP_MS } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.capForRemoteUpdates()
    handle.holdForChoice()
    expect(r.cleared).toEqual([r.timers[0], r.timers[1]])
    r.advance(REMOTE_UPDATE_QUIT_CAP_MS)
    r.timers[1].run()
    expect(r.app.exits).toEqual([])

    // The next quit decides again: 12 s until before-quit says it waits for remote updates again.
    r.appEvents.emit('before-quit')
    expect(r.timers.map(timer => timer.ms)).toEqual([12_000, REMOTE_UPDATE_QUIT_CAP_MS, 12_000])
    expect(r.lines.at(-1)).toBe('[shutdown] quit cap armed (12000 ms)')
    r.advance(12_000)
    r.timers[2].run()
    expect(r.app.exits).toEqual([1])
  })

  it('a join after "Keep Running" is not a quit under way: nothing is armed', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const handle = installShutdownSignals(r.deps)

    r.appEvents.emit('before-quit')
    handle.capForRemoteUpdates()
    handle.holdForChoice()
    const lines = r.lines.length

    handle.remoteUpdatesJoined()
    expect(r.timers).toHaveLength(2)
    expect(r.lines).toHaveLength(lines)
  })

  it('a signal makes a cap callback already queued stale: it cannot drop the deadline timer', async () => {
    const { installShutdownSignals } = await load()
    const r = rig()

    installShutdownSignals(r.deps)
    r.appEvents.emit('before-quit')
    r.proc.emit('SIGTERM', 'SIGTERM')
    // The cap's callback was already queued when the signal cleared it.
    r.timers[0].run()
    r.advance(30)
    r.appEvents.emit('quit')

    // The clean quit cancels the signal's deadline: the timer handle was not lost.
    expect(r.cleared).toEqual([r.timers[0], r.timers[1]])
    expect(r.lines.at(-1)).toBe('[shutdown] SIGTERM: clean quit after 30 ms')
  })

  it("the remote-update cap is derived from the updater's own worst case, and still bounded", async () => {
    const { REMOTE_UPDATE_QUIT_CAP_MS } = await load()
    const updater = fs.readFileSync(path.join(__dirname, 'managed-ssh-update.ts'), 'utf8')

    const constant = (name: string) => {
      const match = updater.match(new RegExp(`const ${name} = ([0-9_ *]+)\\n`))

      expect(match, name).not.toBeNull()

      return match![1]
        .replaceAll('_', '')
        .split('*')
        .reduce((product, factor) => product * Number(factor.trim()), 1)
    }

    const worst =
      constant('DEFAULT_REMOTE_UPDATE_TIMEOUT_MS') +
      constant('DEFAULT_REMOTE_CLEARANCE_TIMEOUT_MS') +
      constant('RECEIPT_GRACE_MS') +
      3 * 30_000 +
      10_000

    expect(REMOTE_UPDATE_QUIT_CAP_MS).toBeGreaterThanOrEqual(worst)
    expect(REMOTE_UPDATE_QUIT_CAP_MS).toBeLessThanOrEqual(2 * 60 * 60_000)
  })

  it("a third party's once listener stays one-shot across both installs (raw listeners go back)", async () => {
    const { installShutdownSignals } = await load()
    const r = rig()
    const fired: string[] = []

    r.proc.once('SIGHUP', () => fired.push('once'))
    installShutdownSignals(r.deps)
    r.ready()
    await new Promise(resolve => setImmediate(resolve))

    r.proc.emit('SIGHUP', 'SIGHUP')
    r.proc.emit('SIGHUP', 'SIGHUP')

    expect(fired).toEqual(['once'])
  })
})
