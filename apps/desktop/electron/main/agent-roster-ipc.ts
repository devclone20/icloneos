// IPC: the union agent roster, registry gateway URLs and managed updates.
import crypto from 'node:crypto'

import { ipcMain } from 'electron'

import { coerceString } from '../../src/iclone-shared/guards'
import { buildGatewayWsUrlWithTicket, gatewayWsUrlIpcResult } from '../connection-config'
import type { RegistryConnection } from '../connection-registry'
import {
  backendScopeKey,
  buildAgentRoster,
  rememberSshEnumeration,
  resolveRegistryLocalRoute,
  shouldDeferLocalEnumeration,
  updateEligibility
} from '../connection-registry'
import type { RosterProfileMetadata } from '../connection-registry'
import { refusedManagedSshUpdate } from '../managed-ssh-update'
import {
  buildRegistryProfileRoutes,
  isLocalEnumerationFailure,
  localRouteFallbackProfiles,
  undialedSshRouteSeeds
} from '../plugin-profile-routes'
import { createRegistryGatewayWsUrlHandler } from '../remote-ws-headers'

import { getJsonForBackend, postJsonForBackend, primaryProfileKey, probeConnectionInstallId } from './backend'
import { ensureRegistryBackend, updateManagedSshConnection } from './backend-routing'
import type { backendDialClaims, backendPool } from './backend-state'
import { managedConnectionUpdates, readDesktopConnectionsRegistry, sshRosterCache } from './connection-config'
import { mintGatewayWsTicket } from './gateway-files'
import { managedConnectionUpdateGate, probeSshProfileInventory } from './managed-ssh'
import { globalRemoteActive, profileHasRemoteOverride } from './remote'
import { rememberRemoteWsHeaders } from './secrets'
import { applyUpdates } from './update-apply'

/** One row of a backend GET /api/profiles body; every field is checked before use. */
interface ProfilesResponseRow {
  name?: unknown
  display_name?: unknown
  title?: unknown
  ui_meta?: Record<string, unknown> | null
  has_avatar?: unknown
}

interface AgentRosterIpcDeps {
  backendDialClaims: typeof backendDialClaims
  backendPool: typeof backendPool
}

