/**
 * V3-F §2 — where the mode and the grants live: `userData/permissions/mode.json` and `grants.json`, 0600, atomic.
 * This module is the ONLY writer of either file, and its writers are reachable only from the gesture-checked
 * `set-mode` handler (ipc.ts) and the door's answer path — the static probes in lock.test.ts hold that.
 *
 * Review panel 2 (A-1): these files decide what the agent may do unattended, so since v0.0.3 each is AUTHENTICATED —
 * written as `{ v: 2, kid, mac, body }` with HMAC-SHA256 under the state key derived from the sealed master (keys.ts),
 * bound to the file's name. The app's code is notarized and cannot be patched unseen; before A-1 this file could be,
 * and a well-formed edit (`payments: ignore`, or the `unconfirmed` mark deleted) passed the shape check and was
 * honoured. Now, in a sealed run:
 *   - a body the key verifies is the user's choice, as written (`unconfirmed` is a required field: absent is a tamper,
 *     never "nothing pending");
 *   - a file that does not verify — edited, malformed, another key's, or `v: 2` with the mark deleted — is REFUSED and
 *     lands on the narrowest reading (Manual mode, every function Manual, no grants), reported in `integrity()` so the
 *     pane and the audit say so;
 *   - a body nobody could sign — a legacy `v: 1` file from before this version, or one written while the Keychain was
 *     off (`{ v: 2, unsealed: true, body }`) — is UNVERIFIED: the function levels are kept as the user's visible choice;
 *     with a trusted base every row the body changed to anything but Manual is pending, with none every LOOSENING
 *     row (ignore, automatic, askOnce) is (Manual in force until confirmed on the system dialog, the same price
 *     ruling 71 charges for a choice made unsealed); the mode and the grants, which have no pending notion, fall to
 *     the narrowest reading and the pane says to choose them again. Upgrade decision, see `load`.
 *   - a file that is missing while a sibling verifies was deleted (a sealed write materialises every sibling, so after
 *     the first authenticated write all four exist): refused like a tamper, never the fresh-install defaults.
 * Declared bound (panel 4, measured): with nothing verified left, the store cannot recover the user's choice for a row
 * when all four files are deleted (it reads as a fresh install, with no finding) or replaced by legacy records that
 * leave the row out (four `unverified` findings, but nothing signed to compare against). Either way the row reads the
 * shipped default — Follow mode, under the Manual mode a fresh install starts in — never wider than that default, but
 * wider than a row the user had turned off: its request asks instead of being refused. Both routes reach the same
 * bound, so pending more rows on the replace route alone closes nothing (the delete route then reaches it silently). The fix is a Keychain-held fact that a sealed write has happened, so a missing or legacy set after it reads as
 * a deletion: planned for v0.0.4.
 * In an unsealed run nothing can be verified or signed: bodies are read as the stored choice for display, and the
 * authority already keeps everything Manual in force (clampUnsealed, modeFor, publish).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  LOOSENING_LEVELS,
  type PermissionIntegrityFinding,
  type PermissionIntegrityProblem,
  type PermissionStateFile
} from '../../src/iclone-shared/permissions'
import { readJsonValidated } from '../iclone-acp-store'
import { writeFileAtomicSync } from '../lib/atomic-write'

import {
  DEFAULT_FUNCTION_LEVELS,
  type FunctionLevel,
  type FunctionLevels,
  isFunctionLevel,
  isPermissionFunction,
  normalizeLevels,
  PERMISSION_FUNCTIONS,
  type PermissionFunction
} from './functions'
import type { PermissionKeys } from './keys'
import {
  type ActionClass,
  DEFAULT_STANDING_MODE,
  effectiveMode,
  isActionClass,
  isPermissionMode,
  modeAllowedAt,
  type ModeScope,
  type PermissionMode
} from './modes'

const MODE_FILE = 'mode.json'
const GRANTS_FILE = 'grants.json'
/** V3-F2: the level of every function, and the grants given to a function (kept apart from the class grants, so
 *  neither V3-F's class matcher nor the classifier's strictest-class rule ever sees them). */
