// Ensuring the right backend for a profile, registry connection or terminal.
import path from 'node:path'

import { powerMonitor } from 'electron'

import {
  buildGatewayWsUrlWithTicket,
  connectionScopeKey,
  modeIsRemoteLike,
  normalizeRemoteBaseUrl,
  normalizeSshConfig,
  normAuthMode,
  resolveProfileBackendRoute,
  resolveTestWsUrl
} from '../connection-config'
import {
  backendScopeKey,
  parseBackendScopeKey,
  registrySourceOwnsPrimaryBackend,
  resolveRegistryLocalRoute,
  reuseMatchingPrimarySshBackend
} from '../connection-registry'
import {
  gatewayFilePath,
  gatewayFileRequestPaths,
  isNotFoundError,
  resolveGatewayFileBackend
} from '../gateway-file-download'
import { probeGatewayWebSocket } from '../gateway-ws-probe'
import { DEFAULT_FETCH_TIMEOUT_MS } from '../hardening'
import {
  assertManagedUpdatePreflightClear,
  executeManagedRemoteUpdate,
  recoverManagedSshScopes,
  type RemoteUpdateTarget,
  runManagedSshUpdate,
  waitForManagedRemoteClearance
} from '../managed-ssh-update'
import { PreviewReachRegistry } from '../preview-reach'
import { prepareProfileRenameLifecycle } from '../profile-rename-routing'
import * as remoteLifecycle from '../remote-lifecycle'
import {
  attachPowerResumeRemoteRevalidation,
  ensureHealthyPooledRemoteBackendForDispatch,
  revalidateSuspectPooledRemoteBackends
} from '../remote-liveness'
import { createSshProbeConnection, pickLocalPort } from '../ssh-connection'
import { detectRemotePlatform, helper } from '../windows-remote-lifecycle'
import { setWslBridgeProfileState } from '../wsl-path-bridge'

import {
  activeSshTerminalTarget,
  fetchJsonForBackend,
  gatewayFileRequestPath,
  primaryProfileKey,
  profileRouteOptions,
  stopBackendChild,
  teardownPrimaryBackendAndWait,
  waitForBackendExit
} from './backend'
import {
  evictLruPoolBackends,
  poolStopper,
  startPoolIdleReaper,
  stopPoolBackend,
  suspectPoolSweepScope,
  teardownPoolBackendAndWait
} from './backend-pool'
import type { ProbeWebSocketImpl } from './backend-readiness'
import {
  backendConnectionState,
  backendDialClaims,
  backendPool,
  POOL_MAX_BACKENDS,
  type PoolEntry,
  profileDeletionGate,
  registryDispatchRevalidation,
  remoteLiveness,
  remoteRevalidation,
  windowConnectionRoutes
} from './backend-state'
import type { BackendConnection } from './backend-state'
import {
  coerceDesktopConnectionConfig,
  managedConnectionRecoveries,
  managedConnectionUpdates,
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry,
  sshConnections,
  writeActiveDesktopProfile
} from './connection-config'
import type { RegistryEntry } from './connection-config'
import { PROFILE_NAME_RE } from './env'
import type { GatewayFileConnection, GatewayFileSavePayload } from './gateway-files'
import {
  downloadViaOauthSessionToFile,
  downloadViaTokenToFile,
  gatedFileAuth,
  mintGatewayWsTicket,
  saveGatewayFileViaDataUrl
} from './gateway-files'
import { fetchJson } from './http'
import { rememberLog } from './log'
import {
  clearManagedSshRecovery,
  effectiveSshConfigFingerprint,
  managedConnectionUpdateGate,
  managedPrimaryRestoreOwners,
  markManagedSshRecoveryLaunching,
  persistManagedSshRecovery,
  previewReachByWebContents,
  readManagedSshRecoveryRecords,
  resetPreviewReach,
  sshBootstrapCoordinator,
  sshRememberLog,
  teardownSshConnection
} from './managed-ssh'
import {
  captureManagedSshScopes,
  connectRegistryBackend,
  drainManagedSshScope,
  ensureManagedSshBackend,
  ensureManagedSshBackendAtKey,
  type ManagedSshScope,
  openManagedSshUpdateTransport,
  remoteUpdateTargetFromState,
  resolveRemoteBackend,
  spawnPoolBackend
} from './managed-ssh-update'
import { ensureNativeAccessToken, fetchJsonViaOauthSession } from './oauth'
import type { RemoteSshConfig } from './remote'
import { fetchConnectionStatus, globalRemoteActive, profileHasRemoteOverride } from './remote'
import { decryptDesktopSecret, decryptRemoteHeaders, encryptDesktopSecret, rememberRemoteWsHeaders } from './secrets'
import { startHermes } from './start-hermes'
import { connectionRuntimeState, windowsState } from './state'
import { broadcastBatteryState, sendPowerResume } from './window-events'

