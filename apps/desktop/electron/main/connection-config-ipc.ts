// IPC: connection probing, OAuth, Hermes Cloud, saving/applying config and profiles.
import { ipcMain, shell } from 'electron'

import { isRecord } from '../../src/iclone-shared/guards'
import { applyConnectionChange } from '../connection-apply'
import {
  authModeFromStatus,
  connectionScopeKey,
  modeIsRemoteLike,
  normalizeRemoteBaseUrl,
  normalizeSshConfig,
  normAuthMode,
  savedProfileSsh,
  tokenPreview
} from '../connection-config'
import { applyConnectionConfigAtomically } from '../connection-config-apply'
import { reconcileAppliedGlobalConnection } from '../connection-registry'
import { oauthSessionIsLive } from '../native-auth-decisions'
import { resolveLoginStrategy } from '../native-oauth'
import { runNativeLogin } from '../native-oauth-login'
import { codePathEnv } from '../packaged-env'
import { rehomePrimaryConnection } from '../primary-connection-rehome'

import { primaryProfileKey, sendConnectionApplied, teardownPrimaryBackendAndWait } from './backend'
import type { stopPoolBackend } from './backend-pool'
import { testDesktopConnectionConfig } from './backend-routing'
import { abandonFirstRunSetupChoiceForRemoteApply } from './boot-progress'
import {
  coerceDesktopConnectionConfig,
  readActiveDesktopProfile,
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry,
  writeActiveDesktopProfile,
  writeDesktopConnectionConfig,
  writeDesktopConnectionsRegistry
} from './connection-config'
import type { DesktopConnectionConfig } from './connection-config'
import { fetchPublicJson } from './http'
import { rememberLog } from './log'
import { assertCanMutateManagedPrimaryRouting, sshBootstrapCoordinator, teardownSshConnection } from './managed-ssh'
import {
  _clearNativeTokens,
  _storeNativeTokens,
  clearOauthSession,
  hasLiveOauthSession,
  hasNativeSession,
  hasOauthSessionCookie,
  openOauthLoginWindow,
  postJsonNoAuth
} from './oauth'
import {
  cloudAgentSilentSignIn,
  discoverCloudAgents,
  hasLivePortalSession,
  openPortalLoginWindow,
  resolvePortalBaseUrl
} from './portal'
import { gatewayAuthProviders, probeRemoteAuthMode } from './remote'
import { decryptDesktopSecret, probeSecureTokenStorage } from './secrets'
import type { bootState, windowsState } from './state'

interface ConnectionConfigIpcDeps {
  bootState: typeof bootState
  stopPoolBackend: typeof stopPoolBackend
  windowsState: typeof windowsState
}

