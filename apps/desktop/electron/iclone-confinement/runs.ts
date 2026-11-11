/**
 * The run ledger: every confined command with a visible start, its live state and its end.
 *
 * Four files feed it, each with one writer:
 * - the launcher's journal (`ledger/runs.jsonl`, rotated to `.1`): start and end only, in a folder the runtime
 *   profile denies, so the runtime can neither read nor rewrite the record of what ran. A launcher before the refusal
 *   file also wrote its refusals here; those are still read, as the launcher's;
 * - the launcher's refusals (`ledger/refused.jsonl`, its own rotation to `.1`, same folder): the runtime can make the
 *   launcher refuse at will, so refusals live apart and can never rotate a start or end line away;
 * - the plugin's refusals before a request was sent (`run/refused.jsonl`, in the run dir the runtime may write);
 * - the owner's stops (`stops.jsonl`, written here, by main, before the kill).
 * The kernel's membership of a fresh `ps` snapshot says which runs still have processes alive. Every line is validated
 * field by field and a malformed one is dropped: a file another process writes is data, never trusted text. Nothing
 * here keeps a count between reads.
 *
 * The refusal's reason (`RefusalWhy`) is derived here too, by main, from the operation, the target and the profile the
 * run started under; a sentence a process wrote is never the reason.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  type ActivityClass,
  isActivityClass,
  type RefusalView,
  type RefusalWhy,
  type RunNarrowedWhy,
  type RunOrigin,
  type RunPhase,
  type RunRefusalCode,
  type RunView
} from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

import { isRunToken, parseRunToken } from './members'
import { type ProfileSpec, PROJECT_GIT_FILES, PROJECT_GIT_FOLDERS } from './profiles'
import { launcherLedgerDir, runtimeRunDir } from './runtime-profile'
import type { PsRow } from './state'

/**
 * At most this much of the end of each file is read: a journal that grew past it costs the same as a full one. The
 * launcher rotates `runs.jsonl` above 1 MiB and writes UTF-8 as it is (never `\uXXXX` escapes), so a start row at the
 * 2,000-character command clip is about 2.4 KB of plain text and about 8.4 KB of four-byte characters: a generation
 * holds roughly 430 such runs of plain text, 125 of the widest, and this window the newest half of either (about 215
 * and 60), more for shorter commands. Its refusal file rotates above 256 KiB and is read whole.
 */
export const TAIL_BYTES = 512 * 1024
/** A start with no end and nothing alive is still starting for this long (the kernel's answer lags the spawn). */
export const START_GRACE_MS = 3_000
export const RUNS_MAX = 100
/** The runtime's quiet housekeeping, bounded on its own (capRuns). */
export const HOUSEKEEPING_MAX = 100
/**
 * Refusal views kept per source after identical refusals are collapsed into one, newest last-seen first: the
 * launcher's (its refusal file, plus refusals an older launcher wrote into `runs.jsonl`) and the runtime's (the
 * plugin's `run/refused.jsonl`). Together at most 2 x REFUSED_MAX = 50 of the RUNS_MAX = 100 views, so the 50 newest
 * started runs (live ones first) always show: an older run leaves the pane only when newer runs take its place, never
 * because of refusals. Start and end rows are never capped and never share a file with the launcher's refusals.
 */
export const REFUSED_MAX = 25
/** A collapsed count stops here: a number the pane shows, not an accumulator. */
const REFUSED_COUNT_MAX = 1_000_000_000
/** The stops log rotates to `.1` above this size. */
const STOPS_MAX_BYTES = 256 * 1024

const COMMAND_MAX = 2_000
const DETAIL_MAX = 400
const PATH_MAX = 4_096
const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/
const SHA_RE = /^[0-9a-f]{64}$/
/** ISO 8601 as the launcher and main write it (UTC or an offset). */
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/

const REFUSAL_CODES: readonly RunRefusalCode[] = [
  'bad-request',
  'cwd-spelling',
  'cwd-gone',
  'cannot-scan',
  'hard-links',
  'launcher-unavailable',
  'no-profile',
  'policy',
  'profile-unknown',
  'other'
]

export interface RunStartEvent {
  ev: 'start'
  ts: string
  run: string
  pid: number
  kind: 'program' | 'shell'
  cls: ActivityClass | null
  sha: string
  session: string | null
  command: string
  cwd: string | null
  /** The launcher's word: `cwd` is the real folder of one asked for through a link from outside the project. */
  cwdLink?: boolean
  project: string | null
  net: boolean
  write: boolean
  /** Who issued it (the launcher's reading of how the runtime sent it): the agent, or the runtime's own housekeeping
   *  (the shell environment's session snapshot and probes, the runtime's environment probes). An older launcher wrote
   *  no origin: the agent's. */
  origin: RunOrigin
  /** Started with less than the request asked for. Absent: it got what it asked. */
  narrowed?: boolean
  narrowedWhy?: RunNarrowedWhy | null
  /** Hermes' background wrapper: its own status says nothing about the command it left running. */
  background?: boolean
  /** g17: the owner approved it and it runs outside any Seatbelt, so no kernel token holds it: its process group does. */
  outside?: boolean
}

export interface RunEndEvent {
  ev: 'end'
  ts: string
  run: string
  pid: number
  code: number | null
  signal: number | null
}