let powerResumeRegistered = false

export function registerPowerResumeListeners() {
  if (powerResumeRegistered) {
    return
  }

  powerResumeRegistered = true

  try {
    // 'resume' covers sleep/wake; 'unlock-screen' covers lock/unlock without a
    // full suspend. Either can drop an idle socket.
    powerMonitor.on('resume', sendPowerResume)
    powerMonitor.on('unlock-screen', sendPowerResume)
    powerMonitor.on('on-battery', () => broadcastBatteryState(true))
    powerMonitor.on('on-ac', () => broadcastBatteryState(false))
    connectionRuntimeState.onBatteryPower = powerMonitor.isOnBatteryPower()
    // Pooled remote/SSH backends are also suspect after a wake (#93910): the
    // renderer nudge above only re-drives the PRIMARY socket, while pooled
    // tunnels have no renderer loop of their own. Bounded + coalesced inside;
    // never a hot loop.
    attachPowerResumeRemoteRevalidation({
      log: rememberLog,
      powerMonitor,
      revalidate: () => revalidateSuspectPoolAfterResume()
    })
  } catch {
    // powerMonitor is unavailable before app 'ready' on some platforms; the
    // caller registers after 'ready', so this should not normally throw.
  }
}

export async function saveGatewayFile(payload: GatewayFileSavePayload = {}) {
  const filePath = gatewayFilePath(payload.path)

  if (!filePath) {
    throw new Error('Missing gateway file path')
  }

  const { connection, connectionId, profile } = await resolveGatewayFileBackend<GatewayFileConnection>(payload, {
    ensureLegacy: ensureBackend,
    ensureRegistry: ensureRegistryBackend
  })

  const suggested = String(payload.suggestedName || '').trim()
  const fallbackName = path.basename(filePath) || suggested || 'download'
  const ctx = { suggested, fallbackName }

  const requestPaths = gatewayFileRequestPaths(filePath, requestPath =>
    gatewayFileRequestPath(connection, connectionId, profile, requestPath)
  )

  const url = `${connection.baseUrl}${requestPaths.download}`

  try {
    const auth = await gatedFileAuth(connection)

    if (auth.kind === 'bearer') {
      return await downloadViaTokenToFile(url, auth.token, ctx, { bearer: auth.token })
    }

    if (auth.kind === 'cookie') {
      return await downloadViaOauthSessionToFile(url, ctx)
    }

    return await downloadViaTokenToFile(url, auth.token, ctx)
  } catch (error) {
    // Desktop and the remote gateway update independently. A gateway predating
    // /api/fs/download 404s here; fall back (ONLY on 404) to the older capped
    // data-URL route so downloads keep working against older backends.
    if (isNotFoundError(error)) {
      return await saveGatewayFileViaDataUrl(connection, requestPaths.dataUrl, ctx)
    }

    throw error
  }
}

// Build a fresh WS URL for the *current* connection. Critical for reconnects:
// OAuth WS tickets are single-use with a ~30s TTL, so the ticket baked into
// the cached connection's wsUrl is stale on the second connect. The renderer
// calls this immediately before every gateway.connect() so each WS upgrade
// carries a freshly-minted ticket. For local/token connections this just
// reuses the static token (no minting needed).
export async function freshGatewayWsUrl(profile: string | null | undefined) {
  // Mint for the requested profile's backend, NOT always the primary. The
  // renderer re-mints right before every gateway.connect(); when swapping to a
  // pooled profile we must return THAT backend's ws URL, otherwise the connect
  // silently lands back on the primary (default) backend and writes sessions to
  // the wrong profile's DB. A null/empty profile resolves to the primary, so
  // legacy callers and single-profile users are unchanged.
  const connection = await ensureBackend(profile)

  if (connection.authMode === 'oauth') {
    const ticket = await mintGatewayWsTicket(connection.baseUrl, connection.headers)
    const wsUrl = buildGatewayWsUrlWithTicket(connection.baseUrl, ticket)

    rememberRemoteWsHeaders(wsUrl, connection.headers)

    return wsUrl
  }

  // Local/token: the cached wsUrl already carries the (long-lived) token.
  rememberRemoteWsHeaders(connection.wsUrl, connection.headers)

  return connection.wsUrl
}