async function enumerateRegistryAgentSources(
  { backendDialClaims, backendPool }: Pick<AgentRosterIpcDeps, 'backendDialClaims' | 'backendPool'>,
  registry = readDesktopConnectionsRegistry()
) {
  // One dead source must not wedge the whole roster: ensureRegistryBackend on
  // an unreachable remote can block up to the 45s readiness timeout, and the
  // Bot Mode poll runs every 5s — each poll queued behind the dead dial, so
  // the renderer painted stale rows for the entire outage (and the roster IPC
  // hung >30s in live repro). Bound each source's enumeration; a timeout is
  // reported like any other unreachable source and retried on the next poll.
  const perSourceTimeoutMs = 10_000

  const withEnumerationDeadline = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('roster enumeration timed out')), perSourceTimeoutMs)
        })
      ])
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }

  return Promise.all(
    registry.connections.map(async (connection: RegistryConnection) => {
      let raw: {
        connection: typeof connection
        error?: string
        installId?: string
        profiles: null | string[]
        profileMetadata?: Record<string, RosterProfileMetadata>
      }

      try {
        // SSH roster listing must never spawn a dashboard. A stale
        // sshConnections key used to fall into ensureRegistryBackend and
        // respawn Spark/Mini every Bot Mode poll (~5s), then the mux died
        // (ECONNRESET / liveness probe drop).
        if (connection.kind === 'ssh') {
          await probeSshProfileInventory(connection)
          raw = { connection, profiles: null, error: 'connect-on-demand' }
        } else {
          // Same connect-on-demand courtesy for the forced-local path: when
          // the primary route is remote, enumerating "This device" would
          // SPAWN a local backend this user has never asked for — a phantom
          // `default` agent that also forces -device handle disambiguation
          // onto the real one (remote-gateway-only desktops showed their main
          // agent twice, Aug 17 2026). Enumerate the local source only when
          // it is the delegate route (local-primary desktops, unchanged
          // behavior) or a forced-local child is ALREADY pooled (the user
          // opened one).
          if (connection.kind === 'local') {
            const localRoute = resolveRegistryLocalRoute('default', {
              globalRemote: globalRemoteActive(),
              profileRemoteOverride: Boolean(profileHasRemoteOverride(primaryProfileKey()))
            })

            if (shouldDeferLocalEnumeration(localRoute, backendPool.keys(), connection.id)) {
              return { connection, profiles: null, error: 'connect-on-demand' }
            }
          }

          // Claim-guarded (#90812): this ~5s roster poll can race a renderer's
          // own reconnect dial for the same connection; coalescing avoids
          // bootstrapping a second SSH tunnel / remote dashboard.
          const descriptor: any = await withEnumerationDeadline(
            Promise.resolve(
              backendDialClaims.run(backendScopeKey(connection.id, null), () =>
                ensureRegistryBackend(connection.id, null)
              )
            )
          )

          const body: any = await getJsonForBackend(descriptor, '/api/profiles', { timeoutMs: 8_000 })

          // Cached with a TTL, so the 5s roster poll usually pays zero extra
          // requests for the backend-identity probe.
          const installId = await probeConnectionInstallId(connection.id, descriptor)

          const profiles = Array.isArray(body?.profiles)
            ? body.profiles.map((p: ProfilesResponseRow | null) => String(p?.name || '').trim()).filter(Boolean)
            : []

          const profileMetadata = Array.isArray(body?.profiles)
            ? Object.fromEntries(
                body.profiles
                  .map((profile: ProfilesResponseRow | null) => {
                    const name = String(profile?.name || '').trim()

                    if (!name) {
                      return null
                    }

                    const metadata: RosterProfileMetadata = {}

                    if (typeof profile?.display_name === 'string' && profile.display_name.trim()) {
                      metadata.display_name = profile.display_name.trim()
                    }

                    if (typeof profile?.title === 'string' && profile.title.trim()) {
                      metadata.title = profile.title.trim()
                    }

                    if (profile?.ui_meta && typeof profile.ui_meta === 'object') {
                      metadata.ui_meta = profile.ui_meta
                    }

                    if (typeof profile?.has_avatar === 'boolean') {
                      metadata.has_avatar = profile.has_avatar
                    }

                    return [name, metadata] as const
                  })
                  .filter((entry: unknown): entry is readonly [string, RosterProfileMetadata] => Boolean(entry))
              )
            : undefined

          // The root HERMES_HOME is an agent too; enumerations that omit it
          // (older backends list only named profiles) still get a default row.
          if (!profiles.includes('default')) {
            profiles.unshift('default')
          }

          raw = {
            connection,
            profiles,
            ...(installId ? { installId } : {}),
            ...(profileMetadata ? { profileMetadata } : {})
          }
        }
      } catch (error: any) {
        raw = { connection, profiles: null, error: String(error?.message || error) }
      }

      if (raw.profiles && raw.profiles.length > 0) {
        sshRosterCache.set(connection.id, raw.profiles)
      }

      const remembered = rememberSshEnumeration(raw, sshRosterCache.get(connection.id), connection.kind)

      return {
        connection,
        ...remembered,
        ...(raw.installId ? { installId: raw.installId } : {}),
        ...(raw.profileMetadata ? { profileMetadata: raw.profileMetadata } : {})
      }
    })
  )
}

// Registry-scoped fresh WS URL: the (connectionId, profile) analogue of
// hermes:gateway:ws-url. Same single-use-ticket discipline for OAuth sources.
const registryGatewayWsUrlHandler = createRegistryGatewayWsUrlHandler({
  ensureBackend: (connectionId, profile) => ensureRegistryBackend(connectionId, coerceString(profile) ?? null),
  mintTicket: mintGatewayWsTicket,
  buildTicketUrl: buildGatewayWsUrlWithTicket,
  rememberHeaders: rememberRemoteWsHeaders
})

