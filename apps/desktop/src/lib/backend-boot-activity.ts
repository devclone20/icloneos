import type { DesktopBootProgress, DesktopBootstrapEvent, DesktopBootstrapState } from '@/global'

import {
  BACKEND_BOOT_WAIT_TIMEOUT_MS,
  BACKEND_MAIN_SILENCE_MS,
  type IdleActivitySignal,
  type IdleActivitySubscribe,
  withIdleTimeout
} from './with-timeout'

/** Main's boot-progress phase while it waits for the user's first-run setup choice (electron/main/boot-progress.ts). */
export const BOOT_PHASE_AWAITING_USER = 'bootstrap.choice'

/** Main's boot-progress phase while the starting backend visibly installs its dependencies
 * (electron/main/backend-boot-watch.ts). */
export const BOOT_PHASE_DEPENDENCIES = 'backend.dependencies'

/** Bootstrap events that are install work (the runner's manifest, stages, log lines, heartbeats, completion). */
const INSTALL_EVENT_TYPES = new Set<DesktopBootstrapEvent['type']>([
  'complete',
  'log',
  'manifest',
  'stage',
  'stage-alive'
])

/** The bootstrap events that change main's first-run state (K142 round 2, kept from main's lib/boot-wait): only these
 * supersede a snapshot or lift a hold. A log line, a stage row or a heartbeat never stands in for main's saved state. */
const HOLD_EVENT_TYPES = new Set<DesktopBootstrapEvent['type']>([
  'complete',
  'dismissed',
  'failed',
  'manifest',
  'setup-choice',
  'unsupported-platform'
])

/** The slice of the desktop bridge the boot heartbeat reads. A bridge without a heartbeat (an older preload, a
 * partial test double) gets no re-arming: the plain 45 s budget, exactly as before. */
export interface BootActivityBridge {
  onBootProgress?: (callback: (payload: DesktopBootProgress) => void) => () => void
  onBootstrapEvent?: (callback: (payload: DesktopBootstrapEvent) => void) => () => void
  getBootProgress?: () => Promise<DesktopBootProgress>
  getBootstrapState?: () => Promise<DesktopBootstrapState>
}

function progressAwaitsUser(payload: Pick<DesktopBootProgress, 'phase' | 'running'> | null | undefined) {
  return Boolean(payload && payload.running && payload.phase === BOOT_PHASE_AWAITING_USER)
}

/**
 * Ruling 42 heartbeat for the renderer's boot-class awaits (withIdleTimeout): every boot-progress payload and every
 * bootstrap event main publishes is a sign of life from the layer below; installer stages/log lines and main's
 * dependency-install step (a child syncing packages) are `install` signs, which lift the ceiling to the install one. While main waits on the USER —
 * the first-run setup choice — the budget is put on hold, not burned: a person reading the choice for a minute is not
 * a silent backend. The hold is also taken from the current snapshots, so a renderer that subscribes after the choice
 * was already shown (a reload) still holds.
 */
export function subscribeBackendBootActivity(bridge: BootActivityBridge): IdleActivitySubscribe {
  return listener => {
    let held = false
    let closed = false
    // A snapshot is older than any live event: once one arrived, snapshots are ignored (a stale "choice on screen"
    // would otherwise put a deadline on hold after the user already chose).
    let live = false

    const emit = (signal: IdleActivitySignal) => {
      if (!closed) {
        listener(signal)
      }
    }

    const hold = () => {
      if (!held) {
        held = true
        emit('hold')
      }
    }

    const sign = (install: boolean) => {
      if (held) {
        held = false
        emit('release')
      }

      emit(install ? 'install' : 'activity')
    }

    const offProgress = bridge.onBootProgress?.(payload => {
      live = true

      if (progressAwaitsUser(payload)) {
        hold()
      } else {
        sign(payload.phase === BOOT_PHASE_DEPENDENCIES)
      }
    })

    const offBootstrap = bridge.onBootstrapEvent?.(event => {
      // K142 round 2: while the person reads the setup choice, a stray log line or heartbeat neither lifts the hold nor
      // replaces the saved state; only a hold-changing event does.
      if (!HOLD_EVENT_TYPES.has(event.type)) {
        if (!held) {
          emit(INSTALL_EVENT_TYPES.has(event.type) ? 'install' : 'activity')
        }

        return
      }

      live = true

      if (event.type === 'setup-choice' && event.active) {
        hold()
      } else {
        sign(INSTALL_EVENT_TYPES.has(event.type))
      }
    })

    // Snapshots: a choice already on screen before this subscription holds too. Failures here change nothing.
    void bridge
      .getBootProgress?.()
      .then(snapshot => {
        if (!live && progressAwaitsUser(snapshot)) {
          hold()
        }
      })
      .catch(() => undefined)
    void bridge
      .getBootstrapState?.()
      .then(state => {
        if (!live && state?.setupChoice) {
          hold()
        }
      })
      .catch(() => undefined)

    return () => {
      closed = true
      offProgress?.()
      offBootstrap?.()
    }
  }
}

/**
 * The one way the renderer awaits something that may ride out a primary backend cold boot (first-launch install,
 * cold spawn). Nothing to install: 45 s without a heartbeat fails with `message`, and 45 s is also the whole budget
 * (armed time), as before. Once main reports install activity, main owns the verdict (ruling 42 r2): no renderer
 * ceiling at all, and the renderer fails by itself only if main goes silent for BACKEND_MAIN_SILENCE_MS. Time on hold
 * for the user's setup choice counts for neither.
 */
export function awaitBackendBoot<T>(bridge: BootActivityBridge, work: Promise<T>, message: string): Promise<T> {
  return withIdleTimeout(work, BACKEND_BOOT_WAIT_TIMEOUT_MS, message, {
    ceilingMs: BACKEND_BOOT_WAIT_TIMEOUT_MS,
    installIdleMs: BACKEND_MAIN_SILENCE_MS,
    subscribe: subscribeBackendBootActivity(bridge)
  })
}
