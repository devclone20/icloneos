// Process-wide backend coordination objects: connection state, dial claims, pool, stream throttle, window routes.
import type { spawn } from 'node:child_process'

import { createBackendConnectionState } from '../backend-connection-state'
import { BackendDialClaims } from '../backend-dial-claim'
import { ProfileDeletionGate } from '../profile-delete-routing'
import { type ActiveWork, mergeActiveWork } from '../quit-guard'
import { RemoteLivenessTracker, RemoteRevalidationCoordinator } from '../remote-liveness'
import { createRemoteWsHeaderStore } from '../remote-ws-headers'
import { createStreamThrottle } from '../stream-throttle'
import { WindowConnectionRouteRegistry } from '../window-connection-route'

import { BOOT_FAKE_MODE } from './boot-fake'

export const backendConnectionState = createBackendConnectionState<ReturnType<typeof spawn>, any>()
export const remoteLiveness = new RemoteLivenessTracker()
export const remoteRevalidation = new RemoteRevalidationCoordinator()
export const registryDispatchRevalidation = new RemoteRevalidationCoordinator()
// Single-owner reconnect/dial claim (#90812): reconnectGateway()'s in-flight
// lock is per-renderer, so two windows racing one wake can both invoke the
// backend ensure IPC and double-dial a pooled SSH backend. Main owns backend
// lifecycles, so concurrent dials for one (connectionId, profile) scope
// coalesce here — the second caller awaits the first spawn's result.
export const backendDialClaims = new BackendDialClaims()
// Additional per-profile backends, keyed by profile name. The PRIMARY backend
// (the desktop's launch profile) stays managed by backendConnectionState +
// startHermes(); this pool only holds EXTRA profile
// backends spawned lazily when a session belongs to a different profile. A user
// with no named profiles never populates this map, so their experience is
// byte-for-byte the single-backend behavior.
/** The descriptor every backend dial resolves to: the primary child, a pooled profile, a remote or an SSH tunnel. */
export interface BackendConnection {
  baseUrl: string
  mode: 'local' | 'remote'
  source: string
  authMode: 'oauth' | 'token'
  // null in OAuth mode: REST is cookie-authed via the session partition.
  token: string | null
  wsUrl: string
  headers?: Record<string, string>
  profile?: string
  connectionId?: string
  remoteHost?: string
  remoteIdentity?: string
  remoteKind?: 'cloud' | 'ssh' | 'url'
  remoteHermesVersion?: string
  remoteProfile?: string
  ssh?: {
    effectiveConfigFingerprint?: string
    host?: string
    keyPath?: string
    port?: number
    remoteHermesPath?: string
    remoteProfile?: string
    user?: string
  }
  sharedPrimary?: boolean
  sharedRemote?: boolean
  logs?: string[]
}

export interface PoolEntry {
  process: ReturnType<typeof spawn> | null
  // As announced by the child; waitForDashboardPortAnnouncement does not validate it.
  port: unknown
  token: string | null
  connectionPromise: Promise<BackendConnection> | null
  lastActiveAt: number
  remoteBaseUrl: string | null
}

export const backendPool = new Map<string, PoolEntry>()
export const profileDeletionGate = new ProfileDeletionGate()
// Keep the pool light: cap concurrent profile backends (LRU eviction) and reap
// idle ones. A user idles at exactly the primary backend; pool backends only
// exist while a non-primary profile is actively being chatted through.
export const POOL_MAX_BACKENDS = Math.max(1, Number(process.env.HERMES_DESKTOP_POOL_MAX) || 3)
export const POOL_IDLE_MS = Math.max(60_000, Number(process.env.HERMES_DESKTOP_POOL_IDLE_MS) || 10 * 60_000)

// A backend touched within this window has a live renderer socket (the keepalive
// pings every 60s for every open profile). LRU eviction must spare these — a
// concurrent multi-profile session keeps several backends "fresh" at once, and
// killing one to honor the soft cap would abort a running agent.
//
// The window is intentionally MUCH wider than the 60s ping cadence:
//   * 1 missed ping    = +60s of apparent silence
//   * WSL2 IPC stall  = the renderer's `hermes:backend:touch` roundtrips
//                       through 9p; a single brief 9p hiccup can stretch a
//                       ping to ~30s of observed silence (#95189: gateways
//                       exited every ~2 min on WSL2 because the previous
//                       90s window left no headroom — one delayed ping
//                       pushed a live backend past the threshold and the
//                       cap-driven eviction killed the active profile's
//                       backend mid-session, re-minting runtime ids and
//                       re-allocating pooled gateway secondaries ~700×/day).
//   * 3× ping + 60s headroom = ~4 min, comfortable margin for two missed
//     pings + WSL2 IPC stall. The hard ceiling for the cap-eligible set is
//     POOL_IDLE_MS above (default 10 min) — this constant only governs the
//     "is this backend plausibly still alive" question for LRU eviction,
//     not when the idle reaper definitively tears a backend down.
export const POOL_KEEPALIVE_FRESH_MS = Math.max(
  120_000,
  Number(process.env.HERMES_DESKTOP_POOL_KEEPALIVE_FRESH_MS) || 4 * 60_000
)

// Auto-reload budget for renderer crashes, shared by EVERY window (primary,
// secondary session, instance) so a crash loop anywhere is suppressed after
// the same budget instead of reloading per-window forever. A deterministic
// startup crash would otherwise loop forever (reload → crash → reload),
// pinning CPU and spamming logs. Allow a few reloads per rolling window, then
// stop and leave the dead window so the user can read the error / quit.
export const RENDERER_RELOAD_WINDOW_MS = 60_000
export const RENDERER_RELOAD_MAX = 3
export const rendererReloadTimesRef: { current: number[] } = { current: [] }
export const MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS = 3
export const remoteWsHeaderStore = createRemoteWsHeaderStore()
interface BootProgressState {
  error: string | null
  fakeMode: boolean
  isCloudBackendDown: boolean
  message: string
  phase: string
  progress: number
  retryable: boolean
  running: boolean
  statusCode: number | null
  timestamp: number
}

export const progressState: { bootProgressState: BootProgressState } = {
  bootProgressState: {
    error: null,
    fakeMode: BOOT_FAKE_MODE,
    isCloudBackendDown: false,
    message: 'Waiting to start Hermes backend',
    phase: 'idle',
    progress: 0,
    retryable: false,
    running: false,
    statusCode: null,
    timestamp: Date.now()
  }
}

export const windowConnectionRoutes = new WindowConnectionRouteRegistry()
export const windowConnectionRouteOwners = new Set<number>()

// Each renderer reports the turns it has in flight; the quit guard reads the
// merged picture. Keyed by webContents id so a closed window stops counting.
export const activeWorkByWebContents = new Map<number, ActiveWork>()

// The same merged picture drives background throttling: chat windows run
// unthrottled while any turn is in flight (streaming must paint while hidden)
// and fall back to Chromium's default throttling at idle. See stream-throttle.ts.
export const streamThrottle = createStreamThrottle()

export function updateStreamThrottleFromActiveWork() {
  streamThrottle.update(mergeActiveWork(activeWorkByWebContents.values()).count > 0)
}
