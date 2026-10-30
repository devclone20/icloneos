// RTB-6/7 + V3-ON: the agent runtime's install status — what Settings > Machine > Agent runtime shows, what the next
// launch reads to offer the install again once after a skip, and what V3-ON's onboarding queries (status/repair API).
// Types and the pure reducer are shared by main (which owns and persists the record) and the renderer.

import { diagnoseInstallFailure, type InstallDiagnosis } from './install-diagnosis'
import {
  initialPackages,
  type PackageLine,
  PACKAGES_STAGE,
  type PackagesState,
  reducePackageLine,
  settlePackages
} from './install-packages'

/** Tag the skip refusal carries across IPC so the renderer opens the app without the agent instead of a card. */
export const AGENT_INSTALL_SKIPPED_TAG = '[agent-install-skipped]'

export type AgentRuntimeState = 'incomplete' | 'installed' | 'installing' | 'not-installed'

export interface AgentRuntimeStatus {
  schema: 1
  state: AgentRuntimeState
  /** One line per package of the dependency stage, with its state and sizes. */
  packages: PackageLine[]
  /** The last failure, diagnosed (null once an install completes). */
  diagnosis: InstallDiagnosis | null
  /** Times the user chose "Skip for now" since the last install attempt from Settings. */
  skipCount: number
  skippedAt: null | number
  /** First failure stage durations (ms) of the last run, by stage, for the report and Settings. */
  stageDurations: Record<string, number>
  updatedAt: number
}

export function emptyAgentRuntimeStatus(now = 0): AgentRuntimeStatus {
  return {
    diagnosis: null,
    packages: [],
    schema: 1,
    skipCount: 0,
    skippedAt: null,
    stageDurations: {},
    state: 'not-installed',
    updatedAt: now
  }
}

/** The bootstrap events main folds into the status (a structural subset of the runner's events). */
export type StatusBootstrapEvent =
  | { type: 'complete' }
  | { type: 'failed'; error?: string; stage?: null | string }
  | { type: 'log'; line: string; stage?: null | string }
  | { type: 'manifest' }
  | { type: 'stage'; durationMs?: number; error?: null | string; name: string; state: string }
  | { type: string }

/** Live tracker: the persisted status plus the in-flight package state and output tail of the current run. */
export interface AgentRuntimeTracker {
  status: AgentRuntimeStatus
  run: null | { packages: PackagesState; tail: string[]; failedStage: null | string; failedError: null | string }
}

const TAIL = 80

