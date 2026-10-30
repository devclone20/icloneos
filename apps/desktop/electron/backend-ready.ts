import type { EventEmitter } from 'node:events'
import fs from 'node:fs'

import type { BackendActivitySource } from './backend-health'
import {
  beginInstallBudget,
  INSTALL_CEILING_MS,
  INSTALL_STALL_MS,
  INSTALL_WATCHDOG_TAG,
  installBudgetDeadline
} from './install-liveness'

/** Listener registration as both ChildProcess and the EventEmitter fakes in tests expose it. */
type ListenerTarget = Pick<EventEmitter, 'on' | 'off'>

/** A spawned backend: exit/error on the process, the port announcement on stdout. */
interface AnnouncingChild extends ListenerTarget {
  stdout: ListenerTarget | null
}

// `hermes serve` announces HERMES_BACKEND_READY; the legacy `hermes dashboard`
// backend announces HERMES_DASHBOARD_READY. Accept either so the desktop spawn
// works against both the headless backend and old/dashboard runtimes.
const _READY_RE = /^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m

// The announcement clock starts the instant the backend process is spawned —
// before uvicorn binds its socket. On a cold install the child must first
// compile and import the whole `hermes_cli.main` → `web_server` → FastAPI/
// uvicorn chain, and on Windows real-time AV (Defender) scans every freshly
// written `.pyc`. That pre-bind cost can run 30-60s on a slow disk, so a tight
// 45s deadline kills a *healthy but still-starting* backend and respawns it,
// piling up orphaned processes (issue #50209). A roomier default absorbs the
// cold-start cost; a warm start still announces in well under a second.
const DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS = 90_000
// The historical default; kept as a named constant because callers and tests read it.
const MIN_PORT_ANNOUNCE_TIMEOUT_MS = 45_000

/**
 * The port-announcement deadline: always DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS. Ruling 42 (critic M4): no env knob may
 * lengthen a budget — HERMES_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS is gone (a value of 1e9 used to make main wait 11 days
 * for a silent child). A child that is visibly installing gets its time from the install liveness rule instead.
 */
function resolvePortAnnounceTimeoutMs(_env: NodeJS.ProcessEnv = process.env) {
  return DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS
}

/**
 * Settles with the first port `watch` reports; rejects when the child exits or errors first, or the timeout passes.
 * `watch` starts its port source and returns the function that stops it.
 *
 * With an `activity` source (the child's classified output, ruling 42 + amendment) the deadline slides once the child
 * shows install work (a `serve` that syncs its dependencies before binding): never earlier than `timeoutMs` after the
 * spawn (the silent cold-compile floor of before), DEFAULT_BACKEND_READY_TIMEOUT_MS after the child's last line while
 * it keeps talking, and never past BACKEND_INSTALL_CEILING_MS after the spawn. Until then, and without a source: the
 * fixed `timeoutMs` of before.
 */
function awaitAnnouncedPort(
  child: ListenerTarget,
  timeoutMs: number,
  describeOutputTail: () => string,
  watch: (found: (port: number) => void) => () => void,
  activity?: BackendActivitySource
) {
  return new Promise<number>((resolve, reject) => {
    let done = false
    const startedAt = Date.now()
    let installing = false
    let lastActivityAt = startedAt
    const budgetAt = () => installBudgetDeadline() ?? Number.POSITIVE_INFINITY

    // Ruling 42 r2: the silent cold-compile floor `timeoutMs` (90 s) from the spawn; once the child shows install work,
    // INSTALL_STALL_MS after its last progress (output or CPU) — never past the one first-launch budget.
    const deadline = () =>
      installing
        ? Math.min(budgetAt(), Math.max(startedAt + timeoutMs, lastActivityAt + INSTALL_STALL_MS))
        : Math.min(budgetAt(), startedAt + timeoutMs)

    const unsubscribeActivity =
      activity?.subscribe(kind => {
        if (kind === 'install' && !installing) {
          installing = true
          beginInstallBudget()
        }

        lastActivityAt = Math.max(lastActivityAt, Date.now())
      }) ?? (() => {})

    let stopWatch = () => {}

    function finish() {
      if (done) {
        return false
      }

      done = true
      clearTimeout(timer)
      unsubscribeActivity()
      stopWatch()
      child.off('exit', onExit)
      child.off('error', onError)

      return true
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      if (finish()) {
        reject(new Error(`Hermes backend: exited before port announcement (${signal || code})${describeOutputTail()}`))
      }
    }

    function onError(err: Error) {
      if (finish()) {
        reject(err)
      }
    }

    const onDeadline = () => {
      const remaining = deadline() - Date.now()

      // The child spoke since this timer was armed: the deadline moved, wait out the rest.
      if (remaining > 0) {
        timer = setTimeout(onDeadline, remaining)

        return
      }

      if (finish()) {
        const elapsed = Date.now() - startedAt

        reject(
          new Error(
            Date.now() >= budgetAt()
              ? `${INSTALL_WATCHDOG_TAG} ceiling ${Math.round(INSTALL_CEILING_MS / 1000)} s reached: the agent was still starting (no port yet)`
              : installing
                ? `${INSTALL_WATCHDOG_TAG} no progress (output or CPU) for ${Math.round(INSTALL_STALL_MS / 1000)} s while the agent installed its dependencies (no port yet)`
                : `Timed out waiting for Hermes backend port announcement (${timeoutMs}ms)`
          )
        )
      }
    }

    let timer = setTimeout(onDeadline, timeoutMs)

    child.on('exit', onExit)
    child.on('error', onError)
    stopWatch = watch(port => {
      if (finish()) {
        resolve(port)
      }
    })

    // The source may report synchronously, before its stop function was assigned.
    if (done) {
      stopWatch()
    }
  })
}

