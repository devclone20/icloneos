// Managed SSH backends: scopes, update transport and recovery.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createBackendOutputTail } from '../backend-claim'
import { waitForDashboardPortAnnouncement } from '../backend-ready'
import { normalizeSshConfig, normAuthMode } from '../connection-config'
import { backendScopeKey, backendScopePrefix } from '../connection-registry'
import { adoptServedDashboardToken } from '../dashboard-token'
import { resolveDesktopRemoteRoute } from '../desktop-remote-route'
import { probeGatewayWebSocket } from '../gateway-ws-probe'
import { consentEnv } from '../iclone-consent'
import { managedSshScopeRole, type RemoteUpdateTarget, waitForManagedSshBootstrapFence } from '../managed-ssh-update'
import { codePathEnv } from '../packaged-env'
import { parentWatchdogEnv } from '../parent-process-identity'
import { assertLocalProfileCanStart } from '../profile-delete-routing'
import * as remoteLifecycle from '../remote-lifecycle'
import { createSshProbeConnection } from '../ssh-connection'
import { waitForUpdateClearance } from '../update-gate'
import { hiddenWindowsChildOptions } from '../windows-child-options'
import {
  detectRemotePlatform,
  probeWindowsRemote,
  terminateOwnedWindowsDashboardForUpdate
} from '../windows-remote-lifecycle'

import { claimBackendChild, primaryProfileKey } from './backend'
import { desktopParentStartMarker, reapOrphanedBackendsOnce, releaseBackendChild } from './backend-ownership'
import { ensureRuntime, startPoolIdleReaper } from './backend-pool'
import { type ProbeWebSocketImpl, waitForHermes } from './backend-readiness'
import {
  type BackendConnection,
  backendConnectionState,
  backendPool,
  type PoolEntry,
  profileDeletionGate
} from './backend-state'
import type { RegistryEntry, SshConnectionEntry } from './connection-config'
import { readDesktopConnectionConfig, readDesktopConnectionsRegistry, sshConnections } from './connection-config'
import { directoryExists, HERMES_HOME } from './env'
import { getBackendArgsForRuntime } from './executables'
import { prepareHermesSpawn } from './iclone-gate'
import { hermesLog, rememberLog } from './log'
import {
  managedConnectionUpdateGate,
  managedPrimaryRestoreOwners,
  sshBootstrapCoordinator,
  sshRememberLog,
  sshScopeKey
} from './managed-ssh'
import type { RemoteSshConfig } from './remote'
import { bootstrapSshConnection, buildRemoteConnection } from './remote'
import { makeDashboardReadyFile, resolveHermesCwd, resolveWebDist } from './runtime'
import { decryptDesktopSecret } from './secrets'
import { lateBound } from './state'
import {
  ensureRuntimeUpdateCheckOff,
  resolveHermesBackend,
  UPDATE_WAIT_POLL_MS,
  UPDATE_WAIT_TIMEOUT_MS,
  updateGateDeps,
  verifyCuratedHealthCommit
} from './updates'
import { getWindowState } from './window-events'

