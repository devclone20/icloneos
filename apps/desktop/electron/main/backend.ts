// Primary backend lifecycle helpers: status, reconnect, exit waits and profile routes.
import { BrowserWindow } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { stopBackendChild as stopBackendChildImpl } from '../backend-child'
import { type BackendOutputTail, claimDecision, pidOnlyStartMarker, probeStartMarker } from '../backend-claim'
import {
  connectionScopeKey,
  pathForRegistryBackendRequest,
  pathWithGlobalRemoteProfile,
  profileRemoteOverride,
  profileSshOverride
} from '../connection-config'
import { backendScopeKey } from '../connection-registry'
import { resolveDesktopRemoteRoute } from '../desktop-remote-route'
import { codePathEnv } from '../packaged-env'
import { registrySshScopeForWindowRoute } from '../window-connection-route'

import {
  backendOwnership,
  desktopParentStartMarker,
  forceKillProcessTree,
  type OwnedBackendChild
} from './backend-ownership'
import { type BackendConnection, backendConnectionState, remoteLiveness, windowConnectionRoutes } from './backend-state'
import { resetBootProgressForReconnect } from './boot-progress'
import {
  connectionInstallIds,
  INSTALL_ID_NEGATIVE_TTL_MS,
  INSTALL_ID_TTL_MS,
  readActiveDesktopProfile,
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry,
  rememberConnectionInstallId,
  sshConnections
} from './connection-config'
import { IS_WINDOWS } from './env'
import type { GatewayFileConnection } from './gateway-files'
import { fetchJson } from './http'
import { rememberLog } from './log'
import { sshScopeKey } from './managed-ssh'
import { ensureNativeAccessToken, fetchJsonViaOauthSession } from './oauth'
import { globalRemoteActive, profileHasRemoteOverride } from './remote'
import { bootState, connectionRuntimeState, windowsState } from './state'

export async function claimBackendChild(
  child: OwnedBackendChild,
  command: string,
  profile: string,
  nonce: string,
  outputTail: BackendOutputTail | null = null
) {
  // Probe/claim policy lives in backend-claim.ts (#93608): a marker probe
  // that fails against a LIVE child degrades to PID-only identity — matching
  // createParentStartMarkerResolver — instead of killing a healthy backend
  // over a flaky Get-Process (PS 5.1 cold starts, #87169). Only a child that
  // actually died keeps the fail-closed throw, now carrying its stderr tail.
  if (child.pid === undefined) {
    throw new Error(`Hermes backend did not spawn (no PID)${outputTail?.describe() ?? ''}`)
  }

  const probe = await probeStartMarker(child.pid)
  const decision = claimDecision(child.exitCode === null && !child.killed, probe)

  if (decision.action === 'fail') {
    stopBackendChild(child)
    await waitForBackendExit(child)
    throw new Error(
      `Hermes backend (PID ${child.pid}) died before its identity could be recorded: ${decision.reason}${outputTail?.describe() ?? ''}`
    )
  }

  let startMarker

  if (decision.action === 'degrade') {
    startMarker = pidOnlyStartMarker(child.pid)
    rememberLog(
      `WARNING: process start marker probe failed for live Hermes backend PID ${child.pid}; ` +
        `claiming with PID-only identity instead of stopping it: ${decision.reason}`
    )
  } else {
    startMarker = decision.startMarker
  }

  try {
    const identity = await backendOwnership.claim({
      command,
      nonce,
      pid: child.pid,
      profile,
      startMarker,
      // Record the spawning Electron so reapOrphans can tell an orphaned
      // backend (parent gone) from one owned by a live instance — a live
      // parent's backend is never reaped (#87295).
      parentPid: process.pid,
      parentStartMarker: (await desktopParentStartMarker()) ?? undefined
    })

    child.hermesBackendIdentity = identity

    return identity
  } catch (error) {
    stopBackendChild(child)
    await waitForBackendExit(child)
    throw new Error(
      `Could not persist ownership for the Hermes backend: ${errorMessage(error)}${outputTail?.describe() ?? ''}`
    )
  }
}

export function gatewayFileRequestPath(
  connection: GatewayFileConnection,
  connectionId: null | string,
  profile: null | string,
  requestPath: string
) {
  return connectionId
    ? pathForRegistryBackendRequest(requestPath, profile, connection)
    : pathWithGlobalRemoteProfile(requestPath, profile, profileRouteOptions(profile))
}

