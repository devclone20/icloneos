/**
 * V3-F — main's permission authority: the one place that changes the mode, grants and revokes, answers the plugin's
 * asks through the consent door, and writes every decision to the audit chain. Nothing here trusts the renderer: a
 * mode change or a revoke arrives with a gesture verdict main computed itself (ipc.ts), Ignore permissions is confirmed
 * on a NATIVE dialog main shows (a renderer cannot click it, F-17), and the plugin's messages arrive signed with the
 * spawn key only main and that Hermes process hold (socket-verb.ts).
 *
 * Main also knows whether the gate is really there (F-7): each spawn must attest (`hello`) within ATTEST_MS and keep a
 * heartbeat; until then, or when it stops, the state says "not enforced" and an audit `gap` says why. When the master
 * key could not be sealed (keys.ts) the authority runs Manual only (fail closed).
 */
import { randomUUID } from 'node:crypto'

import { oneShotReadable } from '../../src/iclone-shared/one-shot-text'
import {
  type ChoiceScope,
  F2_LOOSENING_ENABLED,
  levelOffered,
  type PermissionModeResetView
} from '../../src/iclone-shared/permissions'
import type { ConsentPermissionKey, ConsentRecord } from '../iclone-consent'
import type { DoorPermission, PermissionDoorOutcome } from '../iclone-consent-door'

import { type AuditAgent, type AuditAnswer, type AuditLog, type AuditRecord, modeLayerKey } from './audit'
import {
  ceilingsFrom,
  CREDENTIAL_WRITE_FLOOR,
  credentialReadFloor,
  credentialWriteFloor,
  type PolicyPathsInput,
  projectRootOf,
  protectedPaths,
  secretPaths
} from './classify-policy'
import {
  clampUnsealed,
  coverFunctions,
  decideFunctions,
  type FunctionDecision,
  functionGrantScopes,
  type FunctionLevel,
  type FunctionLevels,
  isFunctionLevel,
  isPermissionFunction,
  isRaise,
  orderFunctions,
  partsUnreadFor,
  PERMISSION_FUNCTIONS,
  type PermissionFunction
} from './functions'
import {
  type ActionClass,
  type ActionFacts,
  type Ceiling,
  CREDENTIAL_READ_FLOOR,
  DEFAULT_CEILING_KEY,
  DEFAULT_STANDING_MODE,
  grantScopesFor,
  isActionClass,
  isNarrowing,
  isPermissionMode,
  type ModeScope,
  type PermissionMode
} from './modes'
import { buildPolicyBody, type MintedSpawnKey, type PolicySigner } from './policy-file'
import { modeFromRecord } from './store'
import type { FunctionGrant, Grant, IntegrityFinding, ModeRecord, PermissionStore } from './store'

/** An `Allow once` that arrived after the plugin stopped waiting is held for the agent's retry this long. */
const LATE_ONCE_MS = 5 * 60_000
/** A spawn that has not attested by then is not enforced (F-7). */
export const ATTEST_MS = 10_000
/** A heartbeat older than this means the gate stopped answering. The plugin beats every 5 s when idle. */
const BEAT_STALE_MS = 15_000
/** How long a decided ask's answer stays readable by `await` (the plugin's retry window). */
const ASK_KEEP_MS = 3 * 60_000
const LINEAGE_MAX = 16
/** R3-MONO: more parts than this (or one unreadable part) and the call's parts count as unread. */
const PARTS_MAX = 64

/** One part of a text call, read by the plugin as a line of its own (`functions.Part`). */
interface PluginPart {
  cls: ActionClass
  facts: ActionFacts
  floor: string | null
  ceilingKey: string | null
  fns: PermissionFunction[]
}

interface PluginCall {
  pid: number
  seq: number
  keyId: string | null
  tool: string
  target: string
  cls: ActionClass
  facts: ActionFacts
  floor: string | null
  ceilingKey: string | null
  project: string | null
  /** F50, S5: the project of the session's own window. A workdir or a path the agent names never selects a mode. */
  sessionProject?: string | null
  /** G-98 F42: the folder the plugin says this plain shell command runs in, when it can run once outside. */
  oneShotCwd?: string | null
  /** G2 A5: the exact file the plugin says this write lands on, when no folder may open for it. */
  oneFilePath?: string | null
  /** G23-W2: the link the agent named, when `oneFilePath` is its real target. */
  oneFileLink?: string | null
  lineage: string[]
  agent: AuditAgent
  reason: string
  /** V3-F2: the call's functions from the plugin's mapping module (`functions.py`), in the fixed function order. */
  fns: PermissionFunction[]
  /** R3-MONO: the parts of a text call (null: the plugin did not read them). */
  parts: PluginPart[] | null
  /** R5-G: the plugin says the call is not FULLY READ; the parts it carries (if any) are still terms (R5-D). */
  unread: boolean
}

interface PluginDecision extends PluginCall {
  outcome: 'allow' | 'refuse'
  mode: PermissionMode
  grantId: string | null
  /** V3-F2: the function whose level decided the call locally (null: none, the mode decided). */
  fn: PermissionFunction | null
}

interface AskResult {
  allowed: boolean
  grantId: string | null
  reason: string
  /** G-98 F42: main recorded this exact command for one run outside the Seatbelt. */
  oneShot?: boolean
  oneFile?: boolean
}

/** The answer to `perm ask`: decided now, or on the sheet (then `perm await <askId>`). */
type AskStart = ({ state: 'decided' } & AskResult) | { state: 'pending'; askId: string }

type AskAwait = ({ state: 'decided' } & AskResult) | { state: 'unknown' }

type SetModeRequest = { mode: PermissionMode; scope: ChoiceScope; key: string | null }

type SetFunctionLevelRequest = { fn: PermissionFunction; level: FunctionLevel }

type SetFunctionLevelResult =
  | { ok: true; fn: PermissionFunction; level: FunctionLevel; raised: boolean }
  | { ok: false; error: 'confirm' | 'gesture' | 'invalid'; message: string }

type SetModeResult =
  | { ok: true; mode: PermissionMode; scope: ChoiceScope }
  | { ok: false; error: 'confirm' | 'gesture' | 'invalid'; message: string }

/** Whether the gate in each running Hermes is proven loaded and answering. */
type EnforcementState = 'degraded' | 'enforced' | 'no-agent' | 'not-enforced' | 'starting'

interface PermissionState {
  /**
   * Whether the master key was sealed in the system keychain at launch. The window needs it because an UNSEALED run
   * clamps to Manual everywhere: the levels below are the user's stored choice. A choice made unsealed is stored
   * pending and acts as Manual until a sealed launch confirms it on the system dialog (ruling 71). The matrix says so
   * instead of letting six columns read as broken buttons (owner).
   */
  sealed: boolean
  /** Functions whose stored level was chosen unsealed and is not in force until confirmed on the system dialog. */
  unconfirmed: PermissionFunction[]
  mode: ModeRecord
  grants: Grant[]
  functions: FunctionLevels
  fnGrants: FunctionGrant[]
  ceilings: Record<string, Ceiling>
  chain: { ok: boolean; records: number; gaps: number; verifying?: true }
  /**
   * A-1: every permission state file that is not in force as written — refused as tampered, deleted, or unverified
   * (legacy / unsealed-written) — with what the store did about it implied by the problem (store.ts). Empty when all
   * verify or nothing was ever written. The pane shows one line per finding; ipc.ts writes one audit `gap` each at launch.
   */
  integrity: IntegrityFinding[]
  /** The project the window has open, resolved the way the plugin resolves it (git root realpath). */
  project: string | null
  enforcement: EnforcementState
  modeReset: PermissionModeResetView[]
}

interface SpawnRecord {
  keyId: string
  mintedAt: number
  pid: number | null
  helloAt: number | null
  beatAt: number | null
  reportedUnattested: boolean
  reportedStale: boolean
}

