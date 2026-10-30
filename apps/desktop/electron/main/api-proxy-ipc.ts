// IPC: the Hermes API proxy across local, pooled and remote backends.
import { ipcMain } from 'electron'

import {
  apiRequestRegistryConnectionId,
  pathForRegistryBackendRequest,
  resolveProfileApiRequest
} from '../connection-config'
import { backendScopeKey, backendScopePrefix } from '../connection-registry'
import { DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs } from '../hardening'
import { resolveOauthRestAuth } from '../native-auth-decisions'
import {
  dispatchConnectionScopedProfileDelete,
  profileNameFromDeleteRequest,
  resolveRouteProfile
} from '../profile-delete-routing'
import { profileRenameFromRequest } from '../profile-rename-routing'
import {
  buildSidebarSessionSliceParams,
  fetchPrimaryProfileSessions,
  fetchRegistrySessionRows,
  fetchRemoteProfileSessions,
  findRemoteOwnerProfileForSession,
  mergeProfileSessionWindow,
  type RegistrySessionSource,
  spliceRegistrySessionRows,
  tagRegistrySessionResponse
} from '../profile-session-routing'

import { fetchJsonForBackend, getJsonForBackend, profileRouteOptions } from './backend'
import type { poolStopper, prepareProfileDeleteRequest } from './backend-pool'
import {
  ensureBackend,
  ensureRegistryBackend,
  fetchJsonForProfile,
  prepareProfileRenameRequest,
  requestJsonForProfile
} from './backend-routing'
import type { BackendConnection } from './backend-state'
import type { backendDialClaims, backendPool, profileDeletionGate } from './backend-state'
import { readDesktopConnectionsRegistry } from './connection-config'
import { PROFILE_NAME_RE } from './env'
import { fetchJson } from './http'
import { rememberLog } from './log'
import { sshBootstrapCoordinator, teardownSshConnection } from './managed-ssh'
import { ensureNativeAccessToken, fetchJsonViaOauthSession } from './oauth'
import { configuredRemoteProfileNames, globalRemoteActive, profileHasRemoteOverride } from './remote'

interface ApiProxyIpcDeps {
  backendDialClaims: typeof backendDialClaims
  backendPool: typeof backendPool
  poolStopper: typeof poolStopper
  prepareProfileDeleteRequest: typeof prepareProfileDeleteRequest
  profileDeletionGate: typeof profileDeletionGate
}

// Re-route remote-profile session requests to the owning remote backend. Returns
// `undefined` when not interceptable (caller takes the normal local path), else
// the response. Reads tag the profile as ?profile=<name>; mutations carry it in
// request.profile. Either way, a remote profile's session lives only on its
// remote host, so the request must go there (where it serves its own state.db).
//   GET    /api/profiles/sessions        → splice each remote profile's rows in
//   GET    /api/sessions/{id}[/messages] → read from remote
//   DELETE /api/sessions/{id}            → delete on remote
//   PATCH  /api/sessions/{id}            → rename/archive on remote
/** The renderer's `hermes:api` payload; every field is optional because the bridge forwards whatever it got. */
type ApiProxyRequest = {
  path: string
  method?: string
  body?: Record<string, unknown>
  upload?: unknown
  profile: string | null
  connectionId?: string | null
  timeoutMs?: number
}

