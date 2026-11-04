/**
 * SIGTERM, SIGINT and SIGHUP in the main process: logout, shutdown, `kill <pid>` and a closed terminal all mean the
 * OS or the user is leaving, so the app quits through its normal path (backends stopped, state flushed) and never
 * waits on anyone: no quit confirmation, and a hard deadline after which it exits anyway.
 *
 * - First signal: mark the quit as signal-initiated (the quit confirmation is skipped), start the teardown, arm the
 *   deadline, call app.quit(). Electron does not emit window-all-closed during app.quit(), so the flag matters for
 *   the confirmation only.
 * - Deadline (8 s, longer than the largest budget before-quit gives a step: the 6 s SSH teardown race): stop the child
 *   process groups the app owns, write ONE log line naming the teardown steps that did not finish, save the minimum
 *   state, app.exit(128 + n). While a step with a hold is still inside it (an SSH teardown that began late, after a
 *   remote-update wait), the deadline waits for it, never past the hard cap (12 s after the signal).
 * - A second signal during the quit takes the deadline path at once: it accelerates the exit but still saves the
 *   minimum state and stops the owned children first; it never kills the process outright. Its exit code (128 + n of
 *   the first signal) is certain only when the second signal arrives before Electron's 'quit': once the quit has
 *   finished, the process may already be on its way out with status 0.
 * - Every other quit (Cmd-Q, the menu, an Apple Event, Chromium's own one-shot signal handler, an update restart) is
 *   bounded too: the first before-quit arms a hard cap (12 s; 60 s for the app-update install, see
 *   INSTALL_QUIT_CAP_MS), which only the active-work confirmation stands down while it waits for the user's choice
 *   ("Keep Running" leaves it off; "Quit Anyway" quits again and arms it). A quit that has not finished by then is
 *   forced: one line '[shutdown] quit cap: forcing exit after N ms; not finished: ...', exit code 1. A quit that does
 *   finish writes '[shutdown] quit: clean quit after N ms (signal=no)'. While before-quit waits for remote update
 *   operations the cap is REMOTE_UPDATE_QUIT_CAP_MS instead ('quit cap (remote updates): forcing exit ...'), and the
 *   12 s cap starts again when that wait ends. The cap never cuts inside a running step's hold (the SSH teardown),
 *   but waits for it at most QUIT_CAP_HOLD_CEILING_MS past the cap.
 * - A clean quit (Electron's 'quit' event) clears the deadline and writes '[shutdown] <SIG>: clean quit after N ms'.
 * - A signal quit stays bounded after 'quit' too: Chromium's own teardown can hang for tens of seconds after it. The
 *   signal's first before-quit starts writing the session storage to disk (DOM storage, cookies), at most
 *   STORAGE_FLUSH_CAP_MS, alongside the teardown (a before-quit listener cannot wait). Only once that flush has
 *   finished or timed out, the 'quit' handler arms app.exit(128 + n) POST_QUIT_EXIT_MS after 'quit'. A quit no signal
 *   started keeps its caps and gets no post-quit exit.
 * - A before-quit here never marks the app as quitting: a quit that waits for remote update operations must still let
 *   their restore dials through. The app marks it (quitState.quitting) where its teardown begins, past that wait; the
 *   active-work confirmation clears it while it holds the quit.
 * - A signal that arrives while a quit waits for remote updates keeps its own deadline: the OS is leaving, so the wait
 *   (and the SSH teardown after it) is cut at the deadline; the next launch recovers from the durable record.
 * - Every forced exit (deadline, second signal, quit cap, install cap) first stops what the app owns (stopOwnedChildren:
 *   its backends, an installer, SSH bootstraps still connecting; then the app's ONE teardown registry, the same pass
 *   will-quit runs, see teardown-registry.ts), saves the minimum state, and calls app.exit only once the storage flush
 *   has settled (started there if no signal started it; at most STORAGE_FLUSH_CAP_MS). So a quit cap after Cmd-Q
 *   flushes too, and a second signal lets the first signal's flush finish (bounded) instead of cutting it. A quit cap's forced exit (a quit no signal started) also runs an armed "Restart now" relaunch
 *   (relaunchIfArmed), since app.exit skips every will-quit handler; a signal's forced exit never relaunches.
 *
 * Time is monotonic (performance.now()): a wall clock stepped back by NTP during the quit moves neither the hold nor
 * the cap. The app's quit steps read the same clock, so a hold and the cap compare like with like.
 *
 * Logging never decides the outcome: a log that throws is ignored, and app.exit runs whatever happens before it.
 *
 * The minimum state is what a forced exit must not lose and can write synchronously: a pending appearance write, the
 * window bounds and the desktop log buffer (so the line above reaches desktop.log).
 *
 * Installed twice: early (a signal before the app is ready still quits) and again once the app is ready. Node sets the
 * OS handler (sigaction) only when a signal gets its first listener, and Chromium sets its own SIGTERM/SIGINT/SIGHUP
 * handlers during browser start-up, replacing Node's; so at ready every listener of each signal is taken off and put
 * back in the same order, which makes Node set its handler again, last. Each phase runs once.
 *
 * A signal before ready: until Chromium sets its handler, ours runs (the quit above, deadline armed). Between Chromium's
 * start-up and ready, Chromium's one-shot handler gets it and asks for a plain quit: before-quit runs with no signal
 * recorded. That quit cannot be told from a user's quit, so nothing here guesses: the before-quit line says
 * 'signal=no' and the quit cap bounds it like any user quit. From ready on, every signal is ours, and Node's handler is
 * not one-shot.
 *
 * Diagnostics, each written to desktop.log at once: '[shutdown] handlers installed (<phase>)', '[shutdown] <SIG>
 * received: ...' when the handler runs, '[shutdown] before-quit seen (signal=<yes|no>)' first on every before-quit,
 * '[shutdown] quit cap armed (...)', '[shutdown] quit held for the active-work choice: cap off' and the clean or forced
 * lines above.
 *
 * No effect on import: nothing is installed until installShutdownSignals() runs.
 */