/** Which file a refusal came from: the launcher's own journal, or the plugin's file the runtime writes. */
export type RefusalSource = 'launcher' | 'runtime'

export interface RunRefusedEvent {
  ev: 'refused'
  /** The first refusal this event stands for. */
  ts: string
  /** The last one, when the writer recorded it (the launcher's coalesced rows), or after collapsing here. */
  lastTs: string | null
  /** How many identical refusals this event stands for (1 for a single row). */
  count: number
  session: string | null
  command: string
  code: RunRefusalCode
  detail: string | null
  /** Set by the reader from the file the line was in, never from the line. */
  reportedBy: RefusalSource
  /** The run this row stops (the launcher's kill row). Only the launcher's own files can name one: the runtime can
   *  write its refusal file at will, and must not be able to say why another run ended. */
  run?: string
}

export interface RunStopEvent {
  ev: 'stop'
  /** When the owner pressed Stop; an outcome line repeats the time of the press it answers. */
  ts: string
  run: string
  /** Written after the kill when it reported processes it could not end. No outcome: the press alone, or a kill that
   *  worked. */
  outcome?: 'failed'
}

/** fx22: the run's first process ended and something it started goes on. The launcher still owns it. */
export interface RunLeftRunningEvent {
  ev: 'left-running'
  ts: string
  run: string
  /** The process group the launcher started the run in. */
  pid?: number
}

/** fx22: what that run left running has ended: the run's true end. `stopped`: the launcher stopped it (policy, quit). */
export interface RunLeftEndedEvent {
  ev: 'left-ended'
  ts: string
  run: string
  stopped: boolean
  why: string | null
  /** At quit, how many the kill did not end. */
  survivors: number
}

export type RunEvent =
  | RunEndEvent
  | RunLeftEndedEvent
  | RunLeftRunningEvent
  | RunRefusedEvent
  | RunStartEvent
  | RunStopEvent

const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 1

const isStatus = (value: unknown): value is number | null =>
  value === null || (Number.isInteger(value) && Math.abs(value as number) < 1_000_000)

const isTs = (value: unknown): value is string =>
  typeof value === 'string' && TS_RE.test(value) && !Number.isNaN(Date.parse(value))

const session = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && SESSION_RE.test(value) ? value : undefined

const clip = (value: string, max: number) => redactSecrets(value.replace(/\0/g, '')).slice(0, max)

/** `.` or `..` as a segment, or an empty one: a spelling that is not the folder it seems to name. */
const UNPLAIN_PATH_RE = /\/\/|(?:^|\/)\.{1,2}(?:\/|$)/

/** A plain absolute path, or null; anything else is malformed (undefined). */
const absPath = (value: unknown): string | null | undefined =>
  value === null || value === undefined
    ? null
    : typeof value === 'string' &&
        value.startsWith('/') &&
        value.length <= PATH_MAX &&
        !/[\0\n]/.test(value) &&
        !UNPLAIN_PATH_RE.test(value)
      ? value
      : undefined

const NARROWED_WHYS: readonly string[] = [
  'needs-allow',
  'needs-file-writing',
  'needs-network',
  'needs-web-browsing',
  'unlisted-folder'
] satisfies RunNarrowedWhy[]

/**
 * A start row's narrowing. `true` with `narrowed_why`, or the earlier form: an object naming the flags taken away. Any
 * other value reads as not narrowed; a reason this app does not know still reads as narrowed, with no reason.
 */
function narrowingOf(raw: Record<string, unknown>): Pick<RunStartEvent, 'narrowed' | 'narrowedWhy'> {
  const said = raw.narrowed

  if (said === true) {
    const why = raw.narrowed_why

    return { narrowed: true, narrowedWhy: NARROWED_WHYS.includes(why as string) ? (why as RunNarrowedWhy) : null }
  }

  if (typeof said === 'object' && said !== null && !Array.isArray(said) && Object.keys(said).length > 0) {
    return {
      narrowed: true,
      narrowedWhy: 'WRITE_PROJECT' in said ? 'needs-allow' : 'NET' in said ? 'needs-network' : null
    }
  }

  return {}
}

/**
 * One journal line → an event, or null when any field is missing, of the wrong type or out of range. A refusal is
 * labelled with `refusedBy`, the writer of the file it was read from (the runtime unless the reader says otherwise).
 */