async function interceptSessionRequestForRemote(
  { backendPool }: Pick<ApiProxyIpcDeps, 'backendPool'>,
  request: ApiProxyRequest
) {
  if (typeof request?.path !== 'string') {
    return undefined
  }

  const method = (request.method || 'GET').toUpperCase()

  let parsed

  try {
    parsed = new URL(request.path, 'http://x')
  } catch {
    return undefined
  }

  const { pathname, searchParams } = parsed

  if (method === 'GET' && pathname === '/api/profiles/sessions') {
    const remoteProfiles = configuredRemoteProfileNames()
    const registrySources = await pooledRegistrySessionSources({ backendPool })

    if (remoteProfiles.length === 0 && registrySources.length === 0) {
      return undefined // no remote profiles and no connected registry gateways → local fast path
    }

    const requested = (searchParams.get('profile') || 'all').trim() || 'all'

    if (requested !== 'all') {
      return profileHasRemoteOverride(requested) ? remoteSessionList(requested, searchParams) : undefined
    }

    return mergeRemoteProfileSessions({ backendPool }, searchParams, remoteProfiles)
  }

  // Batched sidebar slices. With no remote profiles the local batched endpoint
  // (one DB open per profile) serves it directly — take the fast path. When
  // remotes exist, fan the three slices back out to the per-slice
  // /api/profiles/sessions path (which already merges remote rows correctly) and
  // reassemble; local profiles fall back to three primary reads there, but
  // remote correctness is preserved.
  if (method === 'GET' && pathname === '/api/profiles/sessions/sidebar') {
    const remoteProfiles = configuredRemoteProfileNames()
    const registrySources = await pooledRegistrySessionSources({ backendPool })

    if (remoteProfiles.length === 0 && registrySources.length === 0) {
      return undefined // local fast path → batched endpoint's single DB open
    }

    const { recents: recentsSp, cron: cronSp, messaging: messagingSp } = buildSidebarSessionSliceParams(searchParams)

    const [recents, cron, messaging] = await Promise.all([
      fetchProfilesSessionSlice({ backendPool }, recentsSp, remoteProfiles),
      fetchProfilesSessionSlice({ backendPool }, cronSp, remoteProfiles),
      fetchProfilesSessionSlice({ backendPool }, messagingSp, remoteProfiles)
    ])

    return {
      recents: {
        sessions: rowsOf(recents),
        total: Number(recents?.total) || 0,
        profile_totals: recents?.profile_totals || {}
      },
      cron: { sessions: rowsOf(cron) },
      messaging: {
        sessions: rowsOf(messaging),
        total: Number(messaging?.total) || rowsOf(messaging).length
      },
      errors: []
    }
  }

  // Per-session read/mutation. Owner is in ?profile= (reads) or request.profile
  // (mutations). Two remote shapes:
  //  - per-profile override: route to that profile's own remote, sans profile
  //    param (it serves its own state.db natively).
  //  - global remote mode: ONE backend serves every profile via ?profile=, so
  //    route there and KEEP the profile param so it opens the right state.db.
  if (/^\/api\/sessions\/[^/]+(\/messages)?$/.test(pathname)) {
    let profile = (searchParams.get('profile') || request.profile || '').trim()

    if (!profile) {
      // No explicit owner hint (#85834). The list endpoints above already know
      // which remote profile owns each row (remoteSessionList tags s.profile),
      // but a caller without a hint used to fall straight through to the LOCAL
      // backend and 404 on its state.db even though the session lives on a
      // remote. Consult the same remote lists to find the owner; only fall
      // through when the id is genuinely unknown remotely.
      const sessionId = decodeURIComponent(pathname.split('/')[3] || '')
      profile = (await remoteOwnerProfileForSession(sessionId)) || ''

      if (!profile) {
        return undefined
      }
    }

    // Preserve every non-profile query param (limit/offset/order pagination —
    // stripping them made getAllSessionMessages loop the same default page
    // against paginating remote backends).
    const passthroughParams = new URLSearchParams(searchParams)
    passthroughParams.delete('profile')
    const passthroughQuery = passthroughParams.toString()

    if (profileHasRemoteOverride(profile)) {
      if (method === 'GET') {
        return fetchJsonForProfile(profile, passthroughQuery ? `${pathname}?${passthroughQuery}` : pathname)
      }

      const body = request.body && typeof request.body === 'object' ? { ...request.body } : request.body

      if (body) {
        delete body.profile
      }

      return requestJsonForProfile(profile, pathname, method, body)
    }

    if (globalRemoteActive()) {
      // Single global backend: keep ?profile= so it opens the right state.db.
      passthroughParams.set('profile', profile)
      const path = `${pathname}?${passthroughParams.toString()}`

      if (method === 'GET') {
        return fetchJsonForProfile(null, path)
      }

      const body = request.body && typeof request.body === 'object' ? { ...request.body, profile } : { profile }

      return requestJsonForProfile(null, path, method, body)
    }

    return undefined
  }

  return undefined
}

