/**
 * Pure shaping of `ConfinementStateView` for the Containers pane. Every number the pane shows is the length of an
 * array built here from the state main just folded, and every time is measured against main's own clock (`state.at`),
 * so a render never counts, never keeps anything between polls and never reads the window's clock.
 */
import type { ConfinementCopy, OperationKind, UnfoldReason } from '@/i18n/en/confinement'
import type {
  ActivityClass,
  AgentActivityView,
  BackendStatus,
  ConfinedProcessView,
  ConfinementReason,
  ConfinementStateView,
  ConfinementVerdict,
  RefusalView,
  RefusalWhy,
  RunOrigin,
  RunPhase,
  RuntimeConfinementView,
  RunView,
  StopRunResultView
} from '@/iclone-shared/confinement'
import { REFUSALS_LISTED } from '@/iclone-shared/confinement'
import { STOP_NO_ANSWER, STOP_UNAVAILABLE } from '@/store/confinement'

export type Tone = 'down' | 'muted' | 'up' | 'warn'

interface ConfinedGroup {
  root: ConfinedProcessView
  children: ConfinedProcessView[]
}

export function confinedGroups(state: Pick<ConfinementStateView, 'inside'>): ConfinedGroup[] {
  const groups = new Map<number, ConfinedGroup>()

  for (const process of state.inside) {
    if (process.pid === process.root) {
      groups.set(process.pid, { root: process, children: [] })
    }
  }

  for (const process of state.inside) {
    if (process.pid !== process.root) {
      groups.get(process.root)?.children.push(process)
    }
  }

  return [...groups.values()]
}

export const verdictTone = (verdict: ConfinementVerdict): Tone => (verdict === 'green' ? 'up' : 'down')

/** Red is a fault only: an `installed` backend this version does not use is neutral, like `unsupported`, and so is a
 *  check that did not finish in time (`unknown`). */
const BACKEND_TONE: Record<BackendStatus, Tone> = {
  ready: 'up',
  broken: 'down',
  'not-installed': 'warn',
  installed: 'muted',
  unknown: 'muted',
  unsupported: 'muted'
}

export const backendTone = (status: BackendStatus): Tone => BACKEND_TONE[status]

export function counts(state: Pick<ConfinementStateView, 'inside' | 'outside'>): { inside: number; outside: number } {
  return {
    inside: state.inside.filter(process => process.pid === process.root).length,
    outside: state.outside.filter(process => process.kind === 'agent-command').length
  }
}

export const agentName = (agent: AgentActivityView, unattributed: string): string =>
  agent.sessionId === 'unattributed' ? unattributed : (agent.inft ?? agent.sessionId)

export const shortSha = (sha: string): string => sha.slice(0, 12)

/** The catalogue sentence for one reason main folded (each case narrows to that reason's own fields). */
export function sayReason(copy: Pick<ConfinementCopy, 'reason'>, reason: ConfinementReason): string {
  switch (reason.code) {
    case 'backend-not-confining':
      return copy.reason[reason.code](reason)

    case 'plugin-not-loaded':
      return copy.reason[reason.code](reason)

    case 'profile-changed':
      return copy.reason[reason.code](reason)

    case 'widened-profile':
      return copy.reason[reason.code](reason)

    case 'unknown-profile':
      return copy.reason[reason.code](reason)

    case 'agent-command-outside':
      return copy.reason[reason.code](reason)

    case 'forged-marker':
      return copy.reason[reason.code](reason)

    case 'runtime-not-confined':
      return copy.reason[reason.code](reason)

    case 'runtime-not-running':
      return copy.reason[reason.code](reason)

    case 'launcher-down':
      return copy.reason[reason.code](reason)

    case 'agent-commands-unavailable':
      return copy.reason[reason.code](reason)

    case 'membership-unverified':
      return copy.reason[reason.code](reason)

    case 'agent-config-unreadable':
      return copy.reason[reason.code](reason)

    case 'hardlink-appeared':
      return copy.reason[reason.code](reason)

    case 'settings-ignored':
      return copy.reason[reason.code](reason)
  }
}

// ── runs ────────────────────────────────────────────────────────────────────

