/**
 * V3-G §1.5 — `iclone:confinement:state`, folded on every read from a fresh `ps` snapshot, the backends' probes,
 * the profiles main generated and the V3-F audit tail. Nothing in this module remembers a number between reads
 * (G3): the pane's counts are lengths of arrays built here, from processes that exist right now.
 */
import { execFile } from 'node:child_process'

import {
  type ActivityClass,
  type AgentActivityView,
  type BackendStatusView,
  type ConfinedProcessView,
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementBackendId,
  type ConfinementReason,
  type ConfinementStateView,
  type ConfinementVerdict,
  type HardlinkBlockView,
  type HardlinkFirstScanView,
  isActivityClass,
  type IsolationView,
  type OutsideKind,
  type OutsideProcessView,
  type ProfileView,
  type RefusalDayView,
  type RefusalView,
  type RuntimeConfinementView,
  type RunView,
} from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

import { parseMarker } from './backend'
import { type MemberProbe, parseRunToken, RUNTIME_ANSWER } from './members'

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  elapsedSec: number
  command: string
  /** Set only when the kernel was asked (members.ts): this process is confined by icloneOS, in this run's token
   *  (null: ours, token already swept). Absent: not asked, or not ours. */
  run?: string | null
  /** Set only when the kernel was asked: this process is held in the runtime profile (Hermes and the interpreter
   *  children it starts). Never inferred from ancestry or argv. */
  runtime?: boolean
}

/** answered: the kernel was asked · failed: the probe ran and did not answer · none: there was no probe to run (the
 *  runtime's Python does not exist yet, so nothing it starts can exist either). */
export type MembershipProbe = 'answered' | 'failed' | 'none'

/** One `ps` read, with the kernel's membership answer when it could be asked. */
export interface Snapshot {
  rows: PsRow[]
  /** fx29: when `ps` was read, the clock `elapsedSec` counts from; the fold uses it, never a later moment. */
  readAtMs?: number
  /** The membership probe ran: every confined process is annotated, orphans included. */
  verified: boolean
  /** Absent: answered when verified, failed when not. */
  probe?: MembershipProbe
}

/** Annotates `rows` with the kernel's answer; on any probe failure the rows stay ancestry-only and unverified. */
export async function withMembership(rows: PsRow[], probe: MemberProbe | null): Promise<Snapshot> {
  if (!probe) {
    return { rows, verified: false, probe: 'none' }
  }

  try {
    const members = await probe(rows.map(row => row.pid))

    return {
      rows: rows.map(row => {
        if (!members.has(row.pid)) {
          return row
        }

        const answer = members.get(row.pid) ?? null

        return answer === RUNTIME_ANSWER ? { ...row, runtime: true } : { ...row, run: answer }
      }),
      verified: true,
      probe: 'answered'
    }
  } catch {
    return { rows, verified: false, probe: 'failed' }
  }
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseElapsed(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())

  if (!match) {
    return 0
  }

  const [, days, hours, minutes, seconds] = match

  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = []

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)

    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        elapsedSec: parseElapsed(match[4]),
        command: match[5]
      })
    }
  }

  return rows
}

const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,pgid=,etime=,command='] as const

export function readPs(): Promise<PsRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      [...PS_ARGS],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5_000 },
      (error, out) => (error ? reject(error) : resolve(parsePs(String(out))))
    )
  })
}

function childrenOf(rows: readonly PsRow[]): Map<number, PsRow[]> {
  const map = new Map<number, PsRow[]>()

  for (const row of rows) {
    const list = map.get(row.ppid)

    if (list) {
      list.push(row)
    } else {
      map.set(row.ppid, [row])
    }
  }

  return map
}

