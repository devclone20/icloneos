// What a signal-initiated quit tracks, saves and stops, with every effect injected so it can be tested without
// Electron. shutdown-signals-wiring.ts fills these in from the real modules; nothing happens on import.
import type { ShutdownSignalsDeps } from '../shutdown-signals'

// --- Quit steps: the teardown before-quit starts, visible to the deadline -------------------------------------------

/**
 * How long the SSH teardown before-quit starts may still run: its 6 s race (cleanupStale waits up to 5 s for the
 * owned remote pid, #91668), then forceCleanupAll and the re-entered quit. While it runs the deadline waits for it,
 * up to the hard cap in shutdown-signals.ts.
 */
export const SSH_QUIT_TEARDOWN_HOLD_MS = 7_000

/** Where before-quit's SSH teardown stands for this quit. */
export interface SshQuitTeardown {
  started: boolean
  done: boolean
}

/**
 * What one before-quit pass does about SSH. The teardown drops each connection from the live map as soon as it
 * starts (before it kills the owned remote serve and closes the master), so a pass that re-read the map while the
 * teardown ran saw nothing and let the quit through: a re-quit from another step (the backends) ended the app with
 * the remote serve orphaned and the forwards still listening. So once started, every pass waits until it is done.
 */
export function sshQuitTeardownStep(
  teardown: Readonly<SshQuitTeardown>,
  live: { connections: number; bootstraps: number }
): 'pass' | 'start' | 'wait' {
  if (teardown.done) {
    return 'pass'
  }

  if (teardown.started) {
    return 'wait'
  }

  return live.connections > 0 || live.bootstraps > 0 ? 'start' : 'pass'
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface QuitStep {
  name: string
  startedAt: number
  holdMs: null | number
  done: boolean
}

export interface QuitSteps {
  /** Records a teardown step and returns the same promise. holdMs: how long the deadline should wait for it. */
  track<T>(name: string, promise: Promise<T>, holdMs?: number): Promise<T>
  /** The names of the steps still running, once each. */
  pending(): string[]
  /** The latest time a running step with a hold may still run until, or null. */
  holdUntil(): null | number
  /**
   * Sends one line per failed step to the sink, the failures already recorded first: tracking a step handles its
   * rejection, so this line is where the reason goes instead of an unhandledRejection.
   */
  reportFailures(sink: (line: string) => void): void
}

/** now: monotonic ms, the clock shutdown-signals.ts compares holds against (performance.now() by default). */
export function createQuitSteps(now: () => number = () => performance.now()): QuitSteps {
  const steps: QuitStep[] = []
  const failures: string[] = []
  let sink: null | ((line: string) => void) = null

  const tell = (line: string) => {
    try {
      sink?.(line)
    } catch {
      // A sink that throws must not turn the handled rejection into a new unhandled one.
    }
  }

  return {
    track(name, promise, holdMs) {
      const step: QuitStep = { name, startedAt: now(), holdMs: holdMs ?? null, done: false }

      steps.push(step)
      promise.then(
        () => {
          step.done = true
        },
        (error: unknown) => {
          step.done = true
          const line = `[shutdown] quit step ${name} failed: ${reasonOf(error)}`

          failures.push(line)
          tell(line)
        }
      )

      return promise
    },
    pending() {
      return [...new Set(steps.filter(step => !step.done).map(step => step.name))]
    },
    holdUntil() {
      let until: null | number = null

      for (const step of steps) {
        if (!step.done && step.holdMs !== null) {
          until = Math.max(until ?? 0, step.startedAt + step.holdMs)
        }
      }

      return until
    },
    reportFailures(next) {
      sink = next

      for (const line of failures) {
        tell(line)
      }
    }
  }
}

/** The app's one registry: main.ts's before-quit records its SSH teardown and remote-update wait here. */
export const quitSteps = createQuitSteps()

export function trackQuitStep<T>(name: string, promise: Promise<T>, holdMs?: number): Promise<T> {
  return quitSteps.track(name, promise, holdMs)
}

// --- Re-quit: the quit before-quit prevented, started again once its teardown settled ----------------------------------

export interface RequitDeps {
  quit(): void
  log(line: string): void
  /** Runs on a later turn of the event loop (setImmediate in the app). */
  defer(run: () => void): void
}

/**
 * Electron runs a microtask checkpoint inside its before-quit dispatch, BEFORE app.quit() reads whether a listener
 * prevented it. A teardown promise that is already settled (the backend stop when no backend runs: the first-run
 * screen) therefore re-entered app.quit() inside the prevented pass: that inner quit went through and started closing
 * the windows, then the outer pass recorded "not quitting" over it (Browser::Quit: is_quitting_ = HandleBeforeQuit()).
 * The windows closed, will-quit never came, and on macOS the process stayed alive with no window. So a re-quit always
 * runs on a later turn, after the pass that prevented the quit has returned.
 */
export function createRequit(deps: RequitDeps): (after: string) => void {
  const say = (line: string) => {
    try {
      deps.log(line)
    } catch {
      // A log that throws must not be what loses the quit.
    }
  }

  return after => {
    say(`[shutdown] ${after} settled: quitting again on the next turn`)
    deps.defer(() => {
      say(`[shutdown] re-quit after ${after}`)
      deps.quit()
    })
  }
}

// --- Owned children: the process groups a forced exit must not leave behind ------------------------------------------

export interface OwnedChild {
  pid?: number
  exitCode: null | number
  signalCode: null | string
  kill(signal: 'SIGKILL'): boolean
}

/**
 * Still running and safe to kill as a group. pid 0 and 1 are refused: process.kill(-0) would kill the app's own
 * group (in a dev run, the terminal's), and -1 means every process the user owns.
 */
export function ownedChildRunning(child: null | OwnedChild | undefined): child is OwnedChild & { pid: number } {
  return (
    Boolean(child) &&
    child!.exitCode === null &&
    child!.signalCode === null &&
    Number.isInteger(child!.pid) &&
    (child!.pid as number) > 1
  )
}

export interface OwnedChildrenDeps {
  /** The children the app owns now, each with a label for the log line ('backend', 'pool <key>'). */
  list(): Iterable<readonly [string, null | OwnedChild | undefined]>
  kill(pid: number, signal: 'SIGKILL'): void
  isWindows: boolean
  /** Windows: the existing tree kill (taskkill /T /F). */
  killTree(pid: number): void
}

export interface OwnedChildren {
  /** Remembers the running children; the backend stop invalidates their handles, so this runs at the signal. */
  capture(): void
  /** Kills every remembered child still running (capturing again first); returns what was actually signalled. */
  stop(): string[]
}

export function createOwnedChildren(deps: OwnedChildrenDeps): OwnedChildren {
  const owned = new Map<string, OwnedChild & { pid: number }>()

  const capture = () => {
    for (const [label, child] of deps.list()) {
      if (ownedChildRunning(child)) {
        owned.set(`${label} ${child.pid}`, child)
      }
    }
  }

  // Backends run in their own session (pgid == pid): the whole group goes, so tool grandchildren do not outlive the
  // app. If the group is gone (ESRCH) the child itself is the fallback.
  const killGroup = (child: OwnedChild & { pid: number }): boolean => {
    if (deps.isWindows) {
      deps.killTree(child.pid)

      return true
    }

    try {
      deps.kill(-child.pid, 'SIGKILL')

      return true
    } catch {
      try {
        return child.kill('SIGKILL')
      } catch {
        return false
      }
    }
  }

  return {
    capture,
    stop() {
      capture()
      const stopped: string[] = []

      for (const [name, child] of owned) {
        if (ownedChildRunning(child) && killGroup(child)) {
          stopped.push(name)
        }
      }

      return stopped
    }
  }
}

// --- The deps shutdown-signals.ts receives ---------------------------------------------------------------------------

export interface AppShutdownEnv {
  /** Buffers a line for desktop.log. */
  remember(line: string): void
  /** Writes the desktop.log buffer synchronously. */
  flushLogSync(): void
  clearLogFlushTimer(): void
  /** Writes a pending appearance (translucency) change synchronously. */
  flushPendingAppearance(): void
  persistWindowState(): void
  stopBackends(): Promise<unknown>
  children: OwnedChildren
  /** Aborts a running installer; true when there was one to abort. */
  abortInstaller(): boolean
  sshBootstrap: {
    /** Force-cleanup callbacks registered by bootstraps still running (established connections have none). */
    cleanups(): number
    forceCleanupAll(): Promise<unknown>
  }
  /** SSH connections and bootstraps not yet torn down. */
  sshOpen(): number
  /** Remote update / recovery transactions in flight. */
  remoteUpdates(): number
  openWindows(): number
  steps: QuitSteps
}

export type AppShutdownDeps = Omit<ShutdownSignalsDeps, 'app' | 'process' | 'quitState'>

export function buildAppShutdownDeps(env: AppShutdownEnv): AppShutdownDeps {
  let backendsStopped = false

  // Few lines, on the way out: each reaches desktop.log at once, the clean-quit line included.
  const log = (line: string) => {
    env.remember(line)
    env.flushLogSync()
  }

  env.steps.reportFailures(log)

  return {
    log,
    beginTeardown() {
      env.children.capture()
      // A failed stop leaves "backends" unfinished for the deadline line; the reason goes to the log now.
      void env.stopBackends().then(
        () => {
          backendsStopped = true
        },
        (error: unknown) => {
          try {
            log(`[shutdown] stopping the backends failed: ${reasonOf(error)}`)
          } catch {
            // The deadline still names "backends".
          }
        }
      )
    },
    saveMinimumState() {
      env.flushPendingAppearance()
      env.persistWindowState()
      env.clearLogFlushTimer()
      env.flushLogSync()
    },
    stopOwnedChildren() {
      // The app's registered stops are not here: shutdown-signals.ts runs the teardown registry right after this.
      const stopped = env.children.stop()

      if (env.abortInstaller()) {
        stopped.push('installer')
      }

      // Only bootstraps still connecting have something to clean up locally; an established connection's remote
      // teardown needs the network and is reported as not finished instead.
      const cleanups = env.sshBootstrap.cleanups()

      if (cleanups > 0) {
        void env.sshBootstrap.forceCleanupAll().catch(() => undefined)
        stopped.push(`ssh bootstrap ${cleanups}`)
      }

      return stopped
    },
    pendingTeardown() {
      const pending: string[] = []
      const steps = env.steps.pending()

      if (!backendsStopped) {
        pending.push('backends')
      }

      if (steps.includes('ssh') || env.sshOpen() > 0) {
        pending.push('ssh')
      }

      if (steps.includes('remote updates') || env.remoteUpdates() > 0) {
        pending.push('remote updates')
      }

      const open = env.openWindows()

      if (open > 0) {
        pending.push(`windows ${open}`)
      }

      return pending
    },
    holdUntil: () => env.steps.holdUntil()
  }
}