/** A run with processes alive now: the root (running), or only what it started (background). */
export const isLive = (run: Pick<RunView, 'phase'>): boolean => run.phase === 'running' || run.phase === 'background'

const PHASE_TONE: Record<RunPhase, Tone | 'tone'> = {
  running: 'up',
  background: 'warn',
  exited: 'muted',
  failed: 'down',
  stopped: 'muted',
  refused: 'down',
  unknown: 'warn'
}

export const phaseTone = (phase: RunPhase): Tone | 'tone' => PHASE_TONE[phase]

/** The row's phase words: a failure names its code, or the signal that ended it. */
export function phaseLabel(
  copy: ConfinementCopy['ledger'],
  run: Pick<RunView, 'backgroundEnded' | 'exitCode' | 'phase' | 'signal' | 'stoppedByModes' | 'stoppedByOwner'>
) {
  if (run.stoppedByModes) {
    return copy.phaseStoppedByModes
  }

  if (run.backgroundEnded) {
    return copy.phase.backgroundEnded
  }

  if (run.phase === 'stopped' && !run.stoppedByOwner) {
    return copy.phaseStopped
  }

  if (run.phase !== 'failed') {
    return copy.phase[run.phase]
  }

  return run.signal !== null
    ? copy.phase.failedSignal(run.signal)
    : run.exitCode !== null
      ? copy.phase.failedCode(run.exitCode)
      : copy.phase.failed
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) {
    return null
  }

  const value = Date.parse(iso)

  return Number.isFinite(value) ? value : null
}

/** Whole seconds from `from` to `to` (never negative; 0 when either is unreadable). */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number {
  const a = ms(from)
  const b = ms(to)

  return a === null || b === null ? 0 : Math.max(0, Math.floor((b - a) / 1000))
}

/** How long a run has lasted: to its end, or to main's clock while it is still open. */
/** A live run counts to now: a background run's `endedAt` is when its first process ended, not when it did (proof6 F2). */
export const runSeconds = (
  run: Pick<RunView, 'endedAt' | 'startedAt'> & Partial<Pick<RunView, 'phase'>>,
  at: string
): number => secondsBetween(run.startedAt, run.phase === 'background' ? at : (run.endedAt ?? at))

/** The local wall-clock time of an ISO instant, hh:mm:ss. */
export function clock(iso: string | null | undefined): string {
  const value = ms(iso)

  if (value === null) {
    return '—'
  }

  const date = new Date(value)

  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

/** The first line of what ran: the row shows it; the inspector shows the whole text. */
/** The launcher's own mark on a command it ran once outside the Seatbelt: "[ran once ...] command". */
export function ranOnceMark(command: string): { command: string; mark: null | string } {
  const found = /^\[(ran once[^\]]*)\]\s+/.exec(command)

  return found ? { command: command.slice(found[0].length), mark: found[1] } : { command, mark: null }
}

export const firstLine = (command: string): string =>
  command
    .split('\n')
    .find(line => line.trim() !== '')
    ?.trim() ?? ''

/** The failed sentence for a run: the status it reported, the signal that ended it, or neither known. A status that
 *  followed a refusal of the run's own profile leads with that refusal (`run.refusals`, the kernel's count for this
 *  run), never with "the command itself reported a failure": the refusal is the likelier cause. */
export const failedMeaning = (
  copy: Pick<
    ConfinementCopy['ledger'],
    'backgroundEndedMeaning' | 'failedMeaning' | 'orphanLiveMeaning' | 'phaseMeaning' | 'stoppedByModes' | 'stoppedMeaning'
  >,
  run: Pick<
    RunView,
    'backgroundEnded' | 'exitCode' | 'orphanLive' | 'phase' | 'refusals' | 'signal' | 'stoppedByModes' | 'stoppedByOwner'
  >
): string =>
  run.stoppedByModes
    ? copy.stoppedByModes
    : run.phase === 'stopped' && !run.stoppedByOwner
      ? copy.stoppedMeaning
      : run.backgroundEnded
        ? copy.backgroundEndedMeaning
        : run.phase === 'failed'
          ? copy.failedMeaning(run)
          : run.phase === 'background' && run.orphanLive
            ? copy.orphanLiveMeaning
            : copy.phaseMeaning[run.phase]

