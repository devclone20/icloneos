// Per-profile backend pool: spawn, eviction, idle reaping and shutdown.
import path from 'node:path'

import { app } from 'electron'

import { stopBackendTreesForUpdate } from '../backend-child'
import { createBackendShutdownCoordinator } from '../backend-ownership'
import { isPidAliveWindows, waitForBackendRelease } from '../backend-release-gate'
import { runBootstrap } from '../bootstrap-runner'
import {
  backendScopePrefix,
  connectionDialFieldsChanged,
  mergeConnectionInput,
  normalizeConnectionInput,
  upsertConnection
} from '../connection-registry'
import { resolvePersistedRemoteToken } from '../hardening'
import { prepareDependencyInstall } from '../iclone-runtime-closed'
import { selectPoolEvictions } from '../pool-eviction'
import { createPoolStopper } from '../pool-stop'
import { poolTouchKeys } from '../pool-touch-scope'
import {
  decideProfileDeleteAction,
  localProfilePoolKeys,
  profileNameFromDeleteRequest
} from '../profile-delete-routing'
import { revalidatePooledRemoteBackends } from '../remote-liveness'
import { updateHandoffConflict, writeUpdateMarker } from '../update-marker'
import { observeUpdaterHandoff, spawnUpdaterProcess, stagedUpdaterSupportsPrewrittenMarker } from '../updater-process'
import { chooseUpdaterArgs } from '../windows-hermes-path'

import { assertAgentInstallAllowed } from './agent-runtime-status'
import {
  broadcastConnectionsChanged,
  fetchJsonForBackend,
  primaryProfileKey,
  stopBackendChild,
  teardownPrimaryBackendAndWait,
  waitForBackendExit
} from './backend'
import { forceKillProcessTree, type OwnedBackendChild } from './backend-ownership'
import {
  backendConnectionState,
  backendPool,
  POOL_IDLE_MS,
  POOL_KEEPALIVE_FRESH_MS,
  POOL_MAX_BACKENDS,
  remoteLiveness
} from './backend-state'
import { advanceBootProgress, broadcastBootstrapEvent, updateBootProgress } from './boot-progress'
import {
  readDesktopConnectionsRegistry,
  sanitizeRegistryConnection,
  sshConnections,
  writeActiveDesktopProfile,
  writeDesktopConnectionsRegistry
} from './connection-config'
import { readDesktopUpdateConfig } from './desktop-settings'
import {
  ACTIVE_HERMES_ROOT,
  activeVenvRoot,
  DEFAULT_UPDATE_BRANCH,
  directoryExists,
  fileExists,
  HERMES_HOME,
  IS_PACKAGED,
  IS_WINDOWS,
  isHermesSourceRoot,
  isRuntimeUpgradeFromLegacy,
  pathWithHermesManagedNode,
  PROFILE_NAME_RE,
  resolveUpdateRoot,
  runtimePrivateDependencies,
  SOURCE_REPO_ROOT
} from './env'
import { findGitBash, getVenvPython } from './executables'
import { rememberLog, updatePolicy } from './log'
import { managedConnectionUpdateGate, sshBootstrapCoordinator, teardownSshConnection } from './managed-ssh'
import { type HermesBackendSpec, type RunnableBackendSpec, writeBootstrapMarker } from './runtime'
import { decryptDesktopSecret, encryptDesktopSecret, encryptIncomingRemoteHeaders } from './secrets'
import { bootState, lateBound, quitState } from './state'
import {
  isShimLocked,
  resolveHealedBranch,
  resolveHermesBackend,
  resolveUpdaterBinary,
  sealInstalledDependencies,
  UPDATE_HANDOFF_DWELL_MS,
  venvHermesShimPath
} from './updates'

let poolIdleReaper: ReturnType<typeof setTimeout> | null = null

