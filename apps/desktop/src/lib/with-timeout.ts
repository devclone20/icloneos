/** Idle budget (ruling 42 + the owner's 10:58 amendment) for any renderer await
 * that rides out a primary backend cold boot (initial getConnection(), the
 * soft-switch cold spawn, the registry restore's descriptor wait): the longest
 * the renderer may go WITHOUT A SIGN OF LIFE from main. When main reports no
 * install activity this is also the whole budget, exactly as before: a healthy
 * boot with nothing to install must be up within it. Same value as main's own
 * readiness budget (DEFAULT_BACKEND_READY_TIMEOUT_MS, electron/backend-health.ts).
 * Use it through awaitBackendBoot() (src/lib/backend-boot-activity.ts). */
export const BACKEND_BOOT_WAIT_TIMEOUT_MS = 45_000

/** Ruling 42 r2 (lead: ONE budget authority — main). Once main reports install activity, the renderer never times
 * out on its own: it waits for main's verdict (the install overlay's diagnosis) and only fails by itself when MAIN
 * goes silent — no progress, bootstrap event or heartbeat (main sends one every 10 s) — for this long. Same value as
 * main's stage stall (INSTALL_STALL_MS, electron/install-liveness.ts). No env knob or option changes it. */
export const BACKEND_MAIN_SILENCE_MS = 120_000

// desktop.getConnection() / getConnectionFor() / revalidateConnection() /
// resolveGatewayWsUrl() are IPC round-trips into the main process with no
// timeout of their own (#93454). A wedged main-process round-trip (e.g. a
// stuck revalidation after a liveness-probe trip) otherwise hangs an awaiting
// caller forever. Every caller of these bounds them with this shared budget.
export const RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000

/** Rejection raised by withTimeout. The bounded work is NOT cancelled — the
 * caller decides what a straggler that settles later means. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError
}

/** Settle with `promise`, or reject with a TimeoutError after `ms`.
 * `onTimeout` runs synchronously before the rejection is published so callers
 * can revoke ownership of work that would otherwise keep running unowned. If
 * that callback throws, its error becomes this promise's rejection. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: (error: TimeoutError) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new TimeoutError(message)

      try {
        onTimeout?.(error)
      } catch (onTimeoutError) {
        reject(onTimeoutError)

        return
      }

      reject(error)
    }, ms)

    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** What a boot-class activity source reports:
 * - `activity`: a sign of life — the idle deadline re-arms (within the current ceiling);
 * - `install`: a sign of life that is install work — re-arms AND lifts the ceiling to `installCeilingMs`;
 * - `hold`: the layer below is waiting on the USER (not silent) — both clocks stop (`activity` does not lift it);
 * - `release`: the wait on the user ended — the idle deadline re-arms in full. */
export type IdleActivitySignal = 'activity' | 'hold' | 'install' | 'release'

/** Subscribes `listener` to an activity source; returns the unsubscribe. */
export type IdleActivitySubscribe = (listener: (signal: IdleActivitySignal) => void) => (() => void) | void

export interface IdleTimeoutOptions {
  /** The heartbeat source. Without one this is withTimeout(). Released on settle, always. */
  subscribe?: IdleActivitySubscribe
  /** Ceiling on armed time while no install activity was seen. Default: none. */
  ceilingMs?: number
  /** Ceiling on armed time once an `install` signal arrived. Default: none (main owns the install budget). */
  installCeilingMs?: number
  /** Idle budget once an `install` signal arrived. Default: `idleMs`. */
  installIdleMs?: number
  /** Rejection message when a ceiling (not the idle budget) is what expired; gets the ceiling in ms. */
  ceilingMessage?: (ceilingMs: number) => string
  /** As withTimeout's `onTimeout`: runs before the rejection; if it throws, that error is the rejection. */
  onTimeout?: (error: TimeoutError) => void
}

/** Settle with `promise`, or reject with a TimeoutError once `idleMs` pass with
 * no sign of life from `options.subscribe` (every `activity`/`install` re-arms
 * it), or once the armed time reaches the ceiling in force (`ceilingMs`, or
 * `installCeilingMs` after install activity). The work is not cancelled (same
 * contract as withTimeout). The subscription is released as soon as this
 * settles, whichever way. */
export function withIdleTimeout<T>(
  promise: Promise<T>,
  idleMs: number,
  message: string,
  options: IdleTimeoutOptions = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const baseCeilingMs = options.ceilingMs ?? Number.POSITIVE_INFINITY
    const installCeilingMs = options.installCeilingMs ?? Number.POSITIVE_INFINITY
    let ceilingMs = baseCeilingMs
    let currentIdleMs = idleMs
    let settled = false
    let held = false
    let idleTimer: null | ReturnType<typeof setTimeout> = null
    let ceilingTimer: null | ReturnType<typeof setTimeout> = null
    // Armed time already spent before the current armed span began.
    let armedSpentMs = 0
    let armedSince = Date.now()
    let unsubscribe: (() => void) | void = undefined

    const clearIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const clearCeiling = () => {
      if (ceilingTimer !== null) {
        clearTimeout(ceilingTimer)
        ceilingTimer = null
      }
    }

    const release = () => {
      clearIdle()
      clearCeiling()

      try {
        unsubscribe?.()
      } catch {
        // A failing unsubscribe must not change how this settles.
      }

      unsubscribe = undefined
    }

    const expire = (text: string) => {
      if (settled) {
        return
      }

      settled = true
      release()
      const error = new TimeoutError(text)

      try {
        options.onTimeout?.(error)
      } catch (onTimeoutError) {
        reject(onTimeoutError)

        return
      }

      reject(error)
    }

    const armIdle = () => {
      clearIdle()
      idleTimer = setTimeout(() => expire(message), currentIdleMs)
    }

    // (Re)arms the ceiling for the armed span starting now; `armedSpentMs` holds what earlier spans used.
    const armCeiling = () => {
      clearCeiling()

      if (!Number.isFinite(ceilingMs)) {
        return
      }

      const limit = ceilingMs
      ceilingTimer = setTimeout(
        () => expire(options.ceilingMessage ? options.ceilingMessage(limit) : message),
        Math.max(0, limit - armedSpentMs)
      )
    }

    const spendArmedSpan = () => {
      const now = Date.now()
      armedSpentMs += now - armedSince
      armedSince = now
    }

    const onSignal = (signal: IdleActivitySignal) => {
      if (settled) {
        return
      }

      if (signal === 'hold') {
        if (!held) {
          held = true
          spendArmedSpan()
          clearIdle()
          clearCeiling()
        }

        return
      }

      if (signal === 'release') {
        if (held) {
          held = false
          armedSince = Date.now()
          armCeiling()
        }

        armIdle()

        return
      }

      if (held) {
        return
      }

      if (signal === 'install' && ceilingMs !== installCeilingMs) {
        ceilingMs = installCeilingMs
        currentIdleMs = options.installIdleMs ?? idleMs
        spendArmedSpan()
        armCeiling()
      }

      armIdle()
    }

    armIdle()
    armCeiling()

    try {
      unsubscribe = options.subscribe?.(onSignal)
    } catch (subscribeError) {
      settled = true
      release()
      reject(subscribeError)

      return
    }

    // The source may have settled us synchronously while subscribing.
    if (settled) {
      release()
    }

    Promise.resolve(promise).then(
      value => {
        if (settled) {
          return
        }

        settled = true
        release()
        resolve(value)
      },
      err => {
        if (settled) {
          return
        }

        settled = true
        release()
        reject(err)
      }
    )
  })
}