// Resolve the remote backend for a given profile, or null when that profile
// should run a LOCAL backend. Precedence:
//   1. explicit per-profile remote override (connection.json `profiles[name]`)
//   2. env override (HERMES_DESKTOP_REMOTE_URL/_TOKEN) — applies app-wide
//   3. global remote (connection.json `mode: 'remote'`)
// A null/empty profile resolves the env/global remote, so legacy callers and
// the connection test (which pass no profile) are unchanged.
export async function resolveRemoteBackend(
  profile: string | null,
  options: { poolKey?: string; primary?: boolean } = {}
) {
  const profileKey = String(profile || '').trim() || 'default'

  const managedPrimary = options.primary
    ? [...managedPrimaryRestoreOwners.values()].find(owner => owner.profile === profileKey)
    : null

  if (managedPrimary) {
    // A managed update is restoring the primary: dial the exact connection
    // snapshot the transaction captured, not whatever routing says now.
    const source = managedPrimary.source
    const sshConfig = managedSshConfig(source, profileKey)

    if (!sshConfig) {
      throw new Error(`SSH connection "${source.label}" has no host configured.`)
    }

    managedConnectionUpdateGate.assertCanDial(source.id, managedPrimary.correlationId)

    const currentRoute = resolveDesktopRemoteRoute({
      config: readDesktopConnectionConfig(),
      env: {
        token: codePathEnv('HERMES_DESKTOP_REMOTE_TOKEN'), // iclone-seam: p7-env
        url: codePathEnv('HERMES_DESKTOP_REMOTE_URL')
      },
      profile: profileKey,
      registry: readDesktopConnectionsRegistry()
    })

    const persistenceSource =
      currentRoute?.kind === 'ssh' && currentRoute.connectionId === source.id
        ? currentRoute.source
        : `registry:${source.id}`

    const connection = await bootstrapSshConnection(
      persistenceSource === 'profile' ? profileKey : null,
      sshConfig,
      decryptDesktopSecret(source.token),
      persistenceSource,
      undefined,
      {
        managedScope: 'primary',
        managedUpdateCorrelation: managedPrimary.correlationId,
        primaryRegistryScope: true,
        registryConnectionId: source.id
      }
    )

    return { ...connection, connectionId: source.id }
  }

  const config = readDesktopConnectionConfig()

  const route = resolveDesktopRemoteRoute({
    config,
    env: {
      token: codePathEnv('HERMES_DESKTOP_REMOTE_TOKEN'), // iclone-seam: p7-env
      url: codePathEnv('HERMES_DESKTOP_REMOTE_URL')
    },
    profile,
    registry: readDesktopConnectionsRegistry()
  })

  if (!route) {
    return null
  }

  let connection

  if (route.kind === 'ssh') {
    if (route.connectionId) {
      managedConnectionUpdateGate.assertCanDial(route.connectionId)
    }

    connection = await bootstrapSshConnection(
      route.source === 'profile' ? profile : null,
      route.ssh,
      decryptDesktopSecret(route.token),
      route.source,
      undefined,
      {
        managedScope: options.primary ? 'primary' : options.poolKey ? 'pool' : 'transient',
        poolKey: options.poolKey || '',
        primaryRegistryScope: options.primary === true && Boolean(route.connectionId),
        registryConnectionId: route.connectionId || ''
      }
    )
  } else {
    const token =
      route.authMode === 'oauth'
        ? null
        : route.source === 'env'
          ? (route.token as string | undefined) // backend.ts builds the env route from codePathEnv
          : decryptDesktopSecret(route.token)

    connection = await buildRemoteConnection(
      route.url,
      route.authMode,
      token,
      route.source,
      undefined,
      route.kind === 'cloud' ? 'cloud' : 'url',
      undefined,
      route.headers
    )
  }

  return route.connectionId ? { ...connection, connectionId: route.connectionId } : connection
}

// Dial a non-local registry connection for one profile. Never spawns a local
// child (entry.process stays null — stopPoolBackend/evict already tolerate
// that shape from remote per-profile overrides).
export async function connectRegistryBackend(
  source: RegistryEntry,
  profile: string | null | undefined,
  key: string,
  poolEntry: PoolEntry,
  resolvedSshConfig?: RemoteSshConfig | null,
  resolvedEffectiveFingerprint?: null | Promise<string>,
  managedUpdateCorrelation = '',
  tokenPersistenceSource = ''
): Promise<BackendConnection> {
  const profileKey = String(profile ?? '').trim() || 'default'

  if (source.kind === 'ssh') {
    // The composite key doubles as the ssh scope so each (connection, profile)
    // pair owns its own tunnel + remote dashboard; the profile that re-homes
    // the REMOTE process is the entry's remoteProfile or the requested one —
    // never the composite string.
    const sshConfig = resolvedSshConfig

    if (!sshConfig) {
      throw new Error(`SSH connection "${source.label}" has no host configured.`)
    }

    const connection = await bootstrapSshConnection(
      key,
      sshConfig,
      decryptDesktopSecret(source.token),
      tokenPersistenceSource || `registry:${source.id}`,
      resolvedEffectiveFingerprint ? await resolvedEffectiveFingerprint : undefined,
      {
        managedScope: 'pool',
        managedUpdateCorrelation,
        poolKey: key,
        registryConnectionId: source.id
      }
    )

    poolEntry.remoteBaseUrl = connection.baseUrl

    return {
      ...connection,
      profile: profileKey,
      connectionId: source.id,
      // The remote process runs as this profile; the desktop-side profile key
      // is only the routing label. hermes:api uses it to translate explicit
      // self-profile query filters into the backend's namespace.
      remoteProfile: sshConfig.remoteProfile || '',
      logs: hermesLog.slice(-80),
      ...getWindowState()
    }
  }

  // remote / cloud: one gateway host serves every profile of that source,
  // scoped per request — the descriptor carries the profile + connectionId so
  // renderer-side WS minting and REST scoping target the right agent.
  const token = source.authMode === 'oauth' ? null : decryptDesktopSecret(source.token)

  const connection = await buildRemoteConnection(
    source.url,
    normAuthMode(source.authMode),
    token,
    `registry:${source.id}`,
    undefined,
    source.kind === 'cloud' ? 'cloud' : 'url',
    undefined,
    source.headers
  )

  await waitForHermes(connection.baseUrl, connection.token, undefined, connection.authMode, connection.headers)
  poolEntry.remoteBaseUrl = connection.baseUrl

  return {
    ...connection,
    profile: profileKey,
    connectionId: source.id,
    // One host, many profiles: REST paths must carry ?profile= (same contract
    // as the global-remote shared-primary route).
    sharedRemote: true,
    logs: hermesLog.slice(-80),
    ...getWindowState()
  }
}