/** The launcher's sentence as a reader sees it: the flag names it quotes for its own log are not words for the pane. */
const asSentence = (text: string) => {
  const capital = text.charAt(0).toLocaleUpperCase() + text.slice(1)

  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

export const plainDetail = (detail: string | null | undefined): string | null =>
  detail ? asSentence(detail.replace(/\s*\((?:WRITE_PROJECT|NET)=1\)/g, '')) : null

/** What the launcher adds to its stop sentence, in brackets: which rule the new modes break. The sentence itself is the
 *  pane's own (`stoppedByModes`), so only the addition is shown. */
export function modesStopReason(detail: string | null | undefined): string | null {
  const reason = detail?.replace(/\s*\((?:WRITE_PROJECT|NET)=1\)/g, '').match(/\((.+)\)$/)?.[1]

  return reason ? asSentence(reason) : null
}

/**
 * proof6 F3: nothing ran. The wrapper's `cd` to the run's folder is what exits 126, and the folder the run was judged in
 * is not where its cwd says: the cwd is a link to it, which the sandbox refused to enter.
 */
export const couldNotEnter = (run: Pick<RunView, 'cwdLink' | 'exitCode' | 'narrowed'>): boolean =>
  Boolean(run.narrowed) && run.exitCode === 126 && Boolean(run.cwdLink)

export const narrowedKey = (
  run: Pick<RunView, 'cwdLink' | 'exitCode' | 'narrowed' | 'narrowedWhy'>
): NonNullable<RunView['narrowedWhy']> | 'could-not-enter' | 'unknown' =>
  couldNotEnter(run) ? 'could-not-enter' : (run.narrowedWhy ?? 'unknown')

const narrowedGroup = (run: RunView) => JSON.stringify([run.projectRoot, run.narrowedWhy ?? null])

/**
 * Of the narrowed runs, the newest one per folder and reason: it alone carries the whole note in the list, so an agent
 * that ran twenty commands in a folder gets one explanation and one button, and nineteen short lines.
 */
export function newestNarrowed(runs: readonly RunView[]): ReadonlySet<string> {
  const newest = new Map<string, RunView>()

  for (const run of runs) {
    const seen = newest.get(narrowedGroup(run))

    if (run.narrowed && (!seen || Date.parse(run.startedAt) > Date.parse(seen.startedAt))) {
      newest.set(narrowedGroup(run), run)
    }
  }

  return new Set([...newest.values()].map(run => run.id))
}

/** The folder this row can offer, or null: an unlisted folder the launcher named, unless a later command in it already
 *  had its writes, which shows the folder is allowed now. */
export function folderToOffer(run: RunView, runs: readonly RunView[]): string | null {
  if (!run.narrowed || run.narrowedWhy !== 'unlisted-folder' || !run.projectRoot || couldNotEnter(run)) {
    return null
  }

  const writableLater = runs.some(
    other =>
      other.projectRoot === run.projectRoot &&
      other.writeProject &&
      Date.parse(other.startedAt) > Date.parse(run.startedAt)
  )

  return writableLater ? null : run.projectRoot
}

/** A command the runtime ran for itself (the shell session set-up, its probes), not one the agent asked for. */
export const isHousekeeping = (run: Pick<RunView, 'origin'>): boolean => run.origin === 'runtime'

export type RunFilter = 'all' | 'failed' | 'refused' | 'running'

const FILTERS: Record<RunFilter, (run: RunView) => boolean> = {
  all: () => true,
  running: isLive,
  failed: run => run.phase === 'failed' || run.phase === 'unknown',
  refused: run => run.phase === 'refused' || run.refusals > 0
}

/** Runs the filter keeps whose command, project or working folder contains every word of `query` (any case). */
export function filterRuns(runs: readonly RunView[], filter: RunFilter, query: string): RunView[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)

  return runs.filter(run => {
    if (!FILTERS[filter](run)) {
      return false
    }

    const haystack = [run.command, run.projectRoot ?? '', run.cwd ?? ''].join('\n').toLocaleLowerCase()

    return words.every(word => haystack.includes(word))
  })
}

