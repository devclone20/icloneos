/**
 * v0.0.9 F2 (P0_HERMES_FAILURES bug B): WHY a local backend boot failed, as a structured value.
 *
 * Before this, the boot error was a string that carried the last 20 lines of the SHARED desktop log; those always
 * hold main's own `[iclone-gate] … loaded by Hermes` success line, so a substring test (`isIcloneGateFailure`) called
 * EVERY pre-ready exit "the permission gate is not in place" and Repair chose a hard reinstall that could not help.
 *
 * Now main classifies once, from the child's OWN output (stdout+stderr captured from the instant of spawn, never the
 * shared log) or from main's own typed errors, and the cause rides on the error (`error.bootCause`) and on the boot
 * progress broadcast (`bootCause`). Consumers (F3: backend-start-failure.ts, bootstrap-ipc.ts, the failure overlay)
 * read the code; nobody parses text.
 *
 * Only main's own gate refusals (`IcloneGateError`, an error main threw whose message STARTS with the gate mark) and
 * sandbox-exec's exit 71 are `gate-not-loaded`. A gate mark anywhere else in a message is never a cause.
 *
 * Dependency-free on purpose: the renderer-facing type and the classifier are importable from main, from tests and
 * (type-only) from the renderer.
 */

export type BootCauseCode =
  | 'exit-nonzero'
  | 'gate-not-loaded'
  | 'install-state-not-writable'
  | 'port-in-use'
  | 'python-import'
  /** The app installed its runtime here before, and that install's environment has no working interpreter now. */
  | 'runtime-env-broken'
  | 'timeout'
  | 'unknown'

export interface BootCause {
  code: BootCauseCode
  /** The one output line (or main's own message) the code was read from: trimmed, one line, capped, masked. */
  line?: string
}

export const BOOT_CAUSE_CODES: readonly BootCauseCode[] = [
  'exit-nonzero',
  'gate-not-loaded',
  'install-state-not-writable',
  'port-in-use',
  'python-import',
  'runtime-env-broken',
  'timeout',
  'unknown'
]

/**
 * Causes a restart cannot cure: the same runtime, profile and folders fail the same way again. They keep the latch
 * (the loop breaker) and are never restarted automatically; the user's Retry / Repair clears them.
 */
const DETERMINISTIC: ReadonlySet<BootCauseCode> = new Set([
  'gate-not-loaded',
  'install-state-not-writable',
  'python-import',
  'runtime-env-broken'
])

export function isDeterministicBootCause(cause: BootCause | null | undefined): boolean {
  return Boolean(cause && DETERMINISTIC.has(cause.code))
}

/** Main's own gate mark (`iclone-hermes-plugins.ts` GATE_MARK); duplicated so this file stays dependency-free. */
const GATE_MARK = '[iclone-gate]'
const SANDBOX_EXEC_FAILED_STATUS = 71
const LINE_MAX = 240
/** The newest output only: a long-lived child's tail is capped by its buffer anyway. */
const OUTPUT_SCAN_MAX = 64 * 1024
/**
 * v0.0.9 Q (lead decision 5): a cause is read only from the END of the output — the last lines a dying process
 * printed (an uncaught traceback ends with its exception line; `install state is not writable` and `address already in
 * use` are the last things said). A matching line further up is an old warning (an optional import Hermes logged and
 * skipped), never the verdict on this exit.
 */
export const BOOT_CAUSE_WINDOW_LINES = 25
/** After readiness the window is tighter still: a crash's own words are its very last lines. */
export const CRASH_CAUSE_WINDOW_LINES = 5

const INSTALL_STATE_NOT_WRITABLE = /install state is not writable/i
const PORT_IN_USE = /EADDRINUSE|address already in use|\[Errno (?:48|98|10048)\]/i
const PYTHON_IMPORT = /\b(?:ModuleNotFoundError|ImportError)\b|No module named /
/** The header Python prints before an uncaught exception's frames. */
const TRACEBACK_HEADER = /^Traceback \(most recent call last\):/
/** An exception line (`ModuleNotFoundError: …`, `pkg.errors.Foo: …`, a bare `KeyboardInterrupt`): never a log record. */
const EXCEPTION_LINE = /^(?:[A-Za-z_][\w]*\.)*[A-Z]\w*(?:Error|Exception|Exit|Interrupt|Warning)\b(?::|$)/
/**
 * At most this many lines may follow the final exception line (an `atexit` note, a `sys:1: ResourceWarning`). An
 * uncaught exception is the last thing a dying interpreter says; more output after it means the process carried on.
 */
