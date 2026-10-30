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
  type HardlinkBlockView,
  isActivityClass,
  type OutsideKind,
  type OutsideProcessView,
  type ProfileView,
  type RefusalView
} from '../../src/iclone-shared/confinement'
import { redactSecrets } from '../../src/iclone-shared/redact'

import { parseMarker } from './backend'
import { type MemberProbe, parseRunToken } from './members'

export interface PsRow {
  pid: number
  ppid: number
  pgid: number
  elapsedSec: number
  command: string
  /** Set only when the kernel was asked (members.ts): this process is confined by icloneOS, in this run's token
   *  (null: ours, token already swept). Absent: not asked, or not ours. */
  run?: string | null
}

/** One `ps` read, with the kernel's membership answer when it could be asked. */
export interface Snapshot {
  rows: PsRow[]
  /** The membership probe ran: every confined process is annotated, orphans included. */
  verified: boolean
}

/** Annotates `rows` with the kernel's answer; on any probe failure the rows stay ancestry-only and unverified. */
export async function withMembership(rows: PsRow[], probe: MemberProbe | null): Promise<Snapshot> {
  if (!probe) {
    return { rows, verified: false }
  }

  try {
    const members = await probe(rows.map(row => row.pid))

    return {
      rows: rows.map(row => (members.has(row.pid) ? { ...row, run: members.get(row.pid) ?? null } : row)),
      verified: true
    }
  } catch {
    return { rows, verified: false }
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

      const kind: OutsideKind = row.pid === hermes ? 'hermes' : agentTree.has(row.pid) ? 'agent-command' : 'tool'

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
  hermesPids: readonly number[]
  /** Pids that wrote the plugin's load acknowledgement (index.ts reads it). */
  pluginAckPids: readonly number[]
  audit: readonly AuditSlice[]
  refusals: RefusalView[]
  /** Classes whose profile file on disk no longer holds what main generated. */
  tampered: readonly ActivityClass[]
  /** Projects confinement refused to start in (hardlinks.ts): said in the pane, not a verdict on what runs. */
  hardlinks: HardlinkBlockView[]
  /** Said, not red: links that appeared during recent runs (T3) and a settings file that was ignored (T7). */
  notes: readonly ConfinementReason[]
}

const CONFINED_SCOPE = ['terminal', 'execute_code', 'file tools'] as const
const NOT_CONFINED_SCOPE = ['MCP servers', 'browser'] as const

/** Hermes imports its plugins within seconds; before this age a missing acknowledgement is a boot, not a failure. */
const PLUGIN_ACK_GRACE_SEC = 30

/** Hermes runs and has had time to load its plugins, yet no process in its tree acknowledged the confinement plugin. */
function pluginNotLoaded(rows: readonly PsRow[], hermesPids: readonly number[], ackPids: readonly number[]): boolean {
  return hermesPids.some(hermes => {
    const tree = descendants(rows, hermes)
    const root = tree.find(row => row.pid === hermes)

    return root !== undefined && root.elapsedSec >= PLUGIN_ACK_GRACE_SEC && !tree.some(row => ackPids.includes(row.pid))
  })
}

export function foldState(input: FoldInput): ConfinementStateView {
  const inside = confinedProcesses(input.rows, input.known, input.verified)
  const insidePids = new Set(inside.map(process => process.pid))
  const outside = outsideProcesses(input.rows, input.hermesPids, insidePids)
  const reasons: ConfinementReason[] = []
  const selected = input.backends.find(backend => backend.id === input.backend)

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
        if (row.run === undefined && parseMarker(row.command)) {
          reasons.push({ code: 'forged-marker', pid: row.pid })
        }
      }
    }

    for (const process of outside.filter(item => item.kind === 'agent-command')) {
      reasons.push({ code: 'agent-command-outside', pid: process.pid })
    }
  }

  // An accounting gap, not a confinement gap: said in the pane, but it does not turn the verdict red on its own.
  // A link that appeared during a run is over by the time it is known: said too, so the owner learns what that run
  // could reach; the next run in that root is refused like any other.
  const notes: ConfinementReason[] = [
    ...(input.enabled && !input.verified ? [{ code: 'membership-unverified' } as const] : []),
    ...input.notes
  ]

  return {
    schema: CONFINEMENT_STATE_SCHEMA,
    at: input.now.toISOString(),
    backend: input.backend,
    enabled: input.enabled,
    verdict: !input.enabled ? 'off' : reasons.length > 0 ? 'red' : 'green',
    reasons: [...reasons, ...notes],
    backends: input.backends,
    defaultClass: input.defaultClass,
    profiles: input.profiles,
    inside,
    outside,
    agents: agentActivity(input.audit, inside, outside),
    refusals: input.refusals,
    hardlinks: input.hardlinks,
    scope: { confined: [...CONFINED_SCOPE], notConfined: [...NOT_CONFINED_SCOPE] }
  }
}
