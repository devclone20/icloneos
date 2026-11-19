// IPC: bootstrap control and boot progress, and (v0.0.9 F3) the repair kit.
import { app, ipcMain } from 'electron'

import { decideBootstrapRepair, routeBootstrapRepair } from '../bootstrap-repair-guard'
import { recordRepairKit } from '../iclone-permissions/ipc'
import { endInstallBudget } from '../install-liveness'
import { createAppSenderGuard } from '../ipc-sender-guard'
import { activeProfileHermesHome } from '../repair-kit/active-home'
import { causeOf } from '../repair-kit/classify'
import { createAppRepairKit, registerRepairKitIpc, repairGestureOk } from '../repair-kit/ipc'
import type { RepairKit } from '../repair-kit/kit'

import {
  clearAgentInstallSkip,
  getAgentRuntimeStatus,
  openAgentRuntimeFix,
  skipAgentInstall
} from './agent-runtime-status'
import { lastTrustedInputAt } from './agent-update'
import { resetHermesConnection, teardownPrimaryBackendAndWait } from './backend'
import { resetBackendAutoRestart } from './backend-auto-restart'
import { backendOwnership } from './backend-ownership'
import { MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS } from './backend-state'
import type { backendConnectionState, progressState } from './backend-state'
import {
  continueFirstRunLocalBootstrap,
  getBootstrapState,
  getFirstRunSetupGate,
  resetBootstrapSnapshot
} from './boot-progress'
import { ACTIVE_HERMES_ROOT, DEV_SERVER, HERMES_HOME, runtimePrivateDependencies } from './env'
import { rememberLog } from './log'
import { resolveRendererIndex } from './runtime'
import type { bootState } from './state'

interface BootstrapIpcDeps {
  backendConnectionState: typeof backendConnectionState
  bootState: typeof bootState
  progressState: typeof progressState
  /** v0.0.9 W1b: the desktop's chosen profile (connection-config.ts `readActiveDesktopProfile`), read at every kit
   *  scan so the repair kit looks in the ACTIVE profile's HERMES_HOME. Absent = no preference (sticky file decides). */
  readDesktopProfile?: () => null | string
}

