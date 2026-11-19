/**
 * v0.0.9 F2 (P0_HERMES_FAILURES bug C): main restarts the local backend by itself after it crashes or fails to boot,
 * with progressive waits and a loop breaker. Before this a failed LOCAL boot latched `bootState.backendStartFailure`
 * for the life of the process: every later startHermes() re-threw it without spawning, so "Hermes doesn't start /
 * doesn't restart" until the user found Retry or quit the app.
 *
 * Policy (owner order 17 Nov):
 * - a cause a restart cannot cure (boot-cause.ts `isDeterministicBootCause`: gate refused, install state not
 *   writable, a Python import failure) keeps the latch and is NOT restarted: the failure screen shows its cause, the
 *   user's Retry / Repair clears it;
 * - anything else (a crash after ready, an exit before ready, a deadline, an unknown error) is restarted after
 *   1, 2, 4, 8, 16 s; at most 5 automatic attempts in any 10 minutes, then the breaker trips (phase `stopped`) and
 *   the latch stays until the user acts;
 * - while a restart is pending the latched error IS the hold: the renderer's own reconnect loop gets it back and
 *   never spawns ahead of the schedule; the scheduled attempt clears exactly that latch (never someone else's) and
 *   calls startHermes(), which the renderer's calls then join;
 * - nothing restarts while the app quits, during an intentional re-home, after a bootstrap (install) failure, or for
 *   a remote backend (remote failures have their own retry contract);
 * - every reset path (Retry, Repair, reset, an explicit restart) calls `reset()`: the user's action always wins and
 *   starts a fresh budget.
 *
 * Pure state machine: clock, timers, the restart itself and the publication are injected (testable without
 * Electron, no import of start-hermes, so no cycle).
 */
import type { BootCause } from '../boot-cause'
import { isDeterministicBootCause } from '../boot-cause'

export const AUTO_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]
export const AUTO_RESTART_MAX_ATTEMPTS = 5
export const AUTO_RESTART_WINDOW_MS = 10 * 60_000

export type BackendRestartPhase = 'idle' | 'restarting' | 'stopped' | 'waiting'

/** What the renderer is told (rides on the boot-progress broadcast as `restart`). Plain data. */
export interface BackendRestartStatus {
  phase: BackendRestartPhase
  /** The automatic attempt waiting or running (1-based); 0 when idle. */
  attempt: number
  maxAttempts: number
  /** Epoch ms of the next automatic attempt while `waiting`, else null. */
  nextAttemptAt: null | number
  /** What started this episode. */
  trigger: 'boot-failed' | 'crash' | null
  /** Why no further automatic attempt will run (`stopped` only). */
  stoppedBecause: 'deterministic' | 'limit' | null
  cause: BootCause | null
}

export const IDLE_RESTART_STATUS: BackendRestartStatus = Object.freeze({
  phase: 'idle',
  attempt: 0,
  maxAttempts: AUTO_RESTART_MAX_ATTEMPTS,
  nextAttemptAt: null,
  trigger: null,
  stoppedBecause: null,
  cause: null
}) as BackendRestartStatus

export interface BackendAutoRestartDeps {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** May an automatic restart run at all right now (not quitting, not re-homing, no install failure, local). */
  mayRestart: () => boolean
  /** Clear the latch only if it is still exactly `held` (a user reset may have replaced or cleared it). */
  releaseHold: (held: Error) => void
  /** startHermes(). Its own failure handler reports the next failure back through `noteFailure`. */
  restart: () => Promise<unknown>
  /** The backend is back after an automatic attempt: tell the renderer to re-dial (`hermes:backend:restarted`). */
  announceRestarted: () => void
  publish: (status: BackendRestartStatus) => void
  log: (line: string) => void
}

export interface BackendAutoRestart {
  /**
   * A local boot failed, or a ready backend crashed. `held` is the error now latched (the hold). Returns the status
   * it published: `waiting` (scheduled), `stopped` (deterministic or breaker tripped) or `idle` (not allowed now).
   */
  noteFailure: (input: { cause: BootCause; held: Error; trigger: 'boot-failed' | 'crash' }) => BackendRestartStatus
  /** The backend is ready (any path): a pending attempt is dropped, the phase returns to idle (history kept). */
  noteReady: () => void
  /** The user (Retry, Repair, reset) or an explicit restart took over: drop the timer AND the attempt history. */
  reset: () => void
  status: () => BackendRestartStatus
}

export function delayForAttempt(attempt: number): number {
  return AUTO_RESTART_DELAYS_MS[Math.min(Math.max(attempt, 1), AUTO_RESTART_DELAYS_MS.length) - 1]!
}