// Before handing off the update on Windows, the desktop MUST stop every backend
// it spawned and WAIT for the venv shim to actually unlock. The old code did
// `hermesProcess.kill('SIGTERM')` + `app.quit()` fire-and-forget: SIGTERM on
// Windows doesn't reap the backend's grandchildren, and quit didn't wait for
// teardown, so the updater raced a still-locked `hermes.exe`, the quarantine
// rename failed, uv's `pip install` hit "Access is denied", and the git path
// bailed into a full ZIP re-download that ALSO couldn't write the locked shim —
// a half-applied install (ryanc's update.log). Here we tree-kill the primary +
// pool backends and poll the shim until it's writable (or a bounded timeout),
// so by the time we spawn the updater the lock is genuinely gone.
//
// Windows-only: the venv-shim mandatory lock is a Windows phenomenon. On
// macOS/Linux there's no REPLACE-on-running-exe block, the existing before-quit
// SIGTERM + app.quit() teardown already works (the macOS path is flawless), and
// aggressively SIGKILL-ing the backend here would be an untested behavior change
// for no benefit. So we no-op off Windows and leave that path exactly as it was.
export async function releaseBackendLockForUpdate(updateRoot: string) {
  return releaseBackendLock(updateRoot, 'updates')
}

// Shared backend teardown + venv-shim unlock wait. Used by BOTH the self-update
// hand-off and the desktop uninstaller — they have the identical Windows
// problem: the desktop's backend (and the grandchildren IT spawned — a hermes
// REPL, a pty terminal, the gateway) keep `hermes.exe` and other files in the
// venv mandatory-locked, so any in-place replace/delete of the install tree
// races a live handle and half-fails (#37532). We tree-kill every backend PID
// the desktop owns, then poll the shim until it's genuinely writable.
//
// `tag` only flavors the log lines. No-op off Windows (POSIX has no mandatory
// locks — the before-quit SIGTERM + the cleanup script's own PID-wait suffice).
export async function releaseBackendLock(updateRoot: string, tag: string) {
  if (!IS_WINDOWS) {
    return { unlocked: true }
  }

  const hermesProcess = backendConnectionState.getProcess()

  // Seed the release gate with every PID we are about to signal: the
  // supervised primary backend and all pool backends. The gate waits for
  // these to actually LEAVE the process table, not just for the shim to
  // unlock — the shim probe only covers venv\Scripts\hermes.exe, but the
  // backend is `python.exe -m hermes_cli.main serve`, which need not hold
  // the shim at all (#74805 first-attempt race).
  const initialPids: number[] = []

  if (hermesProcess && typeof hermesProcess.pid === 'number') {
    initialPids.push(hermesProcess.pid)
  }

  for (const entry of backendPool.values()) {
    if (entry.process && typeof entry.process.pid === 'number') {
      initialPids.push(entry.process.pid)
    }
  }

  stopBackendTreesForUpdate(hermesProcess, {
    forceKillProcessTree,
    stopAllPoolBackends
  })

  const shim = venvHermesShimPath(updateRoot)

  const gate = await waitForBackendRelease(
    initialPids,
    {
      isShimLocked: () => Boolean(isShimLocked(shim)),
      isPidAlive: isPidAliveWindows,
      collectStragglerPids: () => {
        const stragglers: number[] = []

        const currentHermesProcess = backendConnectionState.getProcess()

        if (currentHermesProcess && typeof currentHermesProcess.pid === 'number') {
          stragglers.push(currentHermesProcess.pid)
        }

        for (const entry of backendPool.values()) {
          if (entry.process && typeof entry.process.pid === 'number') {
            stragglers.push(entry.process.pid)
          }
        }

        return stragglers
      },
      killProcessTree: forceKillProcessTree,
      sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
      now: () => Date.now(),
      log: rememberLog
    },
    tag
  )

  if (gate.unlocked) {
    return { unlocked: true }
  }

  // Do NOT proceed past a held lock: handing off to the updater while another
  // process (a second desktop window, a user terminal, an unkillable child)
  // still maps the venv's files guarantees a half-updated venv — the updater's
  // dependency sync dies on access-denied partway through uninstalls, leaving
  // imports broken (the July 2026 brotlicffi/_sodium.pyd incidents). Failing
  // the update loudly and keeping the app running is strictly better than a
  // bricked install that needs manual venv surgery.
  rememberLog(
    `[${tag}] venv shim still locked after 15s; aborting hand-off (something outside this app holds the venv)`
  )

  return { unlocked: false }
}