export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

export const SHUTDOWN_SIGNAL_NUMBERS: Readonly<Record<ShutdownSignal, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15
}

export const SIGNAL_QUIT_DEADLINE_MS = 8_000

/** No hold extends the deadline past this many ms after the first signal. */
export const SIGNAL_QUIT_HARD_CAP_MS = 12_000

/** Any quit a signal did not start: forced if it has not finished this many ms after its first before-quit. */
export const QUIT_HARD_CAP_MS = 12_000

/**
 * The app-update install's quit: Squirrel.Mac checks the downloaded bundle and hands it to ShipIt around the quit
 * quitAndInstall() starts, which a large bundle on a slow disk can stretch past 12 s; cut short, the update is lost.
 * Still bounded, and below the app's 90 s install watchdog (iclone-app-update.ts), so a hung install quit is forced
 * before the watchdog would report the install as failed in an app that is half torn down.
 */
export const INSTALL_QUIT_CAP_MS = 60_000

/**
 * A quit that waits for remote (SSH) update operations before its SSH teardown (main.ts joins the updater's observer
 * and restore first: cut there, the teardown never runs and the remote `serve --isolated` is orphaned). Derived from
 * the updater's own worst case (managed-ssh-update.ts): the observer gives up after 60 min
 * (DEFAULT_REMOTE_UPDATE_TIMEOUT_MS), a recovery's clearance wait after 5 min (DEFAULT_REMOTE_CLEARANCE_TIMEOUT_MS),
 * plus 5 min for the rest: preflight and launch (30 s execs, the 10 s intent proof), the last observation running past
 * the deadline (a 30 s exec), the 15 s receipt grace and the restore dials. Past that the updater has failed on its own
 * terms, and the remote install marker fails closed on the next launch. Once the wait ends, the rest of the quit gets
 * QUIT_HARD_CAP_MS from then.
 */