// Transactional update for a Desktop-managed SSH install. Unlike the generic
// fleet fan-out below, this path owns the remote serve lifecycle: it gates new
// dials, drains only exact Desktop-owned processes, runs the launcher outside
// those serves, proves the correlated receipt, and restores every prior scope.
async function requestManagedSshUpdate(rawId: string) {
  const connectionId = String(rawId || '').trim()
  const existing = managedConnectionUpdates.get(connectionId)

  if (existing) {
    return existing
  }

  const correlationId = crypto.randomUUID()
  const registry = readDesktopConnectionsRegistry()
  const source = registry.connections.find(connection => connection.id === connectionId)

  if (!source) {
    return refusedManagedSshUpdate(connectionId, correlationId, `No connection with id "${connectionId}".`)
  }

  if (source.kind !== 'ssh') {
    return refusedManagedSshUpdate(
      connectionId,
      correlationId,
      'Only registered Desktop-managed SSH connections can use this update lifecycle.'
    )
  }

  if (!managedConnectionUpdateGate.claim(connectionId, correlationId)) {
    return refusedManagedSshUpdate(connectionId, correlationId, 'A managed update is already in progress.')
  }

  const operation = (async () => {
    try {
      return await updateManagedSshConnection(source, correlationId)
    } catch (error: any) {
      return refusedManagedSshUpdate(connectionId, correlationId, String(error?.message || error))
    } finally {
      managedConnectionUpdateGate.release(connectionId, correlationId)
      managedConnectionUpdates.delete(connectionId)
    }
  })()

  managedConnectionUpdates.set(connectionId, operation)

  return operation
}

