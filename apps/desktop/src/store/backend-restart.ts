/**
 * v0.0.9 F2 — the renderer's view of main's automatic backend restart (electron/main/backend-auto-restart.ts).
 *
 * Main publishes the status on the boot-progress broadcast it already sends (`restart`, beside `bootCause`), so no
 * new bridge method is needed. This store listens to that broadcast ITSELF (the boot hook stops applying progress to
 * `$desktopBoot` once the first boot completed, and a crash restart happens after that) and narrows the field
 * defensively: it is not in the `DesktopBootProgress` type yet, and anything malformed is treated as absent.
 */
import { atom } from 'nanostores'

import { f2Crash, f2Restart } from '@/i18n/en/v009-f2'

export type BackendRestartPhase = 'idle' | 'restarting' | 'stopped' | 'waiting'

export interface BackendRestartView {
  phase: BackendRestartPhase
  attempt: number
  maxAttempts: number
  nextAttemptAt: null | number
  stoppedBecause: 'deterministic' | 'limit' | null
}

export const IDLE_BACKEND_RESTART: BackendRestartView = Object.freeze({
  phase: 'idle',
  attempt: 0,
  maxAttempts: 5,
  nextAttemptAt: null,
  stoppedBecause: null
}) as BackendRestartView

const PHASES: readonly string[] = ['idle', 'restarting', 'stopped', 'waiting']

/** The `restart` field of a boot-progress payload, validated; IDLE when absent or malformed. */
export function readBackendRestart(progress: unknown): BackendRestartView {
  const raw = progress && typeof progress === 'object' ? (progress as { restart?: unknown }).restart : undefined

  if (!raw || typeof raw !== 'object') {
    return IDLE_BACKEND_RESTART
  }

  const { attempt, maxAttempts, nextAttemptAt, phase, stoppedBecause } = raw as Record<string, unknown>

  if (typeof phase !== 'string' || !PHASES.includes(phase)) {
    return IDLE_BACKEND_RESTART
  }

  const count = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : fallback

  return {
    phase: phase as BackendRestartPhase,
    attempt: count(attempt, 0),
    maxAttempts: count(maxAttempts, IDLE_BACKEND_RESTART.maxAttempts) || IDLE_BACKEND_RESTART.maxAttempts,
    nextAttemptAt: typeof nextAttemptAt === 'number' && Number.isFinite(nextAttemptAt) ? nextAttemptAt : null,
    stoppedBecause: stoppedBecause === 'deterministic' || stoppedBecause === 'limit' ? stoppedBecause : null
  }
}

export const $backendRestart = atom<BackendRestartView>(IDLE_BACKEND_RESTART)

/** Apply one boot-progress payload (exported for tests and for any other listener that already has one). */
export function applyBackendRestartProgress(progress: unknown): void {
  const next = readBackendRestart(progress)
  const current = $backendRestart.get()

  if (
    next.phase !== current.phase ||
    next.attempt !== current.attempt ||
    next.maxAttempts !== current.maxAttempts ||
    next.nextAttemptAt !== current.nextAttemptAt ||
    next.stoppedBecause !== current.stoppedBecause
  ) {
    $backendRestart.set(next)
  }
}

interface BootProgressBridge {
  getBootProgress?: () => Promise<unknown>
  onBootProgress?: (callback: (payload: unknown) => void) => () => void
}

let wired = false

/** Listen to main's boot-progress broadcast once per window (idempotent; a no-op without the bridge). */
export function wireBackendRestart(): void {
  if (wired || typeof window === 'undefined') {
    return
  }

  const bridge = (window as unknown as { hermesDesktop?: BootProgressBridge }).hermesDesktop

  if (!bridge?.onBootProgress) {
    return
  }

  wired = true
  bridge.onBootProgress(applyBackendRestartProgress)
  void bridge
    .getBootProgress?.()
    .then(applyBackendRestartProgress)
    .catch(() => undefined)
}

wireBackendRestart()

/** Test seam. */
export function resetBackendRestartForTests(): void {
  wired = false
  $backendRestart.set(IDLE_BACKEND_RESTART)
}

/** True while main is bringing the agent back by itself (a pending or running automatic attempt). */
export function isBackendRestarting(view: BackendRestartView = $backendRestart.get()): boolean {
  return view.phase === 'waiting' || view.phase === 'restarting'
}

/** The calm one-line status for a restart, or null when there is none to show. */
export function backendRestartLabel(view: BackendRestartView = $backendRestart.get()): null | string {
  switch (view.phase) {
    case 'waiting':

    case 'restarting':
      return f2Restart.restarting(Math.max(1, view.attempt), view.maxAttempts)

    case 'stopped':
      return stoppedCopy(view)

    default:
      return null
  }
}