const FUNCTIONS_FILE = 'functions.json'
const FN_GRANTS_FILE = 'fn-grants.json'
/** Session-scoped modes kept on disk; the oldest leave first. */
const SESSIONS_MAX = 200
const GRANTS_MAX = 500

export interface ModeRecord {
  v: 1
  standing: PermissionMode
  projects: Record<string, PermissionMode>
  sessions: Record<string, PermissionMode>
  updatedAt: string
}

export interface Grant {
  id: string
  cls: ActionClass
  scope: ModeScope
  sessionId: string | null
  project: string | null
  createdAt: string
  source: 'hermes-allowlist' | 'prompt'
}

export interface FunctionGrant {
  id: string
  fn: PermissionFunction
  scope: ModeScope
  sessionId: string | null
  project: string | null
  createdAt: string
}

interface FunctionsRecord {
  v: 1
  levels: FunctionLevels
  /**
   * Functions whose stored level was chosen while the policy was NOT sealed, so no native confirm was ever shown for
   * it. Such a row is Manual in EVERY run, sealed or not (`PENDING_LEVEL` in authority.ts, ruling 71 / review r2
   * R2-M1), until a sealed launch confirms the level on the system dialog (review s4, M1): storing a choice is not
   * authenticating it.
   *
   * A-1: in the authenticated body this field is REQUIRED (`[]` when nothing is pending). Before, absence was the
   * normal encoding of "nothing pending", so deleting the key made every pending level read as confirmed and the
   * record stayed `v: 1` — the two states could not be told apart. Only the legacy `v: 1` file may omit it, and a
   * legacy file is never trusted as written (its pending rows act as Manual: with no signed base, the loosening ones;
   * see `readUnconfirmed`).
   */
  unconfirmed?: PermissionFunction[]
  updatedAt: string
}

const isFunctionsRecord = (value: unknown, unconfirmedRequired: boolean): value is FunctionsRecord => {
  const record = value as Record<string, unknown> | null
  const levels = record?.levels as Record<string, unknown> | null | undefined

  return (
    !!record &&
    record.v === 1 &&
    !!levels &&
    typeof levels === 'object' &&
    !Array.isArray(levels) &&
    Object.entries(levels).every(([fn, level]) => isPermissionFunction(fn) && isFunctionLevel(level)) &&
    ((record.unconfirmed === undefined && !unconfirmedRequired) ||
      (Array.isArray(record.unconfirmed) && record.unconfirmed.every(fn => isPermissionFunction(fn)))) &&
    typeof record.updatedAt === 'string'
  )
}

function isFunctionGrant(value: unknown): value is FunctionGrant {
  const grant = value as Record<string, unknown> | null

  return (
    !!grant &&
    typeof grant.id === 'string' &&
    isPermissionFunction(grant.fn) &&
    ['project', 'session', 'standing'].includes(grant.scope as string) &&
    (grant.scope !== 'session' || typeof grant.sessionId === 'string') &&
    (grant.scope !== 'project' || typeof grant.project === 'string') &&
    (grant.sessionId === null || typeof grant.sessionId === 'string') &&
    (grant.project === null || typeof grant.project === 'string') &&
    typeof grant.createdAt === 'string'
  )
}

const isFunctionGrantsRecord = (value: unknown): value is { v: 1; grants: FunctionGrant[] } =>
  !!value &&
  (value as Record<string, unknown>).v === 1 &&
  Array.isArray((value as Record<string, unknown>).grants) &&
  ((value as Record<string, unknown>).grants as unknown[]).every(isFunctionGrant)

interface GrantsRecord {
  v: 1
  grants: Grant[]
}

const isModeMap = (value: unknown): value is Record<string, PermissionMode> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.entries(value as Record<string, unknown>).every(([key, mode]) => key.length > 0 && isPermissionMode(mode))