async function handOffWindowsBootstrapRecovery(reason: string) {
  if (!IS_WINDOWS || !IS_PACKAGED) {
    return false
  }

  const updater = resolveUpdaterBinary()

  if (!updater) {
    return false
  }

  const handoffConflict = updateHandoffConflict(HERMES_HOME)

  if (handoffConflict) {
    // Same hazard as applyUpdates (#75778): a live foreign updater already
    // owns the marker. Spawning another here would overwrite its claim and
    // race a second updater over the same install tree. The live updater
    // is already working on this exact install and will restart us when
    // it finishes, so treat this the same as a successful hand-off instead
    // of clobbering it with our own.
    rememberLog(`[bootstrap] refusing recovery hand-off: ${handoffConflict.message}`)
    quitState.isQuittingForHandoff = true
    setTimeout(() => {
      app.quit()
    }, UPDATE_HANDOFF_DWELL_MS)

    return true
  }

  const updateRoot = resolveUpdateRoot()
  const { branch: configuredBranch } = readDesktopUpdateConfig()

  const branch = directoryExists(path.join(updateRoot, '.git'))
    ? await resolveHealedBranch(updateRoot, configuredBranch || DEFAULT_UPDATE_BRANCH)
    : configuredBranch || DEFAULT_UPDATE_BRANCH

  const venvBin = path.join(updateRoot, 'venv', IS_WINDOWS ? 'Scripts' : 'bin')
  const venvHermes = path.join(venvBin, IS_WINDOWS ? 'hermes.exe' : 'hermes')
  const venvPython = path.join(venvBin, IS_WINDOWS ? 'python.exe' : 'python')

  // The updater invokes the venv's Hermes launcher, which in turn requires the
  // venv interpreter. A bootstrap-complete marker proves only that setup once
  // finished; it can outlive a manually removed or quarantined venv. Sending a
  // marker-only install through --update dead-ends at "Could not find the hermes
  // CLI" instead of rebuilding the runtime, so only a runnable pair gets the
  // gentle update path. Partial or missing runtimes go through full repair.
  const updaterArgs = chooseUpdaterArgs(
    {
      hasBootstrapMarker: fileExists(path.join(updateRoot, '.hermes-bootstrap-complete')),
      hasVenvHermes: fileExists(venvHermes),
      hasVenvPython: fileExists(venvPython)
    },
    branch
  )

  await releaseBackendLockForUpdate(updateRoot)

  const child = spawnUpdaterProcess(updater, updaterArgs, {
    cwd: HERMES_HOME,
    env: {
      ...process.env,
      HERMES_HOME,
      PATH: pathWithHermesManagedNode(venvBin)
    },
    detached: true,
    stdio: 'ignore'
  })

  // Same marker pre-write as applyUpdates — see comment there. The recovery
  // hand-off has the same window where the renderer can respawn a backend
  // before the updater writes its own marker, and the same stale-updater
  // exclusion: a pre-#74782 binary would refuse its own pre-written claim and
  // strand the very recovery meant to heal the install.
  if (Number.isInteger(child.pid) && stagedUpdaterSupportsPrewrittenMarker(updater)) {
    writeUpdateMarker(HERMES_HOME, child.pid)
  } else if (Number.isInteger(child.pid)) {
    rememberLog(
      `[bootstrap] skipping marker pre-write: staged updater predates self-adopt (${updater}); it would refuse its own claim`
    )
  }

  rememberLog(
    `[bootstrap] handed off ${reason} recovery to updater: ${updater} ${updaterArgs.join(' ')}; exiting desktop to release app.asar`
  )
  // Same dwell as the in-app update hand-off (#50419): give the updater's
  // window time to appear before we vanish, so the recovery doesn't look like
  // a crash and provoke a mid-recovery relaunch. The dwell doubles as the
  // hand-off settle window (#66753): a spawn error or early updater death
  // returns false so the caller falls through to its next recovery path
  // instead of quitting into nothing.
  const dwellStartedAt = Date.now()
  const handoffOutcome = await observeUpdaterHandoff(child, UPDATE_HANDOFF_DWELL_MS)

  if (!handoffOutcome.ok) {
    rememberLog(`[bootstrap] recovery hand-off not viable, staying alive: ${handoffOutcome.message}`)

    return false
  }

  quitState.isQuittingForHandoff = true
  setTimeout(
    () => {
      app.quit()
    },
    Math.max(0, UPDATE_HANDOFF_DWELL_MS - (Date.now() - dwellStartedAt))
  )

  return true
}