// CRITICAL: this must mirror resolveRemoteBackend's precedence, not just return
// any cached SSH state. A per-profile token/OAuth override wins over a global
// SSH connection — so if the active profile resolves to a NON-SSH backend, the
// terminal must NOT fall through to a global SSH host.
export function activeSshTerminalTarget(webContentsId?: number) {
  const windowRoute = typeof webContentsId === 'number' ? windowConnectionRoutes.get(webContentsId) : null

  if (windowRoute?.registryScoped && windowRoute.connectionId) {
    const scope = registrySshScopeForWindowRoute(windowRoute, readDesktopConnectionsRegistry())

    if (!scope) {
      return null
    }

    const state = sshConnections.get(scope)

    return state && state.ssh ? { ssh: state.ssh, scope } : 'pending'
  }

  const profile = windowRoute?.profile ?? primaryProfileKey()
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

  if (!route || route.kind !== 'ssh') {
    return null
  }

  const scope = route.connectionId
    ? backendScopeKey(route.connectionId, profile)
    : sshScopeKey(route.source === 'profile' ? profile : null)

  const state = sshConnections.get(scope)

  return state && state.ssh ? { ssh: state.ssh, scope } : 'pending'
}

// True when the PRIMARY profile's backend resolves to a remote/cloud host —
// i.e. resolveRemoteBackend(primaryProfileKey()) would return a descriptor
// rather than null. Mirrors that function's precedence (per-profile override →
// env → global) so a startHermes() failure can be classified as remote (never
// latch — transient, must stay retryable) vs local (latch to break install
// loops) BEFORE the throwing resolve/mint runs.
export function primaryBackendIsRemote() {
  return Boolean(profileHasRemoteOverride(primaryProfileKey())) || globalRemoteActive()
}

// backend-child's KillableChild types `kill` as `(signal: string) => void`; ChildProcess.kill takes NodeJS.Signals | number.
type KillableChild = Parameters<typeof stopBackendChildImpl>[0]

export function stopBackendChild(child: OwnedBackendChild | null | undefined) {
  stopBackendChildImpl(child as KillableChild, { forceKillProcessTree, isWindows: IS_WINDOWS })
}

// Soft gateway-mode apply: tear down the primary without resetting boot UI or
// reloading the renderer. The shell stays up; the renderer wipes session lists
// (so skeletons retrigger) and re-dials. Distinct from hard re-home (profile
// switch / crash recovery), which still resets boot progress + reloads.
export function resetHermesConnection({ soft = false } = {}) {
  bootState.backendStartFailure = null
  bootState.remoteReauthFailure = null
  remoteLiveness.clear()
  const hermesProcess = backendConnectionState.invalidate()
  stopBackendChild(hermesProcess)

  if (!soft) {
    resetBootProgressForReconnect()
  }
}

// Re-home the primary backend: reset connection state, then wait for the live
// dashboard process to actually exit (SIGKILL after 5s) so the next
// startHermes() spawns fresh instead of racing the dying one. Shared by the
// connection-config and profile switch flows.
export async function teardownPrimaryBackendAndWait({ soft = false } = {}) {
  // Capture the reference before resetHermesConnection() invalidates it.
  const hermesProcess = backendConnectionState.getProcess()
  const dying = hermesProcess && !hermesProcess.killed ? hermesProcess : null

  if (soft) {
    connectionRuntimeState.softRehomeInProgress = true
  }

  try {
    resetHermesConnection({ soft })
    await waitForBackendExit(dying)
  } finally {
    if (soft) {
      connectionRuntimeState.softRehomeInProgress = false
    }
  }
}

export function sendConnectionApplied() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:connection:applied')
}

// Registry lifecycle push: a connection was removed or materially edited, so
// every window must tear down (and, for edits, re-dial) its secondary sockets
// scoped to that connection. Without this, a removed remote/cloud source keeps
// its renderer WebSocket open and streaming as a ghost, and an edited one
// keeps talking to the OLD endpoint until idle-reap.
export function broadcastConnectionsChanged(payload: {
  connectionId: string
  reason: 'removed' | 'saved' | 'updated'
}) {
  for (const win of BrowserWindow.getAllWindows()) {
    const { webContents } = win

    if (webContents && !webContents.isDestroyed()) {
      webContents.send('hermes:connections:changed', payload)
    }
  }
}

