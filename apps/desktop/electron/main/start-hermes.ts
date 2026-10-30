// Starting the primary Hermes backend.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

import { createBackendOutputTail } from '../backend-claim'
import { isReauthRequiredError } from '../backend-health'
import { waitForDashboardPortAnnouncement } from '../backend-ready'
import {
  isHostKeyChangedBootFailure,
  isRetryableRemoteBootFailure,
  shouldLatchBackendStartFailure,
  shouldLatchHostKeyChangedFailure,
  shouldLatchRemoteReauthFailure
} from '../backend-start-failure'
import { adoptServedDashboardToken } from '../dashboard-token'
import { probeGatewayWebSocket } from '../gateway-ws-probe'
import { icloneCompatGuard } from '../iclone-compat'
import { consentEnv } from '../iclone-consent'
import { paySpawn } from '../iclone-x402/ipc'
import { spawnProfile } from '../iclone-x402/spawn-profile'
import { endInstallBudget, INSTALL_WATCHDOG_TAG } from '../install-liveness'
import { parentWatchdogEnv } from '../parent-process-identity'
import {
  createPrimaryRemoteConnection,
  FirstRunSetupResetError,
  runPrimaryBackendStartup
} from '../primary-backend-startup'
import { ensureLoginShellPath } from '../shell-path'
import { hiddenWindowsChildOptions } from '../windows-child-options'
import { setActiveGatewayProfile, setWslBridgeProfileState } from '../wsl-path-bridge'

import { markAgentRuntimeRunning } from './agent-runtime-status'
import {
  claimBackendChild,
  primaryBackendIsRemote,
  primaryProfileKey,
  stopBackendChild,
  waitForBackendExit
} from './backend'
import { BOOT_DEPENDENCIES_MESSAGE, BOOT_PHASE_DEPENDENCIES, watchBackendBoot } from './backend-boot-watch'
import { desktopParentStartMarker, reapOrphanedBackendsOnce, releaseBackendChild } from './backend-ownership'
import { ensureRuntime } from './backend-pool'
import { type ProbeWebSocketImpl, waitForHermes } from './backend-readiness'
import type { BackendConnection } from './backend-state'
import { backendConnectionState } from './backend-state'
import { BOOT_FAKE_ERROR } from './boot-fake'
import {
  advanceBootProgress,
  broadcastBootstrapEvent,
  updateBootProgress,
  waitForFirstRunSetupChoice
} from './boot-progress'
import { readActiveDesktopProfile } from './connection-config'
import { HERMES_HOME } from './env'
import { getBackendArgsForRuntime } from './executables'
import { prepareHermesSpawn } from './iclone-gate'
import { DESKTOP_LOG_PATH, hermesLog, recentHermesLog, rememberLog } from './log'
import { managedPrimaryRestoreOwners } from './managed-ssh'
import { resolveRemoteBackend } from './managed-ssh-update'
import { makeDashboardReadyFile, resolveHermesCwd, resolveWebDist } from './runtime'
import { bootState, lateBound } from './state'
import {
  ensureRuntimeUpdateCheckOff,
  resolveHermesBackend,
  verifyCuratedHealthCommit,
  waitForUpdateToFinish
} from './updates'
import { getWindowState, sendBackendExit } from './window-events'