const rowsOf = (data: Record<string, unknown>) => (Array.isArray(data?.sessions) ? data.sessions : [])

// A remote profile's session list, read from its remote host and tagged with the
// desktop-facing profile name (the remote's /api/sessions doesn't know it).
async function remoteSessionList(profile: string, searchParams: URLSearchParams) {
  const data = await fetchRemoteProfileSessions(profile, searchParams, fetchJsonForProfile)

  for (const s of rowsOf(data)) {
    s.profile = profile
    s.is_default_profile = false
  }

  return { ...(data as any), sessions: rowsOf(data) }
}

// #85834: find which remote profile owns a session id when the caller gave no
// profile hint (pure lookup lives in profile-session-routing.ts). Results are
// memoized briefly so a burst of hint-less reads (transcript + messages)
// costs one sweep across the configured remotes.
const remoteOwnerBySessionId = new Map<string, { at: number; profile: null | string }>()
const REMOTE_OWNER_CACHE_TTL_MS = 30_000

async function remoteOwnerProfileForSession(sessionId: string) {
  if (!sessionId) {
    return null
  }

  const remoteProfiles = configuredRemoteProfileNames()

  if (remoteProfiles.length === 0) {
    return null
  }

  const cached = remoteOwnerBySessionId.get(sessionId)

  if (cached && Date.now() - cached.at < REMOTE_OWNER_CACHE_TTL_MS) {
    return cached.profile
  }

  const owner = await findRemoteOwnerProfileForSession(sessionId, remoteProfiles, (profile, params) =>
    remoteSessionList(profile, params)
  ).catch(() => null)

  remoteOwnerBySessionId.set(sessionId, { at: Date.now(), profile: owner })

  return owner
}

// Resolve one /api/profiles/sessions slice with remote profiles spliced in —
// the same branch logic as the GET /api/profiles/sessions intercept, but always
// returns data (never `undefined`) so a batched caller can compose slices. A
// specific local profile reads from the local primary; a remote-override profile
// reads from its remote; 'all' merges every remote into the primary aggregate.
async function fetchProfilesSessionSlice(
  { backendPool }: Pick<ApiProxyIpcDeps, 'backendPool'>,
  searchParams: URLSearchParams,
  remoteProfiles: string[]
) {
  const requested = (searchParams.get('profile') || 'all').trim() || 'all'

  if (requested !== 'all') {
    if (profileHasRemoteOverride(requested)) {
      return remoteSessionList(requested, searchParams)
    }

    return fetchPrimaryProfileSessions(searchParams, fetchJsonForProfile)
  }

  return mergeRemoteProfileSessions({ backendPool }, searchParams, remoteProfiles)
}

