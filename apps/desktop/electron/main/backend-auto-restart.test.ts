/**
 * v0.0.9 F2 (P0_HERMES_FAILURES bug C, gate G2): main's automatic restart of the local backend — backoff 1/2/4/8/16 s,
 * at most 5 automatic attempts in any 10 minutes, a loop breaker, never for a cause a restart cannot cure, never while
 * the app quits, and the user's reset always wins. Red on the old code: nothing restarted at all (the latch re-threw).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BootCause } from '../boot-cause'

import {
  AUTO_RESTART_DELAYS_MS,
  AUTO_RESTART_MAX_ATTEMPTS,
  AUTO_RESTART_WINDOW_MS,
  type BackendRestartStatus,
  createBackendAutoRestart,
  delayForAttempt,
  IDLE_RESTART_STATUS
} from './backend-auto-restart'

const TRANSIENT: BootCause = { code: 'exit-nonzero', line: 'RuntimeError: boom' }
const STALE_RECORD: BootCause = { code: 'install-state-not-writable', line: 'install state is not writable…' }

function harness(options: { restart?: () => Promise<unknown> } = {}) {
  let clock = 1_000_000
  const timers: { at: number; run: () => void; handle: number }[] = []
  let nextHandle = 1
  const published: BackendRestartStatus[] = []
  const latch: { current: Error | null } = { current: null }
  const allowed = { current: true }
  const announceRestarted = vi.fn()
  const restart = vi.fn(options.restart ?? (async () => undefined))

  const supervisor = createBackendAutoRestart({
    now: () => clock,
    setTimer: (run, ms) => {
      const handle = nextHandle++

      timers.push({ at: clock + ms, run, handle })

      return handle
    },
    clearTimer: handle => {
      const index = timers.findIndex(timer => timer.handle === handle)

      if (index !== -1) {
        timers.splice(index, 1)
      }
    },
    mayRestart: () => allowed.current,
    releaseHold: held => {
      if (latch.current === held) {
        latch.current = null
      }
    },
    restart,
    announceRestarted,
    publish: status => published.push(status),
    log: () => undefined
  })

  /** Advance the fake clock and run due timers (one at a time, in order). */
  const advance = async (ms: number) => {
    clock += ms

    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]

      if (!due || due.at > clock) {
        break
      }

      timers.shift()
      due.run()
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  const fail = (cause: BootCause = TRANSIENT, trigger: 'boot-failed' | 'crash' = 'boot-failed') => {
    const held = new Error('boot failed')

    latch.current = held

    return supervisor.noteFailure({ cause, held, trigger })
  }

  return { advance, allowed, announceRestarted, fail, latch, published, restart, supervisor, timers }
}