// Restore one scope while its connection-wide managed-update gate is still
// held. The caller supplies the connection snapshot captured before drain so
// a Settings edit during a long update cannot silently reconnect the old
// session to a different host or token context.
export async function ensureManagedSshBackend(source: RegistryEntry, profile: string, correlationId: string) {
  return ensureManagedSshBackendAtKey(source, profile, backendScopeKey(source.id, profile), correlationId)
}

export async function ensureManagedSshBackendAtKey(
  source: RegistryEntry,
  profile: string,
  key: string,
  correlationId: string,
  tokenPersistenceSource = ''
) {
  managedConnectionUpdateGate.assertCanDial(source.id, correlationId)
  const existing = backendPool.get(key)

  if (existing) {
    existing.lastActiveAt = Date.now()

    return existing.connectionPromise
  }

  const entry: PoolEntry = {
    process: null,
    port: null,
    token: null,
    connectionPromise: null,
    lastActiveAt: Date.now(),
    remoteBaseUrl: null
  }

  entry.connectionPromise = connectRegistryBackend(
    source,
    profile,
    key,
    entry,
    managedSshConfig(source, profile),
    null,
    correlationId,
    tokenPersistenceSource
  ).catch(error => {
    if (backendPool.get(key) === entry) {
      backendPool.delete(key)
    }

    throw error
  })
  backendPool.set(key, entry)
  startPoolIdleReaper()

  return entry.connectionPromise
}

function managedSshConfig(source: Record<string, unknown>, profile = '') {
  const profileKey = String(profile ?? '').trim() || 'default'

  return normalizeSshConfig({
    mode: 'ssh',
    host: source.host,
    user: source.user,
    port: source.port,
    keyPath: source.keyPath,
    remoteHermesPath: source.remoteHermesPath,
    remoteProfile: source.remoteProfile || (profileKey === 'default' ? '' : profileKey)
  })
}

/** A managed-SSH scope captured for a connection update: its pool entry, live state and drain/restore bookkeeping. */
export interface ManagedSshScope {
  drained: boolean
  entry: Pick<PoolEntry, 'connectionPromise'>
  forwardRestored: boolean
  key: string
  primary?: boolean
  profile: string
  registryScoped?: boolean
  reuseToken: string
  state: SshConnectionEntry | null
  unsafeDrainFailure: boolean
}