export const filterCounts = (runs: readonly RunView[]): Record<RunFilter, number> => ({
  all: runs.length,
  running: runs.filter(FILTERS.running).length,
  failed: runs.filter(FILTERS.failed).length,
  refused: runs.filter(FILTERS.refused).length
})

/** How old the last answer may be before the pane stops vouching for it. Past main's own `ps` limit (5 s, state.ts): a
 *  slow read still answers inside this, and one that has gone this long has hung. */
export const READ_STALE_AFTER_MS = 8_000

/** A housekeeping run may stay folded while it runs for this long: the session set-up and the probes take seconds. */
export const HOUSEKEEPING_LIVE_MAX_S = 30

/**
 * Whether a run the runtime says it issued for itself is folded out of the default list.
 *
 * `origin` is the runtime's own word: the launcher reads it from how the request was sent, and the runtime composes
 * every request, so nothing the launcher can check proves a command is housekeeping. A confined agent that steers the
 * runtime could mark anything so. The fold therefore never rests on the claim alone; it also needs every fact the
 * runtime cannot choose to say the run was uneventful: the kernel refused it nothing (its own count), it is over and
 * left nothing alive in its sandbox (the kernel's membership), the owner did not stop it, and while it runs, main's
 * clock says it is younger than HOUSEKEEPING_LIVE_MAX_S. Its exit status is the command's own word, so it decides
 * nothing either way. A housekeeping run that fails any of these is in the main list like a command the agent asked
 * for, still said to be the runtime's in its inspector; and the head counts every live one apart.
 */
export const isFoldedHousekeeping = (
  run: Pick<RunView, 'endedAt' | 'origin' | 'phase' | 'refusals' | 'startedAt'>,
  at: string
): boolean =>
  isHousekeeping(run) &&
  run.refusals === 0 &&
  (run.phase === 'exited' ||
    run.phase === 'failed' ||
    (run.phase === 'running' && runSeconds(run, at) < HOUSEKEEPING_LIVE_MAX_S))

/**
 * Why a command the runtime issued for itself is listed with the agent's rather than folded: the first fact that
 * isFoldedHousekeeping did not find uneventful. Null for the agent's commands and for folded housekeeping. Only the
 * explanation reads this; the fold itself is isFoldedHousekeeping alone.
 */
export function unfoldedBecause(
  run: Pick<RunView, 'endedAt' | 'origin' | 'phase' | 'refusals' | 'startedAt'>,
  at: string
): UnfoldReason | null {
  if (!isHousekeeping(run) || isFoldedHousekeeping(run, at)) {
    return null
  }

  if (run.refusals > 0 || run.phase === 'refused') {
    return 'refused'
  }

  return run.phase === 'stopped'
    ? 'stopped'
    : run.phase === 'running'
      ? 'long'
      : run.phase === 'background'
        ? 'outlived'
        : 'no-end'
}

/** What the list shows and what it folds behind the housekeeping disclosure (isFoldedHousekeeping), at main's clock. */
export function splitHousekeeping(runs: readonly RunView[], at: string): { listed: RunView[]; folded: RunView[] } {
  return {
    listed: runs.filter(run => !isFoldedHousekeeping(run, at)),
    folded: runs.filter(run => isFoldedHousekeeping(run, at))
  }
}

/** Live runs first (Running), then everything that ended or never started (Recent), each in main's order. */
export function groupRuns(runs: readonly RunView[]): { running: RunView[]; recent: RunView[] } {
  return { running: runs.filter(isLive), recent: runs.filter(run => !isLive(run)) }
}

const HOUR_MS = 3_600_000

/** The header's tally, each number saying what it counts: the agent's commands running now, the runtime's
 *  housekeeping running now, and what the sandbox blocked in the hour before main's clock (kernel refusals, and
 *  commands refused before they started). `blockedByRuntime`: how many of those the runtime made for itself (a part
 *  of `blockedLastHour`, never added to it), so the head never counts them as the agent's. `blockedMore`: the state's
 *  list of refusals is full and its oldest row is still inside the hour, so more were blocked than the list holds and
 *  both numbers are floors. */