// Unified list: primary's local aggregate, with each remote profile's stale local
// rows/totals swapped for the remote's real ones, re-sorted by recency and
// re-windowed to the requested page. A dead remote contributes nothing rather
// than breaking the sidebar. Connected registry gateways' sessions are spliced
// in too (#88880) — the unified Sessions list shows EVERY connected gateway's
// chats, tagged with connection_id + profile so opens route correctly.
async function mergeRemoteProfileSessions(
  { backendPool }: Pick<ApiProxyIpcDeps, 'backendPool'>,
  searchParams: URLSearchParams,
  remoteProfiles: string[]
) {
  const limit = Math.max(1, Number(searchParams.get('limit')) || 20)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const order = searchParams.get('order') === 'created' ? 'started_at' : 'last_active'

  const base = (await fetchPrimaryProfileSessions(searchParams, fetchJsonForProfile)) as any

  // Over-fetch each remote from offset 0 (limit+offset rows) so the merged window
  // is correct for this page — mirrors the primary's per-profile over-fetch.
  const remoteParams = new URLSearchParams(searchParams)
  remoteParams.set('limit', String(limit + offset))
  remoteParams.set('offset', '0')

  const remoteSet = new Set(remoteProfiles)
  const merged = rowsOf(base).filter(s => !remoteSet.has(s?.profile))
  const profileTotals = { ...(base.profile_totals || {}) }
  let total = (Number(base.total) || 0) - remoteProfiles.reduce((n, p) => n + (profileTotals[p] || 0), 0)

  // Swap each remote profile's stale local rows/total for the remote's real ones.
  await Promise.all(
    remoteProfiles.map(async name => {
      const list = await remoteSessionList(name, remoteParams).catch(() => null)

      if (!list) {
        delete profileTotals[name] // dead remote → drop its stale local total too

        return
      }

      const rows = rowsOf(list)
      merged.push(...rows)
      profileTotals[name] = Number(list.total) || rows.length
      total += profileTotals[name]
    })
  )

  // Registry gateways (v2 connections): splice every CONNECTED gateway's rows
  // into the unified list. Only already-pooled backends are read — a sidebar
  // refresh must never dial or spawn a backend (the Bot Mode roster-respawn
  // trap). Reads omit include_hidden, so Bot Mode's hidden canonical chats
  // stay out of the global list, same as local sessions.
  const registrySources = await pooledRegistrySessionSources({ backendPool })

  if (registrySources.length) {
    // connection-registry types the pooled descriptor as unknown; pooledRegistrySessionSources yields BackendConnections.
    const registryRows = await fetchRegistrySessionRows(registrySources, remoteParams, (descriptor, path) =>
      getJsonForBackend(descriptor as BackendConnection, path, { timeoutMs: 10_000 })
    )

    const { added } = spliceRegistrySessionRows(merged, registryRows, profileTotals)
    total += added
  }

  const recency = (s: Record<string, number | undefined> | null | undefined) => s?.[order] ?? s?.started_at ?? 0
  merged.sort((a, b) => recency(b) - recency(a))

  return {
    ...(base as any),
    sessions: mergeProfileSessionWindow(merged, offset, limit),
    total,
    profile_totals: profileTotals
  }
}

// Every CONNECTED registry gateway as a session source: resolved descriptors
// straight from the backend pool, never dialing. SSH sources contribute one
// backend per pooled (connection, profile) scope; remote/cloud sources are one
// shared host (any pooled scope's descriptor serves the cross-profile read).
// The primary local connection is excluded — the primary aggregate already
// carries local rows.
async function pooledRegistrySessionSources({
  backendPool
}: Pick<ApiProxyIpcDeps, 'backendPool'>): Promise<RegistrySessionSource[]> {
  const registry = readDesktopConnectionsRegistry()
  const sources: RegistrySessionSource[] = []

  for (const connection of registry.connections) {
    if (connection.kind === 'local') {
      continue
    }

    const prefix = backendScopePrefix(connection.id)

    const pooled = [...backendPool.entries()].filter(
      ([key, entry]) => key.startsWith(prefix) && entry.connectionPromise
    )

    if (pooled.length === 0) {
      continue
    }

    const backends: Array<{ descriptor: unknown; profileLabel: null | string }> = []

    for (const [key, entry] of connection.kind === 'ssh' ? pooled : pooled.slice(0, 1)) {
      try {
        // Already-resolved for a connected backend; a still-dialing entry is
        // skipped via the timeout guard rather than blocking the sidebar.
        const descriptor = await Promise.race([
          entry.connectionPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('pending')), 2_000))
        ])

        backends.push({
          descriptor,
          profileLabel: connection.kind === 'ssh' ? key.slice(prefix.length) || 'default' : null
        })
      } catch {
        // Dead or still-connecting backend — contributes nothing this refresh.
      }
    }

    if (backends.length) {
      sources.push({ backends, connectionId: connection.id, kind: connection.kind })
    }
  }

  return sources
}