export async function waitForBackendExit(child: OwnedBackendChild | null | undefined, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = () => child.exitCode !== null || child.signalCode !== null

  const wait = (delay: number) =>
    new Promise<void>(resolve => {
      if (exited()) {
        resolve()

        return
      }

      const timer = setTimeout(resolve, delay)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

  await wait(timeoutMs)

  if (exited()) {
    return
  }

  try {
    if (IS_WINDOWS && typeof child.pid === 'number' && Number.isInteger(child.pid)) {
      forceKillProcessTree(child.pid)
    } else if (typeof child.pid === 'number' && Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    return
  }

  // Await the escalation as well; do not let shutdown or failed adoption race
  // a still-running backend.
  await wait(1000)
}

// The profile the primary (window) backend runs as. readActiveDesktopProfile()
// returns the desktop's stored preference, or null when unset (legacy launch
// that defers to active_profile / default).
export function primaryProfileKey() {
  return readActiveDesktopProfile() || 'default'
}

// Options describing the current connection setup for `resolveProfileBackendRoute`.
export function profileRouteOptions(profile: string | null, request?: { method?: string; path?: string }) {
  const config = readDesktopConnectionConfig()
  const sshOverride = profileSshOverride(config, profile)
  const key = connectionScopeKey(profile) || primaryProfileKey()

  return {
    // A desktop profile can be only a client-side routing alias. Keep backend
    // endpoint filters in the SSH target's namespace (e.g. mara → default).
    backendProfile: sshOverride?.remoteProfile,
    globalRemote: globalRemoteActive(),
    primaryProfile: primaryProfileKey(),
    profileRemoteOverride: Boolean(profileRemoteOverride(config, profile) || sshOverride),
    // The primary profile's own backend resolves to a remote host (its
    // per-profile override, env, or global). Unknown sub-profiles on that
    // gateway must route THROUGH it, not spawn local backends (#88296).
    primaryRemoteActive: primaryBackendIsRemote(),
    // A stored per-profile entry (local or remote) — pins this profile to
    // its own backend; absent entries inherit the primary's remote.
    ownEntry: Boolean((config.profiles || {})[key]),
    requestMethod: request?.method,
    requestPath: request?.path
  }
}

export async function probeConnectionInstallId(connectionId: string, descriptor: any): Promise<string | undefined> {
  const cached = connectionInstallIds.get(connectionId)

  if (cached && Date.now() - cached.ts < (cached.id ? INSTALL_ID_TTL_MS : INSTALL_ID_NEGATIVE_TTL_MS)) {
    return cached.id
  }

  try {
    const status: any = await getJsonForBackend(descriptor, '/api/status', { timeoutMs: 8_000 })

    return rememberConnectionInstallId(connectionId, status)
  } catch {
    // Keep any previously-known id (identity is stable; a transient fetch
    // failure must not flap the roster collapse), but do not cache a MISS
    // over it.
    if (cached?.id) {
      return cached.id
    }

    connectionInstallIds.set(connectionId, { id: undefined, ts: Date.now() })

    return undefined
  }
}

// Convenience wrappers around the bearer-aware descriptor request path.
// Native OAuth sessions are cookieless, so these must not bypass
// fetchJsonForBackend and fall straight through to the cookie partition.
export async function postJsonForBackend(descriptor: BackendConnection, path: string, body: unknown, opts: any = {}) {
  return fetchJsonForBackend(descriptor, path, { ...opts, body: body ?? {}, method: 'POST' })
}

// GET twin of postJsonForBackend.
export async function getJsonForBackend(descriptor: BackendConnection, path: string, opts: any = {}) {
  return fetchJsonForBackend(descriptor, path, opts)
}

// Any-method REST call against a resolved backend descriptor — the descriptor
// analogue of the hermes:api handler's own auth split: OAuth backends prefer a
// native bearer (cookieless RFC 8252 flow) and fall back to the OAuth cookie
// partition; token/local descriptors use the static session-token header.
export async function fetchJsonForBackend(
  descriptor: BackendConnection,
  path: string,
  opts: { method?: string; body?: unknown; upload?: unknown; timeoutMs?: number } = {}
) {
  const url = `${descriptor.baseUrl}${path}`

  if (descriptor.authMode === 'oauth') {
    // The OAuth cookie path rides electron.net with JSON headers; multipart
    // isn't wired there. Fail loudly rather than corrupting the upload.
    if (opts.upload) {
      throw new Error('File uploads are not supported against OAuth-gated remote backends yet.')
    }

    const nativeAt = await ensureNativeAccessToken(descriptor.baseUrl).catch(() => null)

    if (nativeAt) {
      return fetchJson(url, null, {
        method: opts.method,
        body: opts.body,
        timeoutMs: opts.timeoutMs,
        bearer: nativeAt,
        headers: descriptor.headers
      })
    }

    return fetchJsonViaOauthSession(url, {
      method: opts.method,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
      headers: descriptor.headers
    })
  }

  return fetchJson(url, descriptor.token, {
    method: opts.method,
    body: opts.body,
    upload: opts.upload,
    timeoutMs: opts.timeoutMs,
    headers: descriptor.headers
  })
}