export const REMOTE_UPDATE_QUIT_CAP_MS = 70 * 60_000

/**
 * The quit cap never cuts inside a running step's hold (the SSH teardown's 6 s race and force cleanup), but waits for
 * it no longer than this past the cap: a hold extends the bound, it never removes it.
 */
export const QUIT_CAP_HOLD_CEILING_MS = 12_000

/** The exit code of a quit the cap had to force: not 0, so a probe tells a forced quit from a clean one. */
export const QUIT_CAP_EXIT_CODE = 1

/** A signal quit waits at most this long for the session storage to reach disk before its post-quit exit is armed. */
export const STORAGE_FLUSH_CAP_MS = 2_000

/** After a signal quit's 'quit' event (and its storage flush), the process exits this many ms later at the latest. */
export const POST_QUIT_EXIT_MS = 3_000

export interface ShutdownSignalsApp {
  quit(): void
  exit(code: number): void
  on(event: 'quit' | 'will-quit', listener: () => void): unknown
  /** before-quit: the diagnostic line goes ahead of every other listener. */
  prependListener(event: 'before-quit', listener: () => void): unknown
  /** When given, the handlers are installed again once it resolves (see above). */
  whenReady?(): Promise<unknown>
}

type SignalListener = (signal: ShutdownSignal) => void

export interface ShutdownSignalsProcess {
  on(signal: ShutdownSignal, listener: SignalListener): unknown
  removeListener(signal: ShutdownSignal, listener: SignalListener): unknown
  /** The listeners as registered: a `once` listener is its wrapper, so putting it back keeps it one-shot. */
  rawListeners(signal: ShutdownSignal): unknown[]
}

export interface ShutdownSignalsDeps {
  app: ShutdownSignalsApp
  process: ShutdownSignalsProcess
  /** The quit state main.ts reads: the confirmation and macOS window-all-closed both honour this flag. */
  quitState: { isQuittingForHandoff: boolean; quitting?: boolean }
  /**
   * Writes the session storage to disk (DOM storage, cookies), once per process, at most storageFlushCapMs: started by
   * a signal's before-quit and by the teardown (will-quit, every forced exit). Awaited before the post-quit exit is
   * armed and before a forced exit's app.exit; never what holds the quit itself.
   */
  flushStorage?: () => unknown
  /**
   * Synchronous: the app's ONE teardown registry (teardown-registry.ts), each stop at most once; returns what ran, for
   * the log line. Run on will-quit and by every forced exit, with the storage flush.
   */
  teardown?: () => string[]
  storageFlushCapMs?: number
  postQuitExitMs?: number
  log(line: string): void
  /** Starts the teardown work that runs alongside app.quit() (e.g. the backend stop) so it can be tracked. */
  beginTeardown(signal: ShutdownSignal): void
  /** Synchronous: the minimum state a forced exit must not lose. Runs last before app.exit, so the log line lands. */
  saveMinimumState(): void
  /** Synchronous: a quit cap's forced exit runs this right before app.exit (an armed relaunch; will-quit is skipped). */
  relaunchIfArmed?: () => void
  /** Synchronous: stops the child process groups the app owns; returns what it signalled, for the log line. */
  stopOwnedChildren(): string[]
  /** The teardown steps still running, named for the log line. */
  pendingTeardown(): string[]
  /** The time (in now() ms) until which a running step may still finish on its own, or null. */
  holdUntil?: () => null | number
  /** Monotonic ms; defaults to performance.now(), the clock the app's quit steps use too. */
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
  deadlineMs?: number
  /** Defaults to QUIT_HARD_CAP_MS / INSTALL_QUIT_CAP_MS / REMOTE_UPDATE_QUIT_CAP_MS. */
  quitCapMs?: number
  installQuitCapMs?: number
  remoteUpdateQuitCapMs?: number
}