export function parseRunLine(line: string, refusedBy: RefusalSource = 'runtime'): RunEvent | null {
  if (!line.startsWith('{') || line.length > 64 * 1024) {
    return null
  }

  let raw: Record<string, unknown>

  try {
    const parsed: unknown = JSON.parse(line)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }

    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (raw.v !== 1 || !isTs(raw.ts)) {
    return null
  }

  if (raw.ev === 'start') {
    const sess = session(raw.session)
    const cwd = absPath(raw.cwd)
    const project = absPath(raw.project)
    // Only the launcher's exact word folds a run as housekeeping; any other value (none, from an older launcher; one this
    // reader does not know) reads as the agent's: a start row is never dropped, and so never hidden, for its origin.
    const origin: RunOrigin = raw.origin === 'runtime' ? 'runtime' : 'agent'

    if (
      !isRunToken(raw.run) ||
      !isPid(raw.pid) ||
      (raw.kind !== 'shell' && raw.kind !== 'program') ||
      !(raw.cls === null || isActivityClass(raw.cls)) ||
      typeof raw.sha !== 'string' ||
      !SHA_RE.test(raw.sha) ||
      sess === undefined ||
      typeof raw.command !== 'string' ||
      cwd === undefined ||
      project === undefined ||
      typeof raw.net !== 'boolean' ||
      typeof raw.write !== 'boolean'
    ) {
      return null
    }

    return {
      ev: 'start',
      ts: raw.ts,
      run: raw.run,
      pid: raw.pid,
      kind: raw.kind,
      cls: raw.cls,
      sha: raw.sha,
      session: sess,
      command: clip(raw.command, COMMAND_MAX),
      cwd,
      ...(raw.cwd_link === true ? { cwdLink: true } : {}),
      project,
      net: raw.net,
      write: raw.write,
      origin,
      ...narrowingOf(raw),
      ...(raw.background === true ? { background: true } : {}),
      ...(refusedBy === 'launcher' && raw.unconfined === true ? { outside: true } : {})
    }
  }

  if (raw.ev === 'end') {
    if (!isRunToken(raw.run) || !isPid(raw.pid) || !isStatus(raw.code) || !isStatus(raw.signal)) {
      return null
    }

    return { ev: 'end', ts: raw.ts, run: raw.run, pid: raw.pid, code: raw.code, signal: raw.signal }
  }

  if (raw.ev === 'left-running' && refusedBy === 'launcher' && isRunToken(raw.run)) {
    return {
      ev: 'left-running',
      ts: raw.ts,
      run: raw.run,
      ...(typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 1 ? { pid: raw.pid } : {})
    }
  }

  if (raw.ev === 'left-ended' && refusedBy === 'launcher' && isRunToken(raw.run)) {
    return {
      ev: 'left-ended',
      ts: raw.ts,
      run: raw.run,
      stopped: raw.stopped === true,
      why: typeof raw.why === 'string' ? raw.why : null,
      survivors: Number.isInteger(raw.survivors) ? (raw.survivors as number) : 0
    }
  }

  if (raw.ev === 'refused') {
    const run = refusedBy === 'launcher' && isRunToken(raw.run) ? raw.run : undefined
    // The launcher's kill row names its run and may carry neither session nor command: the run's start has them.
    const sess = run && raw.session === undefined ? null : session(raw.session)
    const count = raw.count === undefined ? 1 : raw.count
    const lastTs = raw.last === undefined || raw.last === null ? null : raw.last
    const command = typeof raw.command === 'string' ? raw.command : run ? '' : null

    if (
      sess === undefined ||
      command === null ||
      typeof raw.code !== 'string' ||
      !Number.isInteger(count) ||
      (count as number) < 1 ||
      (count as number) > REFUSED_COUNT_MAX ||
      !(lastTs === null || isTs(lastTs))
    ) {
      return null
    }

    return {
      ev: 'refused',
      ts: raw.ts,
      lastTs,
      count: count as number,
      session: sess,
      command: clip(command, COMMAND_MAX),
      code: (REFUSAL_CODES as readonly string[]).includes(raw.code) ? (raw.code as RunRefusalCode) : 'other',
      detail: typeof raw.detail === 'string' ? clip(raw.detail, DETAIL_MAX) : null,
      reportedBy: refusedBy,
      ...(run ? { run } : {})
    }
  }

  if (raw.ev === 'stop') {
    if (!isRunToken(raw.run)) {
      return null
    }

    return raw.outcome === 'failed'
      ? { ev: 'stop', ts: raw.ts, run: raw.run, outcome: 'failed' }
      : { ev: 'stop', ts: raw.ts, run: raw.run }
  }

  return null
}

/** The last `maxBytes` of a file as whole lines (a line cut by the window is dropped). Never throws. */
export function tailLines(file: string, maxBytes = TAIL_BYTES): string[] {
  let fd: number | null = null

  try {
    fd = fs.openSync(file, 'r')

    const { size } = fs.fstatSync(fd)
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)

    fs.readSync(fd, buffer, 0, length, size - length)

    const lines = buffer.toString('utf8').split('\n')

    if (length < size) {
      lines.shift()
    }

    return lines.filter(Boolean)
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // closed
      }
    }
  }
}

const readEvents = (file: string, refusedBy: RefusalSource = 'runtime'): RunEvent[] =>
  tailLines(file).flatMap(line => {
    const event = parseRunLine(line, refusedBy)

    return event ? [event] : []
  })

export interface RunFiles {
  /** The launcher's ledger (`<userData>/confinement/ledger`): `runs.jsonl` and `refused.jsonl`, only the launcher
   *  writes there. */
  ledgerDir: string
  /** The run dir (`<userData>/confinement/run`), where the plugin writes `refused.jsonl`. */
  refusedDir: string
  /** Main's own stops log. */
  stopsFile: string
}

export const runFiles = (userDataDir: string): RunFiles => ({
  ledgerDir: launcherLedgerDir(userDataDir),
  refusedDir: runtimeRunDir(userDataDir),
  stopsFile: path.join(userDataDir, 'confinement', 'stops.jsonl')
})