export async function ensureTerminalBackend(webContentsId: number) {
  const windowRoute = windowConnectionRoutes.get(webContentsId)

  // Claim-guarded (#90812): opening a terminal pane can race a renderer's own
  // reconnect dial for the same (connectionId, profile) scope; coalescing
  // here avoids bootstrapping a second SSH tunnel / remote dashboard.
  if (windowRoute?.registryScoped && windowRoute.connectionId) {
    return backendDialClaims.run(backendScopeKey(windowRoute.connectionId, windowRoute.profile), () =>
      ensureRegistryBackend(windowRoute.connectionId, windowRoute.profile)
    )
  }

  const profile = windowRoute?.profile ?? primaryProfileKey()

  return backendDialClaims.run(backendScopeKey(null, profile), () => ensureBackend(profile))
}

/**
 * Rewrite a gateway-loopback URL into one this machine can actually load.
 *
 * Returns the URL unchanged when no rewrite is needed or possible — a local
 * backend (the address is already true), a non-loopback host, or a url/cloud
 * remote with no tunnel to borrow. Callers must not treat an unchanged URL as
 * failure; the pane explains an unreachable one on its own.
 */
export async function reachablePreviewUrl(webContentsId: number, rawUrl: string): Promise<string> {
  let target = activeSshTerminalTarget(webContentsId)

  if (target === 'pending') {
    await ensureTerminalBackend(webContentsId).catch(() => undefined)
    target = activeSshTerminalTarget(webContentsId)
  }

  if (!target || target === 'pending') {
    // No SSH transport behind this renderer's gateway. Another window's
    // forward must never be reused for this preview.
    await resetPreviewReach(webContentsId)

    return rawUrl
  }

  const { scope, ssh } = target as { scope: string; ssh: any }
  let reach = previewReachByWebContents.get(webContentsId)

  if (!reach || reach.scope !== scope) {
    await resetPreviewReach(webContentsId)
    reach = { registry: new PreviewReachRegistry(), scope }
    previewReachByWebContents.set(webContentsId, reach)
  }

  try {
    const rewritten = await reach.registry.resolve(rawUrl, {
      cancel: (localPort, remotePort) => ssh.cancelForward(localPort, remotePort),
      forward: (localPort, remotePort, remoteHost) => ssh.forward(localPort, remotePort, remoteHost),
      isCurrent: () => sshConnections.get(scope)?.ssh === ssh,
      // pickLocalPort predates the typed surface here and infers `unknown`.
      pickLocalPort: () => pickLocalPort() as Promise<number>
    })

    return rewritten || rawUrl
  } catch (error: any) {
    sshRememberLog(`preview reach failed for ${rawUrl}: ${error?.message || error}`)

    return rawUrl
  }
}

// GET a profile's resolved backend (remote pool or local primary), parsed JSON.
export async function fetchJsonForProfile(profile: string | null, path: string) {
  return requestJsonForProfile(profile, path, 'GET')
}

// Issue an arbitrary method against a profile's resolved backend, parsed JSON.
export async function requestJsonForProfile(profile: string | null, path: string, method: string, body?: unknown) {
  const conn = await ensureBackend(profile)
  const url = `${conn.baseUrl}${path}`
  const opts = { method, body, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS }

  if (conn.authMode === 'oauth') {
    // Native RFC 8252 flow: authenticate with the bearer token (cookieless)
    // when we hold one for this gateway; otherwise use the cookie partition.
    const nativeAt = await ensureNativeAccessToken(conn.baseUrl).catch(() => null)

    if (nativeAt) {
      return fetchJson(url, null, { ...opts, bearer: nativeAt, headers: conn.headers })
    }

    return fetchJsonViaOauthSession(url, { ...opts, headers: conn.headers })
  }

  return fetchJson(url, conn.token, { ...opts, headers: conn.headers })
}

