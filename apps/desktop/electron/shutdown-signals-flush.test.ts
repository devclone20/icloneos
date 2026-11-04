// A signal quit after Electron's 'quit': the session storage is flushed (at most 2 s), and only then is the exit armed,
// 3 s after 'quit', with the signal's code. A quit no signal started gets neither. A before-quit alone never marks the app
// as quitting (a quit that waits for a remote update still needs its restore dials); the active-work confirmation clears
// the mark. A quit cap's forced exit runs an armed relaunch first; a signal's forced exit never relaunches.
import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
  installShutdownSignals,
  POST_QUIT_EXIT_MS,
  SIGNAL_QUIT_DEADLINE_MS,
  STORAGE_FLUSH_CAP_MS
} from './shutdown-signals'

interface FakeTimer {
  at: number
  ms: number
  run: () => void
  cleared: boolean
}

function rig(
  options: { flush?: () => unknown; noFlushDep?: boolean; relaunch?: () => void; teardown?: () => string[] } = {}
) {
  const lines: string[] = []
  const timers: FakeTimer[] = []
  const proc = new EventEmitter()
  const appEvents = new EventEmitter()
  const quitState = { isQuittingForHandoff: false, quitting: false }
  const flushes: number[] = []
  let clock = 1_000

  const app = {
    exits: [] as number[],
    on: (event: 'quit' | 'will-quit', listener: () => void) => appEvents.on(event, listener),
    prependListener: (event: 'before-quit', listener: () => void) => appEvents.prependListener(event, listener),
    quit() {
      appEvents.emit('before-quit')
    },
    exit(code: number) {
      app.exits.push(code)
      appEvents.emit('quit')
    }
  }

  const handle = installShutdownSignals({
    app,
    process: proc,
    quitState,
    log: line => lines.push(line),
    beginTeardown: () => undefined,
    saveMinimumState: () => undefined,
    stopOwnedChildren: () => [],
    pendingTeardown: () => [],
    ...(options.relaunch ? { relaunchIfArmed: options.relaunch } : {}),
    ...(options.teardown ? { teardown: options.teardown } : {}),
    now: () => clock,
    setTimeout: (run: () => void, ms: number) => {
      const timer: FakeTimer = { at: clock, ms, run, cleared: false }

      timers.push(timer)

      return timer
    },
    clearTimeout: (timer: unknown) => {
      ;(timer as FakeTimer).cleared = true
    },
    ...(options.noFlushDep
      ? {}
      : {
          flushStorage: () => {
            flushes.push(clock)

            return options.flush?.()
          }
        })
  })

  const live = () => timers.filter(timer => !timer.cleared)

  return {
    advance: (ms: number) => {
      clock += ms
    },
    app,
    appEvents,
    flushes,
    handle,
    lines,
    live,
    proc,
    quitState,
    /** Runs the live timers due by now, oldest first (one pass). */
    runDue() {
      for (const timer of live()) {
        if (timer.at + timer.ms <= clock) {
          timer.cleared = true
          timer.run()
        }
      }
    },
    timers
  }
}

