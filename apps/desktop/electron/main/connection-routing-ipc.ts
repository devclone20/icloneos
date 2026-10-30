// IPC: per-window connection routing, revalidation and backend restarts.
import { ipcMain } from 'electron'

import { gatewayWsUrlIpcResult } from '../connection-config'
import { backendScopeKey, resolvedConnectionId } from '../connection-registry'
import { revalidateRemoteConnection } from '../remote-liveness'

import {
  fetchJsonForBackend,
  primaryProfileKey,
  resetHermesConnection,
  sendConnectionApplied,
  teardownPrimaryBackendAndWait
} from './backend'
import type { revalidatePool, touchPoolBackend } from './backend-pool'
import { ensureBackend, ensureRegistryBackend, freshGatewayWsUrl } from './backend-routing'
import type {
  backendConnectionState,
  backendDialClaims,
  remoteLiveness,
  remoteRevalidation,
  windowConnectionRouteOwners,
  windowConnectionRoutes
} from './backend-state'
import { readDesktopConnectionsRegistry } from './connection-config'
import { rememberLog } from './log'
import { resetPreviewReach, sshBootstrapCoordinator, sshScopeKey, teardownSshConnection } from './managed-ssh'
import { startHermes } from './start-hermes'

interface ConnectionRoutingIpcDeps {
  backendConnectionState: typeof backendConnectionState
  backendDialClaims: typeof backendDialClaims
  remoteLiveness: typeof remoteLiveness
  remoteRevalidation: typeof remoteRevalidation
  revalidatePool: typeof revalidatePool
  touchPoolBackend: typeof touchPoolBackend
  windowConnectionRouteOwners: typeof windowConnectionRouteOwners
  windowConnectionRoutes: typeof windowConnectionRoutes
}