// Main's latched crash error has said "…; restarting it automatically." since F2, and stays latched after the breaker
// trips; main's wording is being made neutral (Q correctness 3), and older mains keep the promise.
const RESTART_PROMISE = /;\s*restarting it automatically\.?/gi
// v0.0.9 r3 (eng n5, m-r2-6): the progress line itself ("Restarting the agent (attempt 5 of 5)…") can be latched into
// the text a card shows; once main stopped, that line is a promise nobody keeps. The phrase is matched by the shape
// of f2Restart.restarting, so a change to that copy must change this pattern (backend-restart.honest.test.ts).
const RESTART_PROGRESS = /[ \t]?Restarting the agent \(attempt \d+ of \d+\)…?/g

/** The words for "main stopped restarting the agent", or null while it has not. */
function stoppedCopy(view: BackendRestartView): null | string {
  return view.phase === 'stopped'
    ? view.stoppedBecause === 'limit'
      ? f2Restart.stoppedLimit
      : f2Restart.stoppedDeterministic
    : null
}

/**
 * The error text as the renderer may show it: the automatic-restart promise and the "attempt n of m" progress line are
 * kept only while main really is restarting (a pending or running attempt). Once main has stopped, the progress line
 * becomes the stopped copy; when nothing is scheduled at all, both go and the sentence ends at the cause.
 */
export function honestRestartText<T extends null | string | undefined>(
  message: T,
  view: BackendRestartView = $backendRestart.get()
): T {
  if (typeof message !== 'string' || isBackendRestarting(view)) {
    return message
  }

  const stopped = stoppedCopy(view)
  let replaced = false

  const text = message.replace(RESTART_PROMISE, '.').replace(RESTART_PROGRESS, () => {
    // One stopped sentence however many progress lines were latched.
    const out = stopped && !replaced ? ` ${stopped}` : ''
    replaced = true

    return out
  })

  return (replaced ? text.trim() : text) as T
}

/**
 * v0.0.9 Q (proofs F2-b): main stopped restarting the agent (breaker tripped, or a cause a restart cannot cure) and the
 * gateway is not open — the agent is not coming back by itself. The stopped banner and the composer read this; an
 * open gateway (the user's Retry worked, or anything else brought it back) always wins over a stale `stopped`.
 */
export function isRestartStopped(view: BackendRestartView, gatewayState: string): boolean {
  return view.phase === 'stopped' && gatewayState !== 'open'
}

/** r4d (design r4 F2-1): the exit in engineer words (the signal or code), for the entry's Details only. */
export function backendExitDetail(exit: unknown): string {
  const { code, signal } = (exit && typeof exit === 'object' ? exit : {}) as { code?: unknown; signal?: unknown }

  return f2Crash.detail(
    typeof signal === 'string' && /^SIG[A-Z0-9]{2,10}$/.test(signal) ? signal : null,
    typeof code === 'number' && Number.isInteger(code) ? code : null
  )
}

/** The exit main reported for the agent's process (`hermes:backend-exit`); anything malformed reads as unknown. */
export function backendExitCause(exit: unknown): string {
  const { code, signal } = (exit && typeof exit === 'object' ? exit : {}) as { code?: unknown; signal?: unknown }

  if (typeof signal === 'string' && /^SIG[A-Z0-9]{2,10}$/.test(signal)) {
    return f2Crash.causeSignal(signal)
  }

  if (typeof code === 'number' && Number.isInteger(code)) {
    return code === 0 ? f2Crash.causeClean : f2Crash.causeCode(code)
  }

  return f2Crash.causeUnknown
}

/**
 * v0.0.9 design 3 (P0_NOTIFICATIONS: one surface for one state): where "The agent stopped" is said.
 *  - `boot-card`: the boot failure card is up (it owns a failure before readiness, with its own cause and actions);
 *  - `banner`: main stopped restarting and the gateway is not open — the stopped banner is the persistent form;
 *  - `toast`: otherwise (a crash main is about to restart): one sticky toast that leaves when the gateway is open.
 * In the first two the centre still keeps the entry; no toast is shown (and one already up is dismissed).
 */
export function backendStoppedSurface(input: {
  bootError: unknown
  bootRunning: boolean
  gatewayState: string
  restart: BackendRestartView
}): 'banner' | 'boot-card' | 'toast' {
  if (input.bootError && !input.bootRunning) {
    return 'boot-card'
  }

  return isRestartStopped(input.restart, input.gatewayState) ? 'banner' : 'toast'
}