export async function testDesktopConnectionConfig(input: any = {}) {
  if (input.mode === 'ssh') {
    const sshConfig = normalizeSshConfig({
      mode: 'ssh',
      host: input.sshHost,
      user: input.sshUser,
      port: input.sshPort,
      keyPath: input.sshKeyPath,
      remoteHermesPath: input.sshRemoteHermesPath
    })

    if (!sshConfig) {
      return { reachable: false, sshError: 'unreachable', error: 'SSH host is required.' }
    }

    const ssh = createSshProbeConnection(
      { host: sshConfig.host, user: sshConfig.user, port: sshConfig.port, keyPath: sshConfig.keyPath },
      { rememberLog: sshRememberLog }
    )

    try {
      // One bounded retry on TIMEOUT only: a cold Windows backend's first
      // PowerShell exec can exceed the budget (observed live), and a timeout is
      // indeterminate — unlike auth/host-key/unreachable, which are verdicts.
      let attempt = 0

      for (;;) {
        try {
          await ssh.open()
          const platform: any = await detectRemotePlatform(ssh, sshConfig.remoteHermesPath || '')
          let hermesPath
          let hermesVersion
          let supported

          if (platform.os === 'Windows') {
            const runtime = platform
            hermesPath = runtime.hermesPath
            const inspection = await helper(ssh, runtime, 'inspect', [runtime.hermesPath])
            hermesVersion = inspection.version
            supported = inspection.supported
          } else {
            hermesPath = await remoteLifecycle.locateHermes(ssh, sshConfig.remoteHermesPath || '')
            hermesVersion = await remoteLifecycle.probeHermesVersion(ssh, hermesPath)
            supported = await remoteLifecycle.remoteSupportsSshOwnership(ssh, hermesPath)
          }

          if (!supported) {
            return {
              reachable: false,
              sshError: 'update-required',
              error: 'Update Hermes on the remote host before connecting with Desktop SSH.'
            }
          }

          return {
            reachable: true,
            sshError: null,
            error: null,
            remotePlatform: `${platform.os}/${platform.arch}`,
            remoteHermesPath: hermesPath,
            remoteHermesVersion: hermesVersion,
            host: sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host
          }
        } catch (error: any) {
          if (error?.kind === 'timeout' && attempt === 0) {
            attempt += 1
            sshRememberLog('[ssh] test probe timed out once; retrying')

            continue
          }

          throw error
        }
      }
    } catch (error: any) {
      return { reachable: false, sshError: error.kind || 'unknown', error: error.message }
    } finally {
      try {
        await ssh.close()
      } catch {
        void 0
      }
    }
  }

  const config = coerceDesktopConnectionConfig(input, readDesktopConnectionConfig(), { persistToken: false })
  const key = connectionScopeKey(input.profile)
  // The block under test: a per-profile entry or the global remote. Coerce has
  // already normalized the URL and resolved token inheritance for the scope.
  const block = key ? config.profiles?.[key] || null : config.remote

  const wantRemote =
    modeIsRemoteLike(block?.mode) || (!key && modeIsRemoteLike(config.mode)) || (modeIsRemoteLike(input.mode) && block)

  // Test ``/api/status`` through the connection's real auth path. Self-hosted
  // gateways may protect it, and an anonymous success/failure would not prove
  // that the OAuth cookie/native bearer or configured token is reusable. For
  // a remote config we normalize the URL from the input; for local we fall
  // back to the resolved/started backend.
  let baseUrl
  let token = null
  let authMode = 'token'
  let testHeaders = {}

  if (wantRemote && block?.url) {
    baseUrl = normalizeRemoteBaseUrl(block.url)
    authMode = normAuthMode(block.authMode)
    testHeaders = decryptRemoteHeaders(block.headers)

    if (authMode !== 'oauth') {
      token = decryptDesktopSecret(block.token)
    }
  } else {
    const remote = (await resolveRemoteBackend(key)) || (await startHermes())
    baseUrl = remote.baseUrl
    token = remote.token
    authMode = normAuthMode(remote.authMode)
    testHeaders = remote.headers || {}
  }

  const status = (await fetchConnectionStatus(baseUrl, authMode, token, testHeaders)) as any

  // The HTTP status check above proves the backend is reachable, but the chat
  // surface only works once the renderer's live WebSocket to ``/api/ws``
  // connects — a separate transport with separate server-side guards (Host/
  // Origin, ws-ticket/token auth). Validating only the HTTP side produced a
  // false-positive "reachable" while the real boot still failed with "Could not
  // connect to Hermes gateway". Mirror the renderer's connect here so the test
  // reflects the full path the app actually uses.
  const wsUrl = await resolveTestWsUrl(baseUrl, authMode, token, {
    mintTicket: (url: string) => mintGatewayWsTicket(url, testHeaders)
  })

  // Skip the WS leg only when the runtime genuinely lacks a WebSocket (so an
  // older Electron/Node never fails the test spuriously); Electron's main
  // process ships a global WebSocket on every supported version.
  if (wsUrl && typeof globalThis.WebSocket === 'function') {
    const probe = await probeGatewayWebSocket(wsUrl, {
      WebSocketImpl: globalThis.WebSocket as ProbeWebSocketImpl,
      headers: testHeaders
    })

    if (!probe.ok) {
      throw new Error(
        `Reached the gateway over HTTP, but the live WebSocket (/api/ws) connection failed: ${probe.reason} ` +
          'The HTTP check can pass while the WebSocket is blocked by a proxy, firewall, or gateway auth/origin guard.'
      )
    }
  }

  return {
    ok: true,
    baseUrl,
    version: status?.version || null
  }
}

