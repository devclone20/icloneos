// RTB-7 (owner override, 11:0x): the first launch installs EVERYTHING and the user sees each package as its own line.
// The lines are derived from the runner's own output for the dependency stage (PM's per-package progress:
// "  agent-browser:  78.3%  127.2 MiB / 162.3 MiB", "  node: verifying", "  node: repairing", "  node: unpacking",
// "✓ cua-driver", "✗ <name>: <reason>", "⚠ optional <name> was not installed…"). Pure: the install overlay, main's
// status record and the tests share it.
//
// G-01 r4 (lead method): a row changes only on a line that names it, and the end of the stage never invents a row's
// outcome. A row is failed only by its own ✗; when the stage fails or is killed, every row not yet finished is
// "stopped" and the stage's own failure carries the reason; ✗ lines that name no row stay in `unattributed`, which the
// failure card and the persisted status show.

/** The installer stage whose output carries the per-package lines. */
export const PACKAGES_STAGE = 'python-deps'

/** The Python environment sync is a package line too; PM reports it as "venv". */
export const PYTHON_ENV_PACKAGE = 'venv'

/**
 * The closure PM installs on macOS arm64 for this pin, in PM's own order (tools, then the venv, then the default
 * products), as measured on the RT-4 first launch (2026-10-22). Shown as "waiting" before they start; any package
 * the output names that is not here is appended, and one that never shows up is reported as not needed.
 */
export const EXPECTED_PACKAGES: readonly string[] = [
  'ffmpeg',
  'node',
  'npm',
  'python',
  'ripgrep',
  PYTHON_ENV_PACKAGE,
  'agent-browser',
  'cua-driver'
]

export type PackageState =
  'done' | 'downloading' | 'failed' | 'installing' | 'not-needed' | 'stopped' | 'unpacking' | 'verifying' | 'waiting'

/** How the stage that carries the package lines ended: the runner's verdict, or a kill (cancel, watchdog). */
export type PackagesStageEnd = 'failed' | 'killed' | 'succeeded'

/** States only a line naming the row moves a row out of; the end of the stage never changes them. */
export const TERMINAL_PACKAGE_STATES: ReadonlySet<PackageState> = new Set<PackageState>([
  'done',
  'failed',
  'not-needed',
  'stopped'
])

export interface PackageLine {
  name: string
  state: PackageState
  /** Download progress, 0–100, while downloading. */
  percent: null | number
  /** Download sizes as PM prints them ("127.2 MiB"); `total` is cleared when the artifact is unpacked. */
  done: null | string
  total: null | string
  /** Bytes of every artifact of this package seen so far (a package can download more than one: agent-browser
   * fetches its CLI then Chromium), parsed from the totals PM prints. */
  totalBytes: null | number
  /** How many artifacts this package has downloaded so far. */
  parts: number
  startedAt: null | number
  finishedAt: null | number
  /** The ✗/⚠ line that failed it: only its own (a row is never failed by another line or by the stage). */
  error: null | string
  /** PM installs it as an optional default (its failure does not fail the stage). */
  optional: boolean
}

export interface PackagesState {
  packages: PackageLine[]
  /** The package that printed last. Display only: no event is ever attributed through it (downloads of several
   * packages overlap, so "the last line" is not "the package being installed"). */
  active: null | string
  /** ✗ lines that name no row (no "<name>:" prefix, or a name that is not a row), e.g. "✗ uv sync failed; …". Never
   * routed to a guessed row; shown in the stage failure card and persisted in the agent runtime status (G-01 R3-3). */
  unattributed?: readonly string[]
  /** Nameless ✗ lines past MAX_UNATTRIBUTED_LINES: counted, not kept (G-01 R4-4). */
  unattributedMore?: number
}

/** Nameless ✗ lines are kept up to this many (the rest are counted), each cut to the length of a diagnosis's evidence:
 * the failure card shows them and the persisted status is rewritten with them on every log line (G-01 R4-4). */
export const MAX_UNATTRIBUTED_LINES = 20
export const MAX_UNATTRIBUTED_CHARS = 400

const PROGRESS_LINE =
  /^\s*([A-Za-z0-9][\w.+-]*):\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?\s?[KMGT]?i?B)\s*\/\s*(\d+(?:\.\d+)?\s?[KMGT]?i?B)\s*$/