/** Every process under `root` (the root included), breadth first. */
export function descendants(rows: readonly PsRow[], root: number): PsRow[] {
  const kids = childrenOf(rows)
  const self = rows.find(row => row.pid === root)
  const out: PsRow[] = self ? [self] : []
  const queue = [root]

  while (queue.length > 0) {
    const pid = queue.shift() as number

    for (const child of kids.get(pid) ?? []) {
      if (child.pid !== pid) {
        out.push(child)
        queue.push(child.pid)
      }
    }
  }

  return out
}

const COMMAND_MAX = 400
const clipCommand = (command: string) => redactSecrets(command).slice(0, COMMAND_MAX)

export interface KnownProfile {
  cls: ActivityClass
  sha256: string
  widened: boolean
  /** Main generated this text in this run; false = what a profile file on disk holds now, after a change. */
  generated: boolean
}

const isMember = (row: PsRow) => row.run !== undefined

/**
 * Confined roots carry the marker as their last argv; every descendant is inside with them (Seatbelt is inherited).
 * With a verified snapshot the kernel's answer decides: a marker on a process the kernel does not confine is a forgery
 * and is not counted inside, and a member no marker reaches (double-forked, `setsid`, reparented to launchd) is.
 */
export function confinedProcesses(
  rows: readonly PsRow[],
  known: readonly KnownProfile[],
  verified = false
): ConfinedProcessView[] {
  const out: ConfinedProcessView[] = []
  const seen = new Set<number>()
  const rootByRun = new Map<string, number>()

  const push = (
    member: PsRow,
    root: number,
    facts: { cls: string | null; sha12: string; sessionId: string | null }
  ) => {
    const profile = facts.sha12 ? known.find(item => item.sha256.startsWith(facts.sha12)) : undefined
    const cls = isActivityClass(facts.cls) ? facts.cls : null

    seen.add(member.pid)
    out.push({
      pid: member.pid,
      ppid: member.ppid,
      root,
      cls,
      profileSha: facts.sha12,
      profileKnown: Boolean(profile?.generated && profile.cls === cls),
      widened: profile ? profile.widened : false,
      sessionId: facts.sessionId,
      elapsedSec: member.elapsedSec,
      command: clipCommand(member.command)
    })
  }

  for (const row of rows) {
    const marker = parseMarker(row.command)

    if (!marker || seen.has(row.pid) || (verified && !isMember(row))) {
      continue
    }

    if (row.run) {
      rootByRun.set(row.run, row.pid)
    }

    for (const member of descendants(rows, row.pid)) {
      if (!seen.has(member.pid)) {
        push(member, row.pid, marker)
      }
    }
  }

  if (!verified) {
    return out
  }

  // Members no marker reaches, grouped by run; the run's root is its marked shell while it lives, else its oldest member.
  const orphans = rows.filter(row => isMember(row) && !seen.has(row.pid))
  const oldest = new Map<string, PsRow>()

  for (const row of orphans) {
    const current = row.run ? oldest.get(row.run) : undefined

    if (row.run && (!current || row.elapsedSec > current.elapsedSec)) {
      oldest.set(row.run, row)
    }
  }

  for (const row of orphans) {
    const facts = row.run ? parseRunToken(row.run) : null
    const root = row.run ? (rootByRun.get(row.run) ?? oldest.get(row.run)?.pid ?? row.pid) : row.pid

    push(row, root, facts ?? { cls: null, sha12: '', sessionId: null })
  }

  return out
}

/** Hermes' terminal wrapper always prints this marker; an unconfined process carrying it is an agent command. */
const HERMES_TERMINAL_RE = /__HERMES_CWD_/