// Sanitize a connection config into the renderer-facing shape. With no
// `profile` this describes the global/default connection (the existing
// behavior); with a `profile` it describes that profile's per-profile remote
// override (or an empty "local/inherit" view when the profile has none).
async function sanitizeDesktopConnectionConfig(
  config: DesktopConnectionConfig = readDesktopConnectionConfig(),
  profile = null
) {
  const key = connectionScopeKey(profile)
  const scoped = key ? config.profiles?.[key] || null : null
  const block = key ? scoped || {} : config.remote || {}

  const envOverride = key ? false : Boolean(codePathEnv('HERMES_DESKTOP_REMOTE_URL')) // iclone-seam: p7-env
  const savedMode = key ? scoped?.mode : config.mode
  const ssh = savedMode === 'ssh' ? normalizeSshConfig(block) : null

  const savedSsh = savedMode === 'local' ? (key ? savedProfileSsh(config, key) : normalizeSshConfig(block)) : null

  const remoteToken = decryptDesktopSecret(block.token)
  const authMode = normAuthMode(block.authMode)
  const remoteUrl = envOverride ? String(codePathEnv('HERMES_DESKTOP_REMOTE_URL') || '') : String(block.url || '') // iclone-seam: p7-env
  const mode = envOverride ? 'remote' : savedMode === 'ssh' ? 'ssh' : modeIsRemoteLike(savedMode) ? savedMode : 'local'

  // Whether the OS keyring (safeStorage) can encrypt the saved token. When
  // false the renderer knows to offer the plain-text opt-in in Settings →
  // Gateway. With keychain encryption opted out (the default) this reports
  // true WITHOUT touching safeStorage — probing is itself a keychain touch
  // that raises the macOS password dialog (see probeSecureTokenStorage).
  const secureTokenStorage = probeSecureTokenStorage()

  // Whether the currently saved token is stored in plain text (the keyring-less
  // opt-in path). The env override supplies its token from the environment, not
  // the saved block, so it never reports as plain text here.
  const remoteTokenPlainText = !envOverride && isRecord(block.token) && block.token.encoding === 'plain'

  let remoteOauthConnected = false

  if (authMode === 'oauth' && remoteUrl) {
    try {
      // Display signal: treat a live RT cookie as "connected" even if the AT
      // cookie has lapsed — the gateway refreshes the AT on the next request,
      // so the session is still usable. A stored native bearer token (cookieless
      // RFC 8252 flow) counts as connected too — otherwise a completed native
      // sign-in shows "not connected" in Settings. The authoritative liveness
      // check is the ws-ticket mint in resolveRemoteBackend at actual connect time.
      remoteOauthConnected = oauthSessionIsLive(hasNativeSession(remoteUrl), await hasLiveOauthSession(remoteUrl))
    } catch {
      remoteOauthConnected = false
    }
  }

  return {
    mode,
    // Echo the scope back so the UI knows which profile (if any) this reflects.
    profile: key,
    remoteAuthMode: authMode,
    remoteOauthConnected,
    remoteUrl,
    // The persisted Hermes Cloud org (slug/id) for a cloud connection, or '' for
    // remote/local. Lets Settings → Gateway reopen into the same org.
    cloudOrg: mode === 'cloud' ? String(block.org || '') : '',
    remoteTokenPreview: tokenPreview(remoteToken),
    remoteTokenSet: Boolean(remoteToken),
    // Whether the OS keyring can encrypt a token; drives the plain-text opt-in
    // affordance in Settings → Gateway on keyring-less Linux.
    secureTokenStorage,
    // Whether the saved token is currently persisted in plain text.
    remoteTokenPlainText,
    sshHost: (ssh || savedSsh)?.host || '',
    sshUser: (ssh || savedSsh)?.user || '',
    sshPort: (ssh || savedSsh)?.port || null,
    sshKeyPath: (ssh || savedSsh)?.keyPath || '',
    sshRemoteHermesPath: (ssh || savedSsh)?.remoteHermesPath || '',
    sshRemoteProfile: (ssh || savedSsh)?.remoteProfile || '',
    // The env override only forces the global/primary connection; a per-profile
    // scope is never overridden by HERMES_DESKTOP_REMOTE_URL.
    envOverride
  }
}

