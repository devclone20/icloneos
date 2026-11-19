// F1-S (v0.0.9) — the single registry of the preload's owner-click locks. A lock is created ONLY here, and creating it
// is what registers it with the capture-phase listener: `observe` hands every trusted click/keydown to every lock, so a
// lock that is never observed (REL-6's `acpToolsConfirm`, which made the ACP tools' Install refuse every real click)
// cannot exist by construction. The preload builds exactly one registry; a static test forbids any other
// `createConfirmTracker(` call in electron/preload.ts (gesture-locks.test.ts).
//
// Pure (no electron, no DOM globals): the preload is sandboxed, and the tests drive it with stand-in events.
import { createConfirmTracker } from './agent-update-confirm'

export type ConfirmTracker = ReturnType<typeof createConfirmTracker>
export type ConfirmTrackerOptions = Parameters<typeof createConfirmTracker>[0]
export type ObservedEvent = Parameters<ConfirmTracker['observe']>[0]

export interface GestureLocks<Name extends string> {
  /** Every lock, by name. Frozen: nothing can be swapped in after the listener is installed. */
  readonly locks: Readonly<Record<Name, ConfirmTracker>>
  /** The names, in registration order (what the listener feeds). */
  readonly names: readonly Name[]
  /** Feeds one event to EVERY registered lock. The preload's capture listener calls only this. */
  observe(event: ObservedEvent): void
}

/**
 * Builds every lock from its spec and returns them with the one `observe` that feeds them all. A spec without an
 * `isConfirmTarget` is refused at build time (a lock with no control is a lock nobody can open, or anybody can).
 */
export function createGestureLocks<Name extends string>(
  specs: Readonly<Record<Name, ConfirmTrackerOptions>>
): GestureLocks<Name> {
  const names = Object.keys(specs) as Name[]
  const locks = {} as Record<Name, ConfirmTracker>

  for (const name of names) {
    const spec = specs[name]

    if (!spec || typeof spec.isConfirmTarget !== 'function') {
      throw new Error(`gesture lock "${name}" has no confirm target`)
    }

    locks[name] = createConfirmTracker(spec)
  }

  const trackers = names.map(name => locks[name])

  return Object.freeze({
    locks: Object.freeze(locks),
    names: Object.freeze([...names]),
    observe(event: ObservedEvent): void {
      for (const tracker of trackers) {
        tracker.observe(event)
      }
    }
  })
}