const IMPORT_VERDICT_TRAILER_MAX = 2
/**
 * v0.0.9 r2 (m-r2-3): the runtime's own last word on a missing package — its two-line panel ends with
 * `Details: No module named 'fastapi'` (hermes_cli: "plain sentence, then Details: <raw>") and exits 1, with no
 * traceback. Read only as the LAST line of a non-zero exit, like an exception line.
 */
const RUNTIME_IMPORT_DETAILS = /^Details:\s+(?:ModuleNotFoundError:\s+|ImportError:\s+)?No module named ['"][\w.]+['"]/
const TIMEOUT = /\btimed out\b|\btimeout\b/i
const SUPERSEDED = /superseded by a newer connection attempt/i

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** One line, safe to show and to log: no ANSI or control characters, credentials masked, capped. */
export function boundedCauseLine(text: string): string {
  const line = text
    .replace(ANSI, '')
    .replace(CONTROL, ' ')
    .replace(/\b((?:[A-Za-z0-9_-]*?)(?:token|secret|password|api[-_]?key|authorization))(\s*[:=]\s*)\S+/gi, '$1$2***')
    .replace(/\bbearer\s+\S+/gi, 'bearer ***')
    .replace(/\s+/g, ' ')
    .trim()

  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line
}

function outputLines(output: string): string[] {
  const recent = output.length > OUTPUT_SCAN_MAX ? output.slice(output.length - OUTPUT_SCAN_MAX) : output

  return recent
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

/** The LAST line matching `pattern` (the newest statement of the failure), or null. */
function lastMatching(lines: readonly string[], pattern: RegExp): null | string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index]!)) {
      return lines[index]!
    }
  }

  return null
}

/**
 * v0.0.9 critic m2: `python-import` is deterministic (no auto-restart), so it is read only from the exception that
 * ENDED the process: the exception line of the last traceback block in the window (or, with no traceback, the last
 * exception line), and only when that line is the end of the output (at most IMPORT_VERDICT_TRAILER_MAX lines after
 * it) and no signal killed the process (an uncaught ImportError exits 1, it is never a signal). A skipped optional
 * import a logger printed earlier — a WARNING line, or a whole traceback the process outlived — is no verdict: the
 * exit stays transient (`exit-nonzero`) and the supervisor restarts it.
 */
function finalImportFailure(
  window: readonly string[],
  signal: NodeJS.Signals | null | undefined,
  nonZeroExit: boolean
): null | string {
  if (signal) {
    return null
  }

  const last = window.at(-1)

  if (nonZeroExit && last !== undefined && RUNTIME_IMPORT_DETAILS.test(last)) {
    return last
  }

  let header = -1

  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (TRACEBACK_HEADER.test(window[index]!)) {
      header = index

      break
    }
  }

  let verdict = -1

  for (let index = window.length - 1; index > header; index -= 1) {
    if (EXCEPTION_LINE.test(window[index]!)) {
      verdict = index

      break
    }
  }

  if (verdict < 0 || window.length - 1 - verdict > IMPORT_VERDICT_TRAILER_MAX) {
    return null
  }

  const line = window[verdict]!

  return PYTHON_IMPORT.test(line) ? line : null
}

function cause(code: BootCauseCode, line?: null | string): BootCause {
  return line ? { code, line: boundedCauseLine(line) } : { code }
}

/**
 * A child that exited (or could not be started) before it announced readiness. `output` is the child's OWN
 * stdout+stderr (`createBackendOutputTail().text()`); `confinedExec` is `describeConfinedExecFailure`'s answer.
 */