export async function ensureRuntime(backend: HermesBackendSpec): Promise<RunnableBackendSpec> {
  if (backend.bootstrap === false) {
    await advanceBootProgress('runtime.external', `Using ${backend.label}`, 32)

    return backend
  }

  // backend.kind === 'bootstrap-needed' means resolveHermesBackend couldn't
  // find anything to spawn. Hand off to the bootstrap runner which drives the
  // platform installer, writes the bootstrap-complete marker on success, then
  // we re-resolve to get the now-installed backend.
  //
  // Phase 1D status: bootstrap runs but events go to desktop.log only
  // (renderer window isn't created until later in startBackend). Phase 1E
  // will rewire startup to spawn the window first and route bootstrap events
  // to a renderer-side install overlay.
  if (backend.kind === 'bootstrap-needed') {
    assertAgentInstallAllowed() // iclone-seam: rtb6-skip — the user skipped the install: open without the agent
    rememberLog('[bootstrap] no Hermes install found; starting first-launch bootstrap')

    if (await handOffWindowsBootstrapRecovery('bootstrap-needed')) {
      const handoffError: Error & { isBootstrapFailure?: boolean; bootstrapHandedOff?: boolean } = new Error(
        'Hermes recovery was handed off to Hermes Setup. The desktop will restart when recovery completes.'
      )

      handoffError.isBootstrapFailure = true
      handoffError.bootstrapHandedOff = true
      bootState.bootstrapFailure = handoffError
      throw handoffError
    }

    // Eagerly flip the bootstrap UI state to 'active' so the renderer
    // shows the install overlay BEFORE the runner finishes fetching the
    // manifest (which on slow networks can take tens of seconds and would
    // otherwise leave the user staring at the generic 'Preparing' splash).
    // We emit a synthetic manifest with an empty stages list -- the real
    // manifest event will overwrite it once install.ps1 -Manifest returns.
    try {
      broadcastBootstrapEvent({
        type: 'manifest',
        stages: [],
        protocolVersion: null
      })
    } catch {
      void 0
    }

    bootState.bootstrapAbortController = new AbortController()

    // The repair request has been honoured by reaching the installer; clear it
    // so a later boot isn't forced through bootstrap again.
    bootState.bootstrapRepairRequested = false
    bootState.bootstrapRepairAttempt = 0

    // V3-RT critic r2 M1: every install of the app's runtime starts from nothing (the dependency folder, launchers and
    // record are deleted first), so the record written after it can only cover bytes this install made.
    const freshDependencies = IS_PACKAGED ? prepareDependencyInstall(ACTIVE_HERMES_ROOT) : null

    if (freshDependencies) {
      rememberLog('[iclone-runtime] dependency folder, launchers and record removed: this install starts from nothing')
    }

    const bootstrapResult = await runBootstrap({
      appVersion: app.getVersion(),
      installStamp: backend.installStamp,
      activeRoot: backend.activeRoot,
      sourceRepoRoot: SOURCE_REPO_ROOT,
      hermesHome: HERMES_HOME,
      logRoot: path.join(HERMES_HOME, 'logs'),
      abortSignal: bootState.bootstrapAbortController.signal,
      policy: updatePolicy(), // iclone-seam: r1-policy — curated pins every install.sh run, a repair too
      // V3-RT (ruling 36): the app's own runtime keeps uv, Python, PM's store and its environment in its folder; K-RT2:
      // someone who had a runtime at ~/.hermes/hermes-agent is told once that this one is the app's own copy.
      privateDependencies: runtimePrivateDependencies(),
      ...(isRuntimeUpgradeFromLegacy() ? { purpose: 'runtime-upgrade' as const } : {}),
      onEvent: ev => {
        // Tee every bootstrap event to (a) the desktop log for forensics
        // and (b) the renderer for live progress UI. Either may be absent;
        // tolerate both gracefully so a renderer crash doesn't stall the
        // bootstrap and a log-write failure doesn't suppress the UI signal.
        try {
          rememberLog(`[bootstrap] ${JSON.stringify(ev)}`)
        } catch {
          void 0
        }

        try {
          broadcastBootstrapEvent(ev)
        } catch {
          void 0
        }
      },
      writeMarker: writeBootstrapMarker
    })

    bootState.bootstrapAbortController = null

    if (bootstrapResult.cancelled) {
      const cancelledError = new Error('Hermes install was cancelled.') as any
      cancelledError.isBootstrapFailure = true
      cancelledError.bootstrapCancelled = true
      bootState.bootstrapFailure = cancelledError
      throw cancelledError
    }

    if (!bootstrapResult.ok) {
      const bootstrapError = new Error(
        `Hermes bootstrap failed${bootstrapResult.failedStage ? ` at stage '${bootstrapResult.failedStage}'` : ''}: ` +
          `${bootstrapResult.error || 'unknown error'}. ` +
          `Check ${path.join(HERMES_HOME, 'logs', 'desktop.log')} for the full transcript.`
      ) as any

      bootstrapError.isBootstrapFailure = true
      bootstrapError.failedStage = bootstrapResult.failedStage || null
      // Latch the failure so subsequent startHermes() calls return this
      // same error without re-running install.ps1.  Cleared by the
      // hermes:bootstrap:reset IPC (renderer's "Reload and retry").
      bootState.bootstrapFailure = bootstrapError
      throw bootstrapError
    }

    rememberLog('[bootstrap] bootstrap complete; marker written. Re-resolving backend.')

    // V3-RT M1: the installer's outputs are recorded right after it ran (the closed world the next spawn checks).
    if (IS_PACKAGED) {
      try {
        sealInstalledDependencies(ACTIVE_HERMES_ROOT, freshDependencies)
      } catch (error) {
        const sealError = new Error((error as Error).message) as any

        sealError.isBootstrapFailure = true
        sealError.failedStage = 'record-environment'
        bootState.bootstrapFailure = sealError
        throw sealError
      }
    }

    // Re-resolve now that the install exists. The new resolution lands in
    // step 3 (bootstrap-complete marker) and we recurse to wire venvPython.
    return ensureRuntime(resolveHermesBackend(backend.args))
  }

  // bootstrap=true with a real backend (createActiveBackend path) means we
  // have a checkout and need to ensure the venv-derived Python command is
  // wired into the backend before launch. Same code path the old factory
  // sync flow exited through, minus all the factory/pip/marker machinery
  // (install.ps1 owns those concerns now and the bootstrap-complete marker
  // attests they ran successfully).
  if (!isHermesSourceRoot(ACTIVE_HERMES_ROOT)) {
    throw new Error(
      `Hermes install at ${ACTIVE_HERMES_ROOT} is missing or incomplete. ` +
        'Reinstall via the desktop installer or scripts/install.ps1.'
    )
  }

  // On Windows, preflight Git Bash. Hermes' terminal tool calls bash.exe
  // directly (tools/environments/local.py); without it the agent can't run
  // terminal commands. install.ps1's Stage-Git puts PortableGit at
  // %LOCALAPPDATA%\hermes\git\, which findGitBash() picks up, so for any
  // user who completed the bootstrap this is a no-op. For users who got
  // here via an external `hermes` on PATH, this check still helps.
  if (IS_WINDOWS && !findGitBash()) {
    throw new Error(
      'Git for Windows is required for Hermes on Windows (provides Git Bash, ' +
        "which the agent's terminal tool uses). Install it from " +
        'https://git-scm.com/download/win or run `winget install -e --id Git.Git`, ' +
        'then relaunch Hermes.'
    )
  }

  const venvRoot = activeVenvRoot()
  const venvPython = getVenvPython(venvRoot)

  if (!fileExists(venvPython)) {
    // No venv at the expected location AND no bootstrap-needed sentinel
    // means we have a half-installed checkout: .git exists, source files
    // exist, but venv is missing or broken. This shouldn't happen in
    // normal flow because activeRuntimeState() requires isHermesSourceRoot()
    // plus an importable hermes_cli before it hands back the active runtime.
    // If we hit this, the user (or a deleted venv) broke the invariant; tell
    // them to re-run the install.
    throw new Error(
      `Hermes venv missing at ${venvRoot}. Re-run the desktop installer or ` + '`scripts/install.ps1` to rebuild it.'
    )
  }

  const runnable = Object.assign(backend, {
    command: getVenvPython(venvRoot),
    label: `Hermes at ${ACTIVE_HERMES_ROOT} (venv: ${venvRoot})`
  })

  updateBootProgress({
    phase: 'runtime.ready',
    message: 'Hermes runtime is ready',
    progress: 82,
    running: true,
    error: null
  })

  return runnable
}