export async function captureManagedSshScopes(source: RegistryEntry): Promise<ManagedSshScope[]> {
  const prefix = backendScopePrefix(source.id)
  const config = readDesktopConnectionConfig()
  const registry = readDesktopConnectionsRegistry()

  const routeForProfile = (profile: string) =>
    resolveDesktopRemoteRoute({
      config,
      env: {
        token: codePathEnv('HERMES_DESKTOP_REMOTE_TOKEN'), // iclone-seam: p7-env
        url: codePathEnv('HERMES_DESKTOP_REMOTE_URL')
      },
      profile,
      registry
    })

  const pooled = [...backendPool.entries()]
    .filter(([key]) => {
      const state = sshConnections.get(key)
      const route = routeForProfile(String(key))

      return (
        managedSshScopeRole({
          connectionId: source.id,
          key: String(key),
          prefix,
          routeConnectionId: route?.kind === 'ssh' ? route.connectionId : '',
          state
        }) === 'pool'
      )
    })
    .map(([key, entry]): ManagedSshScope => ({
      drained: false,
      entry,
      forwardRestored: false,
      key,
      profile: String(key).startsWith(prefix) ? String(key).slice(prefix.length) || 'default' : String(key),
      registryScoped: String(key).startsWith(prefix),
      reuseToken: '',
      state: null,
      unsafeDrainFailure: false
    }))

  const pooledKeys = new Set(pooled.map(scope => scope.key))

  const primary = [...sshConnections.entries()]
    .filter(
      ([key, state]) =>
        !pooledKeys.has(key) &&
        managedSshScopeRole({ connectionId: source.id, key: String(key), prefix, state }) === 'primary'
    )
    .map(([key, state]): ManagedSshScope => ({
      drained: false,
      entry: { connectionPromise: backendConnectionState.getPromise() },
      forwardRestored: false,
      key,
      primary: true,
      profile: String(primaryProfileKey() || 'default'),
      reuseToken: '',
      state,
      unsafeDrainFailure: false
    }))

  const primaryPromise = backendConnectionState.getPromise()
  const primaryProfile = String(primaryProfileKey() || 'default')
  const primaryRoute = routeForProfile(primaryProfile)

  if (
    primary.length === 0 &&
    primaryPromise &&
    primaryRoute?.kind === 'ssh' &&
    primaryRoute.connectionId === source.id
  ) {
    primary.push({
      drained: false,
      entry: { connectionPromise: primaryPromise },
      forwardRestored: false,
      key: primaryRoute.source === 'profile' ? sshScopeKey(primaryProfile) : sshScopeKey(null),
      primary: true,
      profile: primaryProfile,
      reuseToken: '',
      state: null,
      unsafeDrainFailure: false
    })
  }

  if (primary.length > 1) {
    throw new Error('Managed SSH update found multiple primary scopes; refusing an ambiguous drain.')
  }

  const captured: any[] = [...pooled, ...primary]

  // An already-started bootstrap may not have published sshConnections yet.
  // Join every bootstrap qualified to this registry id. Its final boundary
  // rechecks the managed gate and exact-terminates any serve it created, so no
  // pre-claim dial can publish while the updater mutates the remote install.
  await waitForManagedSshBootstrapFence(sshBootstrapCoordinator.active, source.id)

  for (const scope of captured) {
    try {
      const descriptor: any = await scope.entry.connectionPromise

      // Every independently spawned profile has its own random served token.
      // Keep it on the scope—not one mutable connection snapshot—so restore
      // can authenticate/reuse the exact process it captured.
      scope.reuseToken = String(descriptor?.token || '')
    } catch (error: any) {
      if (error?.unsafeManagedBootstrap === true) {
        throw error
      }
      // A still-pending pooled scope remains part of the restore worklist even
      // if its original dial loses the race with the update gate.
    }

    scope.state = sshConnections.get(scope.key) || null
  }

  return captured
}

export function remoteUpdateTargetFromState(state: SshConnectionEntry | null | undefined): RemoteUpdateTarget {
  if (!state?.ssh || !state?.hermesPath || !state?.hermesHome) {
    throw new Error('The managed SSH scope does not carry a complete remote runtime identity.')
  }

  if (!['Darwin', 'Linux', 'Windows'].includes(state.remotePlatform)) {
    throw new Error(`Unsupported managed SSH update platform: ${state.remotePlatform || 'unknown'}.`)
  }

  return {
    ssh: state.ssh,
    platform: state.remotePlatform,
    hermesPath: state.hermesPath,
    hermesHome: state.hermesHome,
    ...(state.pythonPath ? { pythonPath: state.pythonPath } : {})
  }
}