export function tally(state: Pick<ConfinementStateView, 'at' | 'refusals' | 'runs'>): {
  running: number
  housekeeping: number
  blockedLastHour: number
  blockedByRuntime: number
  blockedMore: boolean
} {
  const now = ms(state.at) ?? 0

  const recent = (iso: string | null) => {
    const value = ms(iso)

    return value !== null && now - value <= HOUR_MS && value <= now + 1000
  }

  const live = state.runs.filter(isLive)
  const origins = new Map(state.runs.map(run => [run.id, run.origin]))
  const refusals = state.refusals.filter(refusal => recent(refusal.ts))
  const refusedRuns = state.runs.filter(run => run.phase === 'refused' && recent(run.endedAt ?? run.startedAt))

  return {
    running: live.filter(run => !isHousekeeping(run)).length,
    housekeeping: live.filter(isHousekeeping).length,
    blockedLastHour: refusals.length + refusedRuns.length,
    blockedByRuntime:
      refusals.filter(refusal => refusalOrigin(origins, refusal) === 'runtime').length +
      refusedRuns.filter(isHousekeeping).length,
    blockedMore: state.refusals.length >= REFUSALS_LISTED && recent(state.refusals[REFUSALS_LISTED - 1].ts)
  }
}

/** Who issued the run a refusal belongs to; null when it is not attributed to a run the state still lists. */
const refusalOrigin = (origins: ReadonlyMap<string, RunOrigin>, refusal: Pick<RefusalView, 'run'>): RunOrigin | null =>
  (refusal.run ? origins.get(refusal.run) : undefined) ?? null

/** The kernel refusals main attributed to this run, oldest first (the order of the lifecycle). */
export const refusalsOf = (state: Pick<ConfinementStateView, 'refusals'>, runId: string): RefusalView[] =>
  state.refusals.filter(refusal => refusal.run === runId).sort((a, b) => (ms(a.ts) ?? 0) - (ms(b.ts) ?? 0))

/** What the refused operation was trying to do, from the kernel's operation name. */
export function operationKind(operation: string): OperationKind {
  if (operation.startsWith('file-read')) {
    return 'read'
  }

  if (operation.startsWith('file-write') || operation === 'file-link' || operation === 'file-unlink') {
    return 'write'
  }

  if (operation.startsWith('network')) {
    return 'network'
  }

  if (operation.startsWith('process-exec') || operation.startsWith('process-fork')) {
    return 'exec'
  }

  if (operation.startsWith('mach') || operation.startsWith('ipc') || operation.startsWith('xpc')) {
    return 'service'
  }

  return 'other'
}

export function sayOperation(copy: ConfinementCopy['ledger'], operation: string): string {
  const kind = operationKind(operation)

  return kind === 'other' ? copy.operation.other(operation) : copy.operation[kind]
}

export const refusalWhy = (refusal: Pick<RefusalView, 'why'>): RefusalWhy => refusal.why ?? 'other'

/** The rule that refused it, naming the run's profile when the run (and so its class) is known. */
export function sayWhy(copy: ConfinementCopy, refusal: Pick<RefusalView, 'why'>, cls: ActivityClass | null): string {
  return copy.ledger.why[refusalWhy(refusal)](cls ? copy.classes[cls].name : '')
}

export interface RefusalKind {
  key: string
  /** The first of the kind in the list's order: its time and its words stand for the group. */
  refusal: RefusalView
  count: number
}

/**
 * fx24: one run's refusals by what they are, so a `cd ../sibling` (five refusals of one folder) reads as one line with
 * its count. The key is what happened: the process, the path, and the operation or the shell's look. A probe of another
 * path is its own line, and every refusal is in a count.
 */
export function refusalKinds(refusals: readonly RefusalView[]): RefusalKind[] {
  const kinds = new Map<string, RefusalKind>()

  for (const refusal of refusals) {
    const key = JSON.stringify([
      refusal.shellLook ? 'look' : refusal.operation,
      refusal.process,
      refusal.target,
      refusal.why
    ])

    const kind = kinds.get(key)

    if (kind) {
      kind.count += 1
    } else {
      kinds.set(key, { key, refusal, count: 1 })
    }
  }

  return [...kinds.values()]
}