const UNPACK_LINE = /^\s*([A-Za-z0-9][\w.+-]*): unpacking\b/
// PM opens each package's turn with "<name>: verifying" (hashing what is present, re-reading prefetched archives)
// and prints it again after unpacking (the staged tree's check).
const VERIFY_LINE = /^\s*([A-Za-z0-9][\w.+-]*): verifying\s*$/
// A download in a prefetched package's turn that the prefetch did not cover (a present dependency whose bytes moved,
// a cached archive that failed its hash): PM names it before its progress lines, which then count as a new part.
const REPAIR_LINE = /^\s*([A-Za-z0-9][\w.+-]*): repairing\s*$/
// PM prints exactly "✓ <name>" (or "✓ <name> (staged …)", "✓ venv +extra") for a package; installer chatter such as
// "✓ uv ready (…)" or "✓ dependencies installed" has more words and is not a package.
const DONE_LINE = /^✓ ([A-Za-z0-9][\w.+-]*)(?:\s+\(staged [^)]*\)|\s+\+[\w +-]+)?\s*$/
const VENV_START = /^\s*→ Installing Python dependencies/
const FAILED_LINE = /^\s*✗ (.+)$/
// The package a ✗ belongs to: PM prints "✗ <name>: <reason>" for the package its install loop was on.
const FAILED_NAME = /^([A-Za-z0-9][\w.+-]*):/
const OPTIONAL_FAILED_LINE = /^\s*⚠ optional ([A-Za-z0-9][\w.+-]*) was not installed/
const NOT_PACKAGES = new Set(['dependencies', 'test'])

const UNIT: Record<string, number> = { B: 1, GB: 1e9, GiB: 2 ** 30, KB: 1e3, KiB: 2 ** 10, MB: 1e6, MiB: 2 ** 20 }

export function parseSize(text: null | string): null | number {
  const match = text ? /^(\d+(?:\.\d+)?)\s?([KMGT]?i?B)$/.exec(text.trim()) : null

  if (!match) {
    return null
  }

  const unit = UNIT[match[2]]

  return unit ? Math.round(Number(match[1]) * unit) : null
}

function blank(name: string): PackageLine {
  return {
    done: null,
    error: null,
    finishedAt: null,
    name,
    optional: false,
    parts: 0,
    percent: null,
    startedAt: null,
    state: 'waiting',
    total: null,
    totalBytes: null
  }
}

export function initialPackages(expected: readonly string[] = EXPECTED_PACKAGES): PackagesState {
  return { active: null, packages: expected.map(blank) }
}

function update(state: PackagesState, name: string, patch: (line: PackageLine) => PackageLine): PackagesState {
  const index = state.packages.findIndex(line => line.name === name)
  const packages = state.packages.slice()

  if (index === -1) {
    packages.push(patch(blank(name)))
  } else {
    packages[index] = patch(packages[index])
  }

  return { ...state, packages }
}

/** A named step line ("<name>: verifying|repairing|unpacking"): the row it names, in the state the step means. */
const STEPS: readonly { pattern: RegExp; patch: (line: PackageLine, at: number) => PackageLine }[] = [
  {
    pattern: UNPACK_LINE,
    patch: (line, at) => ({ ...line, percent: null, startedAt: line.startedAt ?? at, state: 'unpacking', total: null })
  },
  {
    pattern: VERIFY_LINE,
    patch: (line, at) => ({ ...line, percent: null, startedAt: line.startedAt ?? at, state: 'verifying' })
  },
  {
    pattern: REPAIR_LINE,
    patch: (line, at) => ({
      ...line,
      done: null,
      percent: 0,
      startedAt: line.startedAt ?? at,
      state: 'downloading',
      total: null
    })
  }
]

/** Fold one line of the dependency stage's output into the package lines. */
export function reducePackageLine(state: PackagesState, raw: string, at: number): PackagesState {
  const line = raw.replace(/\r$/, '')
  let match = PROGRESS_LINE.exec(line)

  if (match) {
    const [, name, percent, done, total] = match

    return {
      ...update(state, name, prev => {
        // A new artifact: the first progress line, or one after the previous artifact was unpacked or a repair
        // started (both clear `total`). "verifying" keeps it: a re-download of the same archive is the same part.
        const newPart = prev.total !== total
        const bytes = parseSize(total) ?? 0

        return {
          ...prev,
          done,
          parts: newPart ? prev.parts + 1 : prev.parts,
          percent: Number(percent),
          startedAt: prev.startedAt ?? at,
          state: 'downloading',
          total,
          totalBytes: newPart ? (prev.totalBytes ?? 0) + bytes : prev.totalBytes
        }
      }),
      active: name
    }
  }

  for (const step of STEPS) {
    match = step.pattern.exec(line)

    if (match) {
      const name = match[1]

      return { ...update(state, name, prev => step.patch(prev, at)), active: name }
    }
  }

  // The installer's own preparation prints the same line before any package starts; only PM's venv sync (after the
  // tools) is the Python environment line.
  if (VENV_START.test(line) && state.packages.some(pkg => pkg.state === 'done')) {
    return {
      ...update(state, PYTHON_ENV_PACKAGE, prev =>
        prev.state === 'done' ? prev : { ...prev, startedAt: prev.startedAt ?? at, state: 'installing' }
      ),
      active: PYTHON_ENV_PACKAGE
    }
  }

  match = DONE_LINE.exec(line)

  if (match && !NOT_PACKAGES.has(match[1])) {
    const name = match[1]

    return {
      ...update(state, name, prev => ({
        ...prev,
        error: null,
        finishedAt: at,
        percent: null,
        startedAt: prev.startedAt ?? at,
        state: 'done',
        total: null
      })),
      active: state.active === name ? null : state.active
    }
  }

  match = OPTIONAL_FAILED_LINE.exec(line)

  if (match) {
    const name = match[1]

    return update(state, name, prev => ({
      ...prev,
      error: prev.error ?? line.trim(),
      finishedAt: prev.finishedAt ?? at,
      optional: true,
      state: 'failed'
    }))
  }

  match = FAILED_LINE.exec(line)

  if (match) {
    const text = match[1]
    // Attributed by the package name the line carries, exact match over every row, nothing else: never by the row
    // that printed last or by an open row (G-01 F1/R2-1: overlapping downloads make both wrong).
    const name = FAILED_NAME.exec(text)?.[1]

    if (name === undefined || !state.packages.some(pkg => pkg.name === name)) {
      const kept = state.unattributed ?? []

      return kept.length < MAX_UNATTRIBUTED_LINES
        ? { ...state, unattributed: [...kept, text.trim().slice(0, MAX_UNATTRIBUTED_CHARS)] }
        : { ...state, unattributedMore: (state.unattributedMore ?? 0) + 1 }
    }

    return {
      ...update(state, name, prev => ({
        ...prev,
        error: text,
        finishedAt: at,
        percent: null,
        state: 'failed',
        total: null
      })),
      active: state.active === name ? null : state.active
    }
  }

  return state
}