/**
 * Save (create or edit) a registry connection from a renderer payload.
 * Edits merge over the stored entry (mergeConnectionInput) so fields the
 * editor doesn't carry — cloud `org`, ssh `remoteHermesPath`/`remoteProfile` —
 * survive a rename. Token handling mirrors coerceDesktopConnectionConfig: an
 * incoming plaintext token is encrypted (honoring the same allowPlainTextToken
 * opt-in seam as Settings → Gateway); an absent token field inherits the
 * stored envelope on edit; switching auth away from 'token' clears it
 * (normalizeConnectionInput drops tokens on non-token entries).
 */
export async function saveRegistryConnection(input: any = {}) {
  const registry = readDesktopConnectionsRegistry()
  const existing = input.id ? registry.connections.find(c => c.id === input.id) : null
  const incomingToken = typeof input.token === 'string' ? input.token.trim() : ''

  const token = resolvePersistedRemoteToken({
    incomingToken,
    persistToken: true,
    existingToken: existing?.token,
    allowPlainText: input.allowPlainTextToken,
    encryptSecret: encryptDesktopSecret
  })

  // Extra gateway headers arrive as plaintext strings from the editor (or
  // envelopes from a hand-edited import). Encrypt plaintext values the same
  // way tokens are stored; a null/empty value drops that header. An absent
  // `headers` field inherits the stored set via mergeConnectionInput.
  const headers =
    input.headers && typeof input.headers === 'object'
      ? encryptIncomingRemoteHeaders(input.headers, existing?.headers, {
          allowPlainText: input.allowPlainTextToken
        })
      : input.headers

  const merged = mergeConnectionInput({ ...input, token, headers }, existing)
  const entry = normalizeConnectionInput(merged, registry)

  // Token-auth remotes must actually have a token to be dialable. OAuth and
  // cloud entries authenticate via cookies/native tokens instead.
  if (entry.kind === 'remote' && entry.authMode !== 'oauth' && !decryptDesktopSecret(entry.token)) {
    throw new Error('Remote gateway session token is required.')
  }

  if (existing && connectionDialFieldsChanged(existing, entry)) {
    managedConnectionUpdateGate.assertCanMutate(entry.id)
  }

  writeDesktopConnectionsRegistry(upsertConnection(registry, entry))

  // A dial-material edit (endpoint/auth/ssh routing — NOT a label rename)
  // leaves pooled backends under `conn:<id>::*` and renderer sockets pointing
  // at the OLD target while the UI shows the new one. Recycle them: stop this
  // connection's pooled backends/tunnels and tell renderers to dispose+redial
  // their secondaries for this connection id.
  if (existing && connectionDialFieldsChanged(existing, entry)) {
    await stopRegistryConnectionBackends(entry.id)
    broadcastConnectionsChanged({ connectionId: entry.id, reason: 'updated' })
  } else {
    // Every OTHER successful save (a brand-new connection, a label rename)
    // must still republish the registry snapshot, or windows that didn't
    // perform the save — and the switcher menu fed by $connectionsRegistry —
    // keep painting the stale list until reload (#95393). 'saved' is a pure
    // registry-refresh signal: no sockets moved, so listeners must not
    // dispose or redial anything for it.
    broadcastConnectionsChanged({ connectionId: entry.id, reason: 'saved' })
  }

  return sanitizeRegistryConnection(entry)
}