export function createBackendAutoRestart(deps: BackendAutoRestartDeps): BackendAutoRestart {
  /** Start times of the automatic attempts that actually ran (the sliding window of the breaker). */
  let attempts: number[] = []
  let timer: unknown = null
  let generation = 0
  let current: BackendRestartStatus = IDLE_RESTART_STATUS

  const set = (next: BackendRestartStatus) => {
    current = next
    deps.publish(next)

    return next
  }

  const cancelTimer = () => {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
  }

  const prune = (now: number) => {
    attempts = attempts.filter(at => now - at < AUTO_RESTART_WINDOW_MS)
  }

  const fire = async (mine: number, held: Error, base: BackendRestartStatus) => {
    timer = null

    if (mine !== generation) {
      return
    }

    if (!deps.mayRestart()) {
      deps.log('[boot] auto-restart: skipped (the app is quitting, re-homing or not on a local backend)')
      set(IDLE_RESTART_STATUS)

      return
    }

    attempts.push(deps.now())
    set({ ...base, phase: 'restarting', nextAttemptAt: null })
    deps.log(`[boot] auto-restart: attempt ${base.attempt}/${AUTO_RESTART_MAX_ATTEMPTS} now`)
    deps.releaseHold(held)

    try {
      await deps.restart()
      // The start resolved: the backend is up (its ready path already called noteReady, which moved the generation).
      deps.log(`[boot] auto-restart: the backend is back (attempt ${base.attempt})`)

      if (current.phase === 'restarting') {
        set(IDLE_RESTART_STATUS)
      }

      deps.announceRestarted()
    } catch {
      // Usually the failure handler of that start already called noteFailure (which bumped the generation and
      // scheduled the next attempt or tripped the breaker). v0.0.9 Q (correctness 2): a start that failed WITHOUT
      // reaching it (an early throw: not the primary instance, quitting, a bootstrap or re-auth latch set meanwhile, a
      // superseded start) left nothing scheduled — the status must not keep saying "restarting" forever.
      if (mine === generation && current.phase === 'restarting') {
        deps.log(`[boot] auto-restart: attempt ${base.attempt} ended without a new failure report; nothing is scheduled`)
        set(IDLE_RESTART_STATUS)
      }
    }
  }

  const noteFailure: BackendAutoRestart['noteFailure'] = ({ cause, held, trigger }) => {
    generation += 1
    cancelTimer()

    if (!deps.mayRestart()) {
      return set(IDLE_RESTART_STATUS)
    }

    // A crash after ready is always worth a restart (its output tail spans the whole run, so an old warning line is
    // no verdict on this exit); a flapping one is stopped by the breaker below.
    if (trigger === 'boot-failed' && isDeterministicBootCause(cause)) {
      deps.log(`[boot] auto-restart: not restarting, the cause is not transient (${cause.code})`)

      return set({
        ...IDLE_RESTART_STATUS,
        phase: 'stopped',
        trigger,
        stoppedBecause: 'deterministic',
        cause
      })
    }

    const now = deps.now()

    prune(now)

    if (attempts.length >= AUTO_RESTART_MAX_ATTEMPTS) {
      deps.log(
        `[boot] auto-restart: stopped after ${AUTO_RESTART_MAX_ATTEMPTS} attempts in ${AUTO_RESTART_WINDOW_MS / 60_000} min (${cause.code}); waiting for the user`
      )

      return set({
        ...IDLE_RESTART_STATUS,
        phase: 'stopped',
        attempt: attempts.length,
        trigger,
        stoppedBecause: 'limit',
        cause
      })
    }

    const attempt = attempts.length + 1
    const delay = delayForAttempt(attempt)
    const mine = generation

    const next = set({
      ...IDLE_RESTART_STATUS,
      phase: 'waiting',
      attempt,
      nextAttemptAt: now + delay,
      trigger,
      cause
    })

    deps.log(
      `[boot] auto-restart: ${trigger === 'crash' ? 'the backend stopped' : 'the backend did not start'} (${cause.code}); attempt ${attempt}/${AUTO_RESTART_MAX_ATTEMPTS} in ${delay / 1000} s`
    )
    timer = deps.setTimer(() => void fire(mine, held, next), delay)

    return next
  }

  return {
    noteFailure,
    noteReady() {
      generation += 1
      cancelTimer()

      if (current.phase !== 'idle') {
        set(IDLE_RESTART_STATUS)
      }
    },
    reset() {
      generation += 1
      cancelTimer()
      attempts = []

      if (current.phase !== 'idle') {
        set(IDLE_RESTART_STATUS)
      }
    },
    status: () => current
  }
}

// ── the primary backend's instance ───────────────────────────────────────────
// Bound once by start-hermes.ts (which owns startHermes) so that reset paths elsewhere in main (backend.ts
// resetHermesConnection, F3's Retry/Repair in bootstrap-ipc.ts) reach it without importing start-hermes (a cycle).

let primary: BackendAutoRestart | null = null

export function bindBackendAutoRestart(deps: BackendAutoRestartDeps): BackendAutoRestart {
  primary = createBackendAutoRestart(deps)

  return primary
}

/** The primary backend's supervisor, or null before start-hermes.ts is loaded. */
export function primaryBackendAutoRestart(): BackendAutoRestart | null {
  return primary
}

/** The user's Retry / Repair / reset, or an explicit restart: drop any pending attempt and start a fresh budget. */
export function resetBackendAutoRestart(): void {
  primary?.reset()
}

/** The status the renderer sees (idle before binding). */
export function backendRestartStatus(): BackendRestartStatus {
  return primary?.status() ?? IDLE_RESTART_STATUS
}