// Resolve a backend connection for the given profile, per the routing table in
// resolveProfileBackendRoute(). An empty / unknown profile resolves to the
// primary, so legacy callers are unchanged.
export async function ensureBackend(profile: string | null | undefined) {
  const key = profile && String(profile).trim() ? String(profile).trim() : primaryProfileKey()

  profileDeletionGate.assertCanStart(key)

  const route = resolveProfileBackendRoute(key, profileRouteOptions(key))

  if (route.backend === 'primary') {
    const connection = await startHermes()
    setWslBridgeProfileState(key, connection.mode !== 'remote')

    // A shared backend still owes the caller its profile scope, so renderer-side
    // WebSocket, filesystem, and cache routing target the selected profile.
    // `sharedPrimary` marks this as the shared-primary route: pooled backends
    // also carry `profile`, so only this descriptor gets the flag.
    return route.descriptorProfile
      ? { ...connection, profile: route.descriptorProfile, sharedPrimary: true }
      : connection
  }

  // A backend for this key may still be dying (idle reap, LRU eviction, a
  // just-finished delete). Wait for its bounded exit before reusing or
  // spawning, so two children never share one profile's HERMES_HOME.
  const stopping = poolStopper.inFlight(key)

  if (stopping) {
    await stopping
  }

  const existing = backendPool.get(key)

  if (existing?.connectionPromise) {
    existing.lastActiveAt = Date.now()
    const connection = await existing.connectionPromise
    setWslBridgeProfileState(key, connection.mode !== 'remote')

    return connection
  }

  evictLruPoolBackends(POOL_MAX_BACKENDS - 1)

  const entry: PoolEntry = {
    process: null,
    port: null,
    token: null,
    connectionPromise: null,
    lastActiveAt: Date.now(),
    remoteBaseUrl: null
  }

  entry.connectionPromise = spawnPoolBackend(key, entry).catch(async error => {
    // Land the failure in desktop.log: without this a spawn that dies before
    // its child exists (guard rejection, runtime resolution) leaves no trace
    // beyond renderer-side rejections users never see in a bundle.
    rememberLog(
      `Hermes backend for profile "${key}" failed to start: ${error instanceof Error ? error.message : String(error)}`
    )

    if (backendPool.get(key) === entry) {
      backendPool.delete(key)
    }

    stopBackendChild(entry.process)
    await waitForBackendExit(entry.process)
    throw error
  })
  backendPool.set(key, entry)
  startPoolIdleReaper()

  const connection = await entry.connectionPromise
  setWslBridgeProfileState(key, connection.mode !== 'remote')

  return connection
}