describe('backend auto-restart', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it('backs off 1, 2, 4, 8, 16 s', () => {
    expect(AUTO_RESTART_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect([1, 2, 3, 4, 5].map(delayForAttempt)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('a transient boot failure is restarted after 1 s: the hold (latch) is released, startHermes runs, the renderer is told', async () => {
    const status = h.fail()

    expect(status).toMatchObject({ phase: 'waiting', attempt: 1, trigger: 'boot-failed' })
    expect(h.latch.current).not.toBeNull()

    await h.advance(999)
    expect(h.restart).not.toHaveBeenCalled()

    await h.advance(1)
    expect(h.restart).toHaveBeenCalledTimes(1)
    expect(h.latch.current).toBeNull()
    expect(h.announceRestarted).toHaveBeenCalledTimes(1)
    expect(h.supervisor.status().phase).toBe('idle')
  })

  it('each further failure waits longer; the 6th within 10 min trips the breaker (stopped, latch kept)', async () => {
    for (let attempt = 1; attempt <= AUTO_RESTART_MAX_ATTEMPTS; attempt += 1) {
      const status = h.fail()

      expect(status).toMatchObject({ phase: 'waiting', attempt })
      expect(h.timers[0]!.at - status.nextAttemptAt!).toBe(0)
      await h.advance(delayForAttempt(attempt) - 1)
      expect(h.restart).toHaveBeenCalledTimes(attempt - 1)
      await h.advance(1)
    }

    expect(h.restart).toHaveBeenCalledTimes(AUTO_RESTART_MAX_ATTEMPTS)

    const tripped = h.fail()

    expect(tripped).toMatchObject({ phase: 'stopped', stoppedBecause: 'limit' })
    expect(h.timers).toHaveLength(0)
    expect(h.latch.current).not.toBeNull()
    await h.advance(60_000)
    expect(h.restart).toHaveBeenCalledTimes(AUTO_RESTART_MAX_ATTEMPTS)
  })

  it('the window slides: once the oldest attempt is 10 min old, a new failure is restarted again', async () => {
    for (let attempt = 1; attempt <= AUTO_RESTART_MAX_ATTEMPTS; attempt += 1) {
      h.fail()
      await h.advance(delayForAttempt(attempt))
    }

    expect(h.fail().phase).toBe('stopped')

    await h.advance(AUTO_RESTART_WINDOW_MS)

    expect(h.fail()).toMatchObject({ phase: 'waiting', attempt: 1 })
  })

  it('a cause a restart cannot cure is never restarted (stale install record, gate, import)', async () => {
    expect(h.fail(STALE_RECORD)).toMatchObject({ phase: 'stopped', stoppedBecause: 'deterministic' })
    expect(h.fail({ code: 'gate-not-loaded' }).phase).toBe('stopped')
    expect(h.fail({ code: 'python-import' }).phase).toBe('stopped')
    await h.advance(60_000)
    expect(h.restart).not.toHaveBeenCalled()
  })

  it('a crash after ready is always restarted (its output spans the whole run; the breaker stops a flapping one)', () => {
    expect(h.fail({ code: 'python-import' }, 'crash')).toMatchObject({ phase: 'waiting', trigger: 'crash' })
  })

  it('nothing restarts while the app quits (or re-homes): idle, no timer', async () => {
    h.allowed.current = false

    expect(h.fail().phase).toBe('idle')
    expect(h.timers).toHaveLength(0)

    h.allowed.current = true
    h.fail()
    h.allowed.current = false
    await h.advance(1_000)
    expect(h.restart).not.toHaveBeenCalled()
  })

  it('the user’s reset wins: the pending attempt is dropped and the budget starts fresh', async () => {
    for (let attempt = 1; attempt <= AUTO_RESTART_MAX_ATTEMPTS; attempt += 1) {
      h.fail()
      await h.advance(delayForAttempt(attempt))
    }

    h.fail()
    h.supervisor.reset()

    expect(h.supervisor.status().phase).toBe('idle')
    expect(h.fail()).toMatchObject({ phase: 'waiting', attempt: 1 })
  })

  it('a ready backend (any path) cancels a pending attempt', async () => {
    h.fail()
    h.supervisor.noteReady()
    await h.advance(5_000)

    expect(h.restart).not.toHaveBeenCalled()
    expect(h.supervisor.status().phase).toBe('idle')
  })

  it('the attempt clears only its own hold: a latch someone else set meanwhile stays', async () => {
    h.fail()

    const other = new Error('a newer latch')

    h.latch.current = other
    await h.advance(1_000)

    expect(h.latch.current).toBe(other)
  })

  it('a failed attempt whose failure handler reported it: the next attempt is scheduled by that report', async () => {
    let failing: ReturnType<typeof harness> | null = null

    failing = harness({
      restart: () => {
        // The start's own failure handler (start-hermes) calls noteFailure before the start rejects.
        failing!.supervisor.noteFailure({ cause: { code: 'exit-nonzero' }, held: new Error('again'), trigger: 'boot-failed' })

        return Promise.reject(new Error('still broken'))
      }
    })

    failing.fail()
    await failing.advance(1_000)

    expect(failing.announceRestarted).not.toHaveBeenCalled()
    expect(failing.supervisor.status()).toMatchObject({ attempt: 2, phase: 'waiting' })
  })

  it('correctness 2: a start that failed WITHOUT a failure report never stays "restarting" forever', async () => {
    // Red on the old code: phase stayed `restarting` with no timer (an early throw, a superseded start).
    const failing = harness({ restart: () => Promise.reject(new Error('not the primary instance')) })

    failing.fail()
    await failing.advance(1_000)

    expect(failing.announceRestarted).not.toHaveBeenCalled()
    expect(failing.supervisor.status()).toEqual(IDLE_RESTART_STATUS)
  })

  it('publishes every status (the renderer’s calm “restarting (attempt n)”)', async () => {
    h.fail()
    await h.advance(1_000)

    expect(h.published.map(status => status.phase)).toEqual(['waiting', 'restarting', 'idle'])
  })
})