export function registerAgentRosterIpc({ backendDialClaims, backendPool }: AgentRosterIpcDeps): void {
  ipcMain.handle('hermes:plugin-profile-routes', async (_event, rawProfileNames) => {
    const fallbackProfileNames = Array.isArray(rawProfileNames)
      ? rawProfileNames
          .filter(name => typeof name === 'string')
          .map(name => name.trim())
          .filter(Boolean)
          .slice(0, 256)
      : []

    const registry = readDesktopConnectionsRegistry()
    const enumerations = await enumerateRegistryAgentSources({ backendDialClaims, backendPool }, registry)
    let agents = buildAgentRoster(enumerations, { primaryConnectionId: registry.primary })

    // Roster enumeration deliberately does not dial connect-on-demand SSH
    // sources. Publish one credential-free seed route so a plugin can be the
    // first caller that opens the tunnel.
    const sshSeeds = undialedSshRouteSeeds(agents, registry.connections)

    if (sshSeeds.length > 0) {
      agents = [
        ...agents,
        ...sshSeeds.map(seed => {
          const source = registry.connections.find(connection => connection.id === seed.connectionId)!

          return {
            connectionId: source.id,
            connectionKind: source.kind,
            connectionLabel: source.label,
            handle: seed.profile,
            profile: seed.profile
          }
        })
      ]
    }

    // A local enumeration can fail while remote/cloud sources succeed. Preserve
    // cached v1 profile names as explicitly-local rows so those valid routes do
    // not disappear and duplicate names remain source-qualified.
    const localSource = registry.connections.find(source => source.kind === 'local')

    const localEnumeration = localSource
      ? enumerations.find(({ connection }) => connection.id === localSource.id)
      : undefined

    const localFallbackProfiles = localSource
      ? localRouteFallbackProfiles(
          agents,
          localSource.id,
          fallbackProfileNames,
          isLocalEnumerationFailure(localEnumeration?.error)
        )
      : []

    if (localSource && localFallbackProfiles.length > 0) {
      agents = [
        ...agents,
        ...localFallbackProfiles.map(profile => ({
          connectionId: localSource.id,
          connectionKind: localSource.kind,
          connectionLabel: localSource.label,
          handle: profile,
          profile
        }))
      ]
    }

    return buildRegistryProfileRoutes({ agents, sources: registry.connections })
  })

  ipcMain.handle('hermes:agents:roster', async () => {
    const registry = readDesktopConnectionsRegistry()
    const enumerations = await enumerateRegistryAgentSources({ backendDialClaims, backendPool }, registry)

    return {
      agents: buildAgentRoster(enumerations, { primaryConnectionId: registry.primary }),
      // The active gateway owns the renderer's profiles.list — union agents
      // that report THIS connection are the same identities, not extra rows.
      // Expose the primary id so the plugin merger can annotate them in place
      // instead of appending duplicates (remote-only desktops doubled every
      // bot otherwise; see #88344).
      primaryConnectionId: registry.primary,
      sources: enumerations.map(({ connection, error, installId, profiles }) => ({
        connectionId: connection.id,
        label: connection.label,
        kind: connection.kind,
        reachable: profiles !== null,
        ...(installId ? { installId } : {}),
        ...(error ? { error } : {})
      }))
    }
  })

  ipcMain.handle('hermes:gateway:ws-url-for', async (_event, payload) => {
    return gatewayWsUrlIpcResult(() => registryGatewayWsUrlHandler(payload))
  })

  ipcMain.handle('hermes:connections:update-managed', async (_event, rawId) => requestManagedSshUpdate(rawId))

  // Fan out `hermes update` to every eligible registered connection at once.
  // Cloud entries are excluded (platform-managed); each dispatch reports
  // independently so one dead LAN box can't wedge the batch. Local reuses the
  // app's own update pipeline; Desktop-managed SSH uses the transactional
  // drain/update/restore lifecycle; URL remotes POST their backend updater.
  ipcMain.handle('hermes:connections:update-all', async (_event, payload) => {
    const registry = readDesktopConnectionsRegistry()

    // Optional renderer-side exclusions: the everything-update flow dispatches
    // the ACTIVE backend through its own detailed-progress path and chains the
    // local client apply LAST (it relaunches the app), so it excludes those ids
    // here to avoid double-dispatch. No payload keeps the Settings button's
    // original all-rows behavior byte-identical.
    const excludeIds = new Set<string>(
      Array.isArray((payload as any)?.excludeIds) ? (payload as any).excludeIds.map((id: unknown) => String(id)) : []
    )

    const results = await Promise.all(
      registry.connections
        .filter(connection => !excludeIds.has(connection.id))
        .map(async (connection: RegistryConnection) => {
          const base = { connectionId: connection.id, label: connection.label, kind: connection.kind }
          const eligibility = updateEligibility(connection)

          if (!eligibility.eligible) {
            return { ...base, ok: false, skipped: true, reason: eligibility.reason }
          }

          try {
            if (connection.kind === 'local') {
              // The app-managed runtime updates through the same pipeline as the
              // Settings → Updates button (marker + venv gate + relaunch flow).
              const result: any = await applyUpdates({})

              return { ...base, ok: result?.ok !== false, detail: result?.message || 'update started' }
            }

            if (connection.kind === 'ssh') {
              const result = await requestManagedSshUpdate(connection.id)

              return {
                ...base,
                ok: result.ok,
                detail: result.message,
                managed: result,
                ...(result.ok ? {} : { error: result.error || result.outcome })
              }
            }

            // Claim-guarded (#90812): coalesce with a concurrent renderer dial
            // for the same connection instead of bootstrapping a second backend.
            const descriptor: any = await backendDialClaims.run(backendScopeKey(connection.id, null), () =>
              ensureRegistryBackend(connection.id, null)
            )

            const body: any = await postJsonForBackend(descriptor, '/api/hermes/update', {}, { timeoutMs: 15_000 })

            if (body?.ok === false) {
              // The backend refused (docker/nix/externally-managed installs) —
              // surface ITS message, per-row, instead of failing the batch.
              return {
                ...base,
                ok: false,
                skipped: true,
                reason: body?.error || 'backend-refused',
                detail: body?.message
              }
            }

            return { ...base, ok: true, detail: body?.message || 'update started' }
          } catch (error: any) {
            return { ...base, ok: false, error: String(error?.message || error) }
          }
        })
    )

    return { ok: true, results }
  })
}
