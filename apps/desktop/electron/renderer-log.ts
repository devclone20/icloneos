/**
 * Renderer console/error capture shared by every renderer-content window.
 *
 * Historically only the primary window (`createWindow()`) attached a
 * `console-message` hook, so a renderer crash in ANY other window — secondary
 * session windows, instance windows, the HUD, quick entry —
 * evaporated with the window: nothing in desktop.log, nothing to attach to a
 * bug report (#79428 defect B). The React error boundary logs crashes via
 * `console.error`, so windows without the hook also lost every boundary catch.
 *
 * `attachRendererConsoleCapture` is the one owner of that hook. Every window
 * that loads our renderer must go through it; the label says which window the
 * line came from so multi-window reports are diagnosable. Windows that load
 * EXTERNAL content (OAuth portals) must NOT attach — third-party pages can log
 * tokens or PII we never want on disk.
 */
import { fixtureSwitchLogLine, type FixtureWallet } from './fixture-wallet'

interface ConsoleMessageDetails {
  level: number
  message: string
  sourceUrl: string
  lineNumber: number
}

interface WebContentsLike {
  on(event: 'console-message', listener: (...args: unknown[]) => void): unknown
}

interface WindowLike {
  webContents: WebContentsLike
}

/** Normalize Electron's two `console-message` signatures into one line, or
 *  null for non-error levels. Canonical (Electron 36+): `(event, details)`;
 *  deprecated positional: `(event, level, message, line, sourceId)`.
 *  `level` is numeric 0..3, where 3 === error. */
export function formatRendererConsoleLine(
  label: string,
  detailsOrLevel: unknown,
  message?: unknown,
  line?: unknown,
  sourceId?: unknown
): string | null {
  const details =
    detailsOrLevel && typeof detailsOrLevel === 'object' ? (detailsOrLevel as ConsoleMessageDetails) : null

  const level = details ? details.level : detailsOrLevel

  if (level !== 3) {
    return null
  }

  const text = details ? details.message : message
  const src = details ? details.sourceUrl : sourceId
  const lineNo = details ? details.lineNumber : line

  return `[renderer console:${label}] ${String(text)} (${String(src)}:${String(lineNo)})`
}

/** Attach the error-level console hook to a renderer window. `log` is the
 *  desktop.log sink (rememberLog in main.ts). */
export function attachRendererConsoleCapture(win: WindowLike, label: string, log: (line: string) => void): void {
  win.webContents.on('console-message', (_event, detailsOrLevel, message, line, sourceId) => {
    const formatted = formatRendererConsoleLine(label, detailsOrLevel, message, line, sourceId)

    if (formatted !== null) {
      log(formatted)
    }
  })
}

/** v0.0.9 r3b: the text of ANY console line (every level), both signatures; for a dev-only tap (fixture-wallet.ts). */
export function attachRendererConsoleTap(win: WindowLike, tap: (message: unknown) => void): void {
  win.webContents.on('console-message', (_event, detailsOrLevel, message) => {
    tap(detailsOrLevel && typeof detailsOrLevel === 'object' ? (detailsOrLevel as ConsoleMessageDetails).message : message)
  })
}

/**
 * v0.0.9 r4 (eng r3b-m3): the fixture reopen-loop tap, attached ONLY in a dev/test run with an active fixture wallet.
 * A production (packaged) window, or any run without a fixture, gets no listener at all, so it pays nothing for a dev
 * hook. Three locks: the fixture is already null when packaged (codePathEnv + resolveFixtureWallet), and `isPackaged`
 * is checked again here. Returns whether the tap was attached.
 */
export function attachFixtureSwitchTap(
  win: WindowLike,
  options: { fixture: FixtureWallet | null; isPackaged: boolean },
  log: (line: string) => void
): boolean {
  const { fixture, isPackaged } = options

  if (isPackaged || !fixture) {
    return false
  }

  attachRendererConsoleTap(win, message => {
    const line = fixtureSwitchLogLine(fixture, message)

    if (line) {
      log(line)
    }
  })

  return true
}

/** Format a renderer error-boundary report (hermes:logs:renderer-error IPC)
 *  for desktop.log. Boundary catches carry the component stack — the one piece
 *  of context a minified console line loses — so persist it alongside.
 *  Inputs are renderer-supplied: clamp so a hostile/buggy payload cannot bloat
 *  the log. */
export function formatRendererBoundaryReport(
  label: unknown,
  boundary: unknown,
  message: unknown,
  componentStack: unknown
): string {
  const truncate = (value: unknown, max: number): string => String(value ?? '').slice(0, max)

  const head = `[renderer crash:${truncate(label, 64) || 'unknown'}] [error-boundary:${truncate(boundary, 64) || 'unknown'}] ${
    truncate(message, 2000) || '(no message)'
  }`

  const stack = truncate(componentStack, 4000).trim()

  return stack ? `${head}\n${stack}` : head
}