export type TimelineNode =
  | { kind: 'start'; ts: string }
  | { kind: 'refusal'; ts: string; refusal: RefusalView; count?: number }
  | { kind: 'end'; ts: string; seconds: number }
  | { kind: 'live'; seconds: number }
  | { kind: 'no-end' }
  | { kind: 'refused'; ts: string }

/** Started → each refusal → Ended (or running for N s live, or no end recorded); one node for a run refused before
 *  it started. */
export function timeline(run: RunView, refusals: readonly RefusalView[], at: string): TimelineNode[] {
  if (run.phase === 'refused') {
    return [{ kind: 'refused', ts: run.endedAt ?? run.startedAt }]
  }

  const nodes: TimelineNode[] = [
    { kind: 'start', ts: run.startedAt },
    ...refusalKinds(refusals).map(({ count, refusal }) => ({
      kind: 'refusal' as const,
      ts: refusal.ts,
      refusal,
      ...(count > 1 ? { count } : {})
    }))
  ]

  if (isLive(run)) {
    nodes.push({ kind: 'live', seconds: runSeconds(run, at) })
  } else if (run.endedAt) {
    nodes.push({ kind: 'end', ts: run.endedAt, seconds: runSeconds(run, at) })
  } else {
    nodes.push({ kind: 'no-end' })
  }

  return nodes
}

export interface RefusalGroup {
  runId: string | null
  run: RunView | null
  refusals: RefusalView[]
}

export type OriginFilter = RunOrigin | 'all'

/** Refusals grouped by the run they belong to, in the order of the ledger; the unattributed ones last. `origin` keeps
 *  only the runs that party issued (an unattributed refusal has no known issuer, so only All keeps it). */
export function refusalGroups(
  state: Pick<ConfinementStateView, 'refusals' | 'runs'>,
  why: RefusalWhy | 'all',
  origin: OriginFilter = 'all'
): RefusalGroup[] {
  const origins = new Map(state.runs.map(run => [run.id, run.origin]))

  const kept = state.refusals.filter(
    refusal =>
      (why === 'all' || refusalWhy(refusal) === why) && (origin === 'all' || refusalOrigin(origins, refusal) === origin)
  )

  const byRun = new Map<string | null, RefusalView[]>()

  for (const refusal of kept) {
    const key = refusal.run ?? null
    byRun.set(key, [...(byRun.get(key) ?? []), refusal])
  }

  const runs = new Map(state.runs.map(run => [run.id, run]))

  const ids = [
    ...state.runs.map(run => run.id).filter(id => byRun.has(id)),
    ...[...byRun.keys()].filter((id): id is string => id !== null && !runs.has(id))
  ]

  const groups: RefusalGroup[] = ids.map(id => ({
    runId: id,
    run: runs.get(id) ?? null,
    refusals: byRun.get(id) ?? []
  }))

  const loose = byRun.get(null)

  return loose ? [...groups, { runId: null, run: null, refusals: loose }] : groups
}

/** How many refusals each rule refused, for the filter chips (only the rules that occur). */
export function whyCounts(state: Pick<ConfinementStateView, 'refusals'>): Array<{ why: RefusalWhy; count: number }> {
  const tallyByWhy = new Map<RefusalWhy, number>()

  for (const refusal of state.refusals) {
    tallyByWhy.set(refusalWhy(refusal), (tallyByWhy.get(refusalWhy(refusal)) ?? 0) + 1)
  }

  return [...tallyByWhy].map(([why, count]) => ({ why, count }))
}

/** How many refusals each issuer's runs were refused, for the Issued by chips (an unattributed refusal counts in
 *  neither). */
export function originCounts(state: Pick<ConfinementStateView, 'refusals' | 'runs'>): Record<RunOrigin, number> {
  const origins = new Map(state.runs.map(run => [run.id, run.origin]))
  const counted: Record<RunOrigin, number> = { agent: 0, runtime: 0 }

  for (const refusal of state.refusals) {
    const origin = refusalOrigin(origins, refusal)

    if (origin) {
      counted[origin] += 1
    }
  }

  return counted
}

