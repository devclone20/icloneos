// Remote backends: resolution, profile routing and auth probing.

import { isRecord } from '../../src/iclone-shared/guards'
import { makeNousCloudBackendDownError, makeUnsignedOauthError } from '../backend-health'
import {
  authModeFromStatus,
  buildGatewayWsUrl,
  buildGatewayWsUrlWithTicket,
  connectionScopeKey,
  gatewayTicketFailure,
  hostLabelFromBaseUrl,
  modeIsRemoteLike,
  normalizeRemoteBaseUrl,
  profileHasRemoteConnection,
  resolveRemoteSshDashboardProfile
} from '../connection-config'
import type { normalizeSshConfig } from '../connection-config'
import { upsertConnection } from '../connection-registry'
import { adoptServedDashboardToken } from '../dashboard-token'
import { fenceManagedSshBootstrapPublication, managedSshTokenPersistencePlan } from '../managed-ssh-update'
import { oauthGuardMayHardFail, oauthSessionIsLive, oauthTicketFailureAuthMessage } from '../native-auth-decisions'
import { codePathEnv } from '../packaged-env'
import * as remoteLifecycle from '../remote-lifecycle'
import { sshConfigFingerprint } from '../ssh-bootstrap-coordinator'
import { pickLocalPort, SshConnection } from '../ssh-connection'
import { connectWindowsRemote, detectRemotePlatform } from '../windows-remote-lifecycle'

import { waitForHermes } from './backend-readiness'
import type { BackendConnection } from './backend-state'
import {
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry,
  sshConnections,
  writeDesktopConnectionConfig,
  writeDesktopConnectionsRegistry
} from './connection-config'
import { mintGatewayWsTicket } from './gateway-files'
import { fetchJson, fetchPublicJson, requestOptionsWithHeaders } from './http'
import {
  effectiveSshConfigFingerprint,
  managedConnectionUpdateGate,
  rollbackSshBootstrapResult,
  sshBootstrapCoordinator,
  sshOwnershipKey,
  sshProbeReuseProof,
  sshRememberLog,
  sshScopeKey,
  teardownSshConnection
} from './managed-ssh'
import { ensureNativeAccessToken, fetchJsonViaOauthSession, hasLiveOauthSession, hasNativeSession } from './oauth'
import { decryptRemoteHeaders, encryptDesktopSecret, rememberRemoteWsHeaders } from './secrets'

// Best-effort read of a gateway's advertised auth providers, cached per base
// URL for the life of the process. Used by the oauth pre-flight guard to tell
// a password-provider gateway (which cannot satisfy the bearer/cookie checks
// by design) from a real OAuth one. Any failure returns [] so callers keep the
// strict guard — backends predating /api/auth/providers are unaffected.
const gatewayAuthProvidersCache = new Map<string, any[]>()

export async function gatewayAuthProviders(baseUrl: string, headers = {}) {
  const cached = gatewayAuthProvidersCache.get(baseUrl)

  if (cached) {
    return cached
  }

  let providers: { name: string; supportsPassword: boolean }[] = []

  try {
    const body = (await fetchPublicJson(
      `${baseUrl}/api/auth/providers`,
      requestOptionsWithHeaders({ timeoutMs: 8_000 }, headers)
    )) as any

    if (Array.isArray(body?.providers)) {
      const listed: unknown[] = body.providers
      providers = listed
        .filter(isRecord)
        .map(p => ({ name: String(p.name || ''), supportsPassword: Boolean(p.supports_password) }))
        .filter(p => p.name)
    }

    gatewayAuthProvidersCache.set(baseUrl, providers)
  } catch {
    // Optional metadata — an unreadable list keeps the strict guard.
  }

  return providers
}