export interface ShutdownSignalsHandle {
  /** The signal that started the quit, or null. */
  signalled(): null | ShutdownSignal
  /** True once the forced exit ran (deadline or second signal). */
  forced(): boolean
  /** Installs the handlers for a phase ('early', 'ready'), once per phase; ours ends up the OS handler. */
  install(phase: string): void
  /** The active-work confirmation is on screen: the cap of a quit no signal started stands down until the next quit. */
  holdForChoice(): void
  /** The quit under way is the app-update install: its cap becomes INSTALL_QUIT_CAP_MS from its first before-quit. */
  capForInstall(): void
  /**
   * The quit under way waits for remote update operations: until remoteUpdatesJoined(), its cap is
   * REMOTE_UPDATE_QUIT_CAP_MS from its first before-quit instead of 12 s. Once per wait.
   */
  capForRemoteUpdates(): void
  /** The remote-update wait has ended: the rest of the quit (the SSH teardown) gets the normal cap from now. */
  remoteUpdatesJoined(): void
}

const installed = new WeakMap<object, ShutdownSignalsHandle>()

/** A log line on the way out: a log that throws is ignored, never what stops the quit or the exit. */
function say(log: (line: string) => void, line: () => string): void {
  try {
    log(line())
  } catch {
    // Nothing left to tell it to.
  }
}

function attempt<T>(log: (line: string) => void, what: string, run: () => T, fallback: T): T {
  try {
    return run()
  } catch (error) {
    say(log, () => `[shutdown] ${what} failed: ${error instanceof Error ? error.message : String(error)}`)

    return fallback
  }
}

