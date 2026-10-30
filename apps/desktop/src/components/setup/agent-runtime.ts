/**
 * V3-ON — the Packages section's source: V3-RT-B's `window.hermesDesktop.agentRuntime` (branch v3-rtb-boot-budget
 * a3e8bbcb13, `src/iclone-shared/agent-runtime-status.ts` + `install-packages.ts` + `install-diagnosis.ts`).
 *
 * The contract below is RT-B's, name for name and type for type (agent-runtime.test.ts holds it equal at the type
 * level), so wiring is a one-line swap: when both fronts merge, the lead replaces the types with imports from
 * `@/iclone-shared/agent-runtime-status` and `setupAgentRuntime()`'s body with `return window.hermesDesktop?.agentRuntime
 * ?? null`. Until then (lead decision r2 minor 2) the source is null: the Packages section is NOT shown and does not
 * count as undecided anywhere (no probe, no "Not set up" pill).
 */
import type { SetupPackage, SetupPackageState } from './types'

// ── RT-B's contract (TODO(V3-RT-B): import these from '@/iclone-shared/agent-runtime-status' after the merge) ──────
export type PackageState = 'done' | 'downloading' | 'failed' | 'installing' | 'not-needed' | 'unpacking' | 'waiting'

export interface PackageLine {
  name: string
  state: PackageState
  percent: null | number
  done: null | string
  total: null | string
  totalBytes: null | number
  parts: number
  startedAt: null | number
  finishedAt: null | number
  error: null | string
  optional: boolean
}

export type InstallFailureClass =
  | 'cancelled'
  | 'disk'
  | 'integrity'
  | 'interpreter'
  | 'killed'
  | 'network'
  | 'permission'
  | 'resolver'
  | 'stalled'
  | 'unknown'

export type InstallFixAction = 'open-network-settings' | 'open-storage-settings' | 'repair' | 'retry' | 'reveal-folder'

export interface InstallDiagnosis {
  class: InstallFailureClass
  fix: InstallFixAction
  stage: null | string
  packageName: null | string
  neededBytes: null | number
  evidence: null | string
}

export type AgentRuntimeState = 'incomplete' | 'installed' | 'installing' | 'not-installed'

export interface AgentRuntimeStatus {
  schema: 1
  state: AgentRuntimeState
  packages: PackageLine[]
  diagnosis: InstallDiagnosis | null
  skipCount: number
  skippedAt: null | number
  stageDurations: Record<string, number>
  updatedAt: number
}

/** `window.hermesDesktop.agentRuntime` exactly as RT-B declares it in global.d.ts. */
export interface AgentRuntimeBridge {
  status: () => Promise<AgentRuntimeStatus & { skippedThisRun: boolean }>
  skip: () => Promise<{ ok: boolean; reason?: string }>
  installAgain: () => Promise<{ ok: boolean }>
  openFix: (fix: 'open-network-settings' | 'open-storage-settings' | 'reveal-folder') => Promise<{ ok: boolean }>
  onChange: (callback: (status: AgentRuntimeStatus) => void) => () => void
}

/**
 * The Packages section's source. TODO(V3-RT-B): after both merge, the body becomes
 * `return window.hermesDesktop?.agentRuntime ?? null`.
 */
export function setupAgentRuntime(): AgentRuntimeBridge | null {
  return null
}

// ── The view (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────

const VIEW_STATE: Readonly<Record<PackageState, SetupPackageState | null>> = {
  done: 'installed',
  failed: 'failed',
  downloading: 'installing',
  installing: 'installing',
  unpacking: 'installing',
  waiting: 'installing',
  // Not needed on this Mac: nothing to show.
  'not-needed': null
}

/**
 * RT-B's status as the section's rows. A run that was skipped leaves its unfinished lines as "skipped" (the only state
 * besides "failed" that offers Install again); a line not needed on this Mac is not shown.
 */
export function packageRowsOf(status: AgentRuntimeStatus | null | undefined): SetupPackage[] {
  if (!status || !Array.isArray(status.packages)) {
    return []
  }

  const skipped = status.skippedAt !== null && status.state !== 'installing'

  return status.packages.flatMap(line => {
    const view = VIEW_STATE[line.state]

    if (!view) {
      return []
    }

    return [
      {
        id: line.name,
        name: line.name,
        bytes: line.totalBytes,
        state: view === 'installing' && skipped ? 'skipped' : view,
        progress: view === 'installing' && !skipped ? line.percent : null
      }
    ]
  })
}