/** A path as the Profiles view lists it: the home folder's prefix (`/Users/<name>`) said as `~`. Display only. */
export const homeRelative = (path: string): string => path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')

/** Runs that were live in the previous state and are not now: each is said once to a screen reader. */
export function endedSince(previous: ReadonlyMap<string, RunPhase>, runs: readonly RunView[]): RunView[] {
  return runs.filter(run => {
    const before = previous.get(run.id)

    return before !== undefined && isLive({ phase: before }) && !isLive(run)
  })
}

export const phasesOf = (runs: readonly RunView[]): Map<string, RunPhase> =>
  new Map(runs.map(run => [run.id, run.phase]))

/** The selection after Up/Down in the visible order: it stops at either end and starts at the first row. */
export function moveSelection(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) {
    return null
  }

  const index = current === null ? -1 : ids.indexOf(current)

  if (index === -1) {
    return delta === 1 ? ids[0] : ids[ids.length - 1]
  }

  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))]
}

/** The agent a run belongs to: its iNFT when the session is known, else the session id. */
export function runAgent(
  state: Pick<ConfinementStateView, 'agents'>,
  run: Pick<RunView, 'sessionId'>,
  noSession: string
): string {
  if (!run.sessionId) {
    return noSession
  }

  return state.agents.find(agent => agent.sessionId === run.sessionId)?.inft ?? run.sessionId
}

/** The agent's own commands in a session: the runtime's housekeeping carries the session too, but is not its doing. */
export const runsOfAgent = (state: Pick<ConfinementStateView, 'runs'>, sessionId: string): number =>
  state.runs.filter(run => run.sessionId === sessionId && !isHousekeeping(run)).length

const RUNTIME_TONE: Record<RuntimeConfinementView['state'], Tone> = {
  on: 'up',
  broken: 'down',
  stopped: 'down',
  off: 'muted'
}

const LAUNCHER_TONE: Record<RuntimeConfinementView['launcher'], Tone> = { up: 'up', down: 'down', off: 'muted' }

export const runtimeTone = (state: RuntimeConfinementView['state']): Tone => RUNTIME_TONE[state]
export const launcherTone = (launcher: RuntimeConfinementView['launcher']): Tone => LAUNCHER_TONE[launcher]

/** Machine's rail count turns red when something on it is a fault: a broken backend, a runtime that is not held or
 *  not running while confinement is on, a launcher that is not answering. */
export const macFaults = (state: Pick<ConfinementStateView, 'backends' | 'runtime'>): number =>
  state.backends.filter(backend => backend.status === 'broken').length +
  (state.runtime.state === 'broken' || state.runtime.state === 'stopped' ? 1 : 0) +
  (state.runtime.launcher === 'down' ? 1 : 0)

export type PaneNote = { kind: 'error' | 'info'; text: string }

/** The one sentence a Stop ends in, wherever it was clicked. */
export function stopResultNote(
  copy: Pick<ConfinementCopy, 'killFailed' | 'killed' | 'ledger'>,
  result: StopRunResultView
): PaneNote {
  if (result.ok) {
    return { kind: 'info', text: copy.killed(result.killed.length) }
  }

  if (result.error === STOP_UNAVAILABLE) {
    return { kind: 'error', text: copy.ledger.stopUnavailable }
  }

  if (result.error === STOP_NO_ANSWER) {
    return { kind: 'error', text: copy.ledger.stopNoAnswer }
  }

  return result.reason === 'not-running'
    ? { kind: 'info', text: copy.ledger.stopNotRunning }
    : { kind: 'error', text: copy.killFailed[result.reason](result.survivors.length) }
}

/** The Stop result still worth saying for a run: a failure stops being true once the run has ended. */
export function stopNoteOf(
  notes: Readonly<Record<string, PaneNote>>,
  run: Pick<RunView, 'id' | 'phase'>
): PaneNote | null {
  const note = notes[run.id] ?? null

  return note?.kind === 'error' && !isLive(run) ? null : note
}