// Build a remote backend connection descriptor from an already-resolved remote
// config. Handles both auth models (OAuth ws-ticket vs static session token)
// and is shared by the per-profile, env, and global resolution paths. `token`
// is the DECRYPTED static token (or null in OAuth mode). `source` is a label
// for diagnostics ('profile' | 'env' | 'settings').
export async function buildRemoteConnection(
  rawUrl: unknown,
  authMode: string,
  token: string | null | undefined,
  source: string,
  remoteHost?: string,
  remoteKind: 'cloud' | 'ssh' | 'url' = 'url',
  remoteIdentity?: string,
  headers?: unknown
): Promise<BackendConnection> {
  const baseUrl = normalizeRemoteBaseUrl(rawUrl)
  const remoteHeaders = decryptRemoteHeaders(headers)
  // For token/oauth remotes the meaningful host is the real backend URL; for
  // SSH remotes the caller passes the entered/resolved host explicitly (the
  // baseUrl is a 127.0.0.1 tunnel and would be useless in the pill).
  const host = remoteHost || hostLabelFromBaseUrl(baseUrl)

  if (authMode === 'oauth') {
    // OAuth gateway: auth comes from EITHER a native bearer token (cookieless
    // RFC 8252 flow) OR the session cookies in the OAuth partition. Liveness is
    // NOT "is the access-token cookie present?" — Portal issues a 24h rotating
    // refresh token (hermes #37247), and the gateway middleware transparently
    // rotates a fresh ~15-min access token from it on the next authenticated
    // request. So a session with an expired AT cookie but a live RT cookie is
    // still perfectly connectable. We early-out only when NEITHER a native
    // token NOR any cookie is present, then mint a ws-ticket (which itself
    // prefers the native bearer) as the authoritative liveness check.
    //
    // The native-token check is essential: the native login stores bearer
    // tokens (no cookie is ever set), so gating solely on hasLiveOauthSession
    // here would reject a freshly-completed native sign-in and loop the UI back
    // into "not signed in" even though mintGatewayWsTicket would succeed with
    // the stored bearer.
    if (
      !oauthSessionIsLive(hasNativeSession(baseUrl), await hasLiveOauthSession(baseUrl)) &&
      oauthGuardMayHardFail(await gatewayAuthProviders(baseUrl, remoteHeaders))
    ) {
      throw makeUnsignedOauthError()
    }

    let ticket

    try {
      ticket = await mintGatewayWsTicket(baseUrl, remoteHeaders)
    } catch (error) {
      // For a Nous-managed Cloud agent, a 502/503/504 from the WS-ticket mint
      // means the backend server itself is down — the actionable Cloud-down
      // error. This boundary runs BEFORE the readiness loop, so without this
      // the ticket wrapper below would swallow the server-fault classification
      // and the renderer would never see isCloudBackendDown. Preserve the
      // existing 401/403 reauth and generic transport behavior for everything
      // else (#85335).
      const cloudError = makeNousCloudBackendDownError(baseUrl, error)

      if (cloudError !== null) {
        throw cloudError
      }

      throw gatewayTicketFailure(
        error,
        oauthTicketFailureAuthMessage(hasNativeSession(baseUrl)),
        'Could not reach the remote Hermes gateway while refreshing its WebSocket ticket. Try reconnecting.'
      )
    }

    const wsUrl = buildGatewayWsUrlWithTicket(baseUrl, ticket)

    rememberRemoteWsHeaders(wsUrl, remoteHeaders)

    return {
      baseUrl,
      mode: 'remote',
      source,
      authMode: 'oauth',
      remoteHost: host || undefined,
      remoteIdentity,
      remoteKind,
      headers: remoteHeaders,
      // No static token in OAuth mode; REST is cookie-authed via the partition.
      token: null,
      wsUrl
    }
  }

  if (!token) {
    throw new Error(
      'Remote Hermes gateway is selected, but no session token is saved. ' +
        'Open Settings → Gateway and save a token, or switch back to Local.'
    )
  }

  const wsUrl = buildGatewayWsUrl(baseUrl, token)

  rememberRemoteWsHeaders(wsUrl, remoteHeaders)

  return {
    baseUrl,
    mode: 'remote',
    source,
    authMode: 'token',
    remoteHost: host || undefined,
    remoteIdentity,
    remoteKind,
    headers: remoteHeaders,
    token,
    wsUrl
  }
}

export type RemoteSshConfig = NonNullable<ReturnType<typeof normalizeSshConfig>>

/** What a dial tells the SSH bootstrap about its caller (pool scope, registry source, managed-update fence). */
interface SshBootstrapMetadata {
  managedScope?: string
  poolKey?: string
  registryConnectionId?: string
  managedUpdateCorrelation?: string
  primaryRegistryScope?: boolean
}

type SshBootstrapStart = typeof sshBootstrapCoordinator.start