/** A process group with a live member; a dead one answers ESRCH, or EPERM when only a zombie is left. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)

    return true
  } catch {
    return false
  }
}

/**
 * fx21 (F1): how many runs left a background command running, for the quit decision. The launcher journals
 * `left-running` when a run's first process ended and something it started goes on, and `left-ended` when that ends;
 * a row with no end whose group is gone is a launcher that died before it could say so. Never throws.
 */
export function leftRunningCount(
  files: RunFiles,
  alive: (pid: number) => boolean = groupAlive,
  launcherSince: null | number = null
): number {
  // fx22 (F-c): `launcherSince`, when the launcher running now started. It checks members itself and closes each row
  // when they end, so its own open row is true even when the group is gone: a setsid daemon. An older row is not its word.
  const open = new Map<string, { own: boolean; pid: number }>()

  for (const name of ['runs.jsonl.1', 'runs.jsonl']) {
    for (const line of tailLines(path.join(files.ledgerDir, name))) {
      let row: { ev?: unknown; pid?: unknown; run?: unknown; ts?: unknown }

      try {
        row = JSON.parse(line) as typeof row
      } catch {
        continue
      }

      if (typeof row.run !== 'string') {
        continue
      }

      if (row.ev === 'left-running' && typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 1) {
        const own = launcherSince !== null && typeof row.ts === 'string' && Date.parse(row.ts) >= launcherSince

        open.set(row.run, { own, pid: row.pid })
      } else if (row.ev === 'left-ended') {
        open.delete(row.run)
      }
    }
  }

  return [...open.values()].filter(row => row.own || alive(row.pid)).length
}

const isRefused = (event: RunEvent): event is RunRefusedEvent => event.ev === 'refused'

const lastSeen = (event: RunRefusedEvent) => event.lastTs ?? event.ts

/** The launcher's kill row: it belongs to one run, so it folds onto that run and is not a refused command. */
const isModesStop = (event: RunRefusedEvent) => event.code === 'policy' && event.run !== undefined

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b)

/**
 * One source's refusals: identical ones (same session, code, detail and command) collapsed into one event that keeps
 * the first time, the last seen and the sum of the counts; then the REFUSED_MAX newest by last seen, oldest first. The
 * launcher writes a repeat's first row at once and its window's count later, so the two rows join here.
 */
const newestRefusals = (events: readonly RunRefusedEvent[]): RunRefusedEvent[] => {
  const groups = new Map<string, RunRefusedEvent>()

  for (const event of events) {
    const key = JSON.stringify([event.session, event.code, event.detail, event.command])
    const seen = groups.get(key)

    groups.set(
      key,
      seen
        ? {
            ...seen,
            ts: later(seen.ts, event.ts) === seen.ts ? event.ts : seen.ts,
            lastTs: later(lastSeen(seen), lastSeen(event)),
            count: Math.min(seen.count + event.count, REFUSED_COUNT_MAX)
          }
        : event
    )
  }

  return [...groups.values()].sort((a, b) => Date.parse(lastSeen(a)) - Date.parse(lastSeen(b))).slice(-REFUSED_MAX)
}

/** Every event the ledger folds: start and end from the launcher's journal (older generation first), the launcher's
 *  refusals, the plugin's refusals, the owner's stops. Only the launcher's journal may say start or end, only its
 *  refusal file (and, from an older launcher, its journal) adds refusals of the launcher's, only the plugin's file adds
 *  refusals of the runtime's, only main's log says stop. Each refusal carries the file it came from, never what the line
 *  says, and each source keeps its newest REFUSED_MAX after collapsing. */
export function readRunEvents(files: RunFiles): RunEvent[] {
  const journal = [
    ...readEvents(path.join(files.ledgerDir, 'runs.jsonl.1'), 'launcher'),
    ...readEvents(path.join(files.ledgerDir, 'runs.jsonl'), 'launcher')
  ].filter(event => event.ev !== 'stop')

  const launcherRefused = [
    ...journal,
    ...readEvents(path.join(files.ledgerDir, 'refused.jsonl.1'), 'launcher'),
    ...readEvents(path.join(files.ledgerDir, 'refused.jsonl'), 'launcher')
  ].filter(isRefused)

  const runtimeRefused = readEvents(path.join(files.refusedDir, 'refused.jsonl'), 'runtime').filter(isRefused)

  const stops = [...readEvents(`${files.stopsFile}.1`), ...readEvents(files.stopsFile)].filter(
    event => event.ev === 'stop'
  )

  return [
    ...journal.filter(event => !isRefused(event)),
    // A kill row is bounded by the runs it names, so newer refusals never evict the reason a run ended.
    ...launcherRefused.filter(isModesStop),
    ...newestRefusals(launcherRefused.filter(event => !isModesStop(event))),
    ...newestRefusals(runtimeRefused),
    ...stops
  ]
}

/** Main's stops log: one line per Stop, written before the first signal, and one more when the kill then reports
 *  survivors; 0600, bounded by one rotation. */
export function appendStop(stopsFile: string, run: string, ts: string, outcome?: 'failed'): void {
  fs.mkdirSync(path.dirname(stopsFile), { recursive: true, mode: 0o700 })

  try {
    if (fs.statSync(stopsFile).size > STOPS_MAX_BYTES) {
      fs.renameSync(stopsFile, `${stopsFile}.1`)
    }
  } catch {
    // no log yet
  }

  const line = outcome ? { v: 1, ev: 'stop', ts, run, outcome } : { v: 1, ev: 'stop', ts, run }

  fs.appendFileSync(stopsFile, `${JSON.stringify(line)}\n`, { mode: 0o600 })
}