export async function openManagedSshUpdateTransport(
  source: Record<string, unknown>
): Promise<{ close: () => Promise<void>; target: RemoteUpdateTarget }> {
  const config = managedSshConfig(source)

  if (!config) {
    throw new Error(`SSH connection "${source.label}" has no host configured.`)
  }

  const ssh = createSshProbeConnection(
    { host: config.host, user: config.user, port: config.port, keyPath: config.keyPath },
    { rememberLog: sshRememberLog }
  )

  await ssh.open()

  try {
    const platform: any = await detectRemotePlatform(ssh, config.remoteHermesPath || '')

    if (platform.os === 'Windows') {
      const runtime = platform.hermesPath ? platform : await probeWindowsRemote(ssh, config.remoteHermesPath || '')

      return {
        close: () => ssh.close(),
        target: {
          ssh,
          platform: 'Windows',
          hermesPath: runtime.hermesPath,
          hermesHome: runtime.hermesHome,
          pythonPath: runtime.python
        }
      }
    }

    const hermesPath = await remoteLifecycle.locateHermes(ssh, config.remoteHermesPath || '')
    const hermesHome = await remoteLifecycle.probeRemoteHermesHome(ssh)

    return {
      close: () => ssh.close(),
      target: { ssh, platform: platform.os, hermesPath, hermesHome }
    }
  } catch (error) {
    await ssh.close()
    throw error
  }
}

export async function drainManagedSshScope(scope: ManagedSshScope) {
  const state = scope.state
  let forwardClosed = false

  try {
    if (!state) {
      return
    }

    lateBound.terminalIpc?.disposeTerminalSessionsForSshScope(scope.key)

    if (state.localPort && state.remotePort) {
      await state.ssh.cancelForward(state.localPort, state.remotePort)
      forwardClosed = true
    }

    const expected = {
      ownershipId: state.ownershipId,
      pid: state.pid,
      spawnNonce: state.spawnNonce,
      profile: state.remoteProfile || '',
      hermesPath: state.hermesPath,
      hermesHome: state.hermesHome,
      startedAt: state.startedAt,
      creationTimeNs: state.creationTimeNs,
      creationTime: state.creationTime
    }

    if (state.remotePlatform === 'Windows') {
      await terminateOwnedWindowsDashboardForUpdate(
        state.ssh,
        { hermesPath: state.hermesPath, hermesHome: state.hermesHome, python: state.pythonPath },
        expected
      )
    } else if (state.remotePlatform === 'Linux' || state.remotePlatform === 'Darwin') {
      await remoteLifecycle.terminateOwnedDashboardForUpdate(state.ssh, expected)
    } else {
      throw new Error(`Unsupported managed SSH update platform: ${state.remotePlatform || 'unknown'}.`)
    }
  } catch (error: any) {
    // Ownership refusal is a no-kill result. Keep the original pool/state and
    // restore its exact forward in place; routing it through generic stale
    // cleanup could discard the create-time fence that just refused the kill.
    scope.unsafeDrainFailure = true

    if (state && state.localPort && state.remotePort && scope.reuseToken) {
      try {
        // A failed cancel may mean the old tunnel is still healthy. Prove that
        // exact token first; only recreate the forward when cancellation was
        // confirmed, avoiding a duplicate-bind attempt that masks recovery.
        if (!forwardClosed) {
          await waitForHermes(`http://127.0.0.1:${state.localPort}`, scope.reuseToken, undefined, 'token')
        } else {
          await state.ssh.forward(state.localPort, state.remotePort)
          await waitForHermes(`http://127.0.0.1:${state.localPort}`, scope.reuseToken, undefined, 'token')
        }

        scope.forwardRestored = true
      } catch (restoreError: any) {
        error.message = `${error.message} The original forward also failed to recover: ${restoreError?.message || restoreError}`
      }
    }

    throw error
  } finally {
    if (!scope.unsafeDrainFailure) {
      scope.drained = true

      if (scope.primary) {
        backendConnectionState.invalidate()
      } else if (backendPool.get(scope.key) === scope.entry) {
        backendPool.delete(scope.key)
      }

      if (state && sshConnections.get(scope.key) === state) {
        sshConnections.delete(scope.key)
      }
    }
  }
}