export async function bootstrapSshConnection(
  profile: string | null,
  sshConfig: RemoteSshConfig,
  reuseToken: string,
  source: string,
  resolvedEffectiveFingerprint?: string | undefined,
  metadata: SshBootstrapMetadata = {}
) {
  const scope = sshScopeKey(profile)
  const effectiveConfigFingerprint = resolvedEffectiveFingerprint || (await effectiveSshConfigFingerprint(sshConfig))
  const resolvedConfig = { ...sshConfig, effectiveConfigFingerprint }
  const fingerprint = sshConfigFingerprint(scope, resolvedConfig)

  return sshBootstrapCoordinator.start(
    scope,
    fingerprint,
    lease => bootstrapSshConnectionInner(profile, resolvedConfig, reuseToken, source, metadata, fingerprint, lease),
    metadata
  )
}

async function bootstrapSshConnectionInner(
  profile: string | null,
  sshConfig: RemoteSshConfig & { effectiveConfigFingerprint: string },
  reuseToken: string,
  source: string,
  metadata: SshBootstrapMetadata,
  fingerprint: string,
  lease: Parameters<Parameters<SshBootstrapStart>[2]>[0]
) {
  const scope = sshScopeKey(profile)
  const hostLabel = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host
  const existing = sshConnections.get(scope)

  if (existing && existing.fingerprint !== fingerprint) {
    await teardownSshConnection(profile)
  }

  let ssh: SshConnection | null | undefined = sshConnections.get(scope)?.ssh

  if (ssh && !(await ssh.isAlive())) {
    try {
      await ssh.close()
    } catch {
      void 0
    }

    ssh = null
    sshConnections.delete(scope)
  }

  const created = !ssh

  let removeForceCleanup = () => {}

  if (!ssh) {
    ssh = new SshConnection(
      { host: sshConfig.host, user: sshConfig.user, port: sshConfig.port, keyPath: sshConfig.keyPath },
      {
        rememberLog: sshRememberLog,
        ownershipId: sshOwnershipKey(profile),
        scope,
        effectiveConfigFingerprint: sshConfig.effectiveConfigFingerprint
      }
    )
    const opened = ssh
    removeForceCleanup = lease.onForceCleanup(() => opened.close())
    await opened.open({ signal: lease.signal })
  }

  let result: any

  try {
    if (metadata.registryConnectionId) {
      managedConnectionUpdateGate.assertCanDial(metadata.registryConnectionId, metadata.managedUpdateCorrelation || '')
    }

    const platform = await detectRemotePlatform(ssh, sshConfig.remoteHermesPath || '')
    const lifecycle = platform.os === 'Windows' ? connectWindowsRemote : remoteLifecycle.connect
    result = await lifecycle({
      ssh,
      profile: resolveRemoteSshDashboardProfile(sshConfig.remoteProfile, profile),
      remoteHermesPath: sshConfig.remoteHermesPath || '',
      ownershipId: sshOwnershipKey(profile),
      reuseToken: reuseToken || '',
      forward: (localPort, remotePort) => ssh.forward(localPort, remotePort),
      cancelForward: (localPort, remotePort) => ssh.cancelForward(localPort, remotePort),
      pickLocalPort,
      waitForHermes: (baseUrl, token) => waitForHermes(baseUrl, token, lease.signal, 'token'),
      probeReuseProof: sshProbeReuseProof,
      adoptServedToken: adoptServedDashboardToken,
      rememberLog: sshRememberLog,
      signal: lease.signal
    })
  } catch (error: any) {
    if (created) {
      try {
        await ssh.close()
      } catch {
        void 0
      }
    } else {
      // The cached master was reused but the lifecycle probe against it
      // failed ("Could not verify the existing SSH backend"). Keeping the
      // stale entry means every subsequent boot re-attempts through the same
      // wedged master/tunnel and fails identically until the user re-enters
      // the connection details (whose changed fingerprint forces a teardown).
      // Tear it down now so the next attempt — automatic retry included —
      // bootstraps a fresh master, which is exactly what manual re-entry
      // did (#82679).
      try {
        await teardownSshConnection(profile)
      } catch {
        void 0
      }
    }

    const err = new Error(error.message) as any
    err.sshError = error.kind || 'unknown'
    err.isSshBootstrap = true
    throw err
  }

  try {
    lease.assertCurrent()
  } catch (error) {
    await rollbackSshBootstrapResult(ssh, result, profile, sshConfig, error)
    throw error
  }

  await fenceManagedSshBootstrapPublication({
    assertCanPublish: () => {
      if (metadata.registryConnectionId) {
        managedConnectionUpdateGate.assertCanDial(
          metadata.registryConnectionId,
          metadata.managedUpdateCorrelation || ''
        )
      }
    },
    publish: () => {
      persistSshConnectionToken(profile, source, result.token, metadata.registryConnectionId)
      removeForceCleanup()
      sshConnections.set(scope, {
        ssh,
        fingerprint,
        ownershipId: result.ownershipId || sshOwnershipKey(profile),
        localPort: result.localPort,
        remotePort: result.remotePort,
        pid: result.pid,
        host: sshConfig.host,
        hostLabel,
        hermesVersion: result.hermesVersion || '',
        remotePlatform: result.platform?.os || '',
        reused: result.reused,
        spawnNonce: result.spawnNonce,
        creationTimeNs: result.creationTimeNs,
        creationTime: result.creationTime,
        startedAt: result.startedAt,
        hermesPath: result.hermesPath,
        hermesHome: result.hermesHome,
        pythonPath: result.pythonPath,
        remoteProfile: resolveRemoteSshDashboardProfile(sshConfig.remoteProfile, profile),
        registryConnectionId:
          metadata.registryConnectionId ||
          (typeof source === 'string' && source.startsWith('registry:') ? source.slice('registry:'.length) : ''),
        // Never infer primary ownership from a non-composite scope key: legacy
        // per-profile pools also use bare keys. Only startHermes' explicit call
        // site may label a registry-qualified SSH scope as the primary backend.
        primaryRegistryScope: metadata.primaryRegistryScope === true
      })
    },
    rollback: error => rollbackSshBootstrapResult(ssh, result, profile, sshConfig, error)
  })

  sshRememberLog(
    `[ssh] connection ${result.reused ? 'REUSED' : 'spawned'} dashboard: ` +
      `${result.hermesVersion || 'hermes (version unknown)'} at ${result.hermesPath || '?'}`
  )

  const connection = await buildRemoteConnection(
    result.baseUrl,
    'token',
    result.token,
    source,
    hostLabel,
    'ssh',
    result.ownershipId
  )

  return {
    ...connection,
    remoteHermesVersion: result.hermesVersion || '',
    ssh: {
      effectiveConfigFingerprint: sshConfig.effectiveConfigFingerprint,
      host: sshConfig.host,
      keyPath: sshConfig.keyPath,
      port: sshConfig.port,
      remoteHermesPath: sshConfig.remoteHermesPath,
      remoteProfile: sshConfig.remoteProfile,
      user: sshConfig.user
    }
  }
}