function isModeRecord(value: unknown): value is ModeRecord {
  const record = value as Record<string, unknown> | null

  return (
    !!record &&
    record.v === 1 &&
    isPermissionMode(record.standing) &&
    modeAllowedAt(record.standing, 'standing') &&
    isModeMap(record.projects) &&
    isModeMap(record.sessions) &&
    typeof record.updatedAt === 'string'
  )
}

function isGrant(value: unknown): value is Grant {
  const grant = value as Record<string, unknown> | null

  return (
    !!grant &&
    typeof grant.id === 'string' &&
    isActionClass(grant.cls) &&
    grant.cls !== '$' &&
    ['project', 'session', 'standing'].includes(grant.scope as string) &&
    (grant.sessionId === null || typeof grant.sessionId === 'string') &&
    (grant.project === null || typeof grant.project === 'string') &&
    (grant.scope !== 'session' || typeof grant.sessionId === 'string') &&
    (grant.scope !== 'project' || typeof grant.project === 'string') &&
    typeof grant.createdAt === 'string' &&
    (grant.source === 'prompt' || grant.source === 'hermes-allowlist')
  )
}

const isGrantsRecord = (value: unknown): value is GrantsRecord =>
  !!value &&
  (value as Record<string, unknown>).v === 1 &&
  Array.isArray((value as Record<string, unknown>).grants) &&
  ((value as Record<string, unknown>).grants as unknown[]).every(isGrant)

interface ModeQuery {
  sessionId?: string | null
  /** The session, then its parents to the root (§2: delegated and compressed sessions inherit the parent's mode). */
  lineage?: readonly string[] | null
  project?: string | null
}

const sessionChain = (query: ModeQuery): string[] => {
  const chain = (query.lineage ?? []).filter(sid => typeof sid === 'string' && sid.length > 0)

  return chain.length > 0 ? chain : query.sessionId ? [query.sessionId] : []
}

type SetModeResult = { ok: true; record: ModeRecord } | { ok: false; error: string }

/** The four state files, by role (the pane and the audit name them this way, never by path). Shared with the window. */
export type StateFile = PermissionStateFile

/**
 * Why a state file is not in force as written (sealed run):
 *  - `tampered`: present but refused — it does not verify under this launch's key, or does not parse / fit its shape;
 *  - `unverified`: a body nobody could sign (legacy `v: 1`, or written while the Keychain was off) that this launch
 *    could not verify; kept as a visible choice where that is safe (function levels, as pending), else dropped;
 *  - `missing`: absent while a sibling verifies, so it was deleted (every sealed write materialises all four).
 */
export type IntegrityProblem = PermissionIntegrityProblem

export type IntegrityFinding = PermissionIntegrityFinding

/** What the store needs of the launch's keys (keys.ts): required, no default — a missing seal fact never reads as sealed. */
export type StoreKeys = Pick<PermissionKeys, 'kid' | 'sealed' | 'stateKey'>

const STATE_FILES: Record<StateFile, string> = {
  mode: MODE_FILE,
  grants: GRANTS_FILE,
  functions: FUNCTIONS_FILE,
  fnGrants: FN_GRANTS_FILE
}

/** The narrowest mode record: Manual everywhere, nothing per project or session (also the fresh-install record). */
const NARROWEST_MODE = (): ModeRecord => ({
  v: 1,
  standing: DEFAULT_STANDING_MODE,
  projects: {},
  sessions: {},
  updatedAt: new Date(0).toISOString()
})

/** Every function Manual: what a refused functions.json lands on. Narrower than the shipped `mode` default. */
const ALL_MANUAL: Readonly<FunctionLevels> = Object.freeze(
  Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'manual' as FunctionLevel])) as FunctionLevels
)

/** The MAC covers the file's role and the body's exact serialization: one file's body cannot stand in for another's. */
const stateMac = (key: Buffer, file: StateFile, bodyText: string) =>
  createHmac('sha256', key).update(`${file}\n`).update(bodyText).digest('hex')

const sameHex = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