export function classifyBootExit(input: {
  code: null | number
  confinedExec?: null | string
  output: string
  signal?: NodeJS.Signals | null
  /** The backend had announced readiness (a crash, not a boot failure). */
  afterReady?: boolean
}): BootCause {
  if (input.confinedExec || (input.code === SANDBOX_EXEC_FAILED_STATUS && /sandbox-exec:/.test(input.output))) {
    return cause('gate-not-loaded', input.confinedExec ?? lastMatching(outputLines(input.output), /sandbox-exec:/))
  }

  const lines = outputLines(input.output)
  // Decision 5: only the last lines decide. After readiness, only a non-zero exit whose very last lines name the
  // reason (a signal, a SIGKILL from the OS, an exit 0 are no such statement).
  const nonZeroExit = typeof input.code === 'number' && input.code !== 0

  const window = input.afterReady
    ? nonZeroExit
      ? lines.slice(-CRASH_CAUSE_WINDOW_LINES)
      : []
    : lines.slice(-BOOT_CAUSE_WINDOW_LINES)

  const notWritable = lastMatching(window, INSTALL_STATE_NOT_WRITABLE)

  if (notWritable) {
    return cause('install-state-not-writable', notWritable)
  }

  const portInUse = lastMatching(window, PORT_IN_USE)

  if (portInUse) {
    return cause('port-in-use', portInUse)
  }

  const importFailure = finalImportFailure(window, input.signal, nonZeroExit)

  if (importFailure) {
    return cause('python-import', importFailure)
  }

  if (input.signal || (typeof input.code === 'number' && input.code !== 0)) {
    return cause('exit-nonzero', lines.at(-1) ?? `exit ${input.signal || input.code}`)
  }

  return cause('unknown', lines.at(-1) ?? null)
}

/** The cause a boot error already carries (set by main), else null. Never reads the message text. */
export function readBootCause(error: unknown): BootCause | null {
  const value = error && typeof error === 'object' ? (error as { bootCause?: unknown }).bootCause : undefined

  return isBootCause(value) ? value : null
}

export function isBootCause(value: unknown): value is BootCause {
  if (!value || typeof value !== 'object') {
    return false
  }

  const { code, line } = value as { code?: unknown; line?: unknown }

  return (
    typeof code === 'string' &&
    (BOOT_CAUSE_CODES as readonly string[]).includes(code) &&
    (line === undefined || typeof line === 'string')
  )
}

/**
 * Any boot error main caught. A cause the error already carries wins; else main's OWN typed failures: an
 * `IcloneGateError` (or a message main built that STARTS with the gate mark — `prepareHermesSpawn` refusals), a
 * deadline main enforced. Everything else is `unknown`. Log tails are never consulted.
 */
export function classifyBootError(error: unknown): BootCause {
  const carried = readBootCause(error)

  if (carried) {
    return carried
  }

  const message = (() => {
    try {
      return error instanceof Error ? String(error.message) : String(error)
    } catch {
      return ''
    }
  })()

  const firstLine = message.split('\n')[0] ?? ''

  if (
    (error && typeof error === 'object' && (error as { isIcloneGateFailure?: unknown }).isIcloneGateFailure === true) ||
    message.startsWith(GATE_MARK)
  ) {
    return cause('gate-not-loaded', firstLine)
  }

  if (INSTALL_STATE_NOT_WRITABLE.test(firstLine)) {
    return cause('install-state-not-writable', firstLine)
  }

  if (TIMEOUT.test(firstLine)) {
    return cause('timeout', firstLine)
  }

  return cause('unknown', firstLine || null)
}

/** The missing top-level package a `python-import` cause line names (`fastapi` for `No module named 'fastapi.x'`). */
export function missingModuleOf(cause: BootCause | null | undefined): null | string {
  if (!cause || cause.code !== 'python-import' || !cause.line) {
    return null
  }

  const named = /No module named ['"]([A-Za-z_][\w.]*)['"]/.exec(cause.line)?.[1]

  return named ? named.split('.')[0]! : null
}

/** A newer attempt replaced this one: not a failure of the backend, never restarted for. */
export function isSupersededBootError(error: unknown): boolean {
  try {
    return error instanceof Error && SUPERSEDED.test(error.message)
  } catch {
    return false
  }
}

/** Attach `cause` to `error` (returned for chaining). The field is non-enumerable-safe plain data. */
export function withBootCause<E extends Error>(error: E, bootCause: BootCause): E & { bootCause: BootCause } {
  return Object.assign(error, { bootCause })
}