interface AuthorityDeps {
  store: PermissionStore
  audit: AuditLog
  signer: PolicySigner
  door: {
    /** fx17 (lens4-pass M2): the answer with the door's own word on whether the sheet displayed the folder. */
    askPermissionShown: (
      slug: string,
      permission: DoorPermission,
      key: ConsentPermissionKey,
      reason: string
    ) => Promise<{ outcome: PermissionDoorOutcome; shown: boolean }>
    /** F40: answers once every ask on the sheet that Ignore now covers (`stillAsked` false). */
    releaseAsks?: (stillAsked: (permission: DoorPermission) => boolean) => void
  } | null
  consent: () => ConsentRecord | null
  paths: PolicyPathsInput
  /** Processes the agent may not stop (floor 7). */
  guardPids?: number[]
  /** iNFT contracts (floor 8). */
  inftContracts?: string[]
  /** The native second confirm for Ignore permissions (main's own dialog). Absent ⇒ Ignore cannot be chosen. */
  confirmIgnore?: (request: SetModeRequest) => Promise<boolean>
  /** V3-F2: main's native old → new confirm for raising a function's level. Absent ⇒ no level can be raised. */
  confirmFunctionRaise?: (request: {
    fn: PermissionFunction
    from: FunctionLevel
    to: FunctionLevel
  }) => Promise<boolean>
  /**
   * False when the master key is not sealed: Manual only, everywhere (keys.ts). Fixed for the life of the process:
   * main loads the master once per launch (ipc.ts), so turning the Keychain switch on takes effect at the next launch
   * — Settings › Permissions says so and offers "Restart now" (FX-2 r3). Re-keying a running authority would re-key
   * the audit chain, the signer and every live spawn key; that is not done in place.
   * Required, with no default (review r2, R2-M4): a missing seal fact used to default to sealed, so a launch that never
   * passed it ran as if the Keychain were on. An authority built without it refuses to start.
   */
  keysSealed: boolean
  now?: () => Date
  /** fx13 (D13): what the confinement launcher learns from an allowed ask — the folder the ask named and how the
   *  user answered, so the launcher lifts an asking cell for every run in that folder for a time; `shown` says the
   *  sheet printed the folder, which is what makes it one the user named (lens3-policy H3). Never the command text:
   *  the launcher cannot verify which command runs (H1). Absent (tests of the authority alone): no pass, and the
   *  launcher narrows. */
  /** fx20 (lens5 H2): the folder an ask may name to the user, judged when it is asked (its own spelling, never the home,
   *  the app's data or a `.git`); null: the sheet names no folder and nothing is listed. `same` says at the answer
   *  whether it is still that folder. Absent (tests of the authority alone): the ask's folder as named. */
  askFolder?: (project: string | null) => { project: string; same: () => boolean } | null
  /** G-98 F42: can this approved shell command run once outside the Seatbelt, and the record of the answer. */
  /** G28: the Seatbelt is off for this launch's runtimes. Absent reads as on, where the kernel stands before the list. */
  seatbeltOff?: () => boolean
  oneShot?: {
    available: (cwd: string) => boolean
    issue: (command: string, cwd: string) => boolean
    fileAvailable?: (file: string, ask?: { link?: string | null; ignore?: boolean }) => boolean
    /** G23: `ignore`: main itself decided, from the mode it holds, with no sheet. */
    /** G26: the real file behind a link, seen from main: the runtime's profile refuses it the stat. */
    fileLinkTarget?: (file: string) => string | null
    issueFile?: (file: string, by?: 'ignore', link?: string | null) => boolean
    /** G23-W2: one read of one file, its own kind of row. */
    issueRead?: (file: string, by?: 'ignore', link?: string | null) => boolean
    /** G23: the sheet adds a line: this file runs later with the owner's access, or holds keys. */
    fileRuns?: (file: string) => boolean
  }
  pass?: (pass: {
    project: string | null
    /** fx17 (lens4-pass M1): the class the user allowed; the launcher lifts project writes from Wp or X, the
     *  network from N or X, never one from the other. */
    cls: ActionClass
    scope: 'once' | 'project' | 'session' | 'standing'
    shown: boolean
    /** fx19: the grant this answer made, when it made one (none for a one-time allow). */
    grantId?: string | null
  }) => void
}

function parseSetMode(input: unknown): SetModeRequest | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const scope = raw.scope ?? 'standing'

  if (!isPermissionMode(raw.mode) || !['new-session', 'project', 'session', 'standing'].includes(scope as string)) {
    return null
  }

  const key = typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= 4096 ? raw.key : null

  return {
    mode: raw.mode,
    scope: scope as ChoiceScope,
    key: scope === 'standing' || scope === 'new-session' ? null : key
  }
}

function parseSetFunctionLevel(input: unknown): SetFunctionLevelRequest | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  // r5 contingency: with the loosening levels off, a request for one is not a level main knows
  return isPermissionFunction(raw.fn) && isFunctionLevel(raw.level) && levelOffered(raw.level, F2_LOOSENING_ENABLED)
    ? { fn: raw.fn, level: raw.level }
    : null
}

/** F40, L2: how long a session counts as running for what asks outside a tool call. */
const RECENT_CALL_MS = 120_000

const ceilingConsentKey = (cls: ActionClass, named: string | null): ConsentPermissionKey =>
  (named ?? DEFAULT_CEILING_KEY[cls] ?? 'fileWriting') as ConsentPermissionKey

/**
 * What a pending (unconfirmed) row enforces, in EVERY run: Manual — the agent does not do it — until the level is
 * confirmed on the system dialog (owner, after review s4 r2: "acts as Manual in a sealed run"). Review r2
 * (R2-M1): an unsealed run used to apply the unsealed clamp to a pending row, and that clamp keeps Ask always — so
 * Manual -> Ask always chosen with the Keychain off went in force at once while the audit said "not in force".
 */
const PENDING_LEVEL: FunctionLevel = 'manual'

/** The audit reason of a level change: true in every branch (review s4 r2, lens 6). */
function fnLevelReason(change: {
  unconfirmed: boolean
  raised: boolean
  sealed: boolean
  lowered: boolean
  withdrewPending: boolean
  sameInForce: boolean
}): string {
  if (change.unconfirmed) {
    return 'stored unconfirmed: the policy is not sealed, so no dialog was shown and the row acts as Manual until the level is confirmed'
  }

  if (change.raised && change.sealed) {
    return 'raised: confirmed on the system dialog'
  }

  if (change.lowered) {
    return 'lowered'
  }

  if (change.withdrewPending) {
    return 'pending choice replaced by one not wider than the level in force: nothing to confirm'
  }

  return change.sameInForce
    ? 'stored choice changed; nothing changed in force'
    : 'changed at equal strictness: nothing wider in force'
}

/** One layer of a mode record: the standing mode, or a project's or a session's (absent: not set). */
function layerOf(record: ModeRecord, scope: ModeScope, key: string | null): PermissionMode | undefined {
  if (scope === 'standing') {
    return record.standing
  }

  const layer = scope === 'project' ? record.projects : record.sessions

  return key !== null && Object.hasOwn(layer, key) ? layer[key] : undefined
}

/** A copy of `record` with one layer set to `mode`, or taken off (undefined). */
function withLayer(
  record: ModeRecord,
  scope: ModeScope,
  key: string | null,
  mode: PermissionMode | undefined
): ModeRecord {
  if (scope === 'standing') {
    return mode === undefined ? record : { ...record, standing: mode }
  }

  const field = scope === 'project' ? 'projects' : 'sessions'
  const layer = Object.fromEntries(Object.entries(record[field]).filter(([name]) => name !== key))

  return { ...record, [field]: mode === undefined || key === null ? layer : { ...layer, [key]: mode } }
}