export function registerConnectionConfigIpc({
  bootState,
  stopPoolBackend,
  windowsState
}: ConnectionConfigIpcDeps): void {
  ipcMain.handle('hermes:connection-config:get', async (_event, profile) =>
    sanitizeDesktopConnectionConfig(readDesktopConnectionConfig(), profile)
  )

  ipcMain.handle('hermes:connection-config:probe', async (_event, rawUrl) => probeRemoteAuthMode(rawUrl))
  ipcMain.handle('hermes:connection-config:oauth-login', async (_event, rawUrl) => {
    // Capability-gated login (RFC 8252). Probe the gateway's public /api/status
    // for supported auth_flows and /api/auth/providers for provider capabilities:
    //   - all providers support password → always use the embedded login window
    //     (password providers require the dashboard login form; native PKCE
    //     can never complete for that provider shape)
    //   - advertises "native_pkce" AND at least one non-password provider →
    //     run the system-browser + loopback + PKCE flow
    //   - older gateway with no provider metadata → fall back to the auth_flows
    //     check (existing compatibility)
    //   - a failed native login reports the error rather than auto-falling back
    //     to the embedded flow — one sign-in action opens at most one window.
    const baseUrl = normalizeRemoteBaseUrl(rawUrl)

    let statusBody: any = null

    try {
      statusBody = await fetchPublicJson(`${baseUrl}/api/status`, { timeoutMs: 8_000 })
    } catch {
      // Can't read status — fall through to the embedded flow, which has its
      // own error handling and works against any gated gateway.
    }

    const authRequired = statusBody && authModeFromStatus(statusBody) === 'oauth'
    const providers = authRequired ? await gatewayAuthProviders(baseUrl) : []

    const strategy = resolveLoginStrategy(statusBody, { providers })

    if (strategy === 'native') {
      try {
        const tokens = await runNativeLogin(baseUrl, {
          openExternal: url => shell.openExternal(url),
          postJson: (url, body, opts) => postJsonNoAuth(url, body, opts),
          rememberLog
        })

        _storeNativeTokens(baseUrl, tokens)
        // Confirmed sign-in — release the reauth latch so the next
        // startHermes() re-dials instead of replaying the stale rejection.
        bootState.remoteReauthFailure = null

        return { ok: true, baseUrl, connected: true }
      } catch (error) {
        rememberLog(`[native-oauth] native login failed (${error instanceof Error ? error.message : String(error)})`)

        return { ok: false, error: error instanceof Error ? error.message : String(error), connected: false }
      }
    }

    // Legacy embedded-webview cookie flow.
    await openOauthLoginWindow(baseUrl)

    const connected = await hasOauthSessionCookie(baseUrl)

    // Only a CONFIRMED sign-in releases the latch. A cancelled/closed login
    // window must leave it set, or the overlay's "Sign in" button starts
    // flickering again on the next retry.
    if (connected) {
      bootState.remoteReauthFailure = null
    }

    return { ok: true, baseUrl, connected }
  })
  ipcMain.handle('hermes:connection-config:oauth-logout', async (_event, rawUrl) => {
    const baseUrl = normalizeRemoteBaseUrl(rawUrl)
    await clearOauthSession(baseUrl)

    // Also drop any native (RFC 8252) bearer tokens for this gateway so a
    // logout clears BOTH auth shapes.
    _clearNativeTokens(baseUrl)

    // Report against the SAME liveness notion the Settings indicator uses
    // (AT-or-RT cookie, or a native token) so a logout that left any session
    // behind is reflected as still-connected rather than silently signed-out.
    const connected = (await hasLiveOauthSession(baseUrl)) || hasNativeSession(baseUrl)

    return { ok: true, connected }
  })

  // --- Hermes Cloud (cloud-auto-discovery Phase 3) ---
  // One portal login in the OAuth partition powers both discovery and the silent
  // per-agent cascade. See the discovery/cascade helpers above.
  ipcMain.handle('hermes:cloud:status', async () => ({
    portalBaseUrl: resolvePortalBaseUrl(),
    signedIn: await hasLivePortalSession()
  }))
  ipcMain.handle('hermes:cloud:login', async () => {
    await openPortalLoginWindow()

    return { ok: true, signedIn: await hasLivePortalSession() }
  })
  ipcMain.handle('hermes:cloud:logout', async () => {
    await clearOauthSession(resolvePortalBaseUrl())

    return { ok: true, signedIn: await hasLivePortalSession() }
  })
  ipcMain.handle('hermes:cloud:discover', async (_event, org) => {
    // Returns { agents } or { needsOrgSelection: true, orgs }. `org` (optional)
    // scopes discovery to a chosen org for multi-org users.
    return discoverCloudAgents(typeof org === 'string' && org ? org : undefined)
  })
  ipcMain.handle('hermes:cloud:agent-sign-in', async (_event, dashboardUrl) => {
    // Silent per-agent sign-in via the shared portal session. Returns the agent's
    // gateway baseUrl + whether its session cookie landed; the renderer then
    // saves a cloud-mode connection pointed at this dashboardUrl.
    return cloudAgentSilentSignIn(dashboardUrl)
  })
  ipcMain.handle('hermes:connection-config:save', async (_event, payload) => {
    assertCanMutateManagedPrimaryRouting()
    const config = coerceDesktopConnectionConfig(payload)
    writeDesktopConnectionConfig(config)

    return sanitizeDesktopConnectionConfig(config, payload?.profile)
  })
  ipcMain.handle('hermes:connection-config:apply', async (_event, payload) => {
    assertCanMutateManagedPrimaryRouting()
    const previousConfig = readDesktopConnectionConfig()
    const previousRegistry = readDesktopConnectionsRegistry()
    const config = coerceDesktopConnectionConfig(payload, previousConfig)

    const key = connectionScopeKey(payload?.profile)
    const scope = key || ''
    const nextRegistry = key ? previousRegistry : reconcileAppliedGlobalConnection(previousRegistry, config)

    await applyConnectionConfigAtomically({
      previousConfig,
      previousRegistry,
      nextConfig: config,
      nextRegistry,
      // Exercise the same authenticated REST + real WebSocket legs before either
      // config file changes. A rejected OAuth session or blocked /api/ws leaves
      // the previous primary/current connection intact.
      preflight: !key && modeIsRemoteLike(config.mode) ? () => testDesktopConnectionConfig(payload) : undefined,
      writeConfig: writeDesktopConnectionConfig,
      writeRegistry: writeDesktopConnectionsRegistry,
      apply: () =>
        applyConnectionChange({
          cancelAndWait: value => sshBootstrapCoordinator.cancelAndWait(value),
          isPrimary: !key || key === primaryProfileKey(),
          rehomePrimary: () =>
            rehomePrimaryConnection({
              clearLocalBootstrapFailure: () => {
                // A remote connection bypasses local runtime/bootstrap failures. Clear
                // the local-install latch so unsupported/failure escape paths can re-home.
                bootState.bootstrapFailure = null
              },
              mode: config.mode,
              notifyConnectionApplied: sendConnectionApplied,
              resumeFirstRunRemote: abandonFirstRunSetupChoiceForRemoteApply,
              teardownPrimaryBackend: teardownPrimaryBackendAndWait
            }),
          scope,
          sendApplied: sendConnectionApplied,
          stopPool: stopPoolBackend,
          teardownPrimary: () => teardownPrimaryBackendAndWait({ soft: true }),
          teardownSsh: value => teardownSshConnection(value || null)
        })
    })

    return sanitizeDesktopConnectionConfig(config, payload?.profile)
  })

  ipcMain.handle('hermes:profile:get', async () => ({ profile: readActiveDesktopProfile() }))
  // Persistence-only sibling of hermes:profile:set: records the profile the
  // Desktop should boot into next launch WITHOUT tearing down the backend or
  // reloading the window — the rail's live workspace switch already re-homed
  // the gateway (#79886).
  ipcMain.handle('hermes:profile:remember', async (_event, name) => ({
    profile: writeActiveDesktopProfile(name)
  }))
  ipcMain.handle('hermes:profile:set', async (_event, name) => {
    assertCanMutateManagedPrimaryRouting()
    const next = writeActiveDesktopProfile(name)

    // Switching profiles is a backend re-home: relaunch the dashboard under the
    // new HERMES_HOME. Pool backends keep their own homes, so only the primary
    // is torn down.
    await teardownPrimaryBackendAndWait()
    windowsState.mainWindow?.reload()

    return { profile: next }
  })
}