export function registerConnectionRoutingIpc({
  backendConnectionState,
  backendDialClaims,
  remoteLiveness,
  remoteRevalidation,
  revalidatePool,
  touchPoolBackend,
  windowConnectionRouteOwners,
  windowConnectionRoutes
}: ConnectionRoutingIpcDeps): void {
  ipcMain.handle('hermes:connection', async (_event, profile) => {
    // Coalesce concurrent renderer dials for one profile scope (#90812): the
    // renderer-side reconnect lock is per-window, so two windows waking at once
    // both land here. The claim key mirrors ensureBackend()'s own profile
    // normalization so every spelling of the primary coalesces onto one dial.
    const profileKey = profile && String(profile).trim() ? String(profile).trim() : primaryProfileKey()
    const connection = await backendDialClaims.run(backendScopeKey(null, profileKey), () => ensureBackend(profile))
    const connectionId = resolvedConnectionId(readDesktopConnectionsRegistry(), connection)

    return connectionId ? { ...connection, connectionId } : connection
  })
  // Registry-scoped variant: resolve a backend for (connectionId, profile).
  // connectionId '' / 'local' / the registry primary all behave sensibly; the
  // local kind delegates to ensureBackend when the v1 route is local, and
  // forces a genuinely-local child when the v1 global mode is remote (the
  // registry 'local' entry always means this machine).
  ipcMain.handle('hermes:connection:for', async (_event, payload) => {
    const { connectionId, profile } = payload && typeof payload === 'object' ? (payload as any) : ({} as any)
    const registry = readDesktopConnectionsRegistry()
    const id = String(connectionId || '').trim() || registry.primary

    // Same single-owner claim as 'hermes:connection', keyed by the composite
    // (connectionId, profile) scope (#90812): concurrent registry dials for one
    // scope share the first spawn instead of bootstrapping duplicate remotes.
    const connection = await backendDialClaims.run(backendScopeKey(id, profile), () =>
      ensureRegistryBackend(id, profile)
    )

    return { ...connection, connectionId: id, registryScoped: true }
  })

  ipcMain.on('hermes:connection:active-route', (event, route) => {
    const id = event.sender.id
    const previous = windowConnectionRoutes.get(id)
    const next = windowConnectionRoutes.set(id, route)

    if (
      previous?.connectionId !== next?.connectionId ||
      previous?.profile !== next?.profile ||
      previous?.registryScoped !== next?.registryScoped
    ) {
      void resetPreviewReach(id)
    }

    if (!windowConnectionRouteOwners.has(id)) {
      windowConnectionRouteOwners.add(id)
      event.sender.once('destroyed', () => {
        windowConnectionRoutes.delete(id)
        windowConnectionRouteOwners.delete(id)
        void resetPreviewReach(id)
      })
    }
  })
  // Reconnect-after-wake recovery. A REMOTE primary backend has no child process,
  // so the 'exit'/'error' handlers that would clear a dead connection promise never
  // fire — once the remote becomes unreachable across a sleep/wake the renderer
  // re-dials the same dead descriptor forever and the composer stays stuck on
  // "Starting Hermes…". Before the renderer's backoff loop reconnects, it asks us
  // to confirm the cached PRIMARY backend is still reachable; if a remote one is
  // not, we drop the cache so the next getConnection() rebuilds it. Local backends
  // self-heal via their child 'exit' handler, so we never touch them here.
  ipcMain.handle('hermes:connection:revalidate', async () => {
    const connectionPromise = backendConnectionState.getPromise()

    if (!connectionPromise) {
      await revalidatePool()

      return { ok: true, rebuilt: false }
    }

    // Main and every session pop-out have their own renderer reconnect loop but
    // share this primary connection. Coalesce simultaneous requests so one outage
    // produces one failure observation rather than exhausting the whole streak.
    return remoteRevalidation.run(connectionPromise, async () => {
      const [result] = await Promise.all([
        revalidateRemoteConnection({
          connectionPromise,
          currentConnectionPromise: () => backendConnectionState.getPromise(),
          log: rememberLog,
          probe: (connection, path, options) => fetchJsonForBackend(connection, path, options),
          resetConnection: () => resetHermesConnection({ soft: true }),
          tracker: remoteLiveness
        }),
        revalidatePool()
      ])

      // A rebuilt SSH connection must also tear down its tunnel/master before the
      // renderer re-dials (which only happens after this handler resolves), so the
      // fresh bootstrap can't reattach to a dying transport.
      if (result.rebuilt) {
        const conn = await connectionPromise.catch(() => null)

        if (conn?.remoteKind === 'ssh') {
          const profile = primaryProfileKey()
          await sshBootstrapCoordinator.cancelAndWait(sshScopeKey(profile))
          await teardownSshConnection(profile)
        }
      }

      return result
    })
  })

  ipcMain.handle('hermes:backend:touch', async (_event, profile) => {
    touchPoolBackend(profile)

    return { ok: true }
  })
  // Respawn the desktop's own backend so it re-reads config that it resolves
  // ONCE per process. `browser.headed` is the case that forced this: the agent
  // caches it behind a latch (tools/browser_tool.py `_headed_mode_resolved`), so
  // writing the config while the backend is alive changes nothing at all — a
  // toggle without this is a toggle that lies.
  //
  // Same soft teardown the connection-apply path uses: the renderer wipes its
  // sockets and re-dials on `hermes:connection:applied`, and the re-dial is what
  // spawns the fresh backend. No window reload, so the 3D stage and the terminal
  // panes survive. A turn in flight does NOT survive — callers must say so.
  ipcMain.handle('hermes:backend:restart', async () => {
    try {
      await teardownPrimaryBackendAndWait({ soft: true })
      // Respawn HERE, before telling the renderer anything — the same order the
      // profile-rename lifecycle uses. Notifying first left the renderer to
      // re-dial a backend that did not exist yet, and its dial-failure path is
      // the terminal full-screen boot-failure overlay: a slow spawn turned a
      // healthy app into a "reinstall me" screen over a toggle click.
      await startHermes()
      sendConnectionApplied()

      return { ok: true }
    } catch (error) {
      rememberLog(`[backend] restart failed: ${error instanceof Error ? error.message : String(error)}`)
      // Whatever happened, let the renderer re-dial — a failed soft restart
      // must degrade to the ordinary reconnect flow, never to a dead window.
      sendConnectionApplied()

      return { error: error instanceof Error ? error.message : String(error), ok: false }
    }
  })
  ipcMain.handle('hermes:gateway:ws-url', async (_event, profile) => {
    return gatewayWsUrlIpcResult(() => freshGatewayWsUrl(profile))
  })
}
