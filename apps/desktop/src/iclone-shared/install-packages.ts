// RTB-7 (owner override, 11:0x): the first launch installs EVERYTHING and the user sees each package as its own line.
// The lines are derived from the runner's own output for the dependency stage (PM's per-package progress:
// "  agent-browser:  78.3%  127.2 MiB / 162.3 MiB", "  node: unpacking", "✓ cua-driver", "✗ <error>",
// "⚠ optional <name> was not installed…"). Pure: the install overlay, main's status record and the tests share it.

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

export type PackageState = 'done' | 'downloading' | 'failed' | 'installing' | 'not-needed' | 'unpacking' | 'waiting'

export interface PackageLine {
  name: string
  state: PackageState
  /** Download progress, 0–100, while downloading. */
  percent: null | number
  /** Download sizes as PM prints them ("127.2 MiB"). */
  done: null | string
  total: null | string
  /** Bytes of every artifact of this package seen so far (a package can download more than one: agent-browser
   * fetches its CLI then Chromium), parsed from the totals PM prints. */
  totalBytes: null | number
  /** How many artifacts this package has downloaded so far. */
  parts: number
  startedAt: null | number
  finishedAt: null | number
  /** The ✗/⚠ line that failed it. */
  error: null | string
  /** PM installs it as an optional default (its failure does not fail the stage). */
  optional: boolean
}

export interface PackagesState {
  packages: PackageLine[]
  /** The package the output is currently about (where a bare "✗ <error>" lands). */
  active: null | string
}

const PROGRESS_LINE =
  /^\s*([A-Za-z0-9][\w.+-]*):\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?\s?[KMGT]?i?B)\s*\/\s*(\d+(?:\.\d+)?\s?[KMGT]?i?B)\s*$/

const UNPACK_LINE = /^\s*([A-Za-z0-9][\w.+-]*): unpacking\b/
// PM prints exactly "✓ <name>" (or "✓ <name> (staged …)", "✓ venv +extra") for a package; installer chatter such as
// "✓ uv ready (…)" or "✓ dependencies installed" has more words and is not a package.
const DONE_LINE = /^✓ ([A-Za-z0-9][\w.+-]*)(?:\s+\(staged [^)]*\)|\s+\+[\w +-]+)?\s*$/
const VENV_START = /^\s*→ Installing Python dependencies/
const FAILED_LINE = /^\s*✗ (.+)$/
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

const isOpen = (line: PackageLine) =>
  line.state === 'downloading' || line.state === 'unpacking' || line.state === 'installing'

/** Fold one line of the dependency stage's output into the package lines. */
export function reducePackageLine(state: PackagesState, raw: string, at: number): PackagesState {
  const line = raw.replace(/\r$/, '')
  let match = PROGRESS_LINE.exec(line)

  if (match) {
    const [, name, percent, done, total] = match

    return {
      ...update(state, name, prev => {
        // A new artifact: the first progress line, or one after the previous artifact was unpacked.
        const newPart = prev.state !== 'downloading' || prev.total !== total
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

  match = UNPACK_LINE.exec(line)

  if (match) {
    const name = match[1]

    return {
      ...update(state, name, prev => ({ ...prev, percent: null, startedAt: prev.startedAt ?? at, state: 'unpacking' })),
      active: name
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
        state: 'done'
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
    const named = state.packages.find(pkg => isOpen(pkg) && match![1].includes(pkg.name))
    const target = named?.name ?? state.active ?? state.packages.find(isOpen)?.name

    if (!target) {
      return state
    }

    return {
      ...update(state, target, prev => ({ ...prev, error: match![1], finishedAt: at, percent: null, state: 'failed' })),
      active: null
    }
  }

  return state
}

/** At the end of the stage: lines still waiting were not needed (already present); open ones failed if it failed. */
export function settlePackages(state: PackagesState, stage: 'failed' | 'succeeded', at: number): PackagesState {
  const packages = state.packages.map(line => {
    if (line.state === 'waiting') {
      return { ...line, state: stage === 'succeeded' ? ('not-needed' as const) : ('waiting' as const) }
    }

    if (isOpen(line)) {
      return stage === 'succeeded'
        ? { ...line, finishedAt: at, percent: null, state: 'done' as const }
        : { ...line, finishedAt: at, percent: null, state: 'failed' as const }
    }

    return line
  })

  // Critic minor 5: a stage that failed before any package line opened failed in its own preparation of the Python
  // environment — that line carries the failure, so a row (not just the stage) says where it stopped.
  if (stage === 'failed' && !packages.some(line => line.state === 'failed')) {
    const env = packages.findIndex(line => line.name === PYTHON_ENV_PACKAGE)

    if (env !== -1) {
      packages[env] = { ...packages[env], finishedAt: at, state: 'failed' }
    }
  }

  return { active: null, packages }
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
/** A silent step (unpacking, the Python environment sync) creeps towards done with this time constant. */
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

    if (line.state === 'done' || line.state === 'failed') {
      done += weight
    } else if (line.state === 'downloading') {
      done += weight * 0.8 * ((line.percent ?? 0) / 100)
    } else if (line.state === 'unpacking') {
      done += weight * creep(line, 0.8, 0.98)
    } else if (line.state === 'installing') {
      done += weight * creep(line, 0, 0.95)
    }
  }

  return Math.max(0, Math.min(1, done / total))
}