export function createPermissionAuthority(deps: AuthorityDeps) {
  const now = deps.now ?? (() => new Date())

  if (typeof deps.keysSealed !== 'boolean') {
    throw new TypeError('createPermissionAuthority: keysSealed is required (the launch’s seal fact, ipc.ts)')
  }

  const sealedAtLaunch = deps.keysSealed
  const sealed = () => sealedAtLaunch

  // fx47, the owner's "with Ignore on, the agent still asks": the Keychain setting is off by default, so an unsealed run
  // is the ordinary run, and it pinned every mode to Manual. Disk cannot be trusted without the sealed key, but main's
  // memory can: a mode chosen by the owner's own gesture in this run is in force until the app quits. Nothing on disk
  // reaches this record, so a forged or older mode.json widens nothing, and the next launch starts at Manual.
  const liveModes: Pick<ModeRecord, 'projects' | 'sessions' | 'standing'> = {
    standing: DEFAULT_STANDING_MODE,
    projects: {},
    sessions: {}
  }

  /**
   * Permfix (L3-3): a layer whose broadening is not yet on stable storage AND in the audit reads as it was before, for
   * the gate, the bar and every publish (a spawn start, a grant click) — in a sealed run the disk already holds the new
   * file. Also a layer whose broadening failed and could not be rolled back: pinned at its old mode for this run.
   */
  const heldBack = new Map<string, { scope: ModeScope; key: string | null; previous: PermissionMode | undefined }>()
  const layerKey = modeLayerKey

  /** The one record of modes in force: the gate (modeFor), payments (modeOfCaller), the policy the plugin reads, the bar. */
  const modesInForce = (): ModeRecord => {
    const read = deps.store.readMode()
    let record: ModeRecord = sealed() ? read : { ...read, ...liveModes }

    for (const held of heldBack.values()) {
      record = withLayer(record, held.scope, held.key, held.previous)
    }

    return record
  }

  const effectiveOf = (query: Parameters<typeof deps.store.effective>[0]) => modeFromRecord(modesInForce(), query)

  // fx47: the parents a session named on its calls, so a drain and the bar read a session whose id compaction changed.
  const chains = new Map<string, string[]>()
  const lateOnce = new Map<string, number>()
  const pendingAsks = new Map<string, { askId: string; result: Promise<AskResult> }>()

  const asks = new Map<
    string,
    { result: Promise<AskResult>; waiting: number; settled: AskResult | null; until: number; consumed: boolean }
  >()

  const spawns = new Map<string, SpawnRecord>()

  /**
   * The levels IN FORCE. Without a sealed key only the rows that never allow survive (nothing wider than Manual,
   * V3-F §2). In every run, a level stored while unsealed is Manual until its raise is confirmed on the system dialog
   * (review s4, M1): a choice saved without the dialog is never authenticated by a later launch, and is not in force
   * in the launch that stored it either (review r2, R2-M1).
   */
  const levels = (): FunctionLevels => {
    const stored = deps.store.readFunctionLevels()
    const base = sealed() ? stored : clampUnsealed(stored)
    const pending = deps.store.readUnconfirmed()

    if (pending.size === 0) {
      return base
    }

    // Review s4 round 2 (lens 6): the unsealed clamp maps a pending row to 'mode', which in a SEALED run follows the
    // standing mode — so an Ask once chosen with the Keychain off could end up looser than the user's choice (no ask
    // under Automatic). Unsealed, the clamp keeps a pending Ask always, which is laxer than Manual (R2-M1). A pending
    // row is therefore Manual until its level is confirmed on the system dialog (PENDING_LEVEL), sealed or not.
    return Object.fromEntries(
      PERMISSION_FUNCTIONS.map(fn => [fn, pending.has(fn) ? PENDING_LEVEL : base[fn]])
    ) as FunctionLevels
  }

  const publish = () => {
    const record = modesInForce()

    deps.signer.publish(
      buildPolicyBody({
        // Without a sealed key: this run's own modes (fx47), no grant, nothing read back from disk.
        mode: record,
        // fx19, fx20 (lens5 H1): the folders are not modes. The keychain setting is off by default, so unsealed is the
        // ordinary run, and "Allow this folder" must reach the launcher there too; it lists the folder and nothing else.
        folders: record.folders ?? [],
        grants: sealed() ? deps.store.readGrants() : [],
        ceilings: ceilingsFrom(deps.consent()),
        protectedPaths: protectedPaths(deps.paths),
        secretPaths: secretPaths(deps.paths),
        guardPids: deps.guardPids ?? [process.pid],
        inftContracts: deps.inftContracts ?? [],
        functions: levels(),
        fnGrants: sealed() ? deps.store.readFnGrants() : [],
        now: now()
      })
    )
  }

  let ignoreAlertUp = false

  // F40, L2: what asks outside a tool call (payments, the consent verb) carries no session id, yet always follows a
  // shell or tool call of the session that wants it. So it reads the sessions seen in the last two minutes: Ignore only
  // when every one of them is in Ignore. Two sessions at once, one of them not, asks: never allows on another's mode.
  const recentCalls = new Map<string, { at: number; query: Parameters<typeof deps.store.effective>[0] }>()

  /** S6: every call the gate reports, asked or decided alone, keeps its session live and its own query for it. */
  const noteCall = (call: Pick<PluginCall, 'agent' | 'lineage' | 'project' | 'sessionProject'>) => {
    const project = call.sessionProject === undefined ? call.project : call.sessionProject
    const query = { sessionId: call.agent.session_id, lineage: call.lineage, project }
    const at = Date.now()

    for (const [sessionId, seen] of recentCalls) {
      if (at - seen.at > RECENT_CALL_MS) {
        recentCalls.delete(sessionId)
      }
    }

    if (call.agent.session_id) {
      recentCalls.set(call.agent.session_id, { at, query })
    }

    if (call.agent.session_id && call.lineage?.length) {
      chains.set(call.agent.session_id, call.lineage)
    }

    return query
  }

  const modeFor = (call: Pick<PluginCall, 'agent' | 'lineage' | 'project' | 'sessionProject'>): PermissionMode =>
    effectiveOf(noteCall(call))

  /** What the bar reads: a session compaction renamed shows the mode it inherits, on the id the window now holds. */
  const modesShown = (): ModeRecord => {
    const record = modesInForce()
    const sessions = { ...record.sessions }

    for (const [tip, chain] of chains) {
      const from = chain.find(sid => Object.hasOwn(record.sessions, sid))

      if (from && !Object.hasOwn(sessions, tip)) {
        sessions[tip] = record.sessions[from]
      }
    }

    return { ...record, sessions }
  }

  const ceilingFor = (call: Pick<PluginCall, 'ceilingKey' | 'cls'>): Ceiling | undefined => {
    const key = call.ceilingKey ?? DEFAULT_CEILING_KEY[call.cls]

    return key ? ceilingsFrom(deps.consent())[key] : undefined
  }

  const callKey = (call: PluginCall) => `${call.agent.session_id ?? ''}|${call.cls}|${call.tool}|${call.target}`

  const action = (call: PluginCall) => ({ tool: call.tool, target: call.target, project_root: call.project })

  // A Hermes approval relayed by the window (pid 0) is main's record, not a plugin event: no source sequence.
  const base = (call: PluginCall, mode: PermissionMode) => ({
    src: call.pid > 0 ? ('plugin' as const) : ('main' as const),
    src_key: call.pid > 0 ? call.keyId : null,
    hermes_pid: call.pid > 0 ? call.pid : null,
    mode,
    class: call.cls,
    action: action(call),
    agent: call.agent
  })

  /** A plugin record in source order: null when this seq was already recorded (a replay after a lost answer). */
  const sourced = (call: PluginCall, entry: Parameters<AuditLog['append']>[0]): AuditRecord | null => {
    if (call.pid <= 0) {
      return deps.audit.append(entry)
    }

    const result = deps.audit.appendSourced({ ...entry, hermes_pid: call.pid, src_seq: call.seq, src_key: call.keyId })

    return result.duplicate ? null : result.record
  }

  /** G2 A5: the one file, by its exact path, where the rule refuses any folder. */
  const oneFileRoute = (call: PluginCall, mode: PermissionMode): string | null =>
    (call.tool === 'write_file' || call.tool === 'patch' || call.tool === 'read_file') &&
    mode !== 'plan' &&
    call.oneFilePath &&
    deps.oneShot?.fileAvailable?.(call.oneFilePath, { link: call.oneFileLink ?? null, ignore: mode === 'ignore' })
      ? call.oneFilePath
      : null

  /**
   * G26: where the kernel refuses the runtime a stat it names a link as if it were the file. Main sees the disk: the sheet and
   * the row take the real target and name both. A link that cannot take the route stays as named: the launcher refuses it in words.
   */
  const withLinkSeen = (call: PluginCall, mode: PermissionMode): PluginCall => {
    const link = call.oneFilePath

    if (!link || call.oneFileLink) {
      return call
    }

    const target = deps.oneShot?.fileLinkTarget?.(link)

    return target && target !== link && deps.oneShot?.fileAvailable?.(target, { link, ignore: mode === 'ignore' })
      ? { ...call, oneFilePath: target, oneFileLink: link }
      : call
  }

  const credentialWrite = (call: PluginCall): string | null =>
    credentialWriteFloor(call.tool, `${call.target}, ${call.oneFilePath ?? ''}`, deps.paths.home)

  /** G28: the runtime's word or main's own judge, as for a write. */
  const onCredentialRead = (call: PluginCall): boolean =>
    call.floor === CREDENTIAL_READ_FLOOR ||
    !!credentialReadFloor(call.tool, call.target, deps.paths.home, () => deps.seatbeltOff?.() ?? false)

  const credentialFloor = (call: PluginCall): string | null =>
    credentialWrite(call) ?? (onCredentialRead(call) ? CREDENTIAL_READ_FLOOR : null)

  /** G25: main's own judge covers the file tools; the runtime's word adds any other tool that writes a path, like text_to_speech. */
  const onCredentialList = (call: PluginCall): boolean =>
    call.floor === CREDENTIAL_WRITE_FLOOR || !!credentialWrite(call)

  /** G23-W2: a read takes a read row, a write a write row, and one answer for a patch covers both of its steps. */
  const issueOneFile = (call: PluginCall, file: string, by?: 'ignore'): boolean => {
    const link = call.oneFileLink ?? null

    if (call.tool === 'read_file') {
      return deps.oneShot?.issueRead?.(file, by, link) ?? false
    }

    const written = deps.oneShot?.issueFile?.(file, by, link) ?? false

    if (written && call.tool === 'patch') {
      deps.oneShot?.issueRead?.(file, by, link)
    }

    return written
  }

  const oneFileWords = (call: PluginCall, file: string, how: string): string =>
    `${call.tool === 'read_file' ? 'read' : 'written'} once outside the Seatbelt ${how}: ${file}${call.oneFileLink ? ` (through the link ${call.oneFileLink})` : ''}`

  async function askUser(
    call: PluginCall,
    mode: PermissionMode,
    slug: string,
    asked: AuditRecord | null,
    winner: Pick<FunctionDecision, 'fn' | 'level' | 'unread'> | null = null
  ) {
    // V3-F2: an ask its function's level decided offers that level's scopes (Ask once may remember, `$` included;
    // Ask always is once only) and an answer for longer than once becomes a grant for that FUNCTION.
    // R4-UNREAD: a call that was not fully read is asked once only (no grant lifts an unread call).
    const fnScopes = winner?.unread ? (['once'] as const) : winner?.fn ? functionGrantScopes(winner.level) : null
    const fnGrant = !!winner?.fn && winner.level === 'askOnce' && !winner.unread

    // A Hermes approval is answered `once` only (§2): the app never hands Hermes a session or permanent allow.
    // fx20 (lens5 H2): `call.project` is the runtime's text. The sheet shows it only if it is a folder's own spelling,
    // and what the user's answer names is that folder, compared by identity when the answer comes.
    const folder = deps.askFolder
      ? deps.askFolder(call.project)
      : call.project
        ? { project: call.project, same: () => true }
        : null

    // G2 A5: the one file, by its exact path, where the rule refuses any folder. Same binding as the command below.
    const outsideFile = oneFileRoute(call, mode)

    // G24: this answer is about one file. A grant from it would be for a whole class of writes.
    const scopes =
      sealed() && !outsideFile && !onCredentialList(call) && !onCredentialRead(call)
        ? call.pid > 0
          ? (fnScopes ?? grantScopesFor(call.cls)).filter(scope => scope !== 'project' || folder)
          : (['once'] as const)
        : (['once'] as const)

    // G-98 F42: only the shell tool's own text, whole, and only where a launcher can run it. The sheet says so before
    // the click; the answer records exactly the text it showed, never one the runtime sends later.
    // S1: a text with something a person cannot read is not offered outside the Seatbelt at all.
    const outsideOnce =
      call.tool === 'terminal' &&
      call.oneShotCwd &&
      oneShotReadable(call.target) &&
      deps.oneShot?.available(call.oneShotCwd)
        ? call.oneShotCwd
        : null

    const doorAnswer: { outcome: PermissionDoorOutcome; shown: boolean; read?: string | null } = deps.door
      ? await deps.door.askPermissionShown(
          slug,
          {
            cls: call.cls,
            tool: call.tool,
            target: call.target,
            mode,
            project: folder?.project ?? null,
            session: call.agent.session_id,
            subagent: call.agent.subagent_id,
            scopes,
            outsideOnce,
            outsideFile,
            outsideFileRead: call.tool === 'read_file',
            outsideFileLink: outsideFile ? (call.oneFileLink ?? null) : null,
            outsideFileRuns:
              !!outsideFile &&
              call.tool !== 'read_file' &&
              [outsideFile, call.oneFileLink].some(file => !!file && deps.oneShot?.fileRuns?.(file) === true),
            credentialFile: onCredentialList(call),
            credentialRead: onCredentialRead(call),
            keychainOff: !sealed()
          },
          ceilingConsentKey(call.cls, call.ceilingKey),
          call.reason
        )
      : { outcome: 'busy', shown: false }

    const outcome = doorAnswer.outcome

    const heard: AuditAnswer =
      outcome === 'busy' || outcome === 'withdrawn' ? 'deny' : outcome === 'timeout' ? 'timeout' : outcome

    const answeredFolder = folder?.same() ? folder.project : null
    // An allow for "this project" when the project is no longer what the sheet showed covers this one call, no folder.
    const answer: AuditAnswer = heard === 'project' && !answeredFolder ? 'once' : heard

    if (answer === 'timeout') {
      deps.audit.append({
        src: 'door',
        kind: 'timeout',
        mode,
        class: call.cls,
        action: action(call),
        agent: call.agent,
        answer,
        reason: `ask ${asked?.seq_main ?? '?'} unanswered`
      })

      return { allowed: false, grantId: null, reason: 'the owner did not answer within two minutes' }
    }

    let grantId: string | null = null

    if (answer !== 'deny' && answer !== 'once' && fnGrant && winner?.fn) {
      const grant = deps.store.addFnGrant({
        fn: winner.fn,
        scope: answer,
        sessionId: answer === 'session' ? call.agent.session_id : null,
        project: answer === 'project' ? answeredFolder : null
      })

      grantId = grant.id
      deps.audit.append({
        src: 'door',
        kind: 'grant',
        mode,
        scope: answer,
        class: call.cls,
        agent: call.agent,
        grant_id: grant.id,
        gesture: true,
        fn: winner.fn,
        level: winner.level
      })
      publish()
    } else if (answer !== 'deny' && answer !== 'once') {
      const grant = deps.store.addGrant({
        cls: call.cls,
        scope: answer,
        sessionId: answer === 'session' ? call.agent.session_id : null,
        project: answer === 'project' ? answeredFolder : null,
        source: 'prompt'
      })

      grantId = grant.id
      deps.audit.append({
        src: 'door',
        kind: 'grant',
        mode,
        scope: answer,
        class: call.cls,
        agent: call.agent,
        grant_id: grant.id,
        gesture: true
      })
      publish()
    } else if (answer === 'once') {
      grantId = `once-${asked?.id ?? randomUUID()}`
    }

    if (answer === 'once' || answer === 'project' || answer === 'session' || answer === 'standing') {
      // fx13 (D13): every allowed answer, `once` included, is a pass for the folder the ask named and a time — never
      // for the command text, which the launcher cannot verify (lens3-policy H1). The folder counts as one the user
      // named only when the door says its sheet showed it (H3; fx17 M2: the door's own word, not that a door exists).
      // The pass carries the class the user allowed (fx17 M1).
      deps.pass?.({
        project: answeredFolder,
        cls: call.cls,
        scope: answer,
        shown: doorAnswer.shown && answeredFolder !== null,
        grantId: answer === 'once' ? null : grantId
      })
    }

    const allowedAnswer = answer === 'once' || answer === 'project' || answer === 'session' || answer === 'standing'

    // S1: the row is the hash of what the sheet showed. An Allow from a sheet that did not show this whole text stays an
    // Allow, and the command stays confined.
    const oneShot =
      allowedAnswer &&
      outsideOnce !== null &&
      doorAnswer.read === call.target &&
      (deps.oneShot?.issue(doorAnswer.read, outsideOnce) ?? false)

    const oneFile =
      allowedAnswer && outsideFile !== null && doorAnswer.read === call.target && issueOneFile(call, outsideFile)

    deps.audit.append({
      src: 'door',
      kind: 'answer',
      mode,
      scope: answer === 'deny' ? null : answer,
      class: call.cls,
      action: action(call),
      agent: call.agent,
      grant_id: grantId,
      answer,
      ...(winner?.fn ? { fn: winner.fn, level: winner.level } : {}),
      gesture: outcome === 'busy' || outcome === 'withdrawn' ? null : true,
      reason:
        outcome === 'busy'
          ? 'too many permission requests are already waiting'
          : outcome === 'withdrawn'
            ? 'withdrawn'
            : oneShot
              ? `allowed to run once outside the Seatbelt, in ${outsideOnce}`
              : oneFile && (call.tool === 'read_file' || call.oneFileLink)
                ? oneFileWords(call, outsideFile ?? '', 'as you allowed')
                : null
    })

    return answer === 'deny'
      ? {
          allowed: false,
          grantId: null,
          reason: outcome === 'busy' ? 'too many permission requests are waiting' : 'the owner denied it'
        }
      : {
          allowed: true,
          grantId,
          reason: `allowed (${answer})`,
          ...(oneShot ? { oneShot: true } : {}),
          ...(oneFile ? { oneFile: true } : {})
        }
  }

  const sweepAsks = () => {
    const at = now().getTime()

    for (const [id, entry] of asks) {
      if (entry.settled && entry.until < at) {
        asks.delete(id)
      }
    }
  }

  const spawnFor = (keyId: string | null): SpawnRecord | null => (keyId ? (spawns.get(keyId) ?? null) : null)

  /** Spawns that never attested or went silent get one honest `gap` record each. */
  const checkSpawns = () => {
    const at = now().getTime()

    for (const spawn of spawns.values()) {
      if (!spawn.helloAt && !spawn.reportedUnattested && at - spawn.mintedAt >= ATTEST_MS) {
        spawn.reportedUnattested = true
        deps.audit.append({
          src: 'main',
          kind: 'gap',
          hermes_pid: spawn.pid,
          src_key: spawn.keyId,
          reason: `the permission gate in Hermes${spawn.pid ? ` pid ${spawn.pid}` : ''} never attested: its tool calls are refused by Hermes and are not individually recorded`
        })
      } else if (spawn.helloAt && !spawn.reportedStale && at - (spawn.beatAt ?? spawn.helloAt) > BEAT_STALE_MS) {
        spawn.reportedStale = true
        deps.audit.append({
          src: 'main',
          kind: 'gap',
          hermes_pid: spawn.pid,
          src_key: spawn.keyId,
          reason: `the permission gate in Hermes pid ${spawn.pid ?? '?'} stopped answering`
        })
      }
    }
  }

  const enforcement = (): EnforcementState => {
    if (!sealed()) {
      return 'degraded'
    }

    const at = now().getTime()

    const states = [...spawns.values()].map(spawn => {
      if (!spawn.helloAt) {
        return at - spawn.mintedAt < ATTEST_MS ? 'starting' : 'not-enforced'
      }

      return at - (spawn.beatAt ?? spawn.helloAt) > BEAT_STALE_MS ? 'not-enforced' : 'enforced'
    })

    if (states.length === 0) {
      return 'no-agent'
    }

    return states.includes('not-enforced') ? 'not-enforced' : states.includes('starting') ? 'starting' : 'enforced'
  }

  /** S11: the choice made in an empty chat, by window, from the click. In memory only: it never outlives main or the window. */
  const windowChoices = new Map<number, { mode: PermissionMode; at: number }>()

  /** The one call of the store's mode writer (lock.test): every mode written, whichever way it was chosen. */
  const writeLayer = (mode: PermissionMode | null, scope: ModeScope, key: string | null, flush: 'deferred' | 'now') =>
    deps.store.writeMode(mode, scope, key, flush)

  /** Unsealed, main's own memory is the record in force (fx47); sealed, the file is. */
  const setLive = (mode: PermissionMode, scope: ModeScope, key: string | null) => {
    if (sealed()) {
      return
    }

    if (scope === 'standing') {
      liveModes.standing = mode
    } else if (scope === 'project') {
      liveModes.projects[key as string] = mode
    } else {
      liveModes.sessions[key as string] = mode
    }
  }

  /** B2-m1: the layers the sealed launch narrowed for want of a mode_set, until the owner chooses each again. */
  const modeResets = new Map<string, PermissionModeResetView>()

  const recordModeSet = (mode: PermissionMode, scope: ModeScope, key: string | null) => {
    const record = deps.audit.append({ src: 'main', kind: 'mode_set', mode, scope, gesture: true, reason: key })

    modeResets.delete(layerKey(scope, key))

    return record
  }

  /**
   * A sealed launch trusts mode.json only as far as the audit does. A broadening whose flush AND roll-back both failed
   * leaves the broader file with no `mode_set` line (the line follows the flush); the next launch must not read it.
   * A layer broader than its last durable `mode_set` (or than the narrowest default when it has none) is pinned to
   * that audited mode, the file is put back when the disk lets it, and the reason is recorded.
   */
  const distrustUnauditedBroadening = (): void => {
    if (!sealed()) {
      return
    }

    const disk = deps.store.readMode()

    const layers: { scope: ModeScope; key: string | null; mode: PermissionMode }[] = [
      { scope: 'standing', key: null, mode: disk.standing },
      ...Object.entries(disk.projects).map(([key, mode]) => ({ scope: 'project' as const, key, mode })),
      ...Object.entries(disk.sessions).map(([key, mode]) => ({ scope: 'session' as const, key, mode }))
    ]

    // B2-m2: the newest durable mode_set per layer was gathered by the audit's own open pass: no read here.
    const audited = deps.audit.lastModeSets()

    for (const { scope, key, mode } of layers) {
      const id = layerKey(scope, key)
      const trusted = audited.get(id) ?? (scope === 'standing' ? DEFAULT_STANDING_MODE : undefined)

      if (trusted !== undefined && isNarrowing(trusted, mode)) {
        continue
      }

      heldBack.set(id, { scope, key, previous: trusted })

      try {
        if (writeLayer(trusted ?? null, scope, key, 'now').ok) {
          heldBack.delete(id)
        }
      } catch {
        // the pin above keeps the audited mode in force for this run
      }

      const refused = deps.audit.append({
        src: 'main',
        kind: 'mode_refused',
        mode,
        scope,
        gesture: false,
        reason: `mode.json held ${mode} for ${scope}${key === null ? '' : ` ${key}`} with no recorded mode_set; ${trusted ?? 'no mode'} stays in force`
      })

      // B2-m1: the owner is told once (state().modeReset), until he chooses that layer again or dismisses it.
      modeResets.set(id, { id: refused.id, scope, key, was: mode, now: trusted ?? null })
    }
  }

  distrustUnauditedBroadening()

  /**
   * Permfix (L2, L3): mode changes run one at a time, in the order main accepted them, so what is in force, the audit
   * and the policy follow the clicks whatever order the flushes finish in.
   */
  let modeChanges: Promise<unknown> = Promise.resolve()

  const serially = <T>(step: () => Promise<T>): Promise<T> => {
    const run = modeChanges.then(step, step)

    modeChanges = run.catch(() => undefined)

    return run
  }

  type Settled = { ok: true } | { ok: false; refused: boolean; message: string }

  /**
   * The file, the live record when unsealed, and the audit line: every mode written, whichever way it was chosen.
   * `now` (the held choice): durable before it returns, in force and recorded at once.
   *
   * `deferred` (setMode), NARROW-FIRST (L3-1, L3-2, L3-3): mode.json is renamed at once and flushed in the thread pool.
   *  - A narrowing (isNarrowing over MODE_TABLE) is in force and published right after the rename; its audit line
   *    follows the flush. A failed flush keeps the narrower mode (fail closed) and tells the window it was not saved.
   *  - Anything else is held back: the layer reads as before until the flush AND the mode_set line are done, then it
   *    is in force. A failed flush is rolled back on disk and refused; nothing ever published it.
   * Whatever happens, the policy is published from the record in force once the change settles (`finally`).
   */
  const writeInForce = (
    mode: PermissionMode,
    scope: ModeScope,
    key: string | null,
    flush: 'deferred' | 'now'
  ): { ok: true; settled: Promise<Settled> } | { ok: false; error: string } => {
    if (flush === 'now') {
      const written = writeLayer(mode, scope, key, 'now')

      if (!written.ok) {
        return written
      }

      setLive(mode, scope, key)
      recordModeSet(mode, scope, key)

      return { ok: true, settled: Promise.resolve({ ok: true }) }
    }

    const layer = layerKey(scope, key)
    const previous = layerOf(modesInForce(), scope, key)
    const narrowing = previous !== undefined && isNarrowing(previous, mode)
    const pinned = heldBack.get(layer)

    if (!narrowing) {
      heldBack.set(layer, { scope, key, previous })
    }

    let written: ReturnType<typeof writeLayer>

    try {
      written = writeLayer(mode, scope, key, 'deferred')
    } catch (error) {
      restoreHold(layer, pinned)
      throw error
    }

    if (!written.ok) {
      restoreHold(layer, pinned)

      return written
    }

    if (narrowing) {
      heldBack.delete(layer)
      setLive(mode, scope, key)
      publish()
    }

    const durable = written.durable

    const settle = async (): Promise<Settled> => {
      try {
        let flushed = true

        try {
          await durable
        } catch {
          flushed = false
        }

        if (narrowing) {
          recordModeSet(mode, scope, key)

          return flushed
            ? { ok: true }
            : {
                ok: false,
                refused: false,
                message: `${mode} is in force now but could not be saved to disk; it may not survive a restart.`
              }
        }

        if (flushed) {
          try {
            recordModeSet(mode, scope, key)
            setLive(mode, scope, key)
            heldBack.delete(layer)

            return { ok: true }
          } catch {
            // the audit could not record it: never in force unrecorded, rolled back below
          }
        }

        try {
          if (writeLayer(previous ?? null, scope, key, 'now').ok) {
            restoreHold(layer, pinned)
          }
        } catch {
          // the disk keeps the unsaved file; the layer stays pinned at its old mode for this run
        }

        return { ok: false, refused: true, message: `${mode} could not be saved to disk; the mode was not changed.` }
      } finally {
        publish()
      }
    }

    return { ok: true, settled: settle() }
  }

  /** Back to the hold this layer had before the change (a pin from an earlier failed roll-back stays). */
  const restoreHold = (layer: string, pinned: ReturnType<typeof heldBack.get>) => {
    if (pinned) {
      heldBack.set(layer, pinned)
    } else {
      heldBack.delete(layer)
    }
  }

  return {
    publish,
    currentGen: () => deps.signer.currentGen(),
    /** A key for one Hermes spawn, with the policy already signed for it. Attestation is due within ATTEST_MS. */
    mintSpawnKey(): MintedSpawnKey {
      const minted = deps.signer.mint()

      spawns.set(minted.keyId, {
        keyId: minted.keyId,
        mintedAt: now().getTime(),
        pid: null,
        helloAt: null,
        beatAt: null,
        reportedUnattested: false,
        reportedStale: false
      })
      publish()

      return minted
    },
    /** start-hermes tells main which pid got the key, so the hello can be matched to it. */
    spawned(keyId: string, pid: number | null) {
      const spawn = spawns.get(keyId)

      if (spawn && Number.isInteger(pid)) {
        spawn.pid = pid
      }
    },
    /** The spawn exited: no more policy for it; its key still verifies replays of its log. */
    exited(keyId: string) {
      spawns.delete(keyId)
      deps.signer.retire(keyId)
    },
    /** `perm hello`: the gate is loaded in that process. A pid that does not match the spawn is not an attestation. */
    hello(keyId: string, pid: number, hi: number): boolean {
      const spawn = spawns.get(keyId)

      if (!spawn || (spawn.pid !== null && spawn.pid !== pid)) {
        return false
      }

      spawn.pid = pid
      spawn.helloAt = now().getTime()
      spawn.beatAt = spawn.helloAt
      spawn.reportedStale = false
      deps.audit.expectThrough(pid, keyId, hi)

      return true
    },
    beat(keyId: string, pid: number, hi: number): boolean {
      const spawn = spawns.get(keyId)

      if (!spawn?.helloAt || spawn.pid !== pid) {
        return false
      }

      spawn.beatAt = now().getTime()
      spawn.reportedStale = false
      deps.audit.expectThrough(pid, keyId, hi)

      return true
    },
    /** A clean exit: everything up to `hi` must be recorded by now, and the spawn is over (its key retires). */
    bye(keyId: string, pid: number, hi: number) {
      deps.audit.expectThrough(pid, keyId, hi)

      if (spawns.get(keyId)?.pid === pid) {
        spawns.delete(keyId)
        deps.signer.retire(keyId)
      }
    },
    /** Any message the gate signed proves it is alive, not only an idle heartbeat (a busy gate never idles). */
    seen(keyId: string, pid: number) {
      const spawn = spawns.get(keyId)

      if (spawn?.helloAt && spawn.pid === pid) {
        spawn.beatAt = now().getTime()
        spawn.reportedStale = false
      }
    },
    /** Periodic: the gap records for spawns that never attested or went silent. */
    checkSpawns,
    /** Log lines a live gate found that no key verifies (forged, or from before a key loss): a `gap`, never a record. */
    noteUnverifiable(pid: number, keyId: string | null, what: string, lines: number) {
      deps.audit.append({
        src: 'main',
        kind: 'gap',
        hermes_pid: pid > 0 ? pid : null,
        src_key: keyId,
        reason: `${Math.max(1, lines)} ${what} from Hermes${pid > 0 ? ` pid ${pid}` : ''} could not be verified and were not recorded`
      })
    },
    /**
     * S6: the mode for what asks outside a tool call (payments, the consent verb), of the session that called. A caller
     * with no session, one main never saw, or one with no call in the window is not known to be in any mode: Manual, it
     * asks. Never read from another session.
     */
    modeOfCaller(sessionId: null | string): PermissionMode {
      const seen = sessionId === null ? undefined : recentCalls.get(sessionId)

      return seen && Date.now() - seen.at <= RECENT_CALL_MS ? effectiveOf(seen.query) : 'manual'
    },
    /** The ONLY route to mode.json. `gestureOk` is main's own verdict (gesture.ts), never the renderer's claim. */
    async setMode(input: unknown, gestureOk: boolean, windowId?: number): Promise<SetModeResult> {
      const request = parseSetMode(input)

      const refuse = (error: 'confirm' | 'gesture' | 'invalid', message: string): SetModeResult => {
        deps.audit.append({
          src: 'main',
          kind: 'mode_refused',
          mode: request?.mode ?? null,
          scope: request?.scope ?? null,
          gesture: gestureOk,
          reason: message
        })

        return { ok: false, error, message }
      }

      if (!gestureOk) {
        return refuse('gesture', 'A permission mode changes only from your own click or key in icloneOS.')
      }

      if (!request) {
        return refuse('invalid', 'Unknown permission mode or scope.')
      }

      // S11: a choice for the session a window starts belongs to a window. With none behind the call there is nothing to hold it for.
      if (request.scope === 'new-session' && windowId === undefined) {
        return refuse('invalid', 'A choice for a new chat is made from a window.')
      }

      // F40 detail: the native alert once, then one touch. The acknowledgement lives in main's own record.
      if (request.mode === 'ignore' && !deps.store.ignoreAcknowledged()) {
        // One alert for one change. A second click while it is up gets no second alert and changes nothing.
        if (ignoreAlertUp) {
          return refuse('confirm', 'The system dialog for Ignore permissions is already open.')
        }

        let confirmed = false

        ignoreAlertUp = true

        try {
          confirmed = deps.confirmIgnore ? await deps.confirmIgnore(request) : false
        } catch {
          confirmed = false
        } finally {
          ignoreAlertUp = false
        }

        if (!confirmed) {
          return refuse('confirm', 'Ignore permissions was not confirmed on the system dialog.')
        }

        deps.store.acknowledgeIgnore()
      }

      const result = await serially(async (): Promise<SetModeResult> => {
        if (request.scope === 'new-session') {
          windowChoices.set(windowId as number, { mode: request.mode, at: Date.now() })
          deps.audit.append({
            src: 'main',
            kind: 'mode_set',
            mode: request.mode,
            scope: 'new-session',
            gesture: true,
            reason: `held for window ${windowId}`
          })
          publish()

          return { ok: true, mode: request.mode, scope: 'new-session' }
        }

        const key = request.scope === 'project' && request.key ? projectRootOf(request.key) : request.key
        const written = writeInForce(request.mode, request.scope, (key as string | null) ?? null, 'deferred')

        if (!written.ok) {
          return refuse('invalid', written.error)
        }

        const settled = await written.settled

        if (!settled.ok) {
          return settled.refused
            ? refuse('invalid', settled.message)
            : { ok: false, error: 'invalid', message: settled.message }
        }

        // A8: an explicit change of what new chats default to, from this window, replaces what it was holding.
        if (request.scope !== 'session' && windowId !== undefined) {
          windowChoices.delete(windowId)
        }

        return { ok: true, mode: request.mode, scope: request.scope }
      })

      // F40: "stops everything" includes what is waiting on the sheet right now. A floor never reaches the sheet. Only
      // once Ignore is durable, recorded and in force; each ask is judged by the mode in force now, so a narrowing
      // queued behind this change keeps its asks.
      if (result.ok && result.scope !== 'new-session' && result.mode === 'ignore') {
        deps.door?.releaseAsks?.(
          permission =>
            effectiveOf({
              sessionId: permission.session,
              lineage:
                (permission.session && chains.get(permission.session)) ||
                (permission.session ? [permission.session] : []),
              project: permission.project
            }) !== 'ignore'
        )
      }

      return result
    },
    /**
     * S11: the session a window started takes the choice main holds for that window. The gesture was judged at the
     * choice; this call adds nothing to it: the mode comes from main, the choice is single use, it needs real input to
     * that window since the choice, and it lands only on a session with no mode that has not run.
     */
    claimWindowChoice(input: {
      windowId: number | undefined
      sessionId: unknown
      inputAt: number
    }): { ok: true; mode: PermissionMode } | { ok: false } {
      const held = input.windowId === undefined ? undefined : windowChoices.get(input.windowId)
      const { sessionId } = input

      if (!held || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 4096) {
        return { ok: false }
      }

      const refused = (reason: string) => {
        deps.audit.append({
          src: 'main',
          kind: 'mode_refused',
          mode: held.mode,
          scope: 'new-session',
          gesture: false,
          reason
        })

        return { ok: false } as const
      }

      if (input.inputAt <= held.at) {
        return refused('A held choice is taken only after your own input to that window.')
      }

      if (
        Object.hasOwn(modesInForce().sessions, sessionId) ||
        heldBack.has(layerKey('session', sessionId)) ||
        chains.has(sessionId) ||
        recentCalls.has(sessionId)
      ) {
        return refused('A held choice lands only on the session the window starts.')
      }

      windowChoices.delete(input.windowId as number)

      if (!writeInForce(held.mode, 'session', sessionId, 'now').ok) {
        return refused('The held choice could not be written.')
      }

      publish()

      return { ok: true, mode: held.mode }
    },
    /** S11: what main holds for this window, for its own selector. Null for any other. */
    windowChoice(windowId: number | undefined): PermissionMode | null {
      return (windowId !== undefined && windowChoices.get(windowId)?.mode) || null
    },
    /** S11: the window closed. Its choice goes with it. */
    dropWindowChoice(windowId: number): void {
      windowChoices.delete(windowId)
    },
    /** fx20 (lens5 H1): "Allow this folder" and its Remove: the store's folder list, never a mode. After the gesture. */
    setFolder(folder: string, listed: boolean): void {
      deps.store.writeFolder(folder, listed)
      deps.audit.append({
        src: 'main',
        kind: 'mode_set',
        mode: null,
        scope: listed ? 'folder listed' : 'folder removed',
        gesture: true,
        reason: folder
      })
      publish()
    },
    /**
     * V3-F2 — the ONLY route to functions.json. A lowering is immediate; a raise needs main's own gesture verdict AND
     * the native old → new confirm (a dialog no renderer can click). Every change revokes that function's grants.
     */
    async setFunctionLevel(input: unknown, gestureOk: boolean): Promise<SetFunctionLevelResult> {
      const request = parseSetFunctionLevel(input)
      // `from` is the level IN FORCE (an unconfirmed choice counts as Manual, PENDING_LEVEL), `stored` the saved choice.
      const stored = request ? deps.store.readFunctionLevels()[request.fn] : null
      const from = request ? levels()[request.fn] : null
      const wasUnconfirmed = request ? deps.store.readUnconfirmed().has(request.fn) : false

      const refuse = (error: 'confirm' | 'gesture' | 'invalid', message: string): SetFunctionLevelResult => {
        deps.audit.append({
          src: 'main',
          kind: 'fn_level_refused',
          gesture: gestureOk,
          reason: message,
          ...(request ? { fn: request.fn, level: request.level } : {}),
          ...(from ? { prev_level: from } : {})
        })

        return { ok: false, error, message }
      }

      if (!request || !from) {
        return refuse('invalid', 'Unknown function or level.')
      }

      // R2-m5: a raise only when the new level is laxer than the row resolves to today, under every mode in effect.
      const record = modesInForce()
      const inEffect = [record.standing, ...Object.values(record.projects), ...Object.values(record.sessions)]

      // Unsealed, a level the clamp cuts back is stored UNCONFIRMED: no dialog was shown, so a later sealed launch keeps
      // it at Manual until the raise is confirmed. Sealed, every write that gets past the dialog is confirmed.
      // Review s4 r3 (critic B): the clamp alone missed 'mode' and 'askAlways' — manual -> mode chosen unsealed went in
      // force at the next sealed launch with no dialog, and a pending row re-chosen as 'mode' lost its mark. So any
      // raise, and any replacement of a pending row by something other than Manual, is unconfirmed too.
      // Review s4 r3 (lens 9, exhaustive): any rule based on what the unsealed clamp shows misses a case (askOnce
      // confirmed sealed, then 'mode' unsealed, went in force at the next sealed launch with no dialog). So, unsealed,
      // ANY change to a level other than Manual — and any re-choice of a pending row other than Manual — is unconfirmed.
      const unconfirmed = !sealed() && request.level !== 'manual' && (request.level !== stored || wasUnconfirmed)

      // Review r2 (R2-M2, R2-m3): re-choosing exactly what is stored, with the same pending mark, changes nothing — it
      // is not a raise (unsealed, `from` is the clamped level, so it used to come back `raised: true`), writes nothing
      // and revokes no grant. It says so in its own words instead of borrowing "changed at equal strictness".
      if (request.level === stored && unconfirmed === wasUnconfirmed) {
        deps.audit.append({
          src: 'main',
          kind: 'fn_level_set',
          gesture: gestureOk,
          fn: request.fn,
          level: request.level,
          prev_level: from,
          reason: 'no change: this level is already the stored choice; nothing written, no grant revoked'
        })

        return { ok: true, fn: request.fn, level: request.level, raised: false }
      }

      const raised = isRaise(from, request.level, inEffect)

      // Owner's decision: the switch and the matrix are independent. While the policy is NOT sealed the
      // user may still choose any level — the choice is STORED, PENDING — but nothing is raised in force: a pending row
      // is Manual in every run (`levels()`), and the signed policy carries that set. It takes effect only once a sealed
      // launch confirms it on the system dialog (ruling 71); turning the Keychain on does not, by itself, put it in
      // force. The user's own click is still required, and there is no dialog to show unsealed because nothing in force
      // gets wider.
      if (raised && sealed()) {
        if (!gestureOk) {
          return refuse('gesture', 'A level is raised only from your own click in icloneOS.')
        }

        // A dialog that was never shown is NOT a user decision. Both used to come back as `confirm`, which the
        // matrix stays silent about on purpose ("Keep the current level"), so a raise that never reached a dialog
        // looked exactly like a cell that does nothing. Keep `confirm` for a real answer; anything else says so.
        if (!deps.confirmFunctionRaise) {
          return refuse('invalid', 'The confirmation dialog is unavailable, so nothing was changed.')
        }

        let confirmed = false

        try {
          confirmed = await deps.confirmFunctionRaise({ fn: request.fn, from, to: request.level })
        } catch {
          return refuse('invalid', 'The confirmation dialog could not be shown, so nothing was changed.')
        }

        if (!confirmed) {
          return refuse('confirm', 'The raise was not confirmed on the system dialog.')
        }

        // The level may have moved while the dialog was open: the confirm covered `from`, nothing else.
        if (levels()[request.fn] !== from || deps.store.readFunctionLevels()[request.fn] !== stored) {
          return refuse('invalid', 'The level changed while the dialog was open; nothing was changed.')
        }
      }

      if (raised && !sealed() && !gestureOk) {
        return refuse('gesture', 'A level is chosen only from your own click in icloneOS.')
      }

      deps.store.writeFunctionLevel(request.fn, request.level, unconfirmed)

      deps.audit.append({
        src: 'main',
        kind: 'fn_level_set',
        gesture: gestureOk,
        fn: request.fn,
        level: request.level,
        prev_level: from,
        // Only a dialog answered in THIS call may be recorded as a confirmation; each other branch says what it is.
        reason: fnLevelReason({
          unconfirmed,
          raised,
          sealed: sealed(),
          lowered: isRaise(request.level, from, inEffect),
          withdrewPending: wasUnconfirmed && !unconfirmed,
          sameInForce: from === request.level
        })
      })

      for (const gone of deps.store.revokeFnGrants({ fn: request.fn })) {
        deps.audit.append({
          src: 'main',
          kind: 'revoke',
          scope: gone.scope,
          grant_id: gone.id,
          gesture: gestureOk,
          fn: gone.fn,
          reason: 'the function’s level changed'
        })
      }

      publish()

      return { ok: true, fn: request.fn, level: request.level, raised }
    },
    /** V3-F2 merge seam (V3-J M-J1): the level the user set for a function, as the gate applies it. */
    levelOf: (fn: PermissionFunction): FunctionLevel => levels()[fn],
    revoke(id: unknown, gestureOk: boolean): boolean {
      if (!gestureOk || typeof id !== 'string') {
        deps.audit.append({ src: 'main', kind: 'mode_refused', gesture: gestureOk, reason: 'revoke without a gesture' })

        return false
      }

      const [fnGrant] = deps.store.revokeFnGrants({ id })

      if (fnGrant) {
        deps.audit.append({
          src: 'main',
          kind: 'revoke',
          scope: fnGrant.scope,
          grant_id: fnGrant.id,
          gesture: true,
          fn: fnGrant.fn
        })
        publish()

        return true
      }

      const grant = deps.store.revokeGrant(id)

      if (grant) {
        deps.audit.append({
          src: 'main',
          kind: 'revoke',
          class: grant.cls,
          scope: grant.scope,
          grant_id: grant.id,
          gesture: true
        })
        publish()
      }

      return !!grant
    },
    /** A decision the plugin made locally from the signed policy (A or R!): recorded once, never re-decided. */
    recordDecision(decision: PluginDecision): AuditRecord | null {
      noteCall(decision)

      return sourced(decision, {
        ...base(decision, decision.mode),
        ...(decision.fn ? { fn: decision.fn } : {}),
        kind: decision.outcome === 'allow' ? 'use' : 'refuse',
        grant_id: decision.grantId,
        reason: decision.reason
      })
    },
    /** The plugin's ask (Q). Main decides again from its own state; only a real ask reaches the sheet. */
    ask(fromRuntime: PluginCall, slug: string): AskStart {
      sweepAsks()

      const mode = modeFor(fromRuntime)
      const call = withLinkSeen(fromRuntime, mode)
      const key = callKey(call)
      const lateUntil = lateOnce.get(key)

      // fx32p: a "this project" grant names the folder the sheet showed, the repository's root for a folder inside one.
      const grantProject = deps.askFolder?.(call.project)?.project ?? call.project

      const grant = sealed()
        ? deps.store.matchGrant(call.cls, {
            sessionId: call.agent.session_id,
            lineage: call.lineage,
            project: grantProject
          })
        : null

      const lateGrant = !!lateUntil && lateUntil > now().getTime()
      const query = { sessionId: call.agent.session_id, lineage: call.lineage, project: grantProject }
      const fnGrants = new Map<PermissionFunction, FunctionGrant | null>()

      const fnGrant = (fn: PermissionFunction): FunctionGrant | null => {
        if (!fnGrants.has(fn)) {
          fnGrants.set(fn, sealed() ? deps.store.matchFnGrant(fn, query) : null)
        }

        return fnGrants.get(fn) ?? null
      }

      // V3-F2: the levels of the call's functions override the mode for them; with every row at `mode` this is
      // exactly V3-F's decide (gate F2-2).
      const decision = decideFunctions({
        mode,
        cls: call.cls,
        facts: call.facts,
        floor: call.floor ?? credentialFloor(call),
        ceiling: ceilingFor(call),
        classGranted: !!grant && call.cls !== '$',
        onceGranted: lateGrant,
        fns: call.fns,
        levels: levels(),
        fnGranted: fn => fnGrant(fn) !== null,
        // R3-MONO: every part with main's own switch and class grant for the part's class
        parts: (call.parts ?? []).map(part => ({
          cls: part.cls,
          facts: part.facts,
          floor: part.floor,
          ceiling: ceilingFor(part),
          classGranted:
            sealed() &&
            part.cls !== '$' &&
            deps.store.matchGrant(part.cls, {
              sessionId: call.agent.session_id,
              lineage: call.lineage,
              project: grantProject
            }) !== null,
          fns: part.fns
        })),
        partsUnread: partsUnreadFor(call.tool, call.parts, call.unread),
        // R5-D (d): an unread call meets every switch
        switchesOff: Object.values(ceilingsFrom(deps.consent())).includes('off')
      })

      const fnFields = decision.fn ? { fn: decision.fn, level: decision.level } : {}

      // G23: no grant or level opens this file's folder, so outside Ignore an allow here still means one sheet and one row.
      const route = decision.outcome === 'allow' ? oneFileRoute(call, mode) : null
      const lateAllow = decision.by === 'once'

      if (decision.outcome !== 'ask' && !(route && mode !== 'ignore' && !lateAllow)) {
        if (lateGrant && decision.by === 'once') {
          lateOnce.delete(key)
        }

        const grantId =
          decision.rule !== 'grant'
            ? null
            : decision.by === 'once'
              ? `once-late`
              : decision.by === 'fn' && decision.fn
                ? (fnGrant(decision.fn)?.id ?? null)
                : (grant?.id ?? null)

        const refusedBy =
          decision.rule === 'function' && decision.fn ? `${decision.fn} is set to ${decision.level}` : null

        // Main's own word on the mode, never the runtime's: this row is what lets the launcher write. A late Allow already
        // has its row, from the sheet.
        const issuedInIgnore = !!route && mode === 'ignore' && issueOneFile(call, route, 'ignore')
        const oneFile = issuedInIgnore || (!!route && lateAllow)

        sourced(call, {
          ...base(call, mode),
          ...fnFields,
          kind: decision.outcome === 'allow' ? 'use' : 'refuse',
          grant_id: grantId,
          reason:
            decision.outcome === 'refuse'
              ? `${decision.rule}: ${call.floor ?? call.parts?.find(part => part.floor)?.floor ?? refusedBy ?? mode}`
              : issuedInIgnore
                ? oneFileWords(call, route ?? '', 'in Ignore permissions')
                : call.reason
        })

        return {
          state: 'decided',
          allowed: decision.outcome === 'allow',
          grantId,
          ...(oneFile ? { oneFile: true } : {}),
          reason:
            decision.outcome === 'allow'
              ? 'allowed'
              : `refused by ${
                  decision.rule === 'mode'
                    ? `the ${mode} mode`
                    : decision.rule === 'function' && decision.fn
                      ? `your ${decision.fn} level (${decision.level})`
                      : decision.rule
                }`
        }
      }

      const asked = sourced(call, { ...base(call, mode), ...fnFields, kind: 'ask', reason: call.reason })
      const open = pendingAsks.get(key)

      if (open) {
        return { state: 'pending', askId: open.askId }
      }

      const askId = randomUUID()

      const result = askUser(call, mode, slug, asked, decision).then(outcome => {
        const entry = asks.get(askId)

        if (entry) {
          entry.settled = outcome
          entry.until = now().getTime() + ASK_KEEP_MS

          // Nobody was waiting when the owner allowed it once: the agent's retry of the same call consumes it.
          if (entry.waiting === 0 && outcome.allowed && outcome.grantId?.startsWith('once-')) {
            entry.consumed = true
            lateOnce.set(key, now().getTime() + LATE_ONCE_MS)
          }
        }

        return outcome
      })

      asks.set(askId, { result, waiting: 0, settled: null, until: Number.POSITIVE_INFINITY, consumed: false })
      pendingAsks.set(key, { askId, result })
      void result.finally(() => pendingAsks.delete(key))

      return { state: 'pending', askId }
    },
    /** The owner's answer to a pending ask. `signal` aborts when the plugin stopped waiting (socket closed). */
    async awaitAsk(askId: unknown, signal?: AbortSignal): Promise<AskAwait> {
      const entry = typeof askId === 'string' ? asks.get(askId) : undefined

      if (!entry) {
        return { state: 'unknown' }
      }

      // One answer, one call: two identical calls waiting on the same sheet share a Deny, but an Allow goes to the
      // first reader only; the other is told to retry, which asks again.
      const take = (outcome: AskResult): AskAwait => {
        if (outcome.allowed && entry.consumed) {
          return { state: 'unknown' }
        }

        entry.consumed = entry.consumed || outcome.allowed

        return { state: 'decided', ...outcome }
      }

      if (entry.settled) {
        return take(entry.settled)
      }

      entry.waiting += 1

      try {
        const aborted = new Promise<null>(resolve => {
          if (signal?.aborted) {
            resolve(null)
          }

          signal?.addEventListener('abort', () => resolve(null), { once: true })
        })

        const outcome = await Promise.race([entry.result, aborted])

        return outcome === null ? { state: 'unknown' } : take(outcome)
      } finally {
        entry.waiting -= 1
      }
    },
    /**
     * A Hermes approval request (dangerous command, plugin escalation) the window received on its gateway socket.
     * It is answered on the same sheet as every other permission, never in the window: the window only relays the
     * answer main returns. Under the lock Hermes asks only when the permissions plugin is not loaded.
     */
    hermesApproval(input: unknown, slug: string): Promise<'deny' | 'once'> {
      const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
      const command = text(raw.command, 4096)
      const sessionId = text(raw.sessionId, 200) || null

      const call: PluginCall = {
        pid: 0,
        seq: 0,
        keyId: null,
        tool: 'terminal',
        target: command || text(raw.description, 500) || 'a command Hermes flagged',
        cls: 'X',
        facts: { dangerous: true },
        floor: null,
        ceilingKey: null,
        project: null,
        lineage: sessionId ? [sessionId] : [],
        agent: { inft: slug, profile: null, session_id: sessionId, subagent_id: null, task_id: null },
        reason: text(raw.description, 500) || 'Hermes flagged this command as dangerous',
        // V3-F2: recorded as Shell; Hermes' own ask stays a once-only ask at every level (contract §10).
        fns: ['shell'],
        parts: [],
        unread: true
      }

      const mode = modeFor(call)
      const asked = deps.audit.append({ ...base(call, mode), kind: 'ask', reason: call.reason })

      return askUser(call, mode, slug, asked).then(result => (result.allowed ? 'once' : 'deny'))
    },
    state(dir?: unknown): PermissionState {
      // V-2: the maintained verification (audit.ts `health`), never a walk of the whole log on a read. A record changed
      // on disk is verified again there and reads RED here exactly as the full verifier reports it.
      const chain = deps.audit.health()

      return {
        sealed: sealed(),
        unconfirmed: [...deps.store.readUnconfirmed()].sort(),
        mode: modesShown(),
        grants: deps.store.readGrants(),
        functions: deps.store.readFunctionLevels(),
        fnGrants: deps.store.readFnGrants(),
        ceilings: ceilingsFrom(deps.consent()),
        chain: {
          ok: chain.ok,
          records: chain.records,
          gaps: chain.gaps,
          // Only while the chain is being verified again from disk (RED until it is): absent otherwise.
          ...(chain.verifying ? { verifying: true } : {})
        },
        integrity: deps.store.integrity(),
        project: typeof dir === 'string' && dir.length > 0 && dir.length <= 4096 ? projectRootOf(dir) : null,
        enforcement: enforcement(),
        modeReset: [...modeResets.values()]
      }
    },
    /** For the soak and the pane: is a given spawn attested? */
    spawnState: (keyId: string) => spawnFor(keyId),
    tail: (since: number, limit?: number) => deps.audit.tail(since, limit)
  }
}