/** Lets the promise chains of the flush settle. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

const postQuitTimers = (r: ReturnType<typeof rig>) => r.live().filter(timer => timer.ms === POST_QUIT_EXIT_MS)

describe('signal quit: storage flush, then a bounded exit after quit', () => {
  it("the flush starts at the signal's before-quit and is awaited before the exit is armed", async () => {
    let finishFlush: () => void = () => undefined
    const r = rig({ flush: () => new Promise<void>(resolve => (finishFlush = resolve)) })

    r.proc.emit('SIGTERM', 'SIGTERM')
    expect(r.flushes).toEqual([1_000])
    r.advance(100)
    r.appEvents.emit('quit')
    await settle()
    // The flush has not finished: nothing may force the exit yet.
    expect(postQuitTimers(r)).toHaveLength(0)
    expect(r.app.exits).toEqual([])

    finishFlush()
    await settle()
    expect(r.lines).toContain('[shutdown] storage flush: done in 100 ms')
    expect(postQuitTimers(r)).toHaveLength(1)
    expect(r.lines).toContain(`[shutdown] SIGTERM: exit armed (${POST_QUIT_EXIT_MS} ms)`)
    // The flush ran once, however many before-quit passes the quit takes.
    r.appEvents.emit('before-quit')
    expect(r.flushes).toHaveLength(1)
  })

  it('a flush that never settles: the 2 s cap still lets the exit arm, and it fires 3 s after quit with 143', async () => {
    const r = rig({ flush: () => new Promise<void>(() => undefined) })

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.advance(50)
    r.appEvents.emit('quit')
    await settle()
    expect(postQuitTimers(r)).toHaveLength(0)

    const cap = r.live().find(timer => timer.ms === STORAGE_FLUSH_CAP_MS)

    expect(cap).toBeDefined()
    r.advance(STORAGE_FLUSH_CAP_MS - 50 - 1)
    r.runDue()
    await settle()
    expect(postQuitTimers(r)).toHaveLength(0)

    r.advance(1)
    r.runDue()
    await settle()
    expect(r.lines).toContain(`[shutdown] storage flush: timed out after ${STORAGE_FLUSH_CAP_MS} ms`)

    // Armed for what is left of the 3 s after 'quit' (quit at 1050, now 3000: 1050 ms left).
    const exitTimer = r.live().find(timer => timer.ms === 1_050)

    expect(exitTimer).toBeDefined()
    expect(r.app.exits).toEqual([])
    r.advance(1_049)
    r.runDue()
    expect(r.app.exits).toEqual([])
    r.advance(1)
    r.runDue()
    expect(r.app.exits).toEqual([143])
    expect(r.lines).toContain(`[shutdown] SIGTERM: exiting after quit (${POST_QUIT_EXIT_MS} ms)`)
  })

  it('a flush that throws or rejects still arms the exit, once, with 128 + n of the signal', async () => {
    const throwing = rig({
      flush: () => {
        throw new Error('no session yet')
      }
    })

    throwing.proc.emit('SIGINT', 'SIGINT')
    throwing.appEvents.emit('quit')
    await settle()
    expect(throwing.lines.some(line => line === '[shutdown] storage flush: failed after 0 ms (Error)')).toBe(true)
    expect(postQuitTimers(throwing)).toHaveLength(1)
    throwing.advance(POST_QUIT_EXIT_MS)
    throwing.runDue()
    expect(throwing.app.exits).toEqual([130])

    const rejecting = rig({ flush: () => Promise.reject(new Error('disk full')) })

    rejecting.proc.emit('SIGHUP', 'SIGHUP')
    rejecting.appEvents.emit('quit')
    await settle()
    expect(postQuitTimers(rejecting)).toHaveLength(1)
    rejecting.advance(POST_QUIT_EXIT_MS)
    rejecting.runDue()
    expect(rejecting.app.exits).toEqual([129])
  })

  it('a second signal after quit forces at once; the post-quit exit then does nothing', async () => {
    const r = rig({ flush: () => undefined })

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.appEvents.emit('quit')
    await settle()
    expect(postQuitTimers(r)).toHaveLength(1)
    r.proc.emit('SIGTERM', 'SIGTERM')
    expect(r.app.exits).toEqual([143])
    r.advance(POST_QUIT_EXIT_MS)
    r.runDue()
    expect(r.app.exits).toEqual([143])
  })

  it('a quit no signal started: no flush and no post-quit exit, whatever the time', async () => {
    const r = rig({ flush: () => undefined })

    r.app.quit()
    r.advance(200)
    r.appEvents.emit('quit')
    await settle()
    expect(r.flushes).toEqual([])
    expect(r.lines).toContain('[shutdown] quit: clean quit after 200 ms (signal=no)')
    expect(r.live()).toHaveLength(0)
    r.advance(60_000)
    r.runDue()
    expect(r.app.exits).toEqual([])
  })

  it('without a flush dep the signal quit still arms its exit after quit', async () => {
    const r = rig({ noFlushDep: true })

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.appEvents.emit('quit')
    await settle()
    expect(postQuitTimers(r)).toHaveLength(1)
  })
})

describe('a before-quit alone never marks the app as quitting', () => {
  it('a signal quit and a user quit leave quitting off at their first before-quit (main marks it at its teardown)', () => {
    const signal = rig()

    signal.proc.emit('SIGTERM', 'SIGTERM')
    expect(signal.quitState.quitting).toBe(false)

    const user = rig()

    user.app.quit()
    expect(user.quitState.quitting).toBe(false)
  })

  it('the active-work confirmation clears a quitting mark (Keep Running works on)', () => {
    const r = rig()

    r.app.quit()
    r.quitState.quitting = true
    r.handle.holdForChoice()
    expect(r.quitState.quitting).toBe(false)
  })
})

describe("a forced exit and the armed 'Restart now' relaunch", () => {
  it('the quit cap forces the exit: the armed relaunch runs once, before app.exit', async () => {
    const exitsAtRelaunch: number[][] = []
    const holder: { r?: ReturnType<typeof rig> } = {}

    holder.r = rig({ relaunch: () => exitsAtRelaunch.push([...holder.r!.app.exits]) })
    const r = holder.r

    r.app.quit()
    const cap = r.timers.find(timer => !timer.cleared && timer.ms === 12_000)!

    r.advance(12_000)
    cap.run()
    await settle()
    expect(r.app.exits).toEqual([1])
    expect(exitsAtRelaunch).toEqual([[]])
  })

  it("a signal's forced exit (deadline or second signal) never relaunches", async () => {
    let relaunches = 0
    const r = rig({ relaunch: () => (relaunches += 1) })

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.proc.emit('SIGTERM', 'SIGTERM')
    await settle()
    expect(r.app.exits).toEqual([143])
    expect(relaunches).toBe(0)
  })

  it("a signal's deadline exit never relaunches, even with a relaunch armed (alone, or over a user quit's cap)", async () => {
    for (const userQuitFirst of [false, true]) {
      let relaunches = 0
      const r = rig({ relaunch: () => (relaunches += 1) })

      if (userQuitFirst) {
        r.app.quit()
      }

      r.proc.emit('SIGTERM', 'SIGTERM')
      const deadline = r.live().find(timer => timer.ms === SIGNAL_QUIT_DEADLINE_MS)

      expect(deadline).toBeDefined()
      expect(r.app.exits).toEqual([])
      r.advance(SIGNAL_QUIT_DEADLINE_MS)
      r.runDue()
      await settle()
      expect(r.app.exits).toEqual([143])
      expect(relaunches).toBe(0)
    }
  })

  it('a relaunch that throws never stops the exit', async () => {
    const r = rig({
      relaunch: () => {
        throw new Error('no relaunch')
      }
    })

    r.app.quit()
    r.advance(12_000)
    r.timers.find(timer => !timer.cleared && timer.ms === 12_000)!.run()
    await settle()
    expect(r.app.exits).toEqual([1])
  })
})

/** A flush the test settles by hand. */
function deferred() {
  let resolve: () => void = () => undefined

  const promise = new Promise<void>(done => {
    resolve = done
  })

  return { promise, resolve }
}