/**
 * At the end of the stage. Never invents a row's outcome: a finished row (done, failed by its own ✗, not needed,
 * stopped) is returned unchanged. On success a row that never printed was not needed (already present). Every other
 * unfinished row is "stopped": on a failed or killed stage the stage's failure (card, diagnosis) carries the reason;
 * on a succeeded one PM prints ✓ for every package it installs, so a missing ✓ is reported, not assumed.
 */
export function settlePackages(state: PackagesState, stage: PackagesStageEnd, at: number): PackagesState {
  const packages = state.packages.map(line => {
    if (TERMINAL_PACKAGE_STATES.has(line.state)) {
      return line
    }

    if (stage === 'succeeded' && line.state === 'waiting') {
      return { ...line, state: 'not-needed' as const }
    }

    return { ...line, finishedAt: at, percent: null, state: 'stopped' as const }
  })

  return { ...state, active: null, packages }
}

/** The stage's ✗ lines that name no package row (empty when there are none), then "+N more" past the cap. */
export function unattributedFailures(
  state: Pick<PackagesState, 'unattributed' | 'unattributedMore'>
): readonly string[] {
  const kept = state.unattributed ?? []

  return state.unattributedMore ? [...kept, `+${state.unattributedMore} more`] : kept
}

/** Fold a whole log (fixture replay, a reloaded renderer's snapshot). */
export function packagesFromLog(
  log: readonly { line: string; stage?: null | string; ts?: number }[],
  expected: readonly string[] = EXPECTED_PACKAGES
): PackagesState {
  return log.reduce(
    (state, entry) => (entry.stage === PACKAGES_STAGE ? reducePackageLine(state, entry.line, entry.ts ?? 0) : state),
    initialPackages(expected)
  )
}

/** Weight of a line whose size PM never printed (the Python environment sync, a package already present). */
export const UNKNOWN_PACKAGE_WEIGHT_BYTES = 32 * 2 ** 20
/** A silent step (unpacking, verifying, the Python environment sync) creeps towards done with this time constant. */
const CREEP_TAU_MS = 30_000

/**
 * Overall progress of the package lines, 0–1 (critic minor 3): each line weighs its download size where PM printed it
 * (agent-browser's 193 MiB is not ripgrep's 1.7 MiB); a download counts by its own percent; a silent step creeps with
 * time instead of jumping. Lines that turned out not to be needed do not count.
 */
export function packagesProgress(state: PackagesState, now = Date.now()): number {
  const counted = state.packages.filter(line => line.state !== 'not-needed')

  if (counted.length === 0) {
    return 1
  }

  const creep = (line: PackageLine, from: number, to: number) => {
    const elapsed = Math.max(0, now - (line.startedAt ?? now))

    return from + (to - from) * (1 - Math.exp(-elapsed / CREEP_TAU_MS))
  }

  let total = 0
  let done = 0

  for (const line of counted) {
    const weight = line.totalBytes ?? UNKNOWN_PACKAGE_WEIGHT_BYTES
    total += weight

    if (TERMINAL_PACKAGE_STATES.has(line.state)) {
      done += weight
    } else if (line.state === 'downloading') {
      done += weight * 0.8 * ((line.percent ?? 0) / 100)
    } else if (line.state === 'unpacking' || line.state === 'verifying') {
      done += weight * creep(line, 0.8, 0.98)
    } else if (line.state === 'installing') {
      done += weight * creep(line, 0, 0.95)
    }
  }

  return Math.max(0, Math.min(1, done / total))
}
