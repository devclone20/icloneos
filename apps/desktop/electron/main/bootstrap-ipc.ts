// IPC: bootstrap control and boot progress.
import { ipcMain } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { isIcloneGateFailure } from '../../src/iclone-shared/iclone-gate'
import { decideBootstrapRepair } from '../bootstrap-repair-guard'
import { endInstallBudget } from '../install-liveness'

import {
  clearAgentInstallSkip,
  getAgentRuntimeStatus,
  openAgentRuntimeFix,
  skipAgentInstall
} from './agent-runtime-status'
import { resetHermesConnection, teardownPrimaryBackendAndWait } from './backend'
import { MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS } from './backend-state'
import type { backendConnectionState, progressState } from './backend-state'
import {
  continueFirstRunLocalBootstrap,
  getBootstrapState,
  getFirstRunSetupGate,
  resetBootstrapSnapshot
} from './boot-progress'
import { rememberLog } from './log'
import type { bootState } from './state'

interface BootstrapIpcDeps {
  backendConnectionState: typeof backendConnectionState
  bootState: typeof bootState
  progressState: typeof progressState
}

export function registerBootstrapIpc({ backendConnectionState, bootState, progressState }: BootstrapIpcDeps): void {
  ipcMain.handle('hermes:bootstrap:reset', async () => {
    // Renderer's "Reload and retry" path. Clear the latched failure and
    // reset connection state so the next startHermes() call restarts the
    // full backend flow (including a fresh runBootstrap pass).
    rememberLog('[bootstrap] reset requested by renderer; clearing latched failure')
    await teardownPrimaryBackendAndWait()
    bootState.bootstrapFailure = null
    bootState.backendStartFailure = null
    bootState.remoteReauthFailure = null
    getFirstRunSetupGate().resetForRetry()
    resetBootstrapSnapshot()
    endInstallBudget() // Try again gets a full first-launch budget (ruling 42 r2)

    return { ok: true }
  })
  ipcMain.handle('hermes:bootstrap:repair', async () => {
    // Forceful repair: force the next startHermes() through the full installer
    // (refreshing a broken/partial venv) and clear any latched failure + live
    // connection. The renderer reloads afterwards to re-drive the boot flow.
    //
    // We do NOT delete the bootstrap marker here. Repair is also reachable from
    // transient backend errors on a perfectly healthy install, and deleting the
    // marker in that case stranded the app in first-run setup with no way back
    // (#72166). The explicit flag carries the intent instead.
    bootState.bootstrapRepairAttempt += 1

    // Probe the live backend process so the guard can distinguish "venv is
    // genuinely broken" (force reinstall) from "backend is just transiently
    // stalled under GIL pressure" (#74874 — `event loop stalled` followed by
    // `ws ready frame send failed`, then renderer keeps reporting dead).
    const primaryProc = backendConnectionState.getProcess()

    const primaryBackendAlive = Boolean(
      primaryProc &&
      (primaryProc as { exitCode?: number | null }).exitCode === null &&
      (primaryProc as { signalCode?: string | null }).signalCode === null
    )

    const repairDecision = decideBootstrapRepair({
      attempt: bootState.bootstrapRepairAttempt,
      maxSoftAttempts: MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS,
      primaryBackendAlive
    })

    rememberLog(
      `[bootstrap] repair requested by renderer; forcing reinstall + clearing latched failure ` +
        `(attempt=${repairDecision.attempt}/${MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS}, ` +
        `primaryBackendAlive=${primaryBackendAlive}, ` +
        `hardReinstall=${repairDecision.hardReinstall}): ${repairDecision.reason}`
    )

    // The guard may decide the install is healthy enough that a restart
    // (without touching the venv) is the right answer. Translate that into
    // the existing flag: if the guard said "soft restart", we skip the
    // "bypass active runtime" path inside startHermes() and fall through
    // to the normal restart branch, which just kills the current child
    // and respawns it against the same venv. See #74874 — this is what
    // breaks the infinite reinstall loop the user hit.
    // V3-S r2 (m1): a latched permission-gate refusal is not a stalled backend. A soft restart re-resolves the same
    // runtime and is refused again, so a Repair after a gate refusal reinstalls at once (the resolver then also skips
    // any Hermes on PATH, see resolveHermesBackend).
    const gateRefused = isIcloneGateFailure(errorMessage(bootState.backendStartFailure ?? ''))

    if (gateRefused && !repairDecision.hardReinstall) {
      rememberLog('[bootstrap] the permission gate refused the last start; this repair reinstalls the runtime')
    }

    bootState.bootstrapRepairRequested = repairDecision.hardReinstall || gateRefused
    bootState.bootstrapFailure = null
    bootState.backendStartFailure = null
    bootState.remoteReauthFailure = null
    getFirstRunSetupGate().resetForRepair()
    resetHermesConnection()
    endInstallBudget()

    return { ok: true }
  })
  ipcMain.handle('hermes:bootstrap:continue-local', async () => {
    rememberLog('[bootstrap] local install selected by renderer; continuing first-launch bootstrap')
    continueFirstRunLocalBootstrap()

    return { ok: true }
  })
  ipcMain.handle('hermes:bootstrap:cancel', async () => {
    // Renderer's Cancel button during first-launch install. Abort the running
    // install script (SIGTERM via the runner's abortSignal). runBootstrap
    // resolves with { cancelled: true }, which surfaces the recovery overlay.
    if (bootState.bootstrapAbortController) {
      try {
        bootState.bootstrapAbortController.abort()
      } catch {
        void 0
      }

      return { ok: true, cancelled: true }
    }

    return { ok: false, cancelled: false }
  })
  // RTB-6 / V3-ON: the agent runtime's install status, "Skip for now" and "Install again".
  ipcMain.handle('hermes:agent-runtime:get', async () => getAgentRuntimeStatus())
  ipcMain.handle('hermes:agent-runtime:skip', async () => {
    // Only a failed or declined install can be skipped; a running one is cancelled by its own button first.
    if (bootState.bootstrapAbortController) {
      return { ok: false, reason: 'install-running' }
    }

    skipAgentInstall()
    // Every later getConnection() gets the tagged refusal (the app stays open without the agent, nothing nags), not
    // the install failure.
    bootState.bootstrapFailure = null

    return { ok: true }
  })
  ipcMain.handle('hermes:agent-runtime:open-fix', async (_event, fix: unknown) => openAgentRuntimeFix(fix))
  ipcMain.handle('hermes:agent-runtime:install-again', async () => {
    // Settings > Machine > Agent runtime / V3-ON: clear the skip and every latch; the renderer reloads and the boot
    // resumes the install (finished stages and installed packages are reused).
    rememberLog('[agent-runtime] install requested again by the user')
    clearAgentInstallSkip()
    await teardownPrimaryBackendAndWait()
    bootState.bootstrapFailure = null
    bootState.backendStartFailure = null
    bootState.remoteReauthFailure = null
    getFirstRunSetupGate().resetForRetry()
    resetBootstrapSnapshot()
    endInstallBudget()

    return { ok: true }
  })
  ipcMain.handle('hermes:boot-progress:get', async () => progressState.bootProgressState)
  ipcMain.handle('hermes:bootstrap:get', async () => getBootstrapState())
}