/** A new Stop retires the earlier confirmations and its own run's old result; other runs' failures still hold. */
export function notesBeforeStop(notes: Readonly<Record<string, PaneNote>>, runId: string): Record<string, PaneNote> {
  return Object.fromEntries(Object.entries(notes).filter(([id, note]) => id !== runId && note.kind === 'error'))
}

/** Commands refused before they started, newest first as main lists them: no process ran, so no kernel refusal
 *  exists for them, yet the head counts them and Refusals has to show why. */
export const refusedBeforeStart = (
  state: Pick<ConfinementStateView, 'runs'>,
  origin: OriginFilter = 'all'
): RunView[] => state.runs.filter(run => run.phase === 'refused' && (origin === 'all' || run.origin === origin))

export function sayActionKind(copy: Pick<ConfinementCopy['ledger'], 'actionKind'>, kind: string): string {
  return kind === 'use' || kind === 'refuse' ? copy.actionKind[kind] : copy.actionKind.other
}

const SHELLS = new Set(['bash', 'sh', 'zsh'])

/** `tool` may be any program name the kernel reported, so only the catalogue's own keys are looked up. */
export function sayTool(copy: Pick<ConfinementCopy['ledger'], 'toolName'>, tool: string): string {
  // A shell the kernel reported is the agent's terminal: one word for one origin.
  const known = SHELLS.has(tool) ? 'terminal' : tool

  return Object.hasOwn(copy.toolName, known) ? copy.toolName[known] : tool
}

const capital = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1)

/** The scope sentence at its own labels, in any locale: "Confined: a, b. Off while confined: c." A wording that does not
 *  split stays whole, with no label, so no word is ever lost. */
export function splitScope(scope: string): readonly { label: string; text: string }[] {
  const said = /^([^:：]+)[:：]\s*(.*[.。])\s*([^.。:：]+)[:：]\s*(.+)$/su.exec(scope)

  return said
    ? [
        { label: said[1], text: capital(said[2]) },
        { label: said[3], text: capital(said[4]) }
      ]
    : [{ label: '', text: scope }]
}

/**
 * What Agents lists for a session: the same commands its count says (runsOfAgent), one row each, plus what the audit trail
 * holds that is not a command. The trail keeps only its last few records and writes several for one command, so it can
 * neither be counted against the runs nor listed beside them.
 */
export function agentRows(
  state: Pick<ConfinementStateView, 'runs'>,
  agent: Pick<ConfinementStateView['agents'][number], 'actions' | 'sessionId'>
): readonly { action: ConfinementStateView['agents'][number]['actions'][number]; count: number }[] {
  const ofSession = state.runs.filter(run => run.sessionId === agent.sessionId)
  // The trail clips its target at 200 characters (main's agentActivity), and keeps the bare command where the launcher's
  // run says how it ran: "[...] command". A refusal is never a command: its target is a path, and it always stays.
  const isCommandRecord = (action: { kind: string; target: string }) =>
    action.kind !== 'refuse' &&
    ofSession.some(run => run.command.slice(0, 200) === action.target || run.command.endsWith(`] ${action.target}`))

  const runRows = ofSession
    .filter(run => !isHousekeeping(run))
    .map(run => ({
      kind: run.phase === 'refused' ? 'refuse' : 'run',
      outcome: null,
      target: run.command,
      // `program` is an app-fixed helper: no tool of the agent's to name.
      tool: run.kind === 'shell' ? 'terminal' : '',
      ts: run.startedAt
    }))

  const rows = [...runRows, ...agent.actions.filter(action => !isCommandRecord(action))]

  return mergeActions(rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)))
}

/** Identical neighbours in an agent's list read as one row and how many: the newest keeps its time. */
export function mergeActions<T extends { kind: string; target: string; tool: string }>(
  actions: readonly T[]
): readonly { action: T; count: number }[] {
  const merged: { action: T; count: number }[] = []

  for (const action of actions) {
    const last = merged.at(-1)

    if (
      last &&
      last.action.kind === action.kind &&
      last.action.tool === action.tool &&
      last.action.target === action.target
    ) {
      last.count += 1
    } else {
      merged.push({ action, count: 1 })
    }
  }

  return merged
}