// Stop every pooled backend and ssh scope owned by a registry connection —
// called when the connection is removed from the registry.
export async function stopRegistryConnectionBackends(connectionId: string) {
  const prefix = backendScopePrefix(connectionId)

  for (const key of [...backendPool.keys()]) {
    if (String(key).startsWith(prefix)) {
      stopPoolBackend(key)
    }
  }

  const sshScopes = new Set([
    ...[...sshConnections.keys()].filter(scope => String(scope).startsWith(prefix)),
    ...[...sshBootstrapCoordinator.active].map(entry => entry.scope).filter(scope => String(scope).startsWith(prefix))
  ])

  await Promise.all(
    [...sshScopes].map(async scope => {
      await sshBootstrapCoordinator.cancelAndWait(scope)
      await teardownSshConnection(scope)
    })
  )
}

// Mark a pool profile as recently used so the idle reaper spares it. The
// renderer calls this when it opens a profile's chat WS and periodically while
// streaming, since the main process can't see the direct renderer↔backend WS.
export function touchPoolBackend(profile: unknown) {
  for (const key of poolTouchKeys(profile)) {
    const entry = backendPool.get(key)

    if (entry) {
      entry.lastActiveAt = Date.now()

      return
    }
  }
}

// Evict least-recently-used SPAWNED pool backends until at most `keep` remain —
// but only ever evict backends without a live renderer socket (stale beyond the
// keepalive window). When every backend is actively kept alive we let the pool
// exceed the soft cap rather than kill a running session. Process-less
// descriptor entries (remote/cloud registry sources, per-profile remote
// overrides — `entry.process === null`) are excluded from the cap entirely:
// they hold no local process, so counting them used to let a roster refresh
// across N registered remote connections LRU-evict a REAL local backend that
// was merely idle past the keepalive window. Descriptors are still reclaimed
// by the idle reaper.
export function evictLruPoolBackends(keep: number) {
  const evictions = selectPoolEvictions(backendPool.entries(), Math.max(0, keep), Date.now(), POOL_KEEPALIVE_FRESH_MS)

  for (const profile of evictions) {
    rememberLog(`Evicting idle profile backend "${profile}" (LRU cap ${POOL_MAX_BACKENDS})`)
    stopPoolBackend(profile)
  }
}