async function dispatchRegistryApiRequest(
  { backendDialClaims }: Pick<ApiProxyIpcDeps, 'backendDialClaims'>,
  request: ApiProxyRequest,
  registryConnectionId: string,
  routeProfile = request?.profile,
  requestProfile = request?.profile
) {
  // Claim-guarded (#90812): every registry-scoped REST call funnels through
  // here, so it can race a renderer's own WS reconnect dial for the same
  // (connectionId, profile) scope; coalescing avoids bootstrapping a second
  // SSH tunnel / remote dashboard.
  const connection: any = await backendDialClaims.run(backendScopeKey(registryConnectionId, routeProfile), () =>
    ensureRegistryBackend(registryConnectionId, routeProfile)
  )

  const requestPath = pathForRegistryBackendRequest(request.path, requestProfile, connection)

  const response = await fetchJsonForBackend(connection, requestPath, {
    method: request?.method,
    body: request?.body,
    upload: request?.upload,
    timeoutMs: resolveTimeoutMs(request?.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
  })

  return (request?.method || 'GET').toUpperCase() === 'GET'
    ? tagRegistrySessionResponse(requestPath, response, registryConnectionId)
    : response
}

function registryConnectionKind(connectionId: string) {
  const registry = readDesktopConnectionsRegistry()
  const source = registry.connections.find(connection => connection.id === connectionId)

  if (!source) {
    throw new Error(`No connection with id "${connectionId}".`)
  }

  return source.kind
}

async function teardownConnectionScopedProfileBackend(
  { poolStopper }: Pick<ApiProxyIpcDeps, 'poolStopper'>,
  connectionId: string | null | undefined,
  profile: string | null | undefined
) {
  const key = backendScopeKey(connectionId, profile)
  await Promise.all([
    poolStopper.stop(key),
    sshBootstrapCoordinator.cancelAndWait(key).then(() => teardownSshConnection(key))
  ])
}

async function handleHermesApiRequest(
  {
    backendDialClaims,
    backendPool,
    prepareProfileDeleteRequest
  }: Pick<ApiProxyIpcDeps, 'backendDialClaims' | 'backendPool' | 'prepareProfileDeleteRequest'>,
  request: ApiProxyRequest
) {
  // Registry-pinned request (request.connectionId): the renderer is working
  // against a REGISTERED gateway connection, so the data — cron jobs and their
  // run sessions included — lives in THAT host's state.db, not any local
  // profile's. Resolve the backend through the registry (same pool the job
  // list and WS traffic use) instead of the legacy profile route; a shared
  // remote/cloud host serves every profile via ?profile=, so scope the path.
  // An absent/empty id falls through to the byte-identical v1 route below.
  // Explicit `local` stays registry-pinned so it cannot inherit a v1 remote.
  const registryConnectionId = apiRequestRegistryConnectionId(request)

  if (registryConnectionId) {
    return dispatchRegistryApiRequest({ backendDialClaims }, request, registryConnectionId)
  }

  // Remote-profile session requests would otherwise hit the local primary off
  // each profile's on-disk state.db — fine for local profiles, but a remote
  // profile's sessions live on its remote host, so the UI's IDs 404 (or mutations
  // no-op) the moment they run there. Route reads + mutations to the remote.
  const rerouted = await interceptSessionRequestForRemote({ backendPool }, request)

  if (rerouted !== undefined) {
    return rerouted
  }

  const profileRename = await prepareProfileRenameRequest(request)
  const tornDownProfile = await prepareProfileDeleteRequest(request)

  const profile = request?.profile
  // After tearing down a backend for profile deletion, route to the primary
  // backend instead of spawning a fresh pool backend.  A freshly spawned
  // backend calls ensure_hermes_home() which recreates the profile directory,
  // defeating the deletion and leaving a zombie process.
  //
  // Safe local-profile REST calls also stay on the primary dashboard and carry
  // ?profile=. Endpoints that cannot honor that scope retain their pooled
  // backend so a destructive call can never fall through to the primary home.
  //
  // A profile rename tears down the old-name backend the same way; for a
  // primary rename the lifecycle has already made `default` the temporary
  // primary until the PATCH settles, so the request routes there.
  const apiRoute = resolveProfileApiRequest(profile, request.path, profileRouteOptions(profile, request))

  const routeProfile = profileRename
    ? profileRename.routeProfile
    : resolveRouteProfile(tornDownProfile, apiRoute.backendProfile)

  let response

  try {
    const connection = await ensureBackend(routeProfile)
    const timeoutMs = resolveTimeoutMs(request?.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

    const url = `${connection.baseUrl}${apiRoute.requestPath}`

    // OAuth gateways authenticate REST via EITHER a native bearer token
    // (cookieless RFC 8252 flow) OR the HttpOnly session cookie held in the OAuth
    // partition. Prefer the native bearer when present (mirroring
    // mintGatewayWsTicket): the native flow never sets a cookie, so routing an
    // oauth-mode REST call through the cookie-only path returns 401 no_cookie even
    // though a valid bearer is held. Cookie mode rides Electron's net stack bound
    // to the OAuth partition so the cookie attaches automatically. Token/local
    // modes keep using the static session-token header.
    if (connection.authMode === 'oauth') {
      // The OAuth path rides electron.net with JSON headers; multipart isn't
      // wired there. Fail loudly rather than corrupting the upload.
      if (request?.upload) {
        throw new Error('File uploads are not supported against OAuth-gated remote backends yet.')
      }

      // Native bearer first (cookieless). ensureNativeAccessToken transparently
      // refreshes a near-expiry AT via /auth/native/refresh; a null return means
      // no native session (resolveOauthRestAuth then selects the cookie path).
      const nativeAt = await ensureNativeAccessToken(connection.baseUrl).catch(() => null)
      const restAuth = resolveOauthRestAuth(nativeAt)

      if (restAuth.kind === 'bearer') {
        response = await fetchJson(url, null, {
          method: request?.method,
          body: request?.body,
          timeoutMs,
          bearer: restAuth.token
        })
      } else {
        response = await fetchJsonViaOauthSession(url, {
          method: request?.method,
          body: request?.body,
          timeoutMs
        })
      }
    } else {
      response = await fetchJson(url, connection.token, {
        method: request?.method,
        body: request?.body,
        upload: request?.upload,
        timeoutMs
      })
    }
  } catch (error) {
    // A failed rename PATCH must not strand the app on the temporary primary:
    // restore the original active profile and restart its backend.
    if (profileRename) {
      try {
        await profileRename.rollback()
      } catch (rollbackError) {
        rememberLog(`Failed to restore primary profile after rename error: ${String(rollbackError)}`)
      }
    }

    throw error
  }

  await profileRename?.complete()

  return response
}

export function registerApiProxyIpc({
  backendDialClaims,
  backendPool,
  poolStopper,
  prepareProfileDeleteRequest,
  profileDeletionGate
}: ApiProxyIpcDeps): void {
  ipcMain.handle('hermes:api', async (_event, request) => {
    // Hold the deletion gate for BOTH profile deletes and renames: a concurrent
    // renderer reconnect entering ensureBackend() mid-mutation would otherwise
    // respawn the old-name backend and recreate its HERMES_HOME (#45474).
    const deletingProfile = profileNameFromDeleteRequest(request)
    const mutatingProfile = deletingProfile || profileRenameFromRequest(request)?.oldName || null
    const registryConnectionId = apiRequestRegistryConnectionId(request)

    if (deletingProfile && registryConnectionId) {
      return dispatchConnectionScopedProfileDelete(request, {
        acquire: profile => profileDeletionGate.acquire(profile),
        connectionKind: connectionId => registryConnectionKind(connectionId),
        dispatch: routeProfile =>
          dispatchRegistryApiRequest(
            { backendDialClaims },
            request,
            registryConnectionId,
            routeProfile,
            deletingProfile
          ),
        isDefaultProfile: profile => profile === 'default',
        isValidProfileName: profile => PROFILE_NAME_RE.test(profile),
        prepareLocal: localRequest => prepareProfileDeleteRequest(localRequest).then(() => undefined),
        teardownConnection: (connectionId, profile) =>
          teardownConnectionScopedProfileBackend({ poolStopper }, connectionId, profile)
      })
    }

    if (!mutatingProfile) {
      return handleHermesApiRequest({ backendDialClaims, backendPool, prepareProfileDeleteRequest }, request)
    }

    const releaseProfileDeletion = profileDeletionGate.acquire(mutatingProfile)

    return handleHermesApiRequest({ backendDialClaims, backendPool, prepareProfileDeleteRequest }, request).finally(
      releaseProfileDeletion
    )
  })
}
