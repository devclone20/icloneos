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

import { F2_LOOSENING_ENABLED, levelOffered } from '../../src/iclone-shared/permissions'
import type { ConsentPermissionKey, ConsentRecord } from '../iclone-consent'
import type { DoorPermission, PermissionDoorOutcome } from '../iclone-consent-door'

import type { AuditAgent, AuditAnswer, AuditLog, AuditRecord } from './audit'
import { ceilingsFrom, type PolicyPathsInput, projectRootOf, protectedPaths, secretPaths } from './classify-policy'
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
  DEFAULT_CEILING_KEY,
  grantScopesFor,
  isActionClass,
  isPermissionMode,
  type ModeScope,
  type PermissionMode
} from './modes'
import { buildPolicyBody, type MintedSpawnKey, type PolicySigner } from './policy-file'
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
}

/** The answer to `perm ask`: decided now, or on the sheet (then `perm await <askId>`). */
type AskStart = ({ state: 'decided' } & AskResult) | { state: 'pending'; askId: string }

type AskAwait = ({ state: 'decided' } & AskResult) | { state: 'unknown' }

type SetModeRequest = { mode: PermissionMode; scope: ModeScope; key: string | null }

type SetFunctionLevelRequest = { fn: PermissionFunction; level: FunctionLevel }

type SetFunctionLevelResult =
  | { ok: true; fn: PermissionFunction; level: FunctionLevel; raised: boolean }
  | { ok: false; error: 'confirm' | 'gesture' | 'invalid'; message: string }

type SetModeResult =
  | { ok: true; mode: PermissionMode; scope: ModeScope }
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
  chain: { ok: boolean; records: number; gaps: number }
  /**
   * A-1: every permission state file that is not in force as written — refused as tampered, deleted, or unverified
   * (legacy / unsealed-written) — with what the store did about it implied by the problem (store.ts). Empty when all
   * verify or nothing was ever written. The pane shows one line per finding; ipc.ts writes one audit `gap` each at launch.
   */
  integrity: IntegrityFinding[]
  /** The project the window has open, resolved the way the plugin resolves it (git root realpath). */
  project: string | null
  enforcement: EnforcementState
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
    askPermission: (
      slug: string,
      permission: DoorPermission,
      key: ConsentPermissionKey,
      reason: string
    ) => Promise<PermissionDoorOutcome>
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
}

function parseSetMode(input: unknown): SetModeRequest | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const scope = raw.scope ?? 'standing'

  if (!isPermissionMode(raw.mode) || !['project', 'session', 'standing'].includes(scope as string)) {
    return null
  }

  const key = typeof raw.key === 'string' && raw.key.length > 0 && raw.key.length <= 4096 ? raw.key : null

  return { mode: raw.mode, scope: scope as ModeScope, key: scope === 'standing' ? null : key }
}

function parseSetFunctionLevel(input: unknown): SetFunctionLevelRequest | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  // r5 contingency: with the loosening levels off, a request for one is not a level main knows
  return isPermissionFunction(raw.fn) && isFunctionLevel(raw.level) && levelOffered(raw.level, F2_LOOSENING_ENABLED)
    ? { fn: raw.fn, level: raw.level }
    : null
}

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