export function startPoolIdleReaper() {
  if (poolIdleReaper) {
    return
  }

  poolIdleReaper = setInterval(() => {
    const now = Date.now()

    for (const [profile, entry] of [...backendPool.entries()]) {
      if (now - (entry.lastActiveAt || 0) > POOL_IDLE_MS) {
        rememberLog(`Reaping idle profile backend "${profile}" (idle > ${Math.round(POOL_IDLE_MS / 1000)}s)`)
        stopPoolBackend(profile)
      }
    }

    if (backendPool.size === 0 && poolIdleReaper) {
      clearInterval(poolIdleReaper)
      poolIdleReaper = null
    }
  }, 60_000)

  if (typeof poolIdleReaper.unref === 'function') {
    poolIdleReaper.unref()
  }
}

// Bounded, deduplicated pool teardown (see pool-stop.ts): every stop path —
// idle reaper, LRU eviction, profile delete/rename, quit — shares one
// in-flight stop per key and retains the process handle until the bounded
// SIGTERM -> SIGKILL escalation in waitForBackendExit() resolves. Previously
// SIGTERM + immediate entry delete dropped the handle and a slow child
// survived detached under PID 1.
export const poolStopper = createPoolStopper({
  pool: backendPool,
  // pool-stop types the handle as unknown; the pool only ever stores spawn() handles (PoolEntry.process).
  stopChild: child => stopBackendChild(child as OwnedBackendChild | null),
  waitForExit: child => waitForBackendExit(child as OwnedBackendChild | null)
})