export function outsideProcesses(
  rows: readonly PsRow[],
  hermesPids: readonly number[],
  inside: ReadonlySet<number>
): OutsideProcessView[] {
  const out: OutsideProcessView[] = []
  const seen = new Set<number>()

  for (const hermes of hermesPids) {
    const tree = descendants(rows, hermes)

    const agentTree = new Set(
      tree
        .filter(row => !inside.has(row.pid) && HERMES_TERMINAL_RE.test(row.command))
        .flatMap(row => descendants(rows, row.pid).map(member => member.pid))
    )

    for (const row of tree) {
      if (inside.has(row.pid) || seen.has(row.pid)) {
        continue
      }

      seen.add(row.pid)

      // The kernel's runtime mark, never argv: a process that only looks like the launcher's stub is still judged
      // by what it runs (an agent command when Hermes' terminal wrapper started it).
      const kind: OutsideKind =
        row.pid === hermes
          ? 'hermes'
          : row.runtime === true
            ? 'runtime'
            : agentTree.has(row.pid)
              ? 'agent-command'
              : 'tool'

      out.push({ pid: row.pid, ppid: row.ppid, kind, elapsedSec: row.elapsedSec, command: clipCommand(row.command) })
    }
  }

  return out
}

/** The slice of a V3-F audit record the pane joins on (src/iclone-shared/permissions AuditRecordView, plus pid). */
export interface AuditSlice {
  ts: string
  kind: string
  hermes_pid: number | null
  action: { tool: string; target: string } | null
  agent: { inft: string | null; session_id: string | null } | null
  answer: string | null
}

const ACTIONS_PER_AGENT = 8