export function registerBootstrapIpc({
  backendConnectionState,
  bootState,
  progressState,
  readDesktopProfile
}: BootstrapIpcDeps): void {
  // v0.0.9 F3: the repair kit, with this machine's real folders. Its cause is read from the latched failure BEFORE
  // anything clears it (the kit's own stop of the agent resets the latch).
  const kit: RepairKit = createAppRepairKit({
    appVersion: app.getVersion(),
    bootCause: () => (bootState.backendStartFailure ? causeOf(bootState.backendStartFailure) : null),
    hermesHome: HERMES_HOME,
    // v0.0.9 W1b: the stale-install class reads the ACTIVE profile's home (as the spawn does), and the user's home for
    // the runtime's platform-default dependency root.
    activeHermesHome: () => activeProfileHermesHome(HERMES_HOME, readDesktopProfile?.() ?? null),
    home: app.getPath('home'),
    livePid: () => backendConnectionState.getProcess()?.pid ?? null,
    log: rememberLog,
    now: () => new Date(),
    listOrphans: () => backendOwnership.listOrphans(),
    privateHermesHome: runtimePrivateDependencies()?.hermesHome ?? null,
    reapOrphans: () => backendOwnership.reapOrphans(),
    requestReinstall: () => {
      bootState.bootstrapRepairRequested = true
    },
    runtimeRoot: ACTIVE_HERMES_ROOT,
    stopAgent: () => teardownPrimaryBackendAndWait(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    userData: app.getPath('userData')
  })

  /** After a repair changed something on disk: the next start is a fresh one (the installer too, when asked). */
  const clearLatchesForNextStart = (reinstall: boolean) => {
    bootState.bootstrapFailure = null
    bootState.backendStartFailure = null
    bootState.remoteReauthFailure = null

    if (reinstall) {
      // m-r2-2: the owner's click on the kit's Repair is the choice: the reinstall runs, the chooser is not shown again.
      getFirstRunSetupGate().resetForOwnerReinstall()
    } else {
      getFirstRunSetupGate().resetForRetry()
    }

    resetBootstrapSnapshot()
    endInstallBudget()
    // v0.0.9 F2: the owner's repair starts the automatic-restart budget fresh.
    resetBackendAutoRestart()
  }

  // iclone-seam: p7-ipc-sender — the kit moves the app's and the agent's folders: only the app's own renderer, and a
  // real repair or undo only on the owner's own click (repair-kit/ipc.ts).
  const isAppSender = createAppSenderGuard({
    devServer: DEV_SERVER,
    log: rememberLog,
    rendererIndexPath: resolveRendererIndex
  })

  registerRepairKitIpc({
    afterChange: ({ reinstall }) => clearLatchesForNextStart(reinstall),
    audit: entry => recordRepairKit(entry),
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    isTrustedSender: isAppSender,
    kit,
    lastInputAt: event => lastTrustedInputAt(event.sender)
  })

  ipcMain.handle('hermes:bootstrap:reset', async event => {
    // v0.0.9 Q: Retry restarts the agent through the gate (nothing on disk changes): the app renderer only. It stays
    // free of the click rule on purpose — the app itself calls it after a cloud sign-in and after a repair.
    if (!isAppSender(event, 'hermes:bootstrap:reset')) {
      return null
    }

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
    // v0.0.9 F2: the owner's Retry starts the automatic-restart budget fresh (a pending attempt is superseded).
    resetBackendAutoRestart()

    return { ok: true }
  })
  ipcMain.handle('hermes:bootstrap:repair', async (event, input: unknown) => {
    // v0.0.9 Q (security m1): Repair drives the repair kit (moves folders, reaps processes) and forces a reinstall:
    // only the app's own renderer, like every repair-kit channel. Another window that carries the preload gets null
    // and changes nothing (no attempt counted, no latch cleared, no reset).
    if (!isAppSender(event, 'hermes:bootstrap:repair')) {
      return null
    }

    // v0.0.9 Q (F3 rerun, major): EVERY branch of Repair restarts the runtime and, counted, escalates to a reinstall,
    // so every branch needs the owner's own click (V3-F rule: activation + a trusted click on a control marked
    // data-repair-kit-confirm + real input to this window). A scripted call gets the dry-run plan and changes nothing:
    // no attempt counted, no latch cleared, no reset, no reinstall requested.
    const ownerClick = repairGestureOk(input, lastTrustedInputAt(event.sender), Date.now())

    if (!ownerClick) {
      const refusedCause = causeOf(bootState.backendStartFailure)
      const refusedRoute = routeBootstrapRepair(refusedCause.code)
      let plan: Awaited<ReturnType<RepairKit['apply']>> | null = null

      if (refusedRoute.kitClass) {
        try {
          plan = await kit.apply(refusedRoute.kitClass, { dryRun: true })
        } catch {
          plan = null
        }
      }

      rememberLog('[bootstrap] repair refused: no click of the owner reached main; nothing was restarted or moved')

      return {
        ok: false,
        refused: 'gesture' as const,
        cause: refusedCause.code,
        kit: plan ? { applied: 0, classId: plan.classId, ok: false, refused: 'gesture' as const } : null
      }
    }

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
    // v0.0.9 F3: Repair follows the CAUSE of the latched failure (its structured `bootCause`, else the inference over
    // the error's own text; never the appended app log, the 14 Nov misreading). A known cause runs its repair-kit class
    // — moving files only on the owner's own click — and skips the ladder; an unknown one keeps the ladder above.
    const cause = causeOf(bootState.backendStartFailure)
    const route = routeBootstrapRepair(cause.code)
    let kitReport: Awaited<ReturnType<RepairKit['apply']>> | null = null

    if (route.kitClass) {
      try {
        kitReport = await kit.apply(route.kitClass, { dryRun: false })
      } catch (error) {
        rememberLog(
          `[repair-kit] ${route.kitClass} could not run: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      rememberLog(
        `[bootstrap] repair routed by cause ${cause.code} → ${route.kitClass}: ${route.reason}` +
          (kitReport ? ` (${kitReport.applied.length} step(s), ok=${kitReport.ok})` : '')
      )
    }

    const classRepaired = Boolean(kitReport && !kitReport.refused && kitReport.ok && kitReport.applied.length > 0)
    const kitReinstall = Boolean(kitReport?.applied.some(applied => applied.step.kind === 'reinstall-runtime'))
    // V3-S r2 (m1): a gate refusal is not a stalled backend: a soft restart is refused again, so the installer runs.
    // Only a REAL gate refusal now (its cause), never a crash whose appended log happens to hold the gate's line.
    const gateRefused = cause.code === 'gate-not-loaded'

    if (gateRefused && !classRepaired && !repairDecision.hardReinstall) {
      rememberLog('[bootstrap] the permission gate refused the last start; this repair reinstalls the runtime')
    }

    bootState.bootstrapRepairRequested = classRepaired
      ? route.forceReinstall || kitReinstall
      : repairDecision.hardReinstall || gateRefused || route.forceReinstall
    bootState.bootstrapFailure = null
    bootState.backendStartFailure = null
    bootState.remoteReauthFailure = null

    // m-r2-2: this is the owner's own click (checked above). A Repair that reinstalls the app's runtime needs no second
    // click on the first-run chooser; one that only restarts keeps the old reset.
    if (bootState.bootstrapRepairRequested) {
      getFirstRunSetupGate().resetForOwnerReinstall()
    } else {
      getFirstRunSetupGate().resetForRepair()
    }

    resetHermesConnection()
    endInstallBudget()

    return {
      ok: true,
      cause: cause.code,
      kit: kitReport
        ? {
            applied: kitReport.applied.length,
            classId: kitReport.classId,
            ok: kitReport.ok,
            refused: kitReport.refused ?? null
          }
        : null
    }
  })
  ipcMain.handle('hermes:bootstrap:continue-local', async (event, input: unknown) => {
    // v0.0.9 critic m6: this starts the network install, so it is the owner's own click on the app window, like Install
    // again (renderer control marked data-repair-kit-confirm). A scripted call starts nothing.
    if (!isAppSender(event, 'hermes:bootstrap:continue-local')) {
      return null
    }

    if (!repairGestureOk(input, lastTrustedInputAt(event.sender), Date.now())) {
      rememberLog('[bootstrap] local install refused: no click of the owner reached main; nothing was started')

      return { ok: false, refused: 'gesture' as const }
    }

    rememberLog('[bootstrap] local install selected by renderer; continuing first-launch bootstrap')
    continueFirstRunLocalBootstrap()

    return { ok: true }
  })
  ipcMain.handle('hermes:bootstrap:cancel', async event => {
    // v0.0.9 critic m6: the app window only (Cancel stays click-free: stopping an install is always safe).
    if (!isAppSender(event, 'hermes:bootstrap:cancel')) {
      return null
    }

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
  ipcMain.handle('hermes:agent-runtime:skip', async event => {
    if (!isAppSender(event, 'hermes:agent-runtime:skip')) {
      return null
    }

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
  ipcMain.handle('hermes:agent-runtime:open-fix', async (event, fix: unknown) =>
    isAppSender(event, 'hermes:agent-runtime:open-fix') ? openAgentRuntimeFix(fix) : null
  )
  ipcMain.handle('hermes:agent-runtime:install-again', async (event, input: unknown) => {
    // v0.0.9 Q (F3 rerun): Install again reinstalls the runtime: the app renderer only, on the owner's own click.
    if (!isAppSender(event, 'hermes:agent-runtime:install-again')) {
      return null
    }

    if (!repairGestureOk(input, lastTrustedInputAt(event.sender), Date.now())) {
      rememberLog('[agent-runtime] install again refused: no click of the owner reached main; nothing was changed')

      return { ok: false, refused: 'gesture' as const }
    }

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
    resetBackendAutoRestart()

    return { ok: true }
  })
  ipcMain.handle('hermes:boot-progress:get', async () => progressState.bootProgressState)
  ipcMain.handle('hermes:bootstrap:get', async () => getBootstrapState())
}