export interface RunFoldInput {
  nowMs: number
  events: readonly RunEvent[]
  rows: readonly PsRow[]
  /** The kernel answered membership: `live` counts its members. Unverified: only the root's own pid is known. */
  verified: boolean
  /** Kernel refusals per run token, from each run's own refusal file (refusals.ts): the same number while the run
   *  lives and after it ends. */
  refusals: ReadonlyMap<string, number>
  /** Per run, the refusals the pane folds (`refusals` does not count them). */
}

const ms = (ts: string) => Date.parse(ts)
/** `elapsedSec` has a whole second's grain and a `ps` read's lag. */
const ORPHAN_START_SLACK_MS = 2_000
/** How far up a process's parents the owner of a token-less process is looked for; `ps` rows can never loop for long. */
const MAX_ANCESTRY_HOPS = 64

/** The writer's sentence, with the count and the last time when the view stands for several identical refusals. */
const refusedDetailOf = (event: RunRefusedEvent) =>
  event.count > 1
    ? [event.detail, `${event.count} times, last ${lastSeen(event)}`].filter(Boolean).join(' · ')
    : event.detail

/** A stable id for a command that never started (it has no run token): from its first refusal. */
const refusedId = (event: RunRefusedEvent) =>
  `refused-${createHash('sha256')
    .update(`${event.reportedBy}\0${event.ts}\0${event.session ?? ''}\0${event.code}\0${event.command}`)
    .digest('hex')
    .slice(0, 24)}`

const ACTIVE: readonly RunPhase[] = ['running', 'background']

/**
 * g17: who still lives of an approved background command. It runs outside every Seatbelt, so the kernel holds no token
 * for it; the group the launcher started it in names it, with the launcher up or killed. The group's leader ended before
 * the launcher wrote left-running and a group number stays taken while a member lives, so a process leading that number
 * is a recycled pid and nothing here is this command.
 */
export function outsideGroupMembers(group: number | undefined, rows: readonly PsRow[]): PsRow[] {
  if (group === undefined || group <= 1 || rows.some(row => row.pid === group)) {
    return []
  }

  return rows.filter(row => row.pgid === group)
}

/** g17: the group of a run that went outside and that the launcher has not said is over; undefined for any other run. */
export function outsideGroupOf(events: readonly RunEvent[], run: string): number | undefined {
  let outside = false
  let group: number | undefined

  for (const event of events) {
    if (event.ev === 'start' && event.run === run) {
      outside = event.outside === true
    } else if (event.ev === 'left-running' && event.run === run) {
      group = event.pid
    } else if (event.ev === 'left-ended' && event.run === run && event.survivors === 0) {
      return undefined
    }
  }

  return outside ? group : undefined
}

/** What the backend's kill sends. */
const STOP_SIGNALS: ReadonlySet<number> = new Set([9, 15])

/**
 * Whether the owner's Stop is what ended the run. A kill that reported survivors did not, so the run's own end speaks,
 * unless that end is a signal Stop sends, after it was pressed: the kill reached the root and only a child outlived it.
 */
function stopEndedRun(stop: RunStopEvent, end: RunEndEvent | undefined): boolean {
  return (
    stop.outcome !== 'failed' ||
    (end !== undefined && end.signal !== null && STOP_SIGNALS.has(end.signal) && ms(end.ts) >= ms(stop.ts))
  )
}

/**
 * The fold: one RunView per run token that has a start in the window, one per refused command. Phases follow
 * `RunPhase`; a start with no end and nothing alive reads `running` while it is younger than START_GRACE_MS (either
 * side of now: the launcher's clock and main's may disagree by a little), then `unknown`. Live runs come first (newest
 * start first), then the rest (newest first by end, or start when there is none); at most RUNS_MAX.
 */
/**
 * fx26a, fx28: who owns a process the kernel holds as confined whose run token is gone (`run: null`). Each such process
 * has one owner, or none.
 *
 * First the pid: the first process of a run with no end row, started when that run started, is that run's, and so is
 * what hangs below it; that run reads running with its Stop, and no older run can take it. (`roots`.)
 *
 * Then the clock, for what is left: the newest run that started before the process and may have left it. A run that
 * left something behind, ran the background wrapper or still has its first process alive comes first; with none of
 * those, the newest ended run. A Stop counts only if it reported no survivor: one that did ended nothing. A run the
 * kernel still names by its token holds its own members and owns nothing else.
 */