export function agentActivity(
  audit: readonly AuditSlice[],
  inside: readonly ConfinedProcessView[],
  outside: readonly OutsideProcessView[]
): AgentActivityView[] {
  const bySession = new Map<string, AgentActivityView>()

  const entry = (sessionId: string, inft: string | null, ts: string) => {
    let view = bySession.get(sessionId)

    if (!view) {
      view = { sessionId, inft, lastTs: ts, actions: [], inside: 0, outside: 0 }
      bySession.set(sessionId, view)
    }

    return view
  }

  for (const record of audit) {
    const sessionId = record.agent?.session_id

    if (!sessionId) {
      continue
    }

    const view = entry(sessionId, record.agent?.inft ?? null, record.ts)

    view.inft = view.inft ?? record.agent?.inft ?? null
    view.lastTs = record.ts > view.lastTs ? record.ts : view.lastTs
    view.actions.unshift({
      ts: record.ts,
      kind: record.kind,
      tool: record.action?.tool ?? '',
      target: redactSecrets(record.action?.target ?? '').slice(0, 200),
      outcome: record.answer
    })
    view.actions.length = Math.min(view.actions.length, ACTIONS_PER_AGENT)
  }

  for (const process of inside) {
    if (process.sessionId) {
      entry(process.sessionId, null, '').inside += 1
    }
  }

  const agentCommands = outside.filter(process => process.kind === 'agent-command').length

  if (agentCommands > 0) {
    entry('unattributed', null, '').outside = agentCommands
  }

  return [...bySession.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
}

export interface FoldInput {
  /** F41: whether an off written now outlives this main. Absent: it does. */
  settingsPersist?: boolean
  now: Date
  backend: ConfinementBackendId
  enabled: boolean
  defaultClass: ActivityClass
  backends: BackendStatusView[]
  profiles: ProfileView[]
  known: KnownProfile[]
  rows: readonly PsRow[]
  /** The kernel answered which processes are confined (members.ts); false = ancestry only. */
  verified: boolean
  /** Why it did not answer, when it did not: the probe failed, or there was none to run. Absent: failed when
   *  unverified. */
  membership?: MembershipProbe
  hermesPids: readonly number[]
  /** The window's own runtime: its pid, null when main holds none. Absent: the first of `hermesPids` (`runtimePids`
   *  lists it first). The pool's runtimes never stand in for it: they serve other profiles. */
  primaryPid?: number | null
  /** Pids that wrote the plugin's load acknowledgement, one file per runtime (index.ts reads them). */
  pluginAckPids: readonly number[]
  /** What each runtime's plugin last said in its acknowledgement about the agent's commands (index.ts `readAckCommands`):
   *  reported by the runtime, so it is only ever a reason for red. Absent or empty: none said anything. */
  pluginCommands?: readonly PluginCommandsReport[]
  audit: readonly AuditSlice[]
  refusals: RefusalView[]
  /** L4-02: today's own refusal count (refusals.ts `day()`); absent here, the IPC state handler adds it. */
  refusalDay?: RefusalDayView | null
  /** Classes whose profile file on disk no longer holds what main generated. */
  tampered: readonly ActivityClass[]
  /** Projects confinement refused to start in (hardlinks.ts): said in the pane, not a verdict on what runs. */
  hardlinks: HardlinkBlockView[]
  /** CF1: the first hard-link scan running now; absent here, the IPC state handler adds it (as `refusalDay`). */
  firstScan?: HardlinkFirstScanView | null
  /** Said, not red: links that appeared during recent runs (T3) and a settings file that was ignored (T7). */
  notes: readonly ConfinementReason[]
  /** The run ledger (runs.ts), folded from the same snapshot. */
  runs?: RunView[]
  runsCut?: number
  /** The runtime profile main built for the last confined spawn; null or absent: none built (yet, or any more). */
  runtimeProfile?: { profileSha: string | null; reads: string[]; writes: string[]; denied: string[] } | null
  /** The launcher that starts confined commands; absent: not running. */
  launcher?: 'down' | 'off' | 'up'
  /** The runtime profile exists on macOS only; absent: this process's platform. */
  darwin?: boolean
}

const CONFINED_SCOPE = ['terminal', 'execute_code', 'file tools'] as const
const NOT_CONFINED_SCOPE = ['MCP servers', 'browser'] as const

/** Hermes imports its plugins within seconds; before this age a missing acknowledgement is a boot, not a failure. */
const PLUGIN_ACK_GRACE_SEC = 30

/** The confinement plugin's own answer to "can the agent's commands run now?", from its acknowledgement file. */
export interface PluginCommandsReport {
  /** The process that wrote it. */
  pid: number
  available: boolean
  /** Its plain reason when they cannot run (English, clipped). */
  reason: string
  /** Said in the pane, decides nothing: a config.yaml it could not read. Commands still run in the sandbox. */
  note?: string
}

/** The longest reason the pane repeats from the runtime's acknowledgement. */
export const PLUGIN_REASON_MAX = 400

/** The report counts only from a process in a live Hermes tree: a stale file from a Hermes that exited says nothing. */
function fromLiveHermes(input: FoldInput, report: PluginCommandsReport): boolean {
  return input.hermesPids.some(hermes => descendants(input.rows, hermes).some(row => row.pid === report.pid))
}

function commandsUnavailable(input: FoldInput): string | null {
  const report = (input.pluginCommands ?? []).find(item => !item.available && fromLiveHermes(input, item))

  return report ? report.reason.slice(0, PLUGIN_REASON_MAX) || 'no reason given' : null
}

function configUnreadable(input: FoldInput): boolean {
  return (input.pluginCommands ?? []).some(report => Boolean(report.note) && fromLiveHermes(input, report))
}

/** G22 B1: every runtime this Mac runs for the app: the window's and each pool backend's (a remote one has no process). */
export function runtimePids(
  primary: number | null | undefined,
  pool: Iterable<{ process: { pid?: number | null } | null }>
): number[] {
  const pids = [primary, ...Array.from(pool, entry => entry.process?.pid)]

  return [...new Set(pids.filter((pid): pid is number => Boolean(pid)))]
}

/** Hermes runs and has had time to load its plugins, yet no process in its tree acknowledged the confinement plugin. */
function pluginNotLoaded(rows: readonly PsRow[], hermesPids: readonly number[], ackPids: readonly number[]): boolean {
  return hermesPids.some(hermes => {
    const tree = descendants(rows, hermes)
    const root = tree.find(row => row.pid === hermes)

    return root !== undefined && root.elapsedSec >= PLUGIN_ACK_GRACE_SEC && !tree.some(row => ackPids.includes(row.pid))
  })
}

/**
 * The runtime's own confinement, from the facts main has: whether it is configured (confinement on, macOS), whether a
 * Hermes process exists, the kernel's mark on it, and the launcher's state.
 *
 *   not configured                                  ⇒ off      (launcher off)
 *   configured, the window's runtime not alive      ⇒ stopped  (never off, and whatever the pool runs: M4)
 *   configured, every live Hermes held by the kernel ⇒ on
 *   configured, a live Hermes not held (or not asked) ⇒ broken
 *
 * Configured, the launcher is up or down: one that is not running refuses commands just as one that does not answer.
 */
export function runtimeView(input: FoldInput): RuntimeConfinementView {
  const darwin = input.darwin ?? process.platform === 'darwin'
  const configured = input.enabled && darwin
  const pids = [...input.hermesPids]
  const profile = configured ? (input.runtimeProfile ?? null) : null

  const facts = {
    profileSha: profile?.profileSha ?? null,
    launcher: !configured ? ('off' as const) : input.launcher === 'up' ? ('up' as const) : ('down' as const),
    pids,
    reads: [...(profile?.reads ?? [])],
    writes: [...(profile?.writes ?? [])],
    denied: [...(profile?.denied ?? [])]
  }

  if (!configured) {
    return { state: 'off', ...facts }
  }

  // A Hermes pid that already exited has nothing to hold; an unverified snapshot never carries the mark, so a live
  // Hermes reads broken until the kernel can be asked.
  const live = pids.map(pid => input.rows.find(item => item.pid === pid)).filter(row => row !== undefined)

  const primary = input.primaryPid === undefined ? pids[0] : input.primaryPid

  const held = live.every(row => row.runtime === true)

  if (!held) {
    return { state: 'broken', ...facts }
  }

  return { state: input.rows.some(row => row.pid === primary) ? 'on' : 'stopped', ...facts }
}

/** F41: main's setting, and whether a live Hermes runs under the other state, by the kernel's mark and nothing else. */
function isolationView(input: FoldInput): IsolationView {
  const available = input.darwin ?? process.platform === 'darwin'
  const live = input.hermesPids.map(pid => input.rows.find(item => item.pid === pid)).filter(row => row !== undefined)

  return {
    on: input.enabled,
    available,
    persists: input.settingsPersist ?? true,
    runningDiffers: available && input.verified && live.some(row => (row.runtime === true) !== input.enabled)
  }
}

/** The membership probe failed, or had nothing to run with while there was something to ask about (a live Hermes, or
 *  a process carrying the confinement marker). No probe and nothing to ask is no gap. */
function membershipGap(input: FoldInput): boolean {
  if (input.verified) {
    return false
  }

  const probe = input.membership ?? 'failed'

  if (probe === 'failed') {
    return true
  }

  return (
    input.hermesPids.some(pid => input.rows.some(row => row.pid === pid)) ||
    input.rows.some(row => parseMarker(row.command) !== null)
  )
}

/** Said in the pane but never a verdict on their own: an accounting gap, a link found after a run, a settings file
 *  that was ignored. */
const NOTE_CODES: ReadonlySet<ConfinementReason['code']> = new Set([
  'membership-unverified',
  'hardlink-appeared',
  'settings-ignored',
  'agent-config-unreadable'
])

/** The verdict rule, from the reasons alone: off when confinement is off; red on any reason that is not a note;
 *  green otherwise. foldState applies it; a test asserts against it rather than re-deriving it. */
export const verdictOf = (enabled: boolean, reasons: readonly ConfinementReason[]): ConfinementVerdict =>
  !enabled ? 'off' : reasons.some(reason => !NOTE_CODES.has(reason.code)) ? 'red' : 'green'

export function foldState(input: FoldInput): ConfinementStateView {
  const inside = confinedProcesses(input.rows, input.known, input.verified)
  const insidePids = new Set(inside.map(process => process.pid))
  const outside = outsideProcesses(input.rows, input.hermesPids, insidePids)
  const reasons: ConfinementReason[] = []
  const selected = input.backends.find(backend => backend.id === input.backend)
  const runtime = runtimeView(input)

  if (input.enabled) {
    if (!selected || selected.status !== 'ready' || !selected.enforcing) {
      reasons.push({ code: 'backend-not-confining', backend: input.backend, detail: selected?.detail ?? null })
    }

    if (pluginNotLoaded(input.rows, input.hermesPids, input.pluginAckPids)) {
      reasons.push({ code: 'plugin-not-loaded' })
    }

    for (const cls of input.tampered) {
      reasons.push({ code: 'profile-changed', cls })
    }

    for (const process of inside.filter(item => item.pid === item.root)) {
      if (process.widened) {
        reasons.push({ code: 'widened-profile', pid: process.pid, sha: process.profileSha })
      }

      if (!process.profileKnown) {
        reasons.push({ code: 'unknown-profile', pid: process.pid, sha: process.profileSha })
      }
    }

    if (input.verified) {
      for (const row of input.rows) {
        // The launcher's stub carries the confined argv (marker included) while it waits; the kernel holds it in the
        // runtime profile, so it is neither a confined process nor a forgery.
        if (row.run === undefined && row.runtime !== true && parseMarker(row.command)) {
          reasons.push({ code: 'forged-marker', pid: row.pid })
        }
      }
    }

    if (runtime.state === 'broken' && input.verified) {
      for (const pid of runtime.pids) {
        const row = input.rows.find(item => item.pid === pid)

        if (row && row.runtime !== true) {
          reasons.push({ code: 'runtime-not-confined', pid })
        }
      }
    }

    // Not running: nothing runs and every command is refused, so the verdict is never green. The launcher's own state
    // is then a consequence (it stops with the last runtime) and said on This Mac, not as a second reason.
    if (runtime.state === 'stopped') {
      reasons.push({ code: 'runtime-not-running' })
    } else if (runtime.launcher === 'down') {
      reasons.push({ code: 'launcher-down' })
    }

    for (const process of outside.filter(item => item.kind === 'agent-command')) {
      reasons.push({ code: 'agent-command-outside', pid: process.pid })
    }

    // The runtime's word that it withholds the agent's commands: red, never green on its own (an available answer
    // adds nothing; every kernel fact above still decides green).
    const unavailable = commandsUnavailable(input)

    if (unavailable !== null) {
      reasons.push({ code: 'agent-commands-unavailable', reason: unavailable, reportedBy: 'runtime' })
    }
  }

  // An accounting gap, not a confinement gap: said in the pane, but it does not turn the verdict red on its own.
  // A link that appeared during a run is over by the time it is known: said too, so the owner learns what that run
  // could reach; the next run in that root is refused like any other.
  const notes: ConfinementReason[] = [
    ...(input.enabled && membershipGap(input) ? [{ code: 'membership-unverified' } as const] : []),
    ...(input.enabled && configUnreadable(input) ? [{ code: 'agent-config-unreadable' } as const] : []),
    ...input.notes
  ]

  return {
    schema: CONFINEMENT_STATE_SCHEMA,
    at: input.now.toISOString(),
    backend: input.backend,
    enabled: input.enabled,
    isolation: isolationView(input),
    verdict: verdictOf(input.enabled, [...reasons, ...notes]),
    reasons: [...reasons, ...notes],
    backends: input.backends,
    defaultClass: input.defaultClass,
    profiles: input.profiles,
    inside,
    outside,
    agents: agentActivity(input.audit, inside, outside),
    refusals: input.refusals,
    refusalDay: input.refusalDay ?? null,
    hardlinks: input.hardlinks,
    firstScan: input.firstScan ?? null,
    runs: input.runs ?? [],
    runsCut: input.runsCut ?? 0,
    runtime,
    scope: { confined: [...CONFINED_SCOPE], notConfined: [...NOT_CONFINED_SCOPE] }
  }
}