export function installShutdownSignals(deps: ShutdownSignalsDeps): ShutdownSignalsHandle {
  const existing = installed.get(deps.process)

  if (existing) {
    return existing
  }

  const now = deps.now ?? (() => performance.now())

  const schedule =
    deps.setTimeout ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)

      // The deadline must never be what keeps the process alive.
      timer.unref?.()

      return timer
    })

  // The storage flush cap and the post-quit exit: not unref-ed. After 'quit' they are what ends the process, so a loop
  // with nothing else referenced must still run them.
  const scheduleKept = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))

  const cancel = deps.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const storageFlushCapMs = deps.storageFlushCapMs ?? STORAGE_FLUSH_CAP_MS
  const postQuitExitMs = deps.postQuitExitMs ?? POST_QUIT_EXIT_MS
  const deadlineMs = deps.deadlineMs ?? SIGNAL_QUIT_DEADLINE_MS
  const quitCapMs = deps.quitCapMs ?? QUIT_HARD_CAP_MS
  const installQuitCapMs = deps.installQuitCapMs ?? INSTALL_QUIT_CAP_MS
  const remoteUpdateQuitCapMs = deps.remoteUpdateQuitCapMs ?? REMOTE_UPDATE_QUIT_CAP_MS
  let first: null | ShutdownSignal = null
  let startedAt = 0
  let exiting = false
  let quitDone = false
  let timer: unknown = null
  // A quit no signal started: when its first before-quit ran (null: none under way), and whether it is the install.
  let quitStartedAt: null | number = null
  let installQuit = false
  // The quit is waiting for remote update operations (capForRemoteUpdates until remoteUpdatesJoined).
  let remoteUpdateWait = false
  // Which cap timer is current: one cleared or replaced forces nothing, even if it was already queued.
  let capGeneration = 0
  // A signal quit's storage flush (settles when it finished or timed out, never rejects) and its post-quit exit.
  let storageFlushed: null | Promise<void> = null
  // The flush has finished, failed or timed out (or there is none): a forced exit may call app.exit at once.
  let storageFlushSettled = false
  let postQuitTimer: unknown = null
  let quitAt = 0

  // Once per process: the flush, raced against its cap. Whatever the flush does (throws, rejects, never settles), the
  // promise settles by the cap, so the exit that waits on it is still armed.
  const flushStorage = (): Promise<void> => {
    if (storageFlushed) {
      return storageFlushed
    }

    const flush = deps.flushStorage

    if (!flush) {
      storageFlushSettled = true
      storageFlushed = Promise.resolve()

      return storageFlushed
    }

    const began = now()

    storageFlushed = new Promise<void>(resolve => {
      let capTimer: unknown = null
      let settled = false

      const finish = (how: () => string) => {
        if (settled) {
          return
        }

        settled = true
        storageFlushSettled = true

        if (capTimer !== null) {
          cancel(capTimer)
        }

        say(deps.log, () => `[shutdown] storage flush: ${how()}`)
        resolve()
      }

      capTimer = scheduleKept(() => finish(() => `timed out after ${storageFlushCapMs} ms`), storageFlushCapMs)

      const failed = (error: unknown) =>
        finish(
          () =>
            // The error's class only: a store's message can carry a profile path.
            `failed after ${Math.round(now() - began)} ms (${error instanceof Error ? error.name : typeof error})`
        )

      try {
        Promise.resolve(flush()).then(() => finish(() => `done in ${Math.round(now() - began)} ms`), failed)
      } catch (error) {
        failed(error)
      }
    })

    return storageFlushed
  }

  // Signal quits only, and only after the flush settled: a clean quit loses nothing, so the exit just ends a hung
  // Chromium teardown. A second signal or another forced exit before it stands it down (exiting).
  const armPostQuitExit = (signal: ShutdownSignal) => {
    if (exiting || postQuitTimer !== null) {
      return
    }

    const ms = Math.max(0, quitAt + postQuitExitMs - now())

    postQuitTimer = scheduleKept(() => {
      if (exiting) {
        return
      }

      exiting = true

      try {
        say(deps.log, () => `[shutdown] ${signal}: exiting after quit (${Math.round(now() - quitAt)} ms)`)
      } finally {
        deps.app.exit(signalExitCode(signal))
      }
    }, ms)
    say(deps.log, () => `[shutdown] ${signal}: exit armed (${Math.round(ms)} ms)`)
  }

  const stopTimer = () => {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  // The ONE teardown: the app's registry (each stop at most once) and the bounded storage flush. will-quit and every
  // forced exit run this same pass; the flush is once per process, so a flush a signal already started is joined.
  const teardown = (): string[] => {
    const stopped = attempt(deps.log, 'running the teardown', () => deps.teardown?.() ?? [], [] as string[])

    void flushStorage()

    return stopped
  }

  // app.exit once the storage flush has settled: at once when it already has (or there is none), else when it does,
  // which its own cap bounds (STORAGE_FLUSH_CAP_MS). A second signal therefore never cuts a flush in flight.
  const exitAfterFlush = (code: number) => {
    if (storageFlushed === null || storageFlushSettled) {
      deps.app.exit(code)

      return
    }

    say(deps.log, () => `[shutdown] exit waits for the storage flush (at most ${storageFlushCapMs} ms)`)
    void storageFlushed.then(
      () => deps.app.exit(code),
      () => deps.app.exit(code)
    )
  }

  // A second signal still forces after a clean 'quit' (a hung Chromium shutdown); only the deadline stands down.
  const forceExit = (reason: string, code: number, since: number, relaunch = false) => {
    if (exiting) {
      return
    }

    // Set first: a re-entrant signal from inside a step below must not start a second exit.
    exiting = true

    try {
      const stopped = [
        ...attempt(deps.log, 'stopping child processes', () => deps.stopOwnedChildren(), [] as string[]),
        ...teardown()
      ]

      const pending = attempt(deps.log, 'reading the teardown', () => deps.pendingTeardown(), ['unknown'])

      say(
        deps.log,
        () =>
          `[shutdown] ${reason}: forcing exit after ${Math.round(now() - since)} ms; ` +
          `not finished: ${pending.length > 0 ? pending.join(', ') : 'none'}; ` +
          `stopped: ${stopped.length > 0 ? stopped.join(', ') : 'none'}`
      )
      attempt(deps.log, 'saving state', () => deps.saveMinimumState(), undefined)

      if (relaunch) {
        attempt(deps.log, 'relaunching', () => deps.relaunchIfArmed?.(), undefined)
      }
    } finally {
      exitAfterFlush(code)
    }
  }

  const signalExitCode = (signal: ShutdownSignal) => 128 + SHUTDOWN_SIGNAL_NUMBERS[signal]

  const onDeadline = (signal: ShutdownSignal) => {
    timer = null

    if (exiting || quitDone) {
      return
    }

    const cap = startedAt + SIGNAL_QUIT_HARD_CAP_MS
    const hold = attempt(deps.log, 'reading the teardown hold', () => deps.holdUntil?.() ?? null, null)
    const until = hold === null ? null : Math.min(hold, cap)
    const at = now()

    if (until !== null && until > at) {
      timer = schedule(() => onDeadline(signal), until - at)

      return
    }

    forceExit('deadline', signalExitCode(signal), startedAt)
  }

  // capAt: when this cap was due; a hold may move the check past it, never past capAt + QUIT_CAP_HOLD_CEILING_MS.
  const scheduleCapCheck = (capAt: number, at: number) => {
    const generation = ++capGeneration

    timer = schedule(() => onQuitCap(generation, capAt), Math.max(0, at - now()))
  }

  const onQuitCap = (generation: number, capAt: number) => {
    if (generation !== capGeneration) {
      return
    }

    timer = null

    if (first || exiting || quitDone || quitStartedAt === null) {
      return
    }

    const hold = attempt(deps.log, 'reading the teardown hold', () => deps.holdUntil?.() ?? null, null)
    const until = hold === null ? null : Math.min(hold, capAt + QUIT_CAP_HOLD_CEILING_MS)
    const at = now()

    if (until !== null && until > at) {
      say(deps.log, () => `[shutdown] quit cap: waiting ${Math.round(until - at)} ms for the teardown hold`)
      scheduleCapCheck(capAt, until)

      return
    }

    forceExit(remoteUpdateWait ? 'quit cap (remote updates)' : 'quit cap', QUIT_CAP_EXIT_CODE, quitStartedAt, true)
  }

  // from: when this cap counts from (the quit's first before-quit, or the end of its remote-update wait).
  const scheduleQuitCap = (from: number) => {
    stopTimer()
    const capMs = remoteUpdateWait ? remoteUpdateQuitCapMs : installQuit ? installQuitCapMs : quitCapMs
    const capAt = from + capMs
    const why = remoteUpdateWait ? ', remote updates' : installQuit ? ', app-update install' : ''

    scheduleCapCheck(capAt, capAt)
    say(deps.log, () => `[shutdown] quit cap armed (${capMs} ms${why})`)
  }

  // Every quit is bounded: the first before-quit of a quit no signal started arms the cap, once per quit.
  const armQuitCap = () => {
    if (first || exiting || quitDone || quitStartedAt !== null) {
      return
    }

    quitStartedAt = now()
    scheduleQuitCap(quitStartedAt)
  }

  const onSignal = (signal: ShutdownSignal) => {
    if (first) {
      forceExit(`second ${signal}`, signalExitCode(first), startedAt)

      return
    }

    first = signal
    startedAt = now()
    // The signal's own deadline replaces the cap of a quit already under way; a cap callback already queued is stale
    // and must not touch the deadline's timer.
    stopTimer()
    capGeneration += 1
    // Like an update hand-off, the OS is leaving: no confirmation, and macOS window-all-closed quits the process.
    deps.quitState.isQuittingForHandoff = true
    say(deps.log, () => `[shutdown] ${signal} received: quitting (deadline ${deadlineMs} ms)`)
    attempt(deps.log, 'starting the teardown', () => deps.beginTeardown(signal), undefined)
    timer = schedule(() => onDeadline(signal), deadlineMs)
    deps.app.quit()
  }

  deps.app.on('quit', () => {
    if (exiting || quitDone || (!first && quitStartedAt === null)) {
      return
    }

    quitDone = true
    quitAt = now()
    stopTimer()

    // The probe for a clean quit requires these exact lines; the log dep writes them to desktop.log synchronously.
    if (first) {
      const signal = first

      say(deps.log, () => `[shutdown] ${signal}: clean quit after ${Math.round(now() - startedAt)} ms`)
      // Never before the flush has finished or timed out (it began at the signal's before-quit).
      void flushStorage().then(() => armPostQuitExit(signal))
    } else {
      say(
        deps.log,
        () => `[shutdown] quit: clean quit after ${Math.round(now() - (quitStartedAt ?? 0))} ms (signal=no)`
      )
    }
  })

  // The quit goes through: the same teardown a forced exit runs (a forced exit's app.exit skips will-quit).
  deps.app.on('will-quit', () => {
    teardown()
  })

  deps.app.prependListener('before-quit', () => {
    say(deps.log, () => `[shutdown] before-quit seen (signal=${first ? 'yes' : 'no'})`)

    if (first) {
      void flushStorage()
    }

    armQuitCap()
  })

  const phases = new Set<string>()

  const install = (phase: string) => {
    if (phases.has(phase)) {
      return
    }

    phases.add(phase)

    for (const signal of SHUTDOWN_SIGNALS) {
      // Every listener off (Node closes its signal handle and drops its OS handler), then back on in the same order
      // (Node opens a new handle and sets its OS handler again, over whatever was set since). Synchronous: the gap
      // between the two is a few system calls.
      // rawListeners: a third party's `once` listener comes back as its one-shot wrapper, not as a permanent listener.
      const current = deps.process.rawListeners(signal) as SignalListener[]

      for (const listener of current) {
        deps.process.removeListener(signal, listener)
      }

      for (const listener of current.includes(onSignal) ? current : [...current, onSignal]) {
        deps.process.on(signal, listener)
      }
    }

    say(deps.log, () => `[shutdown] handlers installed (${phase})`)
  }

  const handle: ShutdownSignalsHandle = {
    signalled: () => first,
    forced: () => exiting,
    install,
    holdForChoice() {
      if (first || exiting || quitDone) {
        return
      }

      // The quit is held on the user's choice: "Keep Running" goes on working, so new work may start again (a mark the
      // teardown of an earlier pass set is cleared).
      deps.quitState.quitting = false

      if (quitStartedAt === null) {
        return
      }

      stopTimer()
      capGeneration += 1
      quitStartedAt = null
      // The next quit tells again whether it waits for remote updates.
      remoteUpdateWait = false
      say(deps.log, () => '[shutdown] quit held for the active-work choice: cap off')
    },
    capForInstall() {
      installQuit = true

      if (!first && !exiting && !quitDone && quitStartedAt !== null) {
        scheduleQuitCap(quitStartedAt)
      }
    },
    capForRemoteUpdates() {
      if (remoteUpdateWait || first || exiting || quitDone || quitStartedAt === null) {
        return
      }

      remoteUpdateWait = true
      scheduleQuitCap(quitStartedAt)
    },
    remoteUpdatesJoined() {
      if (!remoteUpdateWait) {
        return
      }

      remoteUpdateWait = false

      if (first || exiting || quitDone || quitStartedAt === null) {
        return
      }

      say(deps.log, () => '[shutdown] remote updates joined')
      scheduleQuitCap(now())
    }
  }

  installed.set(deps.process, handle)
  install('early')
  void deps.app.whenReady?.().then(
    () => install('ready'),
    () => undefined
  )

  return handle
}