export function trackBootstrapEvent(
  tracker: AgentRuntimeTracker,
  ev: StatusBootstrapEvent,
  now: number
): AgentRuntimeTracker {
  const status = tracker.status

  if (ev.type === 'manifest') {
    // A run starts (or a synthetic early manifest repeats): fresh package lines, keep the skip record.
    const run = tracker.run ?? { failedError: null, failedStage: null, packages: initialPackages(), tail: [] }

    return {
      run,
      status: { ...status, packages: run.packages.packages, state: 'installing', updatedAt: now }
    }
  }

  const run = tracker.run

  if (!run) {
    // A verdict after the install itself (the agent was still starting when the first-launch budget ran out): the
    // record carries its diagnosis, the install state stays what it was.
    if (ev.type === 'failed') {
      const failed = ev as { error?: string; stage?: null | string }

      return {
        run: null,
        status: {
          ...status,
          diagnosis: diagnoseInstallFailure({ error: failed.error ?? null, stage: failed.stage ?? null }),
          updatedAt: now
        }
      }
    }

    return tracker
  }

  if (ev.type === 'log' && 'line' in ev) {
    const tail = run.tail.length >= TAIL ? [...run.tail.slice(1 - TAIL), ev.line] : [...run.tail, ev.line]
    const packages = ev.stage === PACKAGES_STAGE ? reducePackageLine(run.packages, ev.line, now) : run.packages

    return {
      run: { ...run, packages, tail },
      status: packages === run.packages ? status : { ...status, packages: packages.packages, updatedAt: now }
    }
  }

  if (ev.type === 'stage' && 'name' in ev) {
    const durations =
      typeof ev.durationMs === 'number' ? { ...status.stageDurations, [ev.name]: ev.durationMs } : status.stageDurations

    let packages = run.packages

    if (ev.name === PACKAGES_STAGE && (ev.state === 'succeeded' || ev.state === 'failed')) {
      packages = settlePackages(run.packages, ev.state, now)
    }

    return {
      run: {
        ...run,
        failedError: ev.state === 'failed' ? (ev.error ?? null) : run.failedError,
        failedStage: ev.state === 'failed' ? ev.name : run.failedStage,
        packages
      },
      status: { ...status, packages: packages.packages, stageDurations: durations, updatedAt: now }
    }
  }

  if (ev.type === 'complete') {
    const optionalFailed = run.packages.packages.filter(line => line.state === 'failed')

    return {
      run: null,
      status: {
        ...status,
        diagnosis: optionalFailed.length
          ? diagnoseInstallFailure({ error: optionalFailed[0].error, log: run.tail, stage: PACKAGES_STAGE })
          : null,
        packages: run.packages.packages,
        skipCount: 0,
        skippedAt: null,
        state: optionalFailed.length ? 'incomplete' : 'installed',
        updatedAt: now
      }
    }
  }

  if (ev.type === 'failed') {
    const failed = ev as { error?: string; stage?: null | string }
    const stage = failed.stage ?? run.failedStage
    const error = run.failedError ?? failed.error ?? null

    return {
      run: null,
      status: {
        ...status,
        diagnosis: diagnoseInstallFailure({ error, log: run.tail, stage }),
        packages: run.packages.packages,
        state: run.packages.packages.some(line => line.state === 'done') ? 'incomplete' : 'not-installed',
        updatedAt: now
      }
    }
  }

  return tracker
}

/** The user chose "Skip for now". */
export function recordSkip(status: AgentRuntimeStatus, now: number): AgentRuntimeStatus {
  return { ...status, skipCount: status.skipCount + 1, skippedAt: now, updatedAt: now }
}

/** "Install again" from Settings (or V3-ON): the skip record is cleared so the install runs. */
export function recordInstallAgain(status: AgentRuntimeStatus, now: number): AgentRuntimeStatus {
  return { ...status, skipCount: 0, skippedAt: null, updatedAt: now }
}

/**
 * Whether a launch may start the install by itself. After one skip the next launch offers it again (once); after the
 * user skipped that offer too, only Settings > Machine > Agent runtime (or V3-ON) starts it. A skip in THIS run always
 * holds for the rest of the run (nothing nags).
 */
export function mayAutoInstall(status: AgentRuntimeStatus, skippedThisRun: boolean): boolean {
  if (skippedThisRun) {
    return false
  }

  return status.state === 'installed' || status.skipCount < 2
}

/** Parse a persisted record defensively (a hand-edited or older file never crashes the boot). */
export function parseAgentRuntimeStatus(raw: unknown, now = 0): AgentRuntimeStatus {
  const base = emptyAgentRuntimeStatus(now)

  if (!raw || typeof raw !== 'object' || (raw as { schema?: unknown }).schema !== 1) {
    return base
  }

  const value = raw as Partial<AgentRuntimeStatus>
  const states: AgentRuntimeState[] = ['incomplete', 'installed', 'installing', 'not-installed']

  return {
    ...base,
    diagnosis: value.diagnosis && typeof value.diagnosis === 'object' ? value.diagnosis : null,
    packages: Array.isArray(value.packages) ? value.packages.filter(line => line && typeof line.name === 'string') : [],
    skipCount: Number.isInteger(value.skipCount) && (value.skipCount as number) >= 0 ? (value.skipCount as number) : 0,
    skippedAt: typeof value.skippedAt === 'number' ? value.skippedAt : null,
    stageDurations: value.stageDurations && typeof value.stageDurations === 'object' ? value.stageDurations : {},
    // A run that was "installing" when the app died is not installed.
    state: value.state && states.includes(value.state) && value.state !== 'installing' ? value.state : 'not-installed',
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now
  }
}
