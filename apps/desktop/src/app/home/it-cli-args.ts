/**
 * The `it` command line's argument grammar — pure, so it can be tested
 * without an app, a PTY or a window.
 *
 * Two things live here because both were sources of real bugs:
 *
 * 1. Options are pulled OUT of the vector before the remainder is read as
 *    text. `it send echo hi --enter` must send "echo hi", not "echo hi
 *    --enter" — the flag is for the CLI, not for the shell.
 * 2. A pane reference is an index OR an id. Indices SHIFT under any layout
 *    change (a split inserts its new pane beside the one it came from), so
 *    anything that holds a pane across a split has to address it by id. The
 *    first version of the campaign harness held indices and reported four
 *    failures that were its own bookkeeping.
 */

export interface ItFlags {
  enter: boolean
  lines?: number
  /** A 1-based index in tree order, or an exact terminal id. */
  pane?: string
  /** Which workspace the pane belongs to — an index or a title. Without it,
   *  a pane reference resolves inside the ACTIVE workspace, so an agent
   *  driving a second workspace could not reach it at all. */
  workspace?: string
  /** Everything that was not an option, in order. */
  rest: string[]
  wait?: number
}

const NUMERIC_FLAGS = new Set(['--lines', '--wait'])

export function parseItFlags(argv: readonly string[]): ItFlags {
  const rest: string[] = []
  const flags: ItFlags = { enter: false, rest }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]

    if (token === '--enter') {
      flags.enter = true

      continue
    }

    if (token === '--pane' || token === '--workspace') {
      const raw = argv[i + 1]

      i += 1

      if (raw) {
        if (token === '--pane') {
          flags.pane = raw
        } else {
          flags.workspace = raw
        }
      }

      continue
    }

    if (NUMERIC_FLAGS.has(token)) {
      const value = Number(argv[i + 1])

      i += 1

      if (Number.isFinite(value)) {
        if (token === '--lines') {
          flags.lines = value
        } else {
          flags.wait = value
        }
      }

      continue
    }

    rest.push(token)
  }

  return flags
}

/**
 * Resolve a pane reference against the panes of one workspace, in tree order.
 *
 * `undefined` / empty → the caller's default (the focused pane), signalled by
 * returning `fallback`. Digits in range → that pane. Otherwise an exact id;
 * anything else resolves to nothing rather than to a guess.
 */
export function resolvePaneRef(
  panes: readonly string[],
  ref: string | undefined,
  fallback: null | string
): null | string {
  if (ref === undefined || ref === '') {
    return fallback
  }

  // Digits only: Number() also reads `0x2`, `2.0`, `1e0`, `+2` and `02 `.
  if (/^\d+$/.test(ref)) {
    const index = Number(ref)

    return index >= 1 && index <= panes.length ? panes[index - 1] : null
  }

  // Exact only: a prefix or substring could address a pane nobody meant.
  return panes.find(id => id === ref) ?? null
}

/**
 * Prepare text for a PTY.
 *
 * A terminal's "enter" is CARRIAGE RETURN. A payload carrying LF newlines
 * arrives as literal newlines inside the line editor's buffer and the lines
 * are never accepted — so a multi-line command (a heredoc, a small script)
 * hangs the pane at a continuation prompt instead of running. One job in the
 * campaign did exactly that and poisoned the two that followed it in the same
 * pane. Every write that carries a COMMAND goes through here; raw key bytes
 * (`send-key`) deliberately do not.
 */
export function toPtyText(text: string): string {
  return text.replace(/\r\n|\n/g, '\r')
}

/**
 * Does this screen look like a shell sitting at a prompt?
 *
 * A HEURISTIC, and named like one. Without shell integration (OSC 133) there
 * is no truthful signal for "the foreground job finished", so this reads the
 * last non-blank line and asks whether it ends in a prompt character. It is
 * right for the interactive shells iT opens and wrong for anything that paints
 * its own screen — a pager, an editor, a TUI — which is exactly the case
 * `wait-idle` exists to SURFACE: a driver told `busy` forever has been told
 * something true, and can recover the pane.
 *
 * `>` is deliberately NOT a prompt character. In zsh it is the CONTINUATION
 * prompt — `heredoc>`, `dquote>`, `quote>`, `pipe>`, `for>`, `cmdsubst>` — and
 * a shell waiting to be closed is the single most important thing this
 * predicate has to catch. Counting it as idle cost three jobs: a pane sat in
 * `heredoc>`, this said "at a prompt", and the next two jobs were typed
 * straight into the heredoc. `❯` (U+276F), which many zsh themes use, is a
 * different character and is safe.
 *
 * A prompt character counts only in PROMPT CONTEXT. After a number — glued
 * (`45%`, `12$`) or one space away (`45 %`, `Progress: 100 %`) — it is a
 * progress line or a price, and the job still runs; the one digit-ended
 * prompt that is real is bash's default, `bash-5.2$`. A `#` on a line that
 * holds another `#` is a progress bar (`[#####`) or markdown (`## TODO #`),
 * never root's prompt. A prompt whose last segment is a bare number
 * (`pat@mac 2024 %`) reads as busy: the safe side of a heuristic.
 */
export function screenLooksIdle(text: string): boolean {
  const lines = text.split('\n').filter(line => line.trim())
  const last = (lines[lines.length - 1] ?? '').trimEnd()
  const match = /^(.*?)(\s*)([%$#❯])$/.exec(last)

  if (!match) {
    return false
  }

  const [, before, gap, mark] = match

  if (mark === '#' && before.includes('#')) {
    return false
  }

  if (!before) {
    return true
  }

  if (!gap) {
    return !/\d$/.test(before) || (/-\d+(?:\.\d+)*$/.test(before) && (mark === '$' || mark === '#'))
  }

  return !/^[+-]?\d+(?:[.,]\d+)*$/.test(before.split(/\s+/).pop() ?? '')
}