export type PermissionAuthority = ReturnType<typeof createPermissionAuthority>

/** Validates the JSON the plugin sends; anything else is dropped (the signature already proved the sender). */
const text = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : null)
const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

function parseFacts(value: unknown): ActionFacts {
  const facts = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    dangerous: flag(facts.dangerous),
    getOnly: flag(facts.getOnly),
    inProject: flag(facts.inProject),
    privileged: flag(facts.privileged)
  }
}

const fnList = (value: unknown): PermissionFunction[] =>
  Array.isArray(value) ? orderFunctions(value.slice(0, 32)) : []

/**
 * R3-MONO: the plugin's parts of a text call, each covered like a call of its own. Not an array, more than
 * PARTS_MAX, or one entry that does not parse ⇒ null (unread: no user level allows the call without an ask).
 */
function parseParts(tool: string, value: unknown): PluginPart[] | null {
  if (!Array.isArray(value) || value.length > PARTS_MAX) {
    return null
  }

  const parts: PluginPart[] = []

  for (const entry of value) {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null

    if (!raw || !isActionClass(raw.cls)) {
      return null
    }

    parts.push({
      cls: raw.cls,
      facts: parseFacts(raw.facts),
      floor: text(raw.floor, 200),
      ceilingKey: text(raw.ceilingKey, 64),
      fns: coverFunctions(tool, raw.cls, fnList(raw.fns))
    })
  }

  return parts
}

