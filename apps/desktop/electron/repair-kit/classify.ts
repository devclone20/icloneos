import { ICLONE_GATE_MARK, ownErrorHead } from '../../src/iclone-shared/iclone-gate'
/**
 * v0.0.9 F3 — the cause of a failed boot, for the card and the repair router.
 *
 * The structured `bootCause` main attaches (electron/boot-cause.ts, F2) always wins. Until a failure carries one — an
 * error from an older main, or one that crossed IPC as text — the cause is inferred from the error's OWN text: its
 * first sentence and the child's output tail ("Recent backend output:"), never from the app log main appends after
 * " Log: " (that log holds the gate's own success line on every boot, the 14 Nov misreading).
 *
 * Pure: imported by main and by the renderer.
 */
import { type BootCause, type BootCauseCode, readBootCause } from '../boot-cause'

import type { RepairClassId } from './types'

const APPENDED_LOG = ' Log: '

/** PM's own words when the install state it picked cannot be written (pm/environments.py). */
const INSTALL_STATE_NOT_WRITABLE = /install state is not writable by this user \(/
const PORT_IN_USE = /\b(?:EADDRINUSE|Address already in use|\[Errno (?:48|98)\])/
const PYTHON_IMPORT = /\b(?:ModuleNotFoundError|ImportError|No module named)\b/
const EXITED = /exited before it became ready \(/
const TIMEOUT = /\b(?:timed out|did not become ready|Timed out waiting)\b/i

/** The part of a boot error that is the error itself: everything before main's appended app log. */
export function ownErrorText(text: string): string {
  const cut = text.indexOf(APPENDED_LOG)

  return cut === -1 ? text : text.slice(0, cut)
}

function lineMatching(text: string, pattern: RegExp): string | undefined {
  return text
    .split('\n')
    .map(line => line.trim())
    .find(line => pattern.test(line))
}

/** The cause from the error's own text (see the file header). Never reads the appended log. */
export function inferBootCause(text: string | null | undefined): BootCause {
  if (!text) {
    return { code: 'unknown' }
  }

  const own = ownErrorText(text)
  const head = ownErrorHead(text)

  if (head.startsWith(ICLONE_GATE_MARK)) {
    return { code: 'gate-not-loaded', line: head }
  }

  // The thrown error carries the child's stderr only through the appended log (start-hermes.ts), so the two anchors
  // no other component prints -- PM's install-state refusal and a bind failure -- are also read there. Nothing else is.
  const ordered: [BootCauseCode, RegExp, string][] = [
    ['install-state-not-writable', INSTALL_STATE_NOT_WRITABLE, text],
    ['port-in-use', PORT_IN_USE, text],
    ['python-import', PYTHON_IMPORT, own]
  ]

  for (const [code, pattern, where] of ordered) {
    const line = lineMatching(where, pattern)

    if (line) {
      return { code, line }
    }
  }

  if (EXITED.test(head)) {
    return { code: 'exit-nonzero', line: head }
  }

  if (TIMEOUT.test(head)) {
    return { code: 'timeout', line: head }
  }

  return { code: 'unknown' }
}

/** The cause of a failure value: its structured `bootCause`, else the inference over its own text. */
export function causeOf(failure: unknown): BootCause {
  const structured = readBootCause(failure)

  if (structured) {
    return structured
  }

  if (typeof failure === 'string') {
    return inferBootCause(failure)
  }

  if (failure instanceof Error) {
    return inferBootCause(failure.message)
  }

  if (failure && typeof failure === 'object') {
    const error = (failure as { error?: unknown }).error

    return typeof error === 'string' ? inferBootCause(error) : { code: 'unknown' }
  }

  return { code: 'unknown' }
}

/** The repair-kit class that fixes a cause, when there is one the kit knows. */
export function repairClassForCause(code: BootCauseCode): RepairClassId | null {
  switch (code) {
    case 'install-state-not-writable':
      return 'stale-install-record'

    case 'gate-not-loaded':
      return 'gate-not-starting'

    case 'port-in-use':
      return 'port-busy'

    case 'python-import':

    case 'runtime-env-broken':
      return 'runtime-venv'

    default:
      return null
  }
}