type Loaded<T> =
  /** A sealed run, and the body verifies under this launch's key: the user's choice as written. */
  | { state: 'verified'; body: T }
  /**
   * The body parses and fits, but no key proves it: an unsealed run; or, in a sealed run, a legacy `v: 1` file or
   * one written while the Keychain was off. The latter carries the last sealed envelope it replaced as `prior`; when
   * that verifies here it is the trusted base and the body is the user's unsealed overlay on it.
   */
  | { state: 'unverified'; body: T; prior: T | null }
  | { state: 'absent' }
  /** Present and not to be honoured: bad MAC or another key's, `v: 2` with a body that does not fit, not JSON. */
  | { state: 'refused' }

const envelopeOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

type Shape<T> = (value: unknown, authenticated: boolean) => value is T

export function createPermissionStore(dir: string, keys: StoreKeys, now: () => Date = () => new Date()) {
  if (!keys || typeof keys.sealed !== 'boolean' || !Buffer.isBuffer(keys.stateKey) || typeof keys.kid !== 'string') {
    throw new TypeError('createPermissionStore: the launch’s keys are required (keys.ts, through ipc.ts)')
  }

  const fileOf = (file: StateFile) => path.join(dir, STATE_FILES[file])

  /** A sealed envelope's body when it verifies under this launch's key and fits; null otherwise. */
  const verifiedBody = <T>(file: StateFile, envelope: Record<string, unknown>, valid: Shape<T>): T | null =>
    envelope.v === 2 &&
    typeof envelope.kid === 'string' &&
    typeof envelope.mac === 'string' &&
    envelope.kid === keys.kid &&
    valid(envelope.body, true) &&
    sameHex(envelope.mac, stateMac(keys.stateKey, file, JSON.stringify(envelope.body)))
      ? envelope.body
      : null

  /**
   * Reads one state file. The upgrade decision lives here (A-1): an install from before this version holds flat `v: 1`
   * files nobody signed. They are neither accepted once — any later tamper could be dressed as a legacy file and
   * accepted the same way, reopening the hole — nor refused outright, which would throw away every upgrading user's
   * choices for nothing. They are UNVERIFIED with no trusted base: the one stateless rule that holds at every launch,
   * so a `v: 1` file planted later is never wider than the shipped default either. What unverified means per file is
   * decided by the readers below: function levels are kept as the visible choice, with every LOOSENING level pending
   * (the user confirms each once on the system dialog — what ruling 71 already asks of a choice made with the Keychain
   * off) and Manual / Follow mode / Ask always honoured, since none is wider than the shipped default; the mode and the
   * grants have no pending notion, so they fall to the narrowest reading and the pane says to choose again. The first
   * sealed write re-signs every unverified sibling with exactly that reading, so the choices become trusted (pending
   * marks included) and from then on a non-verified file next to a verified one is a downgrade, refused (`read`).
   * The authenticated history that could re-sign them without a click — the audit chain — is a second trust path with
   * its own failure modes, on the release's critical path; it is the global-plan alternative, not this fix.
   */
  const load = <T>(file: StateFile, valid: Shape<T>): Loaded<T> => {
    const target = fileOf(file)

    if (!existsSync(target)) {
      return { state: 'absent' }
    }

    const envelope = envelopeOf(readJsonValidated(target, (value): value is unknown => value !== undefined))

    if (!envelope) {
      return { state: 'refused' }
    }

    // A legacy flat record (before A-1): unverified, never refused for its age alone — but it must fit its shape.
    if (envelope.v === 1) {
      return valid(envelope, false) ? { state: 'unverified', body: envelope, prior: null } : { state: 'refused' }
    }

    if (envelope.v !== 2 || !valid(envelope.body, true)) {
      return { state: 'refused' }
    }

    // Written while the Keychain was off: honestly marked, nobody could sign it. It carries the sealed envelope it
    // replaced, if any; a `prior` that is present but does not verify here is a tamper, not a base.
    if (envelope.unsealed === true && envelope.kid === undefined && envelope.mac === undefined) {
      if (envelope.prior === undefined || !keys.sealed) {
        return { state: 'unverified', body: envelope.body, prior: null }
      }

      const prior = envelopeOf(envelope.prior)
      const base = prior ? verifiedBody(file, prior, valid) : null

      return base ? { state: 'unverified', body: envelope.body, prior: base } : { state: 'refused' }
    }

    if (typeof envelope.kid !== 'string' || typeof envelope.mac !== 'string') {
      return { state: 'refused' }
    }

    // This run has no key to check with: the body is the stored choice for display; nothing is in force wider than
    // Manual anyway (authority.ts clamps every unsealed run).
    if (!keys.sealed) {
      return { state: 'unverified', body: envelope.body, prior: null }
    }

    const body = verifiedBody(file, envelope, valid)

    return body ? { state: 'verified', body } : { state: 'refused' }
  }

  const loadMode = () => load('mode', isModeRecord)
  const loadGrants = () => load('grants', isGrantsRecord)

  const loadFunctions = () =>
    load('functions', (value, authenticated): value is FunctionsRecord => isFunctionsRecord(value, authenticated))

  const loadFnGrants = () => load('fnGrants', isFunctionGrantsRecord)

  const loaders: Record<StateFile, () => Loaded<unknown>> = {
    mode: loadMode,
    grants: loadGrants,
    functions: loadFunctions,
    fnGrants: loadFnGrants
  }

  /** Something verified under this key ⇒ the store has written here ⇒ every sibling exists and verifies, or was replaced. */
  const anyVerified = (except: StateFile): boolean =>
    (Object.keys(loaders) as StateFile[]).some(file => file !== except && loaders[file]().state === 'verified')

  /**
   * One file's reading next to its siblings: absent, or unverified with no trusted base, beside a verified file is a
   * deletion or a downgrade (a sealed write leaves all four verified), refused like a tamper. An unsealed write over a
   * verified file carries that file as `prior`, so it keeps its base and is not a downgrade.
   */
  const read = <T>(file: StateFile, loaded: Loaded<T>): Loaded<T> =>
    (loaded.state === 'absent' || (loaded.state === 'unverified' && loaded.prior === null && keys.sealed)) &&
    anyVerified(file)
      ? { state: 'refused' }
      : loaded

  // A refused mode file is the narrowest record: Manual, nothing per project or session (a fresh install reads the
  // same). A verified one is the user's. Unverified: in an unsealed run it is shown as stored (the authority publishes
  // Manual then); in a sealed run its trusted base is in force when it has one, else the narrowest record — an
  // unproven mode never goes in force (unlike a function level, a mode has no pending reading to keep it visible).
  const readMode = (): ModeRecord => {
    const loaded = read('mode', loadMode())

    if (loaded.state === 'verified') {
      return loaded.body
    }

    if (loaded.state === 'unverified') {
      return keys.sealed ? (loaded.prior ?? NARROWEST_MODE()) : loaded.body
    }

    return NARROWEST_MODE()
  }

  // Grants: verified as written; unverified with a base ⇒ the base minus what the overlay revoked (a revoke made
  // unsealed narrows, so it is honoured; an addition could not have been made unsealed and is dropped); unverified
  // without a base ⇒ none in force in a sealed run, the stored list for display in an unsealed one; refused ⇒ none.
  const readGrantList = <G extends { id: string }>(file: StateFile, loaded: Loaded<{ grants: G[] }>): G[] => {
    if (loaded.state === 'verified') {
      return loaded.body.grants
    }

    if (loaded.state === 'unverified') {
      if (!keys.sealed) {
        return loaded.body.grants
      }

      const overlay = new Set(loaded.body.grants.map(grant => grant.id))

      return loaded.prior ? loaded.prior.grants.filter(grant => overlay.has(grant.id)) : []
    }

    return []
  }

  const readGrants = (): Grant[] => readGrantList('grants', read('grants', loadGrants()))

  const readFnGrants = (): FunctionGrant[] => readGrantList('fnGrants', read('fnGrants', loadFnGrants()))

  // The function levels. Verified: as written. Unverified: the stored choice, kept visible — in a sealed run every
  // level that could be wider than what the user had is pending (readUnconfirmed), so nothing unproven is in force;
  // in an unsealed run the authority clamps. Refused (tampered, deleted or downgraded beside a verified sibling):
  // every function Manual — narrower than the shipped `mode` default, which under an Automatic mode would be wider
  // than what the user may have had.
  const readFunctionLevels = (): FunctionLevels => {
    const loaded = read('functions', loadFunctions())

    if (loaded.state === 'refused') {
      return { ...ALL_MANUAL }
    }

    return normalizeLevels(loaded.state === 'absent' ? DEFAULT_FUNCTION_LEVELS : loaded.body.levels)
  }

  /**
   * The functions whose stored level is not confirmed on the system dialog (see FunctionsRecord.unconfirmed). Verified:
   * the recorded mark. Unverified in a sealed run — the recorded mark (a mark only narrows, so an unsigned one is
   * kept) PLUS, with a trusted base, every row the overlay changed to anything but Manual (the base's own marks hold
   * for the rows it left alone); with no base, every row at a loosening level (ignore, automatic, askOnce): Manual,
   * Follow mode and Ask always are never wider than the shipped default, while a loosening level nobody signed stays
   * Manual until the user confirms it once. Never wider than the default is not never wider than the user's choice: a
   * row the user turned off reads Follow mode when a legacy body leaves it out — the declared bound in the header,
   * which deleting all four files reaches too. An unsealed run keeps the recorded mark: it cannot verify anything, and
   * everything is Manual in force regardless.
   */
  const readUnconfirmed = (): ReadonlySet<PermissionFunction> => {
    const loaded = read('functions', loadFunctions())

    if (loaded.state === 'absent' || loaded.state === 'refused') {
      return new Set()
    }

    const pending = new Set<PermissionFunction>(loaded.body.unconfirmed ?? [])

    if (loaded.state === 'verified' || !keys.sealed) {
      return pending
    }

    const levels = normalizeLevels(loaded.body.levels)
    const base = loaded.prior ? normalizeLevels(loaded.prior.levels) : null
    const baseMarks = new Set(loaded.prior?.unconfirmed ?? [])

    for (const fn of PERMISSION_FUNCTIONS) {
      const unproven = base
        ? levels[fn] === base[fn]
          ? baseMarks.has(fn)
          : levels[fn] !== 'manual'
        : LOOSENING_LEVELS.includes(levels[fn])

      if (unproven) {
        pending.add(fn)
      }
    }

    return pending
  }

  /** The body a sealed write signs for a sibling that is absent (its narrowest) or unverified (its current reading). */
  const readingBody = (file: StateFile): unknown => {
    switch (file) {
      case 'mode':
        return readMode()

      case 'functions':
        return {
          v: 1,
          levels: readFunctionLevels(),
          unconfirmed: [...readUnconfirmed()].sort(),
          updatedAt: now().toISOString()
        }

      case 'grants':
        return { v: 1, grants: readGrants() }

      case 'fnGrants':
        return { v: 1, grants: readFnGrants() }
    }
  }

  /** The sealed envelope an unsealed write must carry forward: the file's own, or the one it already carries. */
  const priorEnvelope = (file: StateFile): unknown => {
    if (!existsSync(fileOf(file))) {
      return undefined
    }

    const envelope = envelopeOf(readJsonValidated(fileOf(file), (value): value is unknown => value !== undefined))

    if (!envelope || envelope.v !== 2) {
      return undefined
    }

    return envelope.unsealed === true ? envelope.prior : envelope
  }

  const writeEnvelope = (file: StateFile, body: unknown) => {
    const prior = keys.sealed ? undefined : priorEnvelope(file)

    const envelope = keys.sealed
      ? { v: 2, kid: keys.kid, mac: stateMac(keys.stateKey, file, JSON.stringify(body)), body }
      : // Nobody can sign in an unsealed run: say so, and carry the last sealed envelope so the next sealed launch
        // keeps its trusted base and makes pending only what changed here (ruling 71).
        { v: 2, unsealed: true, body, ...(prior === undefined ? {} : { prior }) }

    writeFileAtomicSync(fileOf(file), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * The one writer. A sealed write also re-signs every sibling that is ABSENT (its narrowest body) or UNVERIFIED (its
   * current reading, pending marks included — the choices become trusted), read BEFORE this write lands so the
   * downgrade rule does not see them beside a fresh verified file. From then on all four exist and verify, and an
   * absent or unsigned one is a deletion or a downgrade (`read`). A refused sibling is left as it is: visible in
   * `integrity()` until the user touches that file's own writer, never healed by an unrelated click. An unsealed
   * write touches nothing but its own file.
   */
  const save = (file: StateFile, body: unknown) => {
    const resign: [StateFile, unknown][] = []

    if (keys.sealed) {
      for (const sibling of Object.keys(loaders) as StateFile[]) {
        const state = sibling === file ? 'verified' : loaders[sibling]().state

        if (state === 'absent' || state === 'unverified') {
          resign.push([sibling, readingBody(sibling)])
        }
      }
    }

    writeEnvelope(file, body)

    for (const [sibling, siblingBody] of resign) {
      writeEnvelope(sibling, siblingBody)
    }
  }

  /**
   * Every state file not in force as written, for the pane and the launch audit (empty: all verified or fresh).
   * Unverified with a trusted base is reported only when something the overlay says is not in force: a mode that
   * differs from the base, a grant the base does not have; a function row the overlay changed is already shown
   * pending by the matrix, which is the honest reading of that file.
   */
  const integrity = (): IntegrityFinding[] => {
    const findings: IntegrityFinding[] = []

    for (const file of Object.keys(loaders) as StateFile[]) {
      const loaded = read(file, loaders[file]())

      if (loaded.state === 'refused') {
        findings.push({ file, problem: existsSync(fileOf(file)) ? 'tampered' : 'missing' })
      } else if (loaded.state === 'unverified' && keys.sealed) {
        if (loaded.prior === null) {
          findings.push({ file, problem: 'unverified' })
        } else if (file === 'mode') {
          const { updatedAt: _a, ...overlay } = loaded.body as ModeRecord
          const { updatedAt: _b, ...base } = loaded.prior as ModeRecord

          if (JSON.stringify(overlay) !== JSON.stringify(base)) {
            findings.push({ file, problem: 'unverified' })
          }
        } else if (file === 'grants' || file === 'fnGrants') {
          const base = new Set((loaded.prior as { grants: { id: string }[] }).grants.map(grant => grant.id))

          if ((loaded.body as { grants: { id: string }[] }).grants.some(grant => !base.has(grant.id))) {
            findings.push({ file, problem: 'unverified' })
          }
        }
      }
    }

    return findings
  }

  return {
    readMode,
    readGrants,
    readFunctionLevels,
    readUnconfirmed,
    readFnGrants,
    integrity,
    /**
     * The one writer of functions.json. Caller: authority.setFunctionLevel, after its raise/lower checks. `unconfirmed`
     * marks a level stored without the native confirm (an unsealed run); any other write clears the mark for `fn`.
     * The mark is always written, `[]` included (A-1: absence is not an encoding of "nothing pending" any more).
     */
    writeFunctionLevel(fn: PermissionFunction, level: FunctionLevel, unconfirmed = false): FunctionLevels {
      const levels = { ...readFunctionLevels(), [fn]: level }
      const pending = new Set(readUnconfirmed())

      if (unconfirmed) {
        pending.add(fn)
      } else {
        pending.delete(fn)
      }

      save('functions', {
        v: 1,
        levels,
        unconfirmed: [...pending].sort(),
        updatedAt: now().toISOString()
      })

      return levels
    },
    addFnGrant(input: Omit<FunctionGrant, 'createdAt' | 'id'>): FunctionGrant {
      const grant: FunctionGrant = { ...input, id: `fg-${randomUUID()}`, createdAt: now().toISOString() }

      save('fnGrants', { v: 1, grants: [...readFnGrants(), grant].slice(-GRANTS_MAX) })

      return grant
    },
    /** Revokes one function grant by id, or every grant of `fn` (a level change starts that function fresh). */
    revokeFnGrants(match: { id: string } | { fn: PermissionFunction }): FunctionGrant[] {
      const grants = readFnGrants()
      const gone = grants.filter(grant => ('id' in match ? grant.id === match.id : grant.fn === match.fn))

      if (gone.length > 0) {
        save('fnGrants', { v: 1, grants: grants.filter(grant => !gone.includes(grant)) })
      }

      return gone
    },
    /** The live grant for this function here, if any — narrowest scope first (same rule as the class grants). */
    matchFnGrant(fn: PermissionFunction, query: ModeQuery): FunctionGrant | null {
      const grants = readFnGrants().filter(grant => grant.fn === fn)
      const chain = sessionChain(query)

      return (
        grants.find(grant => grant.scope === 'session' && !!grant.sessionId && chain.includes(grant.sessionId)) ??
        grants.find(grant => grant.scope === 'project' && !!query.project && grant.project === query.project) ??
        grants.find(grant => grant.scope === 'standing') ??
        null
      )
    },
    effective(query: ModeQuery): PermissionMode {
      const record = readMode()
      const session = sessionChain(query).find(sid => Object.hasOwn(record.sessions, sid))

      return effectiveMode({
        standing: record.standing,
        project: query.project && Object.hasOwn(record.projects, query.project) ? record.projects[query.project] : null,
        session: session ? record.sessions[session] : null
      })
    },
    /** The one writer of mode.json. Callers: ipc.ts `set-mode`, after the gesture lock, and nothing else. */
    writeMode(mode: PermissionMode, scope: ModeScope, key: string | null): SetModeResult {
      if (!modeAllowedAt(mode, scope)) {
        return { ok: false, error: 'Ignore permissions cannot be the standing default.' }
      }

      if (scope !== 'standing' && !key) {
        return { ok: false, error: `A ${scope} mode needs the ${scope} it applies to.` }
      }

      const record = readMode()
      const next: ModeRecord = { ...record, updatedAt: now().toISOString() }

      if (scope === 'standing') {
        next.standing = mode
      } else if (scope === 'project') {
        next.projects = { ...record.projects, [key as string]: mode }
      } else {
        const sessions = Object.entries({ ...record.sessions, [key as string]: mode })

        next.sessions = Object.fromEntries(sessions.slice(-SESSIONS_MAX))
      }

      save('mode', next)

      return { ok: true, record: next }
    },
    addGrant(input: Omit<Grant, 'createdAt' | 'id'>): Grant {
      const grant: Grant = { ...input, id: `g-${randomUUID()}`, createdAt: now().toISOString() }

      save('grants', { v: 1, grants: [...readGrants(), grant].slice(-GRANTS_MAX) })

      return grant
    },
    revokeGrant(id: string): Grant | null {
      const grants = readGrants()
      const found = grants.find(grant => grant.id === id) ?? null

      if (found) {
        save('grants', { v: 1, grants: grants.filter(grant => grant.id !== id) })
      }

      return found
    },
    /** The live grant covering this class here, if any — narrowest scope first. */
    matchGrant(cls: ActionClass, query: ModeQuery): Grant | null {
      const grants = readGrants().filter(grant => grant.cls === cls)
      const chain = sessionChain(query)

      return (
        grants.find(grant => grant.scope === 'session' && !!grant.sessionId && chain.includes(grant.sessionId)) ??
        grants.find(grant => grant.scope === 'project' && !!query.project && grant.project === query.project) ??
        grants.find(grant => grant.scope === 'standing') ??
        null
      )
    }
  }
}

export type PermissionStore = ReturnType<typeof createPermissionStore>
