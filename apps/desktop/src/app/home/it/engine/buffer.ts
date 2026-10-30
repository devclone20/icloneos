import type { Terminal } from '@xterm/xterm'

// Serialized view of the in-app terminal, handed to the agent's `read_terminal`
// tool. Line indices are absolute into xterm's buffer (0 = oldest scrollback
// line), so the agent can page with start_line/count against `total_lines`.
export interface TerminalReadResult {
  total_lines: number
  start: number
  end: number
  viewport_rows: number
  cursor_row: number
  text: string
}

export interface TerminalReadOptions {
  start?: number
  count?: number
}

type Reader = (opts: TerminalReadOptions) => TerminalReadResult

// Each live terminal registers a reader keyed by its id; a single `activeId`
// (driven by the tab selection) decides which one the agent's `read_terminal`
// tool sees. Keying by id keeps switching race-free — a deactivating tab's
// cleanup can't null out the tab that just activated.
const readers = new Map<string, Reader>()
let activeId: string | null = null

/** Register a live terminal's reader; returns an idempotent unregister. */
export function registerTerminalReader(id: string, reader: Reader): () => void {
  readers.set(id, reader)

  return () => {
    if (readers.get(id) === reader) {
      readers.delete(id)
    }
  }
}

export function setActiveTerminalId(id: string | null): void {
  activeId = id
}

export function readActiveTerminal(opts: TerminalReadOptions = {}): TerminalReadResult | null {
  const reader = activeId === null ? null : readers.get(activeId)

  return reader ? reader(opts) : null
}

/** Read ONE terminal by id, whatever the selection is. The `it` CLI addresses
 *  panes explicitly (`it read-screen --pane 2`), and a multiplexed surface has
 *  several on screen at once — "the active one" is not an answer there. */
export function readTerminalById(id: string, opts: TerminalReadOptions = {}): null | TerminalReadResult {
  const reader = readers.get(id)

  return reader ? reader(opts) : null
}

// Writers — the same registry shape, for the direction the agent and the CLI
// push in. Registered by the live session (it owns the PTY id); `it send` and
// `it exec` address a pane through this instead of the single-slot injection
// channel, which could only ever reach whichever terminal had focus.
type Writer = (data: string) => void

const writers = new Map<string, Writer>()

export function registerTerminalWriter(id: string, writer: Writer): () => void {
  writers.set(id, writer)

  return () => {
    if (writers.get(id) === writer) {
      writers.delete(id)
    }
  }
}

/** Feed raw bytes to one terminal's PTY. False when it has no live session. */
export function writeToTerminal(id: string, data: string): boolean {
  const writer = writers.get(id)

  if (!writer) {
    return false
  }

  writer(data)

  return true
}

// Output activity. iT lights a workspace's dot when a shell it is NOT showing
// prints something (the HUB's unread rule). Throttled per terminal: a flood of
// twenty thousand lines is one piece of news, not twenty thousand.
type OutputListener = (id: string) => void

const outputListeners = new Set<OutputListener>()
const lastNoted = new Map<string, number>()
const NOTE_THROTTLE_MS = 400

export function onTerminalOutput(listener: OutputListener): () => void {
  outputListeners.add(listener)

  return () => {
    outputListeners.delete(listener)
  }
}

export function noteTerminalOutput(id: string): void {
  const now = Date.now()

  if (now - (lastNoted.get(id) ?? 0) < NOTE_THROTTLE_MS) {
    return
  }

  lastNoted.set(id, now)

  for (const listener of outputListeners) {
    listener(id)
  }
}

export function terminalIsLive(id: string): boolean {
  return writers.has(id)
}

export function makeTerminalReader(term: Terminal): Reader {
  return ({ start, count }) => {
    const buf = term.buffer.active
    const total = buf.length
    const rows = term.rows
    // Default window = the visible screen; baseY is the viewport's top row.
    const from = Math.max(0, Math.min(start ?? buf.baseY, total))
    const to = Math.max(from, Math.min(from + Math.max(1, count ?? rows), total))

    const lines: string[] = []

    // translateToString(true) right-trims and resolves wide chars, dropping SGR
    // colors — exactly what the agent wants.
    //
    // Join WRAPPED rows back into the logical line they came from. A buffer row
    // is a DISPLAY row: in a narrow pane a single line of output is split
    // across several, and `isWrapped` marks each continuation. A reader that
    // ignores that hands back text with breaks the shell never printed — a
    // token as short as a marker can land half on one row and half on the next,
    // and anything matching against it silently fails. Right-trimming has to be
    // skipped on a row that continues, or the join eats a real space.
    for (let i = from; i < to; i += 1) {
      const line = buf.getLine(i)

      if (!line) {
        lines.push('')

        continue
      }

      const continues = buf.getLine(i + 1)?.isWrapped === true
      const text = continues ? line.translateToString(false) : line.translateToString(true)

      if (i > from && line.isWrapped && lines.length) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }

    while (lines.length && !lines[lines.length - 1].trim()) {
      lines.pop()
    }

    return {
      total_lines: total,
      start: from,
      end: to,
      viewport_rows: rows,
      cursor_row: buf.baseY + buf.cursorY,
      text: lines.join('\n')
    }
  }
}