// Spawn an additional dashboard backend pinned to a named profile. Mirrors the
// local-spawn portion of startHermes() but without the boot-progress UI,
// bootstrap, or remote handling (those belong to the primary backend only).
// `opts.forceLocal` skips remote resolution entirely (the registry 'local'
// entry means THIS machine regardless of the v1 routing table); `opts.poolKey`
// is the backendPool key when it differs from the profile name (composite
// registry scopes) so the exit/error cleanup evicts the right entry.
export async function spawnPoolBackend(
  profile: string,
  entry: PoolEntry,
  opts: { forceLocal?: boolean; poolKey?: string } = {}
): Promise<BackendConnection> {
  const poolKey = opts.poolKey || profile

  await reapOrphanedBackendsOnce()
  profileDeletionGate.assertCanStart(profile)

  // A profile may point at its OWN remote backend (connection.json
  // `profiles[name]`), or inherit the app-wide remote (env / global settings).
  // In either case there is no local child to spawn — we just verify the
  // remote is reachable and hand back its connection descriptor. The pool
  // entry keeps `entry.process === null`, which stopPoolBackend/evict already
  // tolerate.
  const remote = opts.forceLocal ? null : await resolveRemoteBackend(profile, { poolKey })
  profileDeletionGate.assertCanStart(profile)

  if (remote) {
    await waitForHermes(remote.baseUrl, remote.token, undefined, remote.authMode, remote.headers)

    // Recorded on the entry so revalidation can probe this descriptor without
    // awaiting connectionPromise, which may still be pending for a sibling.
    entry.remoteBaseUrl = remote.baseUrl

    return {
      ...remote,
      profile,
      logs: hermesLog.slice(-80),
      ...getWindowState()
    }
  }

  const token = crypto.randomBytes(32).toString('base64url')

  // Same update mutual exclusion as the primary window's waitForLocalStart
  // (#73822): pool backends spawn from the same venv, so an ungated respawn
  // during applyUpdates' critical section re-locks the venv and trips the
  // venv-blocker preflight. No boot-progress UI here — pool backends boot
  // silently for background profiles — so we only log while parked.
  {
    let poolAnnounced = false

    await waitForUpdateClearance(updateGateDeps(), {
      onWaitTick: reason => {
        if (!poolAnnounced) {
          poolAnnounced = true
          rememberLog(`[updates] update in progress (${reason}); deferring pool backend start for profile "${profile}"`)
        }
      },
      pollMs: UPDATE_WAIT_POLL_MS,
      timeoutMs: UPDATE_WAIT_TIMEOUT_MS
    })
  }

  profileDeletionGate.assertCanStart(profile)

  // --profile wins over the inherited HERMES_HOME env (see _apply_profile_override
  // step 3 in hermes_cli/main.py), so the child re-homes to this profile.
  // --port 0: the OS assigns an ephemeral port; the child announces it on stdout.
  const backendArgs = ['--profile', profile, 'serve', '--host', '127.0.0.1', '--port', '0']
  const backend = await ensureRuntime(resolveHermesBackend(backendArgs))
  await ensureRuntimeUpdateCheckOff(profile) // iclone-seam: r1-config — updates.check off → spawn
  // Route old runtimes (no `serve`) through the legacy `dashboard --no-open`.
  backend.args = getBackendArgsForRuntime(backend)
  const hermesCwd = resolveHermesCwd()
  const webDist = resolveWebDist()
  const readyFile = backend.readyFile ? makeDashboardReadyFile() : null

  // Guard BEFORE the "Starting" line: a profile that only exists on a remote
  // backend (remote-primary desktop asked for a forced-local child) rejects
  // here, and logging "Starting" first left an orphaned line with no READY
  // and no exit — the exact undiagnosable burst signature in remote-gateway
  // user bundles (Aug 2026, Dash's report).
  assertLocalProfileCanStart(profile, profileDeletionGate, key =>
    directoryExists(path.join(HERMES_HOME, 'profiles', key))
  )

  // V3-S r2 (M1): the same preparation as the primary — the iclone gate installed, verified and proven armed in this
  // runtime for THIS profile, then this spawn's key (fd 3), lock and confinement env. This backend runs the cron ticker
  // too, so without a key it is refused (`[iclone-gate]`) and nothing is spawned.
  const gated = await prepareHermesSpawn({ backend, cwd: hermesCwd, profile, role: 'pool' })

  rememberLog(`Starting Hermes backend for profile "${profile}" via ${backend.label}`)

  const parentStartMarker = await desktopParentStartMarker()
  const backendNonce = crypto.randomBytes(16).toString('hex')
  const parentIdentityEnv = parentWatchdogEnv(process.pid, parentStartMarker, backendNonce)

  const child = spawn(
    backend.command,
    // V3-S r3 (m-b): `-s -P` before the backend's args (no user site, no cwd on sys.path).
    gated.argv(backend.args),
    hiddenWindowsChildOptions({
      cwd: hermesCwd,
      // V3-S r3 (m-b, m-f): sealed — inherited Python settings and foreign ICLONE_* dropped, then the gate's env
      // (V3-F lock + policy file + agent socket, V3-G confinement, the spawn's own bytecode prefix) applied LAST.
      env: gated.seal({
        ...process.env,
        HERMES_HOME,
        ...backend.env,
        ...consentEnv(),
        // Pin the gateway's tool/terminal cwd to the same directory we chose for
        // the child process. Inherited TERMINAL_CWD (or a stale config bridge)
        // can still point at the install dir even when spawn cwd is home.
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

  gated.attach(child)
  entry.process = child
  entry.token = token
  // Buffer stdout+stderr from the instant of spawn (#93608): an early crash's
  // traceback must survive into the claim error and the before-ready exit
  // message instead of a bare exit code. rememberLog attaches later, after
  // the claim, and would miss anything printed before it.
  const outputTail = createBackendOutputTail()
  outputTail.attach(child)
  await claimBackendChild(child, `${backend.command} ${backend.args.join(' ')}`, profile, backendNonce, outputTail)

  child.stdout?.on('data', rememberLog)
  child.stderr?.on('data', rememberLog)

  let ready = false
  let rejectStart: ((error: Error) => void) | null = null

  const startFailed = new Promise((_resolve, reject) => {
    rejectStart = reject
  })

  child.once('error', error => {
    rememberLog(`Hermes backend for profile "${profile}" failed to start: ${error.message}`)
    releaseBackendChild(child)
    backendPool.delete(poolKey)
    rejectStart?.(error)
  })
  child.once('exit', (code, signal) => {
    rememberLog(`Hermes backend for profile "${profile}" exited (${signal || code})`)
    releaseBackendChild(child)
    backendPool.delete(poolKey)

    if (!ready) {
      rejectStart?.(
        new Error(
          `Hermes backend for profile "${profile}" exited before it became ready (${signal || code}).${outputTail.describe()}`
        )
      )
    }
  })

  // Discover the ephemeral port the child bound to
  const port = await Promise.race([
    waitForDashboardPortAnnouncement(child, { describeOutputTail: () => outputTail.describe(), readyFile }),
    startFailed
  ])

  if (readyFile) {
    fs.unlink(readyFile, () => {})
  }

  entry.port = port

  const baseUrl = `http://127.0.0.1:${port}`
  await Promise.race([waitForHermes(baseUrl, token), startFailed])
  ready = true
  verifyCuratedHealthCommit(baseUrl)

  const authToken = await adoptServedDashboardToken(baseUrl, token, {
    childAlive: () => child.exitCode === null && !child.killed,
    label: `Hermes backend for profile "${profile}"`,
    rememberLog
  })

  entry.token = authToken

  // Verify the WebSocket session token before declaring backend ready.
  // HTTP /api/status can pass while WS auth fails (separate transport, separate guards).
  const wsUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(authToken)}`
  const wsProbe = await probeGatewayWebSocket(wsUrl, { WebSocketImpl: globalThis.WebSocket as ProbeWebSocketImpl })

  if (!wsProbe.ok) {
    throw new Error(
      `Hermes backend for profile "${profile}" is HTTP-reachable but the WebSocket (/api/ws) rejected the session token: ${wsProbe.reason}`
    )
  }

  return {
    baseUrl,
    mode: 'local',
    source: 'local',
    authMode: 'token',
    token: authToken,
    profile,
    wsUrl,
    logs: hermesLog.slice(-80),
    ...getWindowState()
  }
}
