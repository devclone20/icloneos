/**
 * The app's ONE teardown registry: every listener, stream, socket, watcher and long-lived child the main process owns
 * registers its stop here, once, where it is created. Two lists that drift apart (will-quit handlers on one side, the
 * forced-exit stops on the other) are how a Market listener, the ACP WORK listeners and the `log stream` child each
 * outlived a forced exit; there is now one list and one function that runs it.
 *
 * Who runs it (shutdown-signals.ts, through its `teardown` dep): will-quit, and every forced exit (the signal deadline,
 * the second signal, the 12 s quit cap and the app-update install cap) right before app.exit, which skips will-quit.
 * The same pass also starts the bounded storage flush there.
 *
 * - Idempotent: each registered stop runs at most once. A stop registered again under the same name (a new resource
 *   in place of the old one) is armed again.
 * - Each stop runs in its own try: one that throws is logged with its error class only (no message: it may carry a
 *   path or a host) and the rest still run.
 * - Synchronous: app.exit follows right after; a stop that needs to wait cannot be waited on there.
 *
 * electron/teardown-registry.test.ts enumerates every quit handler and every long-lived resource in the electron
 * sources and fails when one is neither registered here nor on its commented allow-list.
 *
 * Imports nothing: any module may register without pulling in the shutdown wiring.
 */

export interface TeardownRegistry {
  /** Registers (or re-arms) the stop for `name`. */
  register(name: string, stop: () => void): void
  /** Runs every stop not yet run, in registration order; returns what ran ("<name>" or "<name> (failed)"). */
  run(log?: null | ((line: string) => void)): string[]
  /** The registered names, in order (tests, diagnostics). */
  names(): string[]
}

export function createTeardownRegistry(): TeardownRegistry {
  const entries = new Map<string, { stop: () => void; done: boolean }>()

  return {
    register(name, stop) {
      entries.delete(name)
      entries.set(name, { stop, done: false })
    },
    run(log) {
      const ran: string[] = []

      for (const [name, entry] of entries) {
        if (entry.done) {
          continue
        }

        // Marked first: a stop that re-enters the teardown (or throws) never runs twice.
        entry.done = true

        try {
          entry.stop()
          ran.push(name)
        } catch (error) {
          ran.push(`${name} (failed)`)

          try {
            log?.(`[shutdown] stopping ${name} failed: ${error instanceof Error ? error.name : 'error'}`)
          } catch {
            // Logging never decides the teardown.
          }
        }
      }

      return ran
    },
    names: () => [...entries.keys()]
  }
}

/** The main process's registry. */
export const appTeardown = createTeardownRegistry()

/** Registers what the main process must stop on every way out (will-quit and every forced exit). */
export function registerTeardown(name: string, stop: () => void): void {
  appTeardown.register(name, stop)
}