// ── Registry-scoped backends (multi-connection, PR 2 of the campaign) ──────
// Resolve a backend for (connectionId, profile) against the v2 registry.
// The LOCAL connection routes through ensureBackend() when the v1 route is
// itself local (so every single-source path stays byte-identical), and forces
// a genuinely-local child when the v1 mode says remote; non-local connections
// pool under the composite key from backendScopeKey() and reuse the same pool
// entry lifecycle (LRU, idle reaper, touch) as per-profile local backends.
export async function ensureRegistryBackend(
  connectionId: unknown,
  profile: string | null | undefined,
  managedUpdateCorrelation = ''
): Promise<BackendConnection> {
  const registry = readDesktopConnectionsRegistry()
  const id = String(connectionId || '').trim() || registry.primary
  const source = registry.connections.find(c => c.id === id)

  if (!source) {
    throw new Error(`No connection with id "${id}".`)
  }

  if (source.kind === 'ssh') {
    managedConnectionUpdateGate.assertCanDial(id, managedUpdateCorrelation)
  }

  const profileKey = String(profile ?? '').trim() || 'default'
  let resolvedRegistrySshConfig: RemoteSshConfig | null | undefined
  let registryEffectiveFingerprintPromise: null | Promise<string> = null

  const resolveRegistrySshConfig = () => {
    if (source.kind !== 'ssh') {
      return null
    }

    if (!resolvedRegistrySshConfig) {
      resolvedRegistrySshConfig = normalizeSshConfig({
        mode: 'ssh',
        host: source.host,
        user: source.user,
        port: source.port,
        keyPath: source.keyPath,
        remoteHermesPath: source.remoteHermesPath,
        remoteProfile: source.remoteProfile || (profileKey === 'default' ? '' : profileKey)
      })
    }

    return resolvedRegistrySshConfig
  }

  const resolveRegistryEffectiveFingerprint = () => {
    if (!registryEffectiveFingerprintPromise) {
      const sshConfig = resolveRegistrySshConfig()

      registryEffectiveFingerprintPromise = sshConfig
        ? effectiveSshConfigFingerprint(sshConfig)
        : Promise.reject(new Error(`SSH connection "${source.label}" has no host configured.`))
    }

    return registryEffectiveFingerprintPromise
  }

  // The v2 registry is migrated from (but intentionally coexists with) the
  // v1 primary connection config. Reuse the already-booted primary descriptor
  // when both identities match; otherwise a default-profile registry request
  // opens a second SSH dashboard under a different scope and the competing
  // lifecycle probes repeatedly tear down each other's tunnel.
  const primary = await reuseMatchingPrimarySshBackend({
    connectionId: id,
    effectiveFingerprint: resolveRegistryEffectiveFingerprint,
    ensurePrimary: () => ensureBackend(profile),
    profile,
    registry,
    source
  })

  if (primary) {
    // connection-registry hands back the ensurePrimary descriptor unchanged; its signature widens it to the registry shape.
    return {
      ...(primary as BackendConnection),
      profile: profileKey,
      connectionId: id
    }
  }

  // The v1 primary and the registry primary can describe the same remote
  // backend beyond the SSH-fingerprint path above (cloud/url remotes have no
  // ssh -G identity). Reuse the already-running primary when the registry
  // resolves its live descriptor back to this exact source id; otherwise one
  // Desktop window starts two isolated servers whose transient runtime ids
  // are not interchangeable.
  if (id === registry.primary && source.kind !== 'local' && source.kind !== 'ssh') {
    const primaryDescriptor = await ensureBackend(profile)

    if (registrySourceOwnsPrimaryBackend(registry, id, primaryDescriptor)) {
      return {
        ...primaryDescriptor,
        profile: profileKey,
        connectionId: id
      }
    }
  }

  if (source.kind === 'local') {
    // The registry's 'local' entry means THIS machine's runtime — always.
    // ensureBackend() follows the v1 routing table, which resolves to a
    // REMOTE descriptor when the v1 global mode is remote (or the profile
    // has its own remote override). A migrated remote-mode user would then
    // see the roster's "This device" rows enumerate + dial the remote box
    // (every profile duplicated, -slug handles forced). Delegate only when
    // the v1 route is genuinely local; otherwise spawn/reuse a forced-local
    // child pooled under the composite 'conn:local::<profile>' key so it
    // can't collide with the v1 remote descriptor cached at the bare key.
    profileDeletionGate.assertCanStart(profileKey)

    const localRoute = resolveRegistryLocalRoute(profileKey, {
      globalRemote: globalRemoteActive(),
      profileRemoteOverride: Boolean(profileHasRemoteOverride(profileKey))
    })

    if (localRoute.delegate) {
      return ensureBackend(profile)
    }

    const stoppingLocal = poolStopper.inFlight(localRoute.poolKey)

    if (stoppingLocal) {
      await stoppingLocal
    }

    const existingLocal = backendPool.get(localRoute.poolKey)

    if (existingLocal?.connectionPromise) {
      existingLocal.lastActiveAt = Date.now()

      return existingLocal.connectionPromise
    }

    evictLruPoolBackends(POOL_MAX_BACKENDS - 1)

    const localEntry: PoolEntry = {
      process: null,
      port: null,
      token: null,
      connectionPromise: null,
      lastActiveAt: Date.now(),
      remoteBaseUrl: null
    }

    localEntry.connectionPromise = spawnPoolBackend(profileKey, localEntry, {
      forceLocal: true,
      poolKey: localRoute.poolKey
    }).catch(async error => {
      // Same trace rule as the v1 pool path: a forced-local child whose spawn
      // rejects before the child exists must still land in desktop.log.
      rememberLog(
        `Hermes backend for profile "${profileKey}" (forced-local) failed to start: ${error instanceof Error ? error.message : String(error)}`
      )

      if (backendPool.get(localRoute.poolKey) === localEntry) {
        backendPool.delete(localRoute.poolKey)
      }

      stopBackendChild(localEntry.process)
      await waitForBackendExit(localEntry.process)
      throw error
    })
    backendPool.set(localRoute.poolKey, localEntry)
    startPoolIdleReaper()

    return localEntry.connectionPromise
  }

  const key = backendScopeKey(id, profile)
  const existing = backendPool.get(key)

  if (existing?.connectionPromise) {
    existing.lastActiveAt = Date.now()
    const connectionPromise = existing.connectionPromise

    // A remote process can die while its local SSH forward stays LISTENing.
    // Validate the exact cached descriptor at dispatch time; background
    // revalidation is renderer-driven and may never run while the Bots pane is
    // closed. Concurrent clicks share one retire/reconnect sequence.
    return registryDispatchRevalidation.run(connectionPromise, () =>
      ensureHealthyPooledRemoteBackendForDispatch({
        connectionPromise,
        currentConnectionPromise: () => backendPool.get(key)?.connectionPromise || null,
        probe: (connection, requestPath, options) => fetchJsonForBackend(connection, requestPath, options),
        reconnect: () => ensureRegistryBackend(id, profile),
        retire: async (error: any) => {
          // A late failure from an old descriptor must never tear down a newer
          // entry that another caller has already installed.
          if (backendPool.get(key) !== existing) {
            return
          }

          rememberLog(
            `Pooled remote backend "${key}" failed its dispatch probe (${error?.message || error}); reconnecting on demand.`
          )
          await stopPoolBackend(key)

          if (source.kind === 'ssh') {
            await sshBootstrapCoordinator.cancelAndWait(key)
            await teardownSshConnection(key)
          }
        }
      })
    )
  }

  evictLruPoolBackends(POOL_MAX_BACKENDS - 1)

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
    resolveRegistrySshConfig(),
    source.kind === 'ssh' ? resolveRegistryEffectiveFingerprint() : null,
    managedUpdateCorrelation
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

async function restoreManagedPrimarySshBackend(source: { id: string }, profile: string, correlationId: string) {
  managedConnectionUpdateGate.assertCanDial(source.id, correlationId)
  const profileKey = String(profile || '').trim() || 'default'

  if (managedPrimaryRestoreOwners.size > 0 && !managedPrimaryRestoreOwners.has(source.id)) {
    throw new Error('Another managed SSH primary restore is already in progress.')
  }

  managedPrimaryRestoreOwners.set(source.id, { correlationId, profile: profileKey, source })
  backendConnectionState.invalidate()

  try {
    return await startHermes()
  } finally {
    if (managedPrimaryRestoreOwners.get(source.id)?.correlationId === correlationId) {
      managedPrimaryRestoreOwners.delete(source.id)
    }
  }
}

export async function updateManagedSshConnection(source: RegistryEntry, correlationId: string) {
  const sourceSnapshot = { ...source }
  const scopes = await captureManagedSshScopes(sourceSnapshot)
  let ephemeral: null | { close: () => Promise<void>; target: RemoteUpdateTarget } = null
  let launchAttempted = false
  const firstState = scopes.find(scope => scope.state)?.state

  const target = firstState
    ? remoteUpdateTargetFromState(firstState)
    : (ephemeral = await openManagedSshUpdateTransport(sourceSnapshot)).target

  return runManagedSshUpdate({
    connectionId: source.id,
    correlationId,
    scopes,
    preflightRemote: () => assertManagedUpdatePreflightClear(target, correlationId),
    drainScope: drainManagedSshScope,
    updateRemote: () =>
      executeManagedRemoteUpdate(target, correlationId, {}, async () => {
        markManagedSshRecoveryLaunching(source.id, correlationId)
        launchAttempted = true
      }),
    awaitRestoreClearance: () =>
      waitForManagedRemoteClearance(target, correlationId, { requireTerminal: launchAttempted }),
    closeTransports: async () => {
      const transports = new Set<any>(
        scopes
          .filter(scope => scope.drained)
          .map(scope => scope.state?.ssh)
          .filter(Boolean)
      )

      await Promise.allSettled([...transports].map(ssh => ssh.close()))

      if (ephemeral) {
        await ephemeral.close()
      }
    },
    restoreScope: (scope: ManagedSshScope) => {
      if (scope.unsafeDrainFailure) {
        if (!scope.forwardRestored) {
          throw new Error(`The original ${scope.profile} SSH forward could not be restored safely.`)
        }

        return scope.entry.connectionPromise ?? Promise.resolve(null)
      }

      const scopedSource = scope.reuseToken
        ? { ...sourceSnapshot, token: encryptDesktopSecret(scope.reuseToken) }
        : sourceSnapshot

      if (scope.primary) {
        return restoreManagedPrimarySshBackend(scopedSource, scope.profile, correlationId)
      }

      return scope.registryScoped
        ? ensureManagedSshBackend(scopedSource, scope.profile, correlationId)
        : ensureManagedSshBackendAtKey(scopedSource, scope.profile, scope.key, correlationId, 'profile')
    },
    prepareRecovery: async () => persistManagedSshRecovery(sourceSnapshot, correlationId, scopes),
    completeRecovery: async () => clearManagedSshRecovery(source.id, correlationId),
    releaseGate: () => managedConnectionUpdateGate.release(source.id, correlationId)
  })
}

async function recoverManagedSshUpdate(record: ReturnType<typeof readManagedSshRecoveryRecords>[number]) {
  const connectionId = record.connectionId

  if (managedConnectionRecoveries.has(connectionId) || managedConnectionUpdates.has(connectionId)) {
    return
  }

  const recoveryCorrelation = record.correlationId

  if (!managedConnectionUpdateGate.claim(connectionId, recoveryCorrelation)) {
    return
  }

  const operation = (async () => {
    let transport: null | { close: () => Promise<void>; target: RemoteUpdateTarget } = null

    try {
      transport = await openManagedSshUpdateTransport(record.source)

      const results = await recoverManagedSshScopes<any>({
        scopes: record.scopes,
        awaitClearance: () =>
          waitForManagedRemoteClearance(transport!.target, record.correlationId, {
            requireTerminal: record.phase === 'launching'
          }),
        afterClearance: async () => {
          await transport!.close()
          transport = null
        },
        restoreScope: scope =>
          scope.kind === 'primary'
            ? restoreManagedPrimarySshBackend(record.source, scope.profile, recoveryCorrelation)
            : scope.kind === 'legacy'
              ? ensureManagedSshBackendAtKey(record.source, scope.profile, scope.key, recoveryCorrelation, 'profile')
              : ensureManagedSshBackend(record.source, scope.profile, recoveryCorrelation),
        completeRecovery: async () => clearManagedSshRecovery(connectionId, record.correlationId)
      })

      if (results.every(result => result.status === 'fulfilled')) {
        sshRememberLog(
          `[ssh-update] restored ${record.scopes.length} scope(s) from durable recovery for ${connectionId}`
        )
      } else {
        const failures = results.filter(result => result.status === 'rejected').length
        sshRememberLog(
          `[ssh-update] durable recovery for ${connectionId} left ${failures} scope(s) pending; will retry next launch`
        )
      }
    } catch (error: any) {
      sshRememberLog(
        `[ssh-update] durable recovery for ${connectionId} remains pending: ${String(error?.message || error)}`
      )
    } finally {
      if (transport) {
        await transport.close().catch(() => undefined)
      }

      managedConnectionUpdateGate.release(connectionId, recoveryCorrelation)
      managedConnectionRecoveries.delete(connectionId)
    }
  })()

  managedConnectionRecoveries.set(connectionId, operation)
  await operation
}

export async function resumeManagedSshRecoveries() {
  await Promise.allSettled(readManagedSshRecoveryRecords().map(record => recoverManagedSshUpdate(record)))
}

export async function prepareProfileRenameRequest(request: Record<string, unknown>) {
  return prepareProfileRenameLifecycle(request, {
    isValidProfileName: profile => PROFILE_NAME_RE.test(profile),
    primaryProfileKey,
    reloadPrimaryWindow: () => {
      windowsState.mainWindow?.reload()
    },
    restartPrimaryBackend: async () => {
      await startHermes()
    },
    teardownPoolBackendAndWait,
    teardownPrimaryBackendAndWait,
    writeActiveDesktopProfile: profile => {
      writeActiveDesktopProfile(profile)
    }
  })
}

// Re-dial one retired pool key through the SAME claim-guarded ensure path a
// renderer dial takes (#90812), so a resume-driven rebuild and a concurrent
// renderer reconnect coalesce onto one spawn instead of racing.
function redialPoolBackendAfterResume(poolKey: string) {
  const { connectionId, profile } = parseBackendScopeKey(poolKey)

  return backendDialClaims.run(poolKey, () =>
    connectionId ? ensureRegistryBackend(connectionId, profile) : ensureBackend(profile)
  )
}

// Sleep/wake recovery for POOLED remote/SSH backends (#93910). The primary
// renderer socket already has wake-path probe/reconnect nudges, but pooled
// descriptors (Bots pane, secondary connections) kept serving dead SSH
// tunnels after macOS resume: no child 'exit' fires for a remote, and the
// background failure-streak policy takes several rounds to drop one. On
// resume every pooled remote is suspect — probe each once (bounded), tear
// down the dead ones (pool entry + SSH bootstrap + tunnel/master) and rebuild
// them through the claim-guarded dial path.
function revalidateSuspectPoolAfterResume() {
  return remoteRevalidation.run(suspectPoolSweepScope, () =>
    revalidateSuspectPooledRemoteBackends({
      entries: backendPool.entries(),
      log: rememberLog,
      probe: (connection, path, options) => fetchJsonForBackend(connection, path, options),
      rebuild: poolKey => redialPoolBackendAfterResume(poolKey),
      retire: async poolKey => {
        await stopPoolBackend(poolKey)
        // The pool key doubles as the SSH scope for registry SSH backends and
        // resolves through sshScopeKey() for bare-profile remotes; both
        // teardown calls no-op when the scope holds no SSH state.
        await sshBootstrapCoordinator.cancelAndWait(poolKey)
        await teardownSshConnection(poolKey)
      },
      tracker: remoteLiveness
    })
  )
}