export function orphanOwners(input: Pick<RunFoldInput, 'events' | 'nowMs' | 'rows' | 'verified'>): {
  owners: ReadonlyMap<string, readonly PsRow[]>
  roots: ReadonlySet<string>
} {
  const owners = new Map<string, PsRow[]>()
  const roots = new Map<number, string>()
  const orphans = input.verified ? input.rows.filter(row => row.run === null) : []

  if (orphans.length === 0) {
    return { owners, roots: new Set() }
  }

  const take = (run: string, row: PsRow) => owners.set(run, [...(owners.get(run) ?? []), row])
  const startedAt = (row: PsRow) => input.nowMs - row.elapsedSec * 1000
  const ended = new Set<string>()
  const stops = new Map<string, RunStopEvent>()
  const leftStopped = new Set<string>()
  const left = new Set<string>()
  const held = new Set(input.rows.map(row => row.run))
  const starts: RunStartEvent[] = []

  for (const event of input.events) {
    if (event.ev === 'start') {
      starts.push(event)
    } else if (event.ev === 'end') {
      ended.add(event.run)
    } else if (event.ev === 'stop') {
      // The latest line speaks, as in foldAllRuns.
      stops.set(event.run, event)
    } else if (event.ev === 'left-ended' && event.stopped && event.survivors === 0) {
      leftStopped.add(event.run)
    }

    if (event.ev === 'left-running' || event.ev === 'left-ended') {
      left.add(event.run)
    }
  }

  // fx29 (round2 minor): a stop line with no outcome is the press, not the kill: it counts only when nothing of the
  // run is alive at this scan, so it never excludes the run here; a failed Stop ended nothing either.
  const stopped = (run: string) => {
    const stop = stops.get(run)

    return leftStopped.has(run) || (stop !== undefined && stop.outcome !== undefined && stop.outcome !== 'failed')
  }

  for (const start of starts) {
    const row = ended.has(start.run) ? undefined : orphans.find(item => item.pid === start.pid)

    // A later process that was handed the same pid started later: it is not this run's first.
    if (row && Math.abs(startedAt(row) - ms(start.ts)) <= ORPHAN_START_SLACK_MS) {
      roots.set(row.pid, start.run)
    }
  }

  const byPid = new Map(input.rows.map(row => [row.pid, row]))

  const rootRun = (row: PsRow): string | undefined => {
    let at: PsRow | undefined = row

    for (let hops = 0; at && hops < MAX_ANCESTRY_HOPS; hops += 1) {
      const run = roots.get(at.pid)

      if (run) {
        return run
      }

      at = byPid.get(at.ppid)
    }

    return roots.get(row.pgid)
  }

  const rootRuns = new Set(roots.values())

  const candidates = starts
    .filter(
      start => (ended.has(start.run) || rootRuns.has(start.run)) && !stopped(start.run) && !held.has(start.run)
    )
    .sort((a, b) => ms(b.ts) - ms(a.ts))

  for (const row of orphans) {
    const fits = candidates.filter(start => ms(start.ts) <= startedAt(row) + ORPHAN_START_SLACK_MS)

    const owner =
      rootRun(row) ??
      (fits.find(start => left.has(start.run) || start.background === true || rootRuns.has(start.run)) ?? fits[0])?.run

    if (owner) {
      take(owner, row)
    }
  }

  return { owners, roots: rootRuns }
}

export function foldRuns(input: RunFoldInput): RunView[] {
  return capRuns(foldAllRuns(input)).runs
}

/** An uneventful command the runtime marked as its own: a shell set-up, a probe. Anything it failed or had refused
 *  stays with the agent's runs, because the mark is the runtime's own word and must not buy an eviction. */
const isQuietHousekeeping = (run: RunView): boolean =>
  run.origin === 'runtime' && run.phase === 'exited' && run.refusals === 0

/**
 * The bound on what the state lists: live runs first, then the newest ended runs, RUNS_MAX of the agent's and
 * HOUSEKEEPING_MAX of the runtime's quiet ones, kept apart so a burst of housekeeping never evicts an agent command.
 * `cut` is how many ended runs the journal still holds beyond that, so the pane can say the list stops short.
 */
export function capRuns(all: readonly RunView[]): { runs: RunView[]; cut: number } {
  const agent: RunView[] = []
  const housekeeping: RunView[] = []

  for (const run of all) {
    ;(isQuietHousekeeping(run) ? housekeeping : agent).push(run)
  }

  const kept = new Set([...agent.slice(0, RUNS_MAX), ...housekeeping.slice(0, HOUSEKEEPING_MAX)])

  return { runs: all.filter(run => kept.has(run)), cut: all.length - kept.size }
}