function persistSshConnectionToken(profile: string | null, source: unknown, token: string, registryConnectionId = '') {
  try {
    const persistence = managedSshTokenPersistencePlan(source, registryConnectionId)
    const id = persistence.registryConnectionId
    const encrypted = encryptDesktopSecret(token)

    // A primary legacy route can also be qualified with a stable registry id.
    // Mirror the adopted per-serve token to both stores so the next primary
    // launch and a later registry-scoped launch reuse the same owned process.
    if (id) {
      const registry = readDesktopConnectionsRegistry()
      const entry = registry.connections.find(c => c.id === id)

      if (entry && entry.kind === 'ssh') {
        writeDesktopConnectionsRegistry(upsertConnection(registry, { ...entry, token: encrypted }))
      }
    }

    if (!persistence.legacySource) {
      return
    }

    const config = readDesktopConnectionConfig()

    if (persistence.legacySource === 'profile') {
      const key = connectionScopeKey(profile)

      if (key && config.profiles?.[key]?.mode === 'ssh') {
        config.profiles[key].token = encrypted
        writeDesktopConnectionConfig(config)
      }
    } else if (config.mode === 'ssh' && config.remote) {
      config.remote.token = encrypted
      writeDesktopConnectionConfig(config)
    }
  } catch (error: any) {
    sshRememberLog(`[ssh] could not persist served token: ${error.message}`)
  }
}

// A remote profile's sessions live on its remote host's state.db, not on a local
// file the primary can open — so reads for it must route to the remote backend,
// not the local-disk fast path. These three helpers drive that (see
// interceptSessionReadForRemote).
export function profileHasRemoteOverride(profile: string) {
  return profileHasRemoteConnection(readDesktopConnectionConfig(), profile)
}

export function configuredRemoteProfileNames() {
  const config = readDesktopConnectionConfig()

  return Object.keys(config.profiles || {}).filter(name => profileHasRemoteConnection(config, name))
}