export function parsePluginCall(value: unknown): PluginCall | null {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const agent = raw?.agent && typeof raw.agent === 'object' ? (raw.agent as Record<string, unknown>) : null

  if (
    !raw ||
    !agent ||
    !Number.isInteger(raw.pid) ||
    (raw.pid as number) <= 0 ||
    !Number.isInteger(raw.seq) ||
    (raw.seq as number) <= 0 ||
    typeof raw.tool !== 'string' ||
    !isActionClass(raw.cls)
  ) {
    return null
  }

  const lineage = Array.isArray(raw.lineage)
    ? raw.lineage.filter((sid): sid is string => typeof sid === 'string' && sid.length > 0 && sid.length <= 200)
    : []

  const tool = raw.tool.slice(0, 200)
  const cls = raw.cls
  const parts = parseParts(tool, raw.parts)

  return {
    pid: raw.pid as number,
    seq: raw.seq as number,
    keyId: text(raw.keyId, 64),
    tool,
    target: text(raw.target) ?? '',
    cls,
    facts: parseFacts(raw.facts),
    floor: text(raw.floor, 200),
    ceilingKey: text(raw.ceilingKey, 64),
    project: text(raw.project),
    oneShotCwd: text(raw.oneShotCwd),
    oneFilePath: text(raw.oneFilePath),
    oneFileLink: text(raw.oneFileLink),
    ...('sessionProject' in raw ? { sessionProject: text(raw.sessionProject) } : {}),
    lineage: lineage.slice(0, LINEAGE_MAX),
    agent: {
      inft: text(agent.inft, 200),
      profile: text(agent.profile, 200),
      session_id: text(agent.session_id, 200),
      subagent_id: text(agent.subagent_id, 200),
      task_id: text(agent.task_id, 200)
    },
    reason: text(raw.reason, 500) ?? '',
    // Unknown names are dropped, the order is the fixed function order, never the plugin's; main re-applies the
    // coverage itself (R2-m1), over the union of the call's list and every part's (R3-MONO): it adds, never removes.
    fns: coverFunctions(tool, cls, [...fnList(raw.fns), ...(parts ?? []).flatMap(part => part.fns)]),
    parts,
    // R5-G: only an explicit true is the plugin's word; a plugin older than r5 never sends it ([]/null still are)
    unread: raw.unread === true
  }
}