export async function startHermes() {
  // Only the single-instance lock holder may reap/spawn/claim the desktop
  // backend. A lock-losing instance must stay inert even if some path reaches
  // here (e.g. the deferred-quit window before `ready`): its reapOrphans()
  // otherwise SIGTERMs the running instance's live backend (#87295).
  if (!lateBound.isPrimaryInstance) {
    rememberLog('[boot] non-primary instance: skipping backend machinery')
    throw new Error('Hermes Desktop is already running in another window.')
  }

  await reapOrphanedBackendsOnce()

  // Latched-failure short-circuit: once bootstrap has failed in this
  // process, every subsequent startHermes() call re-throws the same error
  // without re-running install.ps1. This prevents the renderer's
  // ensureGatewayOpen retries (and any other getConnection callers) from
  // restarting a 5-10 minute install loop while the user is still reading
  // the failure overlay.
  if (bootState.bootstrapFailure) {
    throw bootState.bootstrapFailure
  }

  if (bootState.backendStartFailure) {
    throw bootState.backendStartFailure
  }

  // A confirmed remote reauth rejection is terminal until the user signs in.
  // Short-circuiting here keeps the boot-failure overlay latched and its
  // "Sign in" button clickable, instead of re-driving boot on every retry.
  if (bootState.remoteReauthFailure) {
    throw bootState.remoteReauthFailure
  }

  // E2E: simulate a boot failure without breaking the real backend. The boot
  // progresses a few steps, then fails with the given error message.
  if (BOOT_FAKE_ERROR) {
    await advanceBootProgress('backend.resolve', 'Resolving Hermes backend', 8)
    const error = new Error(BOOT_FAKE_ERROR) as any
    error.isBootstrapFailure = true
    bootState.bootstrapFailure = error
    throw error
  }

  const existingConnectionPromise = backendConnectionState.getPromise()

  if (existingConnectionPromise) {
    return existingConnectionPromise
  }

  const connectionAttempt = backendConnectionState.startAttempt()
  const primaryProfile = primaryProfileKey()

  // Legacy path callers without an explicit profile belong to the primary
  // window backend. Profile-scoped callers still pass their key directly.
  setActiveGatewayProfile(primaryProfile)

  // Classify this boot BEFORE the throwing resolve/mint runs: a remote failure
  // must NOT latch (it's transient — see shouldLatchBackendStartFailure), while
  // a local failure latches to break install-restart loops.
  let attemptedRemote = managedPrimaryRestoreOwners.size > 0 || primaryBackendIsRemote()

  const connectionPromise = (async () => {
    const connectRemote = async (remote: BackendConnection) => {
      // resolveRemote() may take arbitrarily long (settings resolve / ws-ticket
      // mint). If a newer attempt started meanwhile (e.g. the user switched
      // remotes and Apply invalidated this attempt), bail before probing.
      if (!backendConnectionState.isCurrentAttempt(connectionAttempt)) {
        throw new Error('Hermes backend start was superseded by a newer connection attempt.')
      }

      await advanceBootProgress('backend.remote', `Connecting to remote Hermes backend at ${remote.baseUrl}`, 24)
      await waitForHermes(remote.baseUrl, remote.token, undefined, remote.authMode, remote.headers)

      // Second async boundary: the health probe itself can outlive the
      // attempt. A late success here must not publish a stale descriptor.
      if (!backendConnectionState.isCurrentAttempt(connectionAttempt)) {
        throw new Error('Hermes backend start was superseded by a newer connection attempt.')
      }

      updateBootProgress({
        phase: 'backend.ready',
        message: 'Remote Hermes backend is ready',
        progress: 94,
        running: true,
        error: null
      })

      return createPrimaryRemoteConnection(remote, hermesLog.slice(-80), getWindowState())
    }

    await advanceBootProgress('backend.resolve', 'Resolving Hermes backend', 8)
    // Resolve for the desktop's primary profile so a per-profile remote
    // override on the active profile is honored (falls back to env / global).

    // GUI launches (Finder/Dock, desktop launchers) inherit a minimal PATH
    // that skips the user's shell profiles. Merge the login-shell PATH into
    // process.env BEFORE resolving the runtime or spawning the backend, so
    // both the Electron-side resolvers and the whole backend subtree (tool
    // availability checks, stdio MCP servers) can find Homebrew-, nvm-, and
    // ~/.local/bin-installed CLIs. Single-flight with the whenReady warmup;
    // failure-hardened — a broken shell profile never blocks boot.
    const loginShellPath = await ensureLoginShellPath()

    if (loginShellPath.applied) {
      rememberLog('[env] merged login-shell PATH into process.env for backend spawn')
    } else if (loginShellPath.reason && !['win32', 'unchanged'].includes(loginShellPath.reason)) {
      rememberLog(`[env] login-shell PATH resolution unavailable (${loginShellPath.reason}); keeping inherited PATH`)
    }

    const token = crypto.randomBytes(32).toString('base64url')
    // --port 0: the OS assigns an ephemeral port; the child announces it on stdout.
    const backendArgs = ['serve', '--host', '127.0.0.1', '--port', '0']
    // Pin the desktop's chosen profile via the global --profile flag. This is
    // deterministic (it wins over the sticky ~/.hermes/active_profile file) and
    // resolves HERMES_HOME the same way `hermes -p <name>` does on the CLI.
    // V3-J (m-r3-2): an unset preference pins the profile Hermes itself would
    // pick from its sticky active_profile file (read the way Hermes reads it,
    // never written), so the pay token below is minted for the profile that
    // actually runs. A sticky value Hermes would refuse gets no flag and no token.
    const activeProfile = readActiveDesktopProfile()
    const runsAs = spawnProfile(activeProfile, { hermesHome: HERMES_HOME })

    backendArgs.unshift(...runsAs.args)

    const setup = await runPrimaryBackendStartup({
      connectRemote,
      ensureLocalRuntime: ensureRuntime,
      prepareLocalBackend: async () => {
        await advanceBootProgress('backend.runtime', 'Resolving Hermes runtime', 28)

        return resolveHermesBackend(backendArgs)
      },
      resolveRemote: () => {
        // Classify immediately before each throwing resolve. This callback runs
        // both for an already-saved remote and after first-run remote Apply.
        attemptedRemote = managedPrimaryRestoreOwners.size > 0 || primaryBackendIsRemote()

        return resolveRemoteBackend(primaryProfile, { primary: true })
      },
      waitForDecision: waitForFirstRunSetupChoice,
      // Mutual exclusion with an in-app update (#50238). Remote connections
      // return before this waiter; local starts park until the updater exits.
      waitForLocalStart: waitForUpdateToFinish
    })

    if (setup.kind === 'remote') {
      // Paths from the remote backend belong to a host the Windows desktop
      // cannot open via wsl.exe — disable WSL path bridging so native dialogs
      // and file panels don't spawn wsl.exe (or the interactive install prompt
      // on WSL-less machines) for unresolvable paths. (#66433)
      setWslBridgeProfileState(primaryProfile, false)

      return setup.connection
    }

    // Local WSL backend — paths are bridgeable.
    setWslBridgeProfileState(primaryProfile, true)

    const backend = setup.backend
    await ensureRuntimeUpdateCheckOff(runsAs.slug ?? activeProfile) // iclone-seam: r1-config — updates.check off → spawn
    // Route old runtimes (no `serve`) through the legacy `dashboard --no-open`.
    backend.args = getBackendArgsForRuntime(backend)
    const hermesCwd = resolveHermesCwd()

    // V3-S: the iclone Hermes plugins from the signed bundle, verified in this runtime and proven armed by its own
    // plugin manager, then this spawn's key, lock and confinement env — or this throws (`[iclone-gate]`, latched like
    // any local failure) and nothing is spawned.
    const gated = await prepareHermesSpawn({
      backend,
      cwd: hermesCwd,
      profile: activeProfile || null,
      role: 'primary'
    })

    const webDist = resolveWebDist()
    const readyFile = backend.readyFile ? makeDashboardReadyFile() : null

    await advanceBootProgress('backend.spawn', `Starting Hermes backend via ${backend.label}`, 84)
    rememberLog(`Starting Hermes backend via ${backend.label}`)

    const profile = primaryProfileKey()
    const parentStartMarker = await desktopParentStartMarker()
    const backendNonce = crypto.randomBytes(16).toString('hex')
    const parentIdentityEnv = parentWatchdogEnv(process.pid, parentStartMarker, backendNonce)
    // V3-J: this spawn's own pay-socket token, bound to the profile it runs as and to that profile's folder (a 0600
    // file; only its path and the folder's identity are in env, which V3-S's seal keeps for the primary spawn).
    const payments = paySpawn(runsAs.slug)

    rememberLog(`[iclone-x402] backend runs as ${runsAs.slug ?? 'an unknown profile (no pay env)'} (${runsAs.why})`)

    const hermesProcess = spawn(
      backend.command,
      // V3-S r3 (m-b): `-s -P` before the backend's args (no user site, no cwd on sys.path).
      gated.argv(backend.args),
      hiddenWindowsChildOptions({
        cwd: hermesCwd,
        // V3-S r3 (m-b, m-f): sealed — inherited Python settings and foreign ICLONE_* dropped, then the gate's env
        // (V3-F lock + policy file + agent socket, V3-G confinement, the spawn's own bytecode prefix) applied LAST.
        env: gated.seal({
          ...process.env,
          // Explicitly pin HERMES_HOME for the child so Python's get_hermes_home()
          // resolves to the SAME location our resolveHermesHome() picked. Without
          // this pin, Python falls back to ~/.hermes on every platform — fine on
          // mac/linux (where our default matches), but on Windows our default is
          // %LOCALAPPDATA%\hermes, which differs from C:\Users\<u>\.hermes.
          // Mismatch would split config / sessions / .env / logs across two
          // directories. install.ps1 sets HERMES_HOME via setx; the desktop
          // can't reliably do that, so we set it inline for every spawn.
          HERMES_HOME,
          ...backend.env,
          ...consentEnv(),
          ...payments.env,
          TERMINAL_CWD: hermesCwd,
          HERMES_DASHBOARD_SESSION_TOKEN: token,
          // Marks this dashboard backend as desktop-spawned so it runs the cron
          // scheduler tick loop (the gateway isn't running under the app).
          HERMES_DESKTOP: '1',
          // Exact parent identity lets the backend self-exit after an unclean
          // Desktop death without mistaking a reused PID for its owner. If the
          // optional marker probe fails, retain legacy PID-only tracking.
          ...parentIdentityEnv,
          HERMES_WEB_DIST: webDist,
          ...(readyFile ? { HERMES_DESKTOP_READY_FILE: readyFile } : {})
        }),
        shell: backend.shell,
        stdio: gated.stdio
      })
    )

    gated.attach(hermesProcess)
    payments.attach(hermesProcess)

    // Buffer stdout+stderr from the instant of spawn (#93608): an early
    // crash's traceback must survive into the claim error and the
    // before-ready exit message shown by the boot UI. rememberLog attaches
    // later, after the claim, and would miss anything printed before it.
    const primaryOutputTail = createBackendOutputTail()
    primaryOutputTail.attach(hermesProcess)

    // Ruling 42 (+ amendment): the child's classified output slides the port/readiness deadlines while it visibly
    // installs dependencies (to the 300 s install ceiling) and keeps the renderer's liveness budget fed meanwhile.
    const bootWatch = watchBackendBoot(hermesProcess, {
      publishDependenciesStep: () =>
        updateBootProgress({
          error: null,
          message: BOOT_DEPENDENCIES_MESSAGE,
          phase: BOOT_PHASE_DEPENDENCIES,
          progress: 88,
          running: true
        }),
      publishHeartbeat: () => updateBootProgress({ running: true })
    })

    await claimBackendChild(
      hermesProcess,
      `${backend.command} ${backend.args.join(' ')}`,
      profile,
      backendNonce,
      primaryOutputTail
    )
    const processOwner = backendConnectionState.attachProcess(connectionAttempt, hermesProcess)

    if (!processOwner) {
      bootWatch.stop()
      stopBackendChild(hermesProcess)
      await waitForBackendExit(hermesProcess)
      releaseBackendChild(hermesProcess)
      throw new Error('Hermes backend start was superseded by a newer connection attempt.')
    }

    hermesProcess.stdout?.on('data', rememberLog)
    hermesProcess.stderr?.on('data', rememberLog)
    let backendReady = false
    let rejectBackendStart: ((error: Error) => void) | null = null

    const backendStartFailed = new Promise((_resolve, reject) => {
      rejectBackendStart = reject
    })

    hermesProcess.once('error', error => {
      releaseBackendChild(hermesProcess)

      if (!backendConnectionState.clearForCurrentProcess(processOwner)) {
        rememberLog(`Ignoring stale Hermes backend error: ${error.message}`)
        rejectBackendStart?.(new Error('Hermes backend start was superseded by a newer connection attempt.'))

        return
      }

      rememberLog(`Hermes backend failed to start: ${error.message}`)
      updateBootProgress(
        {
          error: error.message,
          message: `Hermes backend failed to start: ${error.message}`,
          phase: 'backend.error',
          running: false
        },
        { allowDecrease: true }
      )
      sendBackendExit({ code: null, signal: null, error: error.message })
      rejectBackendStart?.(error)
    })
    hermesProcess.once('exit', (code, signal) => {
      releaseBackendChild(hermesProcess)

      if (!backendConnectionState.clearForCurrentProcess(processOwner)) {
        rememberLog(`Ignoring stale Hermes backend exit (${signal || code})`)

        if (!backendReady) {
          rejectBackendStart?.(new Error('Hermes backend start was superseded by a newer connection attempt.'))
        }

        return
      }

      rememberLog(`Hermes backend exited (${signal || code})`)
      sendBackendExit({ code, signal })

      if (!backendReady) {
        const message = `Hermes backend exited before it became ready (${signal || code}).${primaryOutputTail.describe()}`
        updateBootProgress(
          {
            error: message,
            message,
            phase: 'backend.error',
            running: false
          },
          { allowDecrease: true }
        )
        rejectBackendStart?.(
          new Error(
            `Hermes backend exited before it became ready (${signal || code}). Log: ${DESKTOP_LOG_PATH}\n${recentHermesLog()}`
          )
        )
      }
    })

    await advanceBootProgress('backend.port', 'Waiting for Hermes backend to launch', 86)

    // Discover the ephemeral port the child bound to
    let port: unknown

    try {
      port = await Promise.race([
        waitForDashboardPortAnnouncement(hermesProcess, {
          activity: bootWatch.source,
          describeOutputTail: () => primaryOutputTail.describe(),
          readyFile
        }),
        backendStartFailed
      ])
    } catch (error) {
      bootWatch.stop()
      throw error
    }

    if (readyFile) {
      fs.unlink(readyFile, () => {})
    }

    const baseUrl = `http://127.0.0.1:${port}`
    await advanceBootProgress('backend.wait', 'Waiting for Hermes backend to become ready', 90)

    try {
      await Promise.race([
        waitForHermes(baseUrl, token, undefined, undefined, undefined, bootWatch.source),
        backendStartFailed
      ])
    } finally {
      bootWatch.stop()
    }

    backendReady = true
    bootState.backendStartFailure = null
    markAgentRuntimeRunning()
    endInstallBudget() // ruling 42 r2: the first-launch budget ends when the agent is up
    verifyCuratedHealthCommit(baseUrl)

    const authToken = await adoptServedDashboardToken(baseUrl, token, {
      childAlive: () => hermesProcess.exitCode === null && !hermesProcess.killed,
      rememberLog
    })

    // Verify the WebSocket session token before declaring backend ready.
    const wsUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(authToken)}`
    const wsProbe = await probeGatewayWebSocket(wsUrl, { WebSocketImpl: globalThis.WebSocket as ProbeWebSocketImpl })

    if (!wsProbe.ok) {
      throw new Error(
        `Local Hermes backend is HTTP-reachable but the WebSocket (/api/ws) rejected the session token: ${wsProbe.reason}`
      )
    }

    updateBootProgress({
      phase: 'backend.ready',
      message: 'Hermes backend is ready. Finalizing desktop startup',
      progress: 94,
      running: true,
      error: null
    })
    icloneCompatGuard({ baseUrl, wsUrl }) // iclone-seam: p4a-guard

    // A successful boot (including a soft restart that the repair-guard
    // chose over a hard reinstall, see #74874) means any in-flight repair
    // attempt counter has been honoured — reset it so the next genuine
    // failure starts fresh from attempt 1 instead of inheriting the
    // accumulated count of the resolved episode.
    bootState.bootstrapRepairAttempt = 0

    return {
      baseUrl,
      mode: 'local',
      source: 'local',
      authMode: 'token',
      token: authToken,
      wsUrl,
      logs: hermesLog.slice(-80),
      ...getWindowState()
    }
  })().catch(async error => {
    if (!backendConnectionState.clearPromiseForAttempt(connectionAttempt)) {
      throw error
    }

    const failedProcess = backendConnectionState.invalidate()
    stopBackendChild(failedProcess)
    await waitForBackendExit(failedProcess)

    if (error instanceof FirstRunSetupResetError) {
      throw error
    }

    const message = error instanceof Error ? error.message : String(error)
    const hostKeyChanged = isHostKeyChangedBootFailure(error)

    // Ruling 42 r2 (critic M2): an install-class verdict while the agent was still starting after its install (the
    // first-launch budget ran out, or a dependency sync stopped progressing) is shown where every install failure is:
    // the install overlay, with its diagnosis, Try again and Skip — never the old card.
    if (message.includes(INSTALL_WATCHDOG_TAG)) {
      broadcastBootstrapEvent({ type: 'failed', stage: 'start', error: message })
    }

    // Carry structured Cloud-down metadata through the boot-progress / IPC
    // boundary when present, so the renderer overlay can key on it rather than
    // re-classifying the message string. main owns classification; the renderer
    // only consumes the structured result (#85335).
    const isCloudBackendDown = Boolean(error && typeof error === 'object' && (error as any).isCloudBackendDown === true)

    const statusCode = Number(
      error && typeof error === 'object' && Number.isInteger((error as any).statusCode)
        ? (error as any).statusCode
        : NaN
    )

    // Only latch LOCAL boot failures. A remote failure (lapsed session / mint
    // timeout / host briefly unreachable across sleep) is transient and has no
    // child 'exit' handler to clear the cache — latching it would wedge the app
    // on "session expired" until a full restart, defeating reconnect, the
    // "Sign out & sign in" reload, and the wake-recovery revalidate path.
    if (shouldLatchBackendStartFailure({ attemptedRemote })) {
      bootState.backendStartFailure = error instanceof Error ? error : new Error(message)
    }

    // A host-key CHANGE is the terminal exception among remote failures: SSH
    // fails closed until the user verifies the change and clears the stale
    // known_hosts entry, so retrying re-drives the identical doomed boot (one
    // bundle showed 157 consecutive failures over 2.5h). Latch it like a local
    // failure — reset/repair/apply-config clear the latch after the user fixes
    // known_hosts.
    if (shouldLatchHostKeyChangedFailure({ attemptedRemote, isReauth: false, isHostKeyChanged: hostKeyChanged })) {
      bootState.backendStartFailure = error instanceof Error ? error : new Error(message)
    }

    // A confirmed reauth rejection latches separately: it can't self-heal, and
    // leaving it unlatched hides the overlay's "Sign in" button on every retry.
    if (shouldLatchRemoteReauthFailure({ attemptedRemote, isReauth: isReauthRequiredError(error) })) {
      bootState.remoteReauthFailure = error instanceof Error ? error : new Error(message)
    }

    updateBootProgress(
      {
        error: message,
        isCloudBackendDown: isCloudBackendDown || undefined,
        message: `Desktop boot failed: ${message}`,
        phase: 'backend.error',
        // Renderer contract for the self-heal loop (#82679): a transient
        // REMOTE failure (dropped SSH/HTTP registered connection, mint
        // timeout) is retryable — the renderer re-attempts the boot with
        // bounded backoff. Local failures, confirmed reauth rejections, and
        // host-key changes are not: those end in the recovery overlay /
        // sign-in affordance.
        retryable: isRetryableRemoteBootFailure({
          attemptedRemote,
          isReauth: isReauthRequiredError(error),
          isHostKeyChanged: hostKeyChanged
        }),
        running: false,
        statusCode: Number.isInteger(statusCode) ? statusCode : undefined
      },
      { allowDecrease: true }
    )
    throw error
  })

  backendConnectionState.setPromise(connectionAttempt, connectionPromise)

  return connectionPromise
}