/** Every run the events still hold, before the bound of capRuns. */
export function foldAllRuns(input: RunFoldInput): RunView[] {
  const starts = new Map<string, RunStartEvent>()
  const ends = new Map<string, RunEndEvent>()
  const stops = new Map<string, RunStopEvent>()
  const leftRunning = new Set<string>()
  const leftGroups = new Map<string, number>()
  const leftEnds = new Map<string, RunLeftEndedEvent>()
  const allRefused: RunRefusedEvent[] = []

  for (const event of input.events) {
    if (event.ev === 'start') {
      if (!starts.has(event.run)) {
        starts.set(event.run, event)
      }
    } else if (event.ev === 'end') {
      if (!ends.has(event.run)) {
        ends.set(event.run, event)
      }
    } else if (event.ev === 'stop') {
      // The latest line speaks: an outcome answers its press, and another press supersedes a failure.
      stops.set(event.run, event)
    } else if (event.ev === 'left-running') {
      leftRunning.add(event.run)

      if (event.pid !== undefined) {
        leftGroups.set(event.run, event.pid)
      }
    } else if (event.ev === 'left-ended') {
      // A quit that left survivors did not end the run: it stays open until the kernel says otherwise.
      if (event.survivors === 0) {
        leftEnds.set(event.run, event)
      }
    } else {
      allRefused.push(event)
    }
  }

  const modesStops = new Map<string, RunRefusedEvent>()

  for (const event of allRefused) {
    if (isModesStop(event) && event.run && starts.has(event.run) && !modesStops.has(event.run)) {
      modesStops.set(event.run, event)
    }
  }

  // A row naming a run with no start left in the window stays a row of its own while it has a command to show.
  const refused = allRefused.filter(event =>
    isModesStop(event) ? !starts.has(event.run ?? '') && event.command !== '' : true
  )

  const membersOf = new Map<string, number>()

  for (const row of input.rows) {
    if (row.run) {
      membersOf.set(row.run, (membersOf.get(row.run) ?? 0) + 1)
    }
  }

  const orphaned = orphanOwners(input)
  const views: RunView[] = []

  for (const start of starts.values()) {
    const end = ends.get(start.run)
    const lastStop = stops.get(start.run)
    const stop = lastStop && stopEndedRun(lastStop, end) ? lastStop : undefined
    const rootRow = input.rows.find(row => row.pid === start.pid)
    // Verified: the root is alive only if the kernel holds that pid in this run (a recycled pid is not the root).
    // Its token gone, the pid and the start time are all there is (orphanOwners).
    const rootAlive =
      !end && Boolean(rootRow) && (!input.verified || rootRow?.run === start.run || orphaned.roots.has(start.run))
    const leftEnd = leftEnds.get(start.run)
    // The kernel answers when it can. When it cannot, the launcher's own word that something lives on is all there is,
    // and it outranks the first process's exit status, which says nothing about what that process left running.
    const leftOpen = !input.verified && leftRunning.has(start.run) && !leftEnd
    const outsideLive = start.outside && !leftEnd ? outsideGroupMembers(leftGroups.get(start.run), input.rows).length : 0
    const live =
      outsideLive > 0
        ? outsideLive
        : input.verified
          ? (membersOf.get(start.run) ?? orphaned.owners.get(start.run)?.length ?? 0)
          : rootAlive || leftOpen
            ? 1
            : 0
    // fx29 (round2 medium): the count is a process whose run record is gone, handed to this row by the clock; the pane
    // says so instead of calling it this command's.
    const orphanLive = input.verified && !rootAlive && live > 0 && !membersOf.has(start.run) && outsideLive === 0
    const age = input.nowMs - ms(start.ts)
    // The owner's Stop speaks first. A run that ended by itself before the kill reached it keeps its own end.
    const candidate = modesStops.get(start.run)

    const modesStop =
      candidate && !stop && (!end || (end.signal !== null && STOP_SIGNALS.has(end.signal)) || leftEnd?.why === 'policy')
        ? candidate
        : undefined

    let phase: RunPhase

    if (rootAlive) {
      phase = 'running'
    } else if (live > 0) {
      phase = 'background'
    } else if (stop || modesStop || leftEnd?.stopped) {
      phase = 'stopped'
    } else if (end) {
      phase = end.code === 0 && end.signal === null ? 'exited' : 'failed'
    } else {
      phase = Math.abs(age) < START_GRACE_MS ? 'running' : 'unknown'
    }

    // fx23 (critic B medium 1, proof6 F1): what the run left running has ended by itself. The launcher saw the last
    // member go, or ran the background wrapper; the status in the end row is the first process's, never that command's.
    const backgroundEnded =
      (phase === 'exited' || phase === 'failed') &&
      (Boolean(leftEnd) || leftRunning.has(start.run) || (start.background === true && phase === 'exited'))

    // Background: the root's end is known though processes it started live on. Stopped with no end: the stop's time.
    // What the run left running ended later than its root: that is the run's end.
    const endedAt =
      phase === 'running'
        ? null
        : phase === 'background'
          ? (end?.ts ?? null)
          : (leftEnd?.ts ?? end?.ts ?? stop?.ts ?? modesStop?.ts ?? null)

    views.push({
      id: start.run,
      kind: start.kind,
      cls: start.cls,
      profileSha: start.sha,
      sessionId: start.session,
      command: start.command,
      cwd: start.cwd,
      projectRoot: start.project,
      network: start.net,
      writeProject: start.write,
      startedAt: start.ts,
      endedAt,
      phase,
      exitCode: end?.code ?? null,
      signal: end?.signal ?? null,
      rootPid: start.pid,
      live,
      refusals: input.refusals.get(start.run) ?? 0,
      ...(start.cwdLink ? { cwdLink: true } : {}),
      ...(orphanLive ? { orphanLive: true } : {}),
      ...(backgroundEnded ? { backgroundEnded: true } : {}),
      refusedReason: null,
      refusedDetail: null,
      reportedBy: 'launcher',
      origin: start.origin,
      ...(start.narrowed ? { narrowed: true, narrowedWhy: start.narrowedWhy ?? null } : {}),
      ...(phase === 'stopped' && modesStop ? { stoppedByModes: true, stoppedDetail: modesStop.detail } : {}),
      // g18: the stops file is written by the pane's Stop alone; the launcher's `stopped` may be the agent's process tool.
      ...(phase === 'stopped' && stop ? { stoppedByOwner: true } : {})
    })
  }

  for (const event of refused) {
    views.push({
      id: refusedId(event),
      kind: 'shell',
      cls: null,
      profileSha: '',
      sessionId: event.session,
      command: event.command,
      cwd: null,
      projectRoot: null,
      network: false,
      writeProject: false,
      startedAt: event.ts,
      endedAt: lastSeen(event),
      phase: 'refused',
      exitCode: null,
      signal: null,
      rootPid: null,
      live: 0,
      refusals: 0,
      refusedReason: event.code,
      refusedDetail: refusedDetailOf(event),
      refusedCount: event.count,
      // The launcher's journal or the runtime's own file (its plugin, before any request reached the launcher): the
      // pane says which.
      reportedBy: event.reportedBy,
      origin: 'agent'
    })
  }

  const unique = [...new Map(views.map(view => [view.id, view])).values()]
  const active = unique.filter(view => ACTIVE.includes(view.phase))
  const done = unique.filter(view => !ACTIVE.includes(view.phase))

  active.sort((a, b) => ms(b.startedAt) - ms(a.startedAt))
  done.sort((a, b) => ms(b.endedAt ?? b.startedAt) - ms(a.endedAt ?? a.startedAt))

  return [...active, ...done]
}