// True when the app is in app-global remote mode (Settings → "All profiles" →
// Remote/Cloud, or the env override): a SINGLE remote backend serves every
// profile via ?profile=. Cloud counts — it resolves to a remote backend (Q6).
// Distinct from per-profile overrides — here there's one host for all.
export function globalRemoteActive() {
  if (codePathEnv('HERMES_DESKTOP_REMOTE_URL')) {
    // iclone-seam: p7-env
    return true
  }

  const mode = readDesktopConnectionConfig().mode

  if (modeIsRemoteLike(mode) || mode === 'ssh') {
    return true
  }

  // Registry-primary transport (#91564/#90316): a registered remote/cloud/ssh
  // gateway promoted to primary via connections.json makes the primary
  // backend remote even while the v1 config.mode still says 'local'. Every
  // consumer of this flag ("one remote host serves every profile") must see
  // that, or the local-entry routes delegate into a primary that now dials
  // remote — respawning the exact loopback children the resolver rung in
  // desktop-remote-route.ts eliminates.
  return registryPrimaryIsRemote()
}

// True when the v2 registry PRIMARY names a non-local connection. Mirrors the
// registry fallback rung in resolveDesktopRemoteRoute.
function registryPrimaryIsRemote() {
  try {
    const registry = readDesktopConnectionsRegistry()
    const entry = registry.connections.find(c => c.id === registry.primary)

    return Boolean(entry && (entry.kind === 'remote' || entry.kind === 'cloud' || entry.kind === 'ssh'))
  } catch {
    return false
  }
}

export async function probeRemoteAuthMode(rawUrl: string) {
  // Determine how a remote gateway expects callers to authenticate, WITHOUT
  // sending any credentials. ``/api/status`` is public on every Hermes
  // gateway (it backs the portal liveness probe) and reports:
  //   auth_required: true  → OAuth gate is engaged (cookie + ws-ticket auth)
  //   auth_required: false → loopback/--insecure: legacy session-token auth
  // ``/api/auth/providers`` (also public, only meaningful when gated) gives
  // the human-facing provider name(s) for the login button label.
  //
  // The settings UI calls this as the user types a URL so it can render an
  // OAuth login button vs a session-token entry box. Network/parse failures
  // surface as ``reachable: false`` rather than throwing, so a half-typed or
  // unreachable URL degrades to "can't tell yet" instead of a hard error.
  const baseUrl = normalizeRemoteBaseUrl(rawUrl)

  let status: unknown

  try {
    status = await fetchPublicJson(`${baseUrl}/api/status`, { timeoutMs: 8_000 })
  } catch (error: any) {
    return {
      baseUrl,
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  const authRequired = authModeFromStatus(status) === 'oauth'
  let providers: { name: string; displayName: string; supportsPassword: boolean }[] = []

  if (authRequired) {
    // Best-effort: a gated gateway exposes the registered providers so the
    // button can read "Sign in with Nous Research" instead of a generic
    // label, and so a username/password provider can be distinguished from
    // an OAuth-redirect one (``supports_password``). A failure here doesn't
    // change the auth mode, so swallow it.
    try {
      const body = (await fetchPublicJson(`${baseUrl}/api/auth/providers`, { timeoutMs: 8_000 })) as any

      if (Array.isArray(body?.providers)) {
        const listed: unknown[] = body.providers
        providers = listed
          .filter(isRecord)
          .map(p => ({
            name: String(p.name || ''),
            displayName: String(p.display_name || p.name || ''),
            supportsPassword: Boolean(p.supports_password)
          }))
          .filter(p => p.name)
      }
    } catch {
      // Provider listing is optional metadata; the auth mode is already known.
    }
  }

  return {
    baseUrl,
    reachable: true,
    authMode: authRequired ? 'oauth' : 'token',
    providers,
    version: (isRecord(status) ? status.version : undefined) || null,
    error: null
  }
}

export async function fetchConnectionStatus(baseUrl: string, authMode: string, token: string, headers = {}) {
  const url = `${baseUrl}/api/status`

  if (authMode === 'oauth') {
    // Native PKCE bearer first, OAuth session cookies second — the same two
    // credentials real traffic uses, in the same order. A refresh failure is
    // NOT a silent downgrade to an anonymous probe: the cookie path is still
    // an authenticated request, and if neither credential works the probe
    // fails, which is the correct answer for a gateway we cannot reach with
    // the credentials we hold.
    const nativeAt = await ensureNativeAccessToken(baseUrl).catch(() => null)

    if (nativeAt) {
      return fetchJson(url, null, { timeoutMs: 8_000, bearer: nativeAt, headers })
    }

    return fetchJsonViaOauthSession(url, { timeoutMs: 8_000, headers })
  }

  return fetchJson(url, token, { timeoutMs: 8_000, headers })
}