describe('the ONE teardown: will-quit and every forced exit run the registry and the bounded storage flush', () => {
  it('N2: a quit-cap forced exit after Cmd-Q (no signal) flushes storage before app.exit', async () => {
    const held = deferred()
    const r = rig({ flush: () => held.promise })

    r.app.quit()
    expect(r.flushes).toEqual([])
    r.advance(12_000)
    r.runDue()
    // The cap started the flush; app.exit waits for it.
    expect(r.flushes).toHaveLength(1)
    await settle()
    expect(r.app.exits).toEqual([])
    expect(r.lines).toContain(`[shutdown] exit waits for the storage flush (at most ${STORAGE_FLUSH_CAP_MS} ms)`)
    held.resolve()
    await settle()
    expect(r.app.exits).toEqual([1])
    const done = r.lines.findIndex(line => line.startsWith('[shutdown] storage flush: done'))
    const forced = r.lines.findIndex(line => line.startsWith('[shutdown] quit cap: forcing exit'))

    expect(forced).toBeGreaterThanOrEqual(0)
    expect(done).toBeGreaterThan(forced)
  })

  it('N2: a cap-forced flush that never settles is cut by its 2 s cap, then app.exit runs', async () => {
    const r = rig({ flush: () => new Promise(() => undefined) })

    r.app.quit()
    r.advance(12_000)
    r.runDue()
    await settle()
    expect(r.app.exits).toEqual([])
    r.advance(STORAGE_FLUSH_CAP_MS)
    r.runDue()
    await settle()
    expect(r.app.exits).toEqual([1])
    expect(r.lines).toContain(`[shutdown] storage flush: timed out after ${STORAGE_FLUSH_CAP_MS} ms`)
  })

  it("m2: a second signal lets the first signal's flush finish (bounded) instead of cutting it", async () => {
    const held = deferred()
    const r = rig({ flush: () => held.promise })

    r.proc.emit('SIGTERM', 'SIGTERM')
    expect(r.flushes).toHaveLength(1)
    r.proc.emit('SIGTERM', 'SIGTERM')
    await settle()
    // Joined, never started again, and the exit waits.
    expect(r.flushes).toHaveLength(1)
    expect(r.app.exits).toEqual([])
    held.resolve()
    await settle()
    expect(r.app.exits).toEqual([143])
  })

  it('m2: a second signal over a hung flush still exits at the flush cap', async () => {
    const r = rig({ flush: () => new Promise(() => undefined) })

    r.proc.emit('SIGTERM', 'SIGTERM')
    r.advance(500)
    r.proc.emit('SIGTERM', 'SIGTERM')
    await settle()
    expect(r.app.exits).toEqual([])
    r.advance(STORAGE_FLUSH_CAP_MS - 500)
    r.runDue()
    await settle()
    expect(r.app.exits).toEqual([143])
  })

  it('will-quit runs the teardown and starts the flush; a forced exit after it runs nothing twice', async () => {
    const calls: string[] = []
    const r = rig({ flush: () => undefined, teardown: () => (calls.push('teardown'), ['acp market watch']) })

    r.app.quit()
    r.appEvents.emit('will-quit')
    expect(calls).toEqual(['teardown'])
    expect(r.flushes).toHaveLength(1)
    await settle()
    r.advance(12_000)
    r.runDue()
    await settle()
    // The registry is idempotent itself; here the flush is once per process and the exit is immediate.
    expect(r.flushes).toHaveLength(1)
    expect(r.app.exits).toEqual([1])
  })

  it('every forced exit (deadline, second signal, quit cap) runs the teardown before app.exit and names what ran', async () => {
    for (const how of ['deadline', 'second', 'cap'] as const) {
      const exitsAtTeardown: number[][] = []
      const holder: { r?: ReturnType<typeof rig> } = {}

      holder.r = rig({
        noFlushDep: true,
        teardown: () => (exitsAtTeardown.push([...holder.r!.app.exits]), ['acp market watch', 'it server'])
      })
      const r = holder.r

      if (how === 'cap') {
        r.app.quit()
        r.advance(12_000)
      } else {
        r.proc.emit('SIGTERM', 'SIGTERM')

        if (how === 'second') {
          r.proc.emit('SIGTERM', 'SIGTERM')
        } else {
          r.advance(SIGNAL_QUIT_DEADLINE_MS)
        }
      }

      r.runDue()
      await settle()
      expect(exitsAtTeardown).toEqual([[]])
      expect(r.app.exits).toHaveLength(1)
      expect(r.lines.find(line => line.includes('forcing exit'))).toMatch(/stopped: acp market watch, it server$/)
    }
  })
})