export function createPermissionAuthority(deps: AuthorityDeps) {
  const now = deps.now ?? (() => new Date())

  if (typeof deps.keysSealed !== 'boolean') {
    throw new TypeError('createPermissionAuthority: keysSealed is required (the launch’s seal fact, ipc.ts)')
  }

  const sealedAtLaunch = deps.keysSealed
  const sealed = () => sealedAtLaunch
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
    const record = deps.store.readMode()

    deps.signer.publish(
      buildPolicyBody({
        // Without a sealed key nothing is wider than Manual: no standing, project or session mode, no grant.
        mode: sealed() ? record : { ...record, standing: 'manual', projects: {}, sessions: {} },
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

  const modeFor = (call: Pick<PluginCall, 'agent' | 'lineage' | 'project'>): PermissionMode =>
    sealed()
      ? deps.store.effective({ sessionId: call.agent.session_id, lineage: call.lineage, project: call.project })
      : 'manual'

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
    const scopes = sealed()
      ? call.pid > 0
        ? (fnScopes ?? grantScopesFor(call.cls)).filter(scope => scope !== 'project' || call.project)
        : (['once'] as const)
      : (['once'] as const)

    const outcome: PermissionDoorOutcome = deps.door
      ? await deps.door.askPermission(
          slug,
          {
            cls: call.cls,
            tool: call.tool,
            target: call.target,
            mode,
            project: call.project,
            session: call.agent.session_id,
            subagent: call.agent.subagent_id,
            scopes
          },
          ceilingConsentKey(call.cls, call.ceilingKey),
          call.reason
        )
      : 'busy'

    const answer: AuditAnswer =
      outcome === 'busy' || outcome === 'withdrawn' ? 'deny' : outcome === 'timeout' ? 'timeout' : outcome

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
        project: answer === 'project' ? call.project : null
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
        project: answer === 'project' ? call.project : null,
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
            : null
    })

    return answer === 'deny'
      ? {
          allowed: false,
          grantId: null,
          reason: outcome === 'busy' ? 'too many permission requests are waiting' : 'the owner denied it'
        }
      : { allowed: true, grantId, reason: `allowed (${answer})` }
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
    /** The ONLY route to mode.json. `gestureOk` is main's own verdict (gesture.ts), never the renderer's claim. */
    async setMode(input: unknown, gestureOk: boolean): Promise<SetModeResult> {
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
        return refuse('gesture', 'A permission mode changes only from your own click in icloneOS.')
      }

      if (!request) {
        return refuse('invalid', 'Unknown permission mode or scope.')
      }

      if (request.mode === 'ignore' && request.scope === 'standing') {
        return refuse('invalid', 'Ignore permissions cannot be the standing default.')
      }

      if (request.mode === 'ignore') {
        let confirmed = false

        try {
          confirmed = deps.confirmIgnore ? await deps.confirmIgnore(request) : false
        } catch {
          confirmed = false
        }

        if (!confirmed) {
          return refuse('confirm', 'Ignore permissions was not confirmed on the system dialog.')
        }
      }

      const key = request.scope === 'project' && request.key ? projectRootOf(request.key) : request.key
      const written = deps.store.writeMode(request.mode, request.scope, key)

      if (!written.ok) {
        return refuse('invalid', written.error)
      }

      deps.audit.append({
        src: 'main',
        kind: 'mode_set',
        mode: request.mode,
        scope: request.scope,
        gesture: true,
        reason: key
      })
      publish()

      return { ok: true, mode: request.mode, scope: request.scope }
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
      const record = deps.store.readMode()

      const inEffect = sealed()
        ? [record.standing, ...Object.values(record.projects), ...Object.values(record.sessions)]
        : (['manual'] as PermissionMode[])

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
      return sourced(decision, {
        ...base(decision, decision.mode),
        ...(decision.fn ? { fn: decision.fn } : {}),
        kind: decision.outcome === 'allow' ? 'use' : 'refuse',
        grant_id: decision.grantId,
        reason: decision.reason
      })
    },
    /** The plugin's ask (Q). Main decides again from its own state; only a real ask reaches the sheet. */
    ask(call: PluginCall, slug: string): AskStart {
      sweepAsks()

      const mode = modeFor(call)
      const key = callKey(call)
      const lateUntil = lateOnce.get(key)

      const grant = sealed()
        ? deps.store.matchGrant(call.cls, {
            sessionId: call.agent.session_id,
            lineage: call.lineage,
            project: call.project
          })
        : null

      const lateGrant = !!lateUntil && lateUntil > now().getTime()
      const query = { sessionId: call.agent.session_id, lineage: call.lineage, project: call.project }
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
        floor: call.floor,
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
              project: call.project
            }) !== null,
          fns: part.fns
        })),
        partsUnread: partsUnreadFor(call.tool, call.parts, call.unread),
        // R5-D (d): an unread call meets every switch
        switchesOff: Object.values(ceilingsFrom(deps.consent())).includes('off')
      })

      const fnFields = decision.fn ? { fn: decision.fn, level: decision.level } : {}

      if (decision.outcome !== 'ask') {
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

        sourced(call, {
          ...base(call, mode),
          ...fnFields,
          kind: decision.outcome === 'allow' ? 'use' : 'refuse',
          grant_id: grantId,
          reason: decision.outcome === 'refuse' ? `${decision.rule}: ${call.floor ?? refusedBy ?? mode}` : call.reason
        })

        return {
          state: 'decided',
          allowed: decision.outcome === 'allow',
          grantId,
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
      const chain = deps.audit.verify()

      return {
        sealed: sealed(),
        unconfirmed: [...deps.store.readUnconfirmed()].sort(),
        mode: deps.store.readMode(),
        grants: deps.store.readGrants(),
        functions: deps.store.readFunctionLevels(),
        fnGrants: deps.store.readFnGrants(),
        ceilings: ceilingsFrom(deps.consent()),
        chain: { ok: chain.ok, records: chain.records, gaps: chain.gaps },
        integrity: deps.store.integrity(),
        project: typeof dir === 'string' && dir.length > 0 && dir.length <= 4096 ? projectRootOf(dir) : null,
        enforcement: enforcement()
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