/**
 * Watch a child process's stdout for the `HERMES_(BACKEND|DASHBOARD)_READY
 * port=<N>` line that web_server.py prints after uvicorn binds its socket.
 *
 * Returns the parsed port. Rejects if:
 *   - the child exits before emitting the line
 *   - the child emits an `error` event
 *   - no line arrives within the timeout
 *
 * The default timeout is cold-start tolerant (see
 * DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS) because the clock starts before the
 * backend has even bound its port. Pass an explicit `timeoutMs` to override.
 *
 * A single `cleanup()` tears down every listener (data/exit/error/timeout)
 * on every terminal path — resolve, reject, or timeout — so repeated
 * backend spawns don't leak listener slots on the child.
 */
function waitForDashboardPort(
  child: AnnouncingChild,
  timeoutMs = resolvePortAnnounceTimeoutMs(),
  describeOutputTail = () => '',
  activity?: BackendActivitySource
) {
  return awaitAnnouncedPort(
    child,
    timeoutMs,
    describeOutputTail,
    found => {
      const stdout = child.stdout

      if (!stdout) {
        throw new TypeError('Hermes backend: stdout is not piped, so the port announcement cannot be read.')
      }

      let buf = ''

      function onData(chunk: Buffer | string) {
        buf += chunk.toString()
        let nl

        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const m = line.match(_READY_RE)

          if (m) {
            found(parseInt(m[1], 10))

            return
          }
        }
      }

      stdout.on('data', onData)

      return () => stdout.off('data', onData)
    },
    activity
  )
}

function readDashboardReadyFile(readyFile: fs.PathOrFileDescriptor) {
  if (!readyFile) {
    return null
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
    const port = Number(parsed?.port)

    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function waitForDashboardReadyFile(
  readyFile: fs.PathOrFileDescriptor,
  child: ListenerTarget,
  timeoutMs = resolvePortAnnounceTimeoutMs(),
  describeOutputTail = () => '',
  activity?: BackendActivitySource
) {
  return awaitAnnouncedPort(
    child,
    timeoutMs,
    describeOutputTail,
    found => {
      function check() {
        const port = readDashboardReadyFile(readyFile)

        if (port) {
          found(port)
        }
      }

      const interval = setInterval(check, 50)

      if (typeof interval.unref === 'function') {
        interval.unref()
      }

      check()

      return () => clearInterval(interval)
    },
    activity
  )
}

function waitForDashboardPortAnnouncement(
  child: AnnouncingChild,
  options: {
    /** Returns a formatted stdout/stderr tail suffix for exit errors (#93608). */
    describeOutputTail?: () => string
    readyFile?: fs.PathOrFileDescriptor | null
    timeoutMs?: number
    /** The child's output: slides the deadline while it talks (ruling 42, see awaitAnnouncedPort). */
    activity?: BackendActivitySource
  } = {}
) {
  const timeoutMs = options.timeoutMs ?? resolvePortAnnounceTimeoutMs()
  const describeOutputTail = options.describeOutputTail ?? (() => '')

  if (options.readyFile) {
    return waitForDashboardReadyFile(options.readyFile, child, timeoutMs, describeOutputTail, options.activity)
  }

  return waitForDashboardPort(child, timeoutMs, describeOutputTail, options.activity)
}

export {
  DEFAULT_PORT_ANNOUNCE_TIMEOUT_MS,
  MIN_PORT_ANNOUNCE_TIMEOUT_MS,
  readDashboardReadyFile,
  resolvePortAnnounceTimeoutMs,
  waitForDashboardPort,
  waitForDashboardPortAnnouncement,
  waitForDashboardReadyFile
}