export function stopPoolBackend(profile: string) {
  return poolStopper.stop(profile)
}

export async function teardownPoolBackendAndWait(profile: unknown) {
  await Promise.all(localProfilePoolKeys(profile).map(key => poolStopper.stop(key)))
}

function stopAllPoolBackends() {
  return poolStopper.stopAll()
}

export const backendShutdown = createBackendShutdownCoordinator(async () => {
  const primary = backendConnectionState.invalidate()

  stopBackendChild(primary)
  const pooledStops = stopAllPoolBackends()

  if (poolIdleReaper) {
    clearInterval(poolIdleReaper)
    poolIdleReaper = null
  }

  await Promise.all([waitForBackendExit(primary), pooledStops])
})

export async function exitAfterBackendShutdown(code: number | undefined) {
  await backendShutdown.run()
  app.exit(code)
}

lateBound.exitAfterBackendShutdown = exitAfterBackendShutdown

// Returns the profile name whose backend was torn down, or null when the
// request is not a profile-delete.  The caller uses this to skip ensureBackend
// for the just-torn-down profile — otherwise ensureBackend respawns a pool
// backend whose ensure_hermes_home() recreates the deleted profile directory.
//
// The routing *decision* (which branch fires, what profile name gets
// returned) lives in the pure decideProfileDeleteAction() in
// profile-delete-routing.ts; this function only performs the side effects
// that decision calls for.
export async function prepareProfileDeleteRequest(request: Parameters<typeof profileNameFromDeleteRequest>[0]) {
  const profile = profileNameFromDeleteRequest(request)

  const decision = decideProfileDeleteAction(profile, {
    isDefaultProfile: p => p === 'default',
    isValidProfileName: p => PROFILE_NAME_RE.test(p),
    primaryProfileKey
  })

  if (decision.action === 'noop') {
    return null
  }

  if (decision.action === 'teardown-primary') {
    writeActiveDesktopProfile('default')
    await Promise.all([teardownPrimaryBackendAndWait(), teardownPoolBackendAndWait(decision.profile)])

    return decision.profile
  }

  await teardownPoolBackendAndWait(decision.profile)

  return decision.profile
}

// Pooled remote descriptors get the same treatment as the primary: they have no
// child process to signal their host's death, and the renderer's keepalive touch
// spares them from the idle reaper, so nothing else can retire a dead one.
export function revalidatePool() {
  return revalidatePooledRemoteBackends({
    entries: backendPool.entries(),
    log: rememberLog,
    probe: (connection, path, options) => fetchJsonForBackend(connection, path, options),
    stopBackend: stopPoolBackend,
    tracker: remoteLiveness
  })
}

// Identity for coalescing post-resume sweeps in the shared revalidation
// coordinator: overlapping resume/unlock/network-restore kicks join the one
// in-flight sweep instead of stacking probes.
export const suspectPoolSweepScope = {}
