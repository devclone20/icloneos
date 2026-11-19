/**
 * Repair-loop guard for the desktop bootstrap.
 *
 * Why this exists
 * ───────────────
 * Hermes desktop can request a "repair" of its bundled backend when the
 * renderer observes a transient backend failure (see issue #74874). The
 * classic failure fingerprint:
 *
 *   1. Backend Python process hits a transient GIL stall (e.g. heavy
 *      import, MCP discovery, a long-running agent turn).
 *   2. The renderer's WebSocket can't deliver the `gateway.ready` frame
 *      in time and treats the socket as dead.
 *   3. Renderer calls `hermes:bootstrap:repair`.
 *   4. Bootstrap unconditionally force-reinstalls the venv, restarting
 *      the backend — which stalls again for the same reason.
 *   5. Renderer reports dead backend → another repair → infinite loop.
 *
 * The desktop should distinguish:
 *   - "the venv/install is genuinely broken" → hard reinstall is correct
 *   - "the runtime is healthy but temporarily stalled" → restart only,
 *     NOT a destructive reinstall that drops the venv
 *
 * What this module does
 * ─────────────────────
 * A pure decision helper. Given the current repair attempt count and a
 * hint about whether the live backend process still looks alive, return
 * whether the next repair should:
 *   - `hardReinstall: true`  → run the installer, recreate the venv
 *   - `hardReinstall: false` → restart the existing backend, keep the venv
 *
 * Cap on soft restarts is bounded so an actually-corrupted install still
 * eventually escalates to a hard reinstall after repeated stalls — the
 * guard prevents the *unbounded* reinstall loop, not all reinstalls.
 *
 * The module is intentionally pure (no I/O, no logging, no global state)
 * so it is unit-testable in isolation. Wiring into `main.ts` lives there.
 */

type RepairDecision =
  | {
      /** Run the installer (recreate venv). Caller bypasses the active runtime. */
      hardReinstall: true
      /** Human-readable rationale for the desktop log. */
      reason: string
      /** 1-indexed repair attempt number for diagnostics. */
      attempt: number
    }
  | {
      /** Skip the installer; restart the existing backend only. */
      hardReinstall: false
      reason: string
      attempt: number
    }

type RepairDecisionInput = {
  /**
   * 1-indexed count of how many repair attempts have happened in this
   * failure episode. The first repair is `attempt === 1`; a successful
   * boot resets the counter (see `main.ts`'s bootstrap completion path).
   */
  attempt: number
  /**
   * Soft-restart budget before escalation to a hard reinstall. Defaults
   * to 3: three "just restart" attempts, then a real reinstall. Bounded
   * so a corrupt install still gets fixed; high enough that a GIL
   * stall no longer loops the user into a 30-minute reinstall cycle.
   */
  maxSoftAttempts?: number
  /**
   * Whether the live backend process (the one we are about to tear down
   * to honour the repair request) still looks alive. A process whose
   * `exitCode !== null` or `signalCode !== null` has actually exited;
   * a process with both null is either still running or stalled — and a
   * stall is exactly the case the soft-restart path is for.
   */
  primaryBackendAlive: boolean
}

/**
 * Decide the next repair action.
 *
 * Decision matrix:
 *   attempt ≤ maxSoftAttempts AND alive   → soft restart (don't reinstall)
 *   attempt ≤ maxSoftAttempts AND dead    → soft restart (process exited,
 *                                            but we don't yet trust that
 *                                            the install is corrupt; restart
 *                                            once to confirm)
 *   attempt >  maxSoftAttempts            → hard reinstall (give up on the
 *                                            current install)
 *
 * "Alive" being true does NOT force a soft restart on every call: the
 * attempt counter still increments, so an actually-broken install that
 * keeps respawning a child but never announces READY still escalates
 * after `maxSoftAttempts` cycles.
 */
export function decideBootstrapRepair(input: RepairDecisionInput): RepairDecision {
  const maxSoftAttempts = input.maxSoftAttempts ?? 3
  const attempt = Math.max(1, Math.floor(input.attempt))
  const alive = Boolean(input.primaryBackendAlive)

  if (attempt > maxSoftAttempts) {
    return {
      hardReinstall: true,
      attempt,
      reason:
        `repair attempt ${attempt} exceeds soft-restart budget ` + `(${maxSoftAttempts}); escalating to hard reinstall`
    }
  }

  return {
    hardReinstall: false,
    attempt,
    reason: alive
      ? `repair attempt ${attempt}/${maxSoftAttempts}: primary backend process ` +
        `still alive (likely transient stall, see #74874); restarting only, ` +
        `skipping installer`
      : `repair attempt ${attempt}/${maxSoftAttempts}: primary backend process ` +
        `has exited; restarting before escalating to reinstall`
  }
}

/**
 * v0.0.9 F3 — what "Repair install" does for a known cause. Before this, Repair always ended in the installer (or a
 * restart) whatever had failed; on 14 Nov 2026 it reinstalled the runtime twice while the failing record sat in
 * `~/.hermes/installs`, a folder the installer never looks at. Now the cause picks the repair:
 *
 *   install-state-not-writable → the kit's `stale-install-record` (moves the record aside), then a plain restart
 *   python-import              → the kit's `runtime-venv` (moves the broken record aside), then the installer
 *   runtime-env-broken         → the same: the app's install lost its interpreter (r2 m-r2-2), never the first-run choice
 *   gate-not-loaded            → the kit's `gate-not-starting` (the app's plugins switched back on, else the installer)
 *   port-in-use                → the kit's `port-busy` (the app's own leftovers), then a plain restart
 *   anything else              → the soft/hard ladder above, unchanged
 *
 * Pure. `kitClass` null means: no class repair, fall back to `decideBootstrapRepair`.
 */
export type RepairRouteCause =
  | 'exit-nonzero'
  | 'gate-not-loaded'
  | 'install-state-not-writable'
  | 'port-in-use'
  | 'python-import'
  | 'runtime-env-broken'
  | 'timeout'
  | 'unknown'

export type RepairRouteClass = 'gate-not-starting' | 'port-busy' | 'runtime-venv' | 'stale-install-record'

export interface RepairRoute {
  kitClass: RepairRouteClass | null
  /** The installer runs on the next start (in addition to the class repair, when there is one). */
  forceReinstall: boolean
  reason: string
}

export function routeBootstrapRepair(cause: RepairRouteCause | null | undefined): RepairRoute {
  switch (cause) {
    case 'install-state-not-writable':
      return {
        forceReinstall: false,
        kitClass: 'stale-install-record',
        reason: 'the runtime could not write its install state: the stale install record is moved aside, no reinstall'
      }

    case 'python-import':
      return {
        forceReinstall: true,
        kitClass: 'runtime-venv',
        reason: 'the runtime could not import its own modules: its dependency record is moved aside and reinstalled'
      }

    case 'runtime-env-broken':
      return {
        forceReinstall: true,
        kitClass: 'runtime-venv',
        reason: "the app's runtime has no working interpreter: its environment record is moved aside and reinstalled"
      }

    case 'gate-not-loaded':
      return {
        forceReinstall: false,
        kitClass: 'gate-not-starting',
        reason:
          'the permission gate refused the last start: the kit decides between re-enabling the plugins and a reinstall'
      }

    case 'port-in-use':
      return {
        forceReinstall: false,
        kitClass: 'port-busy',
        reason: "a port or socket is held: the app's own leftovers are cleared, no reinstall"
      }

    default:
      return { forceReinstall: false, kitClass: null, reason: 'no known cause: the soft/hard repair ladder applies' }
  }
}