/** The starts in the events, by run token: what the refusal reason needs to know about the run it belongs to. */
export function runStarts(events: readonly RunEvent[]): Map<string, RunStartEvent> {
  const out = new Map<string, RunStartEvent>()

  for (const event of events) {
    if (event.ev === 'start' && !out.has(event.run)) {
      out.set(event.run, event)
    }
  }

  return out
}

const within = (target: string, root: string) =>
  target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)

/** An anchored glob (`*` within one segment) matches the target or one of its parent folders. */
const globMatches = (target: string, glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}(?:/|$)`).test(target)

const isProjectGitTarget = (target: string, project: string) =>
  PROJECT_GIT_FILES.some(rel => target === `${project}/.git${rel}`) ||
  PROJECT_GIT_FOLDERS.some(rel => within(target, `${project}/.git${rel}`))

export type WhySpec = Pick<ProfileSpec, 'denied' | 'deniedGlobs' | 'network' | 'protectedWrites'>

/**
 * Main's reading of one refusal. `spec` is the profile of the run it belongs to (the active class's when it is not
 * attributed); `run` is that run's start, when known.
 */
export function refusalWhy(
  refusal: Pick<RefusalView, 'operation' | 'process' | 'target'>,
  spec: WhySpec | null,
  run: Pick<RunStartEvent, 'narrowed' | 'narrowedWhy' | 'project' | 'write'> | null
): RefusalWhy {
  const { operation, target } = refusal

  if (refusal.process === 'hard-link' || operation.startsWith('hard-link') || operation === 'cannot-scan-after-run') {
    return 'hard-link'
  }

  const never =
    (spec?.denied ?? []).some(root => within(target, root)) ||
    (spec?.deniedGlobs ?? []).some(glob => globMatches(target, glob))

  if (operation.startsWith('file-read')) {
    return never ? 'never-list' : 'outside-roots'
  }

  if (operation.startsWith('file-write')) {
    if (run?.project && run.write && isProjectGitTarget(target, run.project)) {
      return 'git-config'
    }

    if ((spec?.protectedWrites ?? []).some(root => within(target, root))) {
      return 'protected-file'
    }

    if (never) {
      return 'never-list'
    }

    if (run?.project && !run.write && within(target, run.project)) {
      // A run that asked to write and was given no writes: its mode did not refuse it, so never say it did.
      return run.narrowed && run.narrowedWhy === 'unlisted-folder'
        ? 'narrowed-unlisted-folder'
        : run.narrowed && run.narrowedWhy === 'needs-allow'
          ? 'narrowed-needs-allow'
          : run.narrowed && run.narrowedWhy === 'needs-file-writing'
            ? 'narrowed-needs-file-writing'
            : 'project-read-only'
    }

    return 'not-writable'
  }

  if (operation.startsWith('network')) {
    return spec?.network === 'never'
      ? 'network-never'
      : run?.narrowed && run.narrowedWhy === 'needs-network'
        ? 'narrowed-needs-network'
        : 'network-not-granted'
  }

  if (operation.startsWith('process-exec')) {
    return 'program-refused'
  }

  if (operation.startsWith('mach-lookup')) {
    return 'system-service'
  }

  return 'other'
}

/**
 * Every refusal with its run (a token main recorded; anything else is dropped) and main's reason, derived from the
 * profile of that run's class, or of `activeCls` when the refusal is not attributed.
 */
export function explainRefusals(
  refusals: readonly RefusalView[],
  specs: readonly (WhySpec & { cls: ActivityClass })[],
  starts: ReadonlyMap<string, RunStartEvent>,
  activeCls: ActivityClass
): RefusalView[] {
  return refusals.map(refusal => {
    const run = isRunToken(refusal.run) ? refusal.run : null
    const start = run ? starts.get(run) : undefined
    const cls = start?.cls ?? (run ? parseRunToken(run)?.cls : null) ?? activeCls
    const spec = specs.find(item => item.cls === cls) ?? null

    return { ...refusal, run, why: refusalWhy(refusal, spec, start ?? null) }
  })
}
