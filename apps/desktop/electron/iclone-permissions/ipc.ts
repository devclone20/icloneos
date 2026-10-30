/**
 * V3-F — the renderer's door to the permission authority, and the spawn seam for Hermes. Every channel passes the app
 * sender guard (P7, required — a missing guard refuses); the two that change anything (`set-mode`, `revoke`) also need
 * main's own gesture verdict for THAT sender. `state` and `tail` are the derived views V3-A and V3-G read (§5) —
 * folded from the files on every call, never a cached counter.
 *
 * A Hermes spawn gets its key on an inherited pipe (fd 3), never in env or argv (critic F-2), and the policy lock in
 * the env main passes — which the child reads from its exec-time copy, so `$HERMES_HOME/.env` cannot undo it (F-4).
 * The lock is set even while the authority is not up: the plugin then has no key, runs Manual and is refused (F-7).
 */
import path from 'node:path'

import type { ConsentSenderGuard } from '../iclone-consent'
import { guardedHandler } from '../iclone-consent'
import type { ConsentRecord } from '../iclone-consent'
import type { ConsentDoor } from '../iclone-consent-door'
import { BUNDLED_REGISTRY } from '../iclone-ownership-registry'

import { type AuditAgent, type AuditLog, type AuditRecord, createAuditLog } from './audit'
import { createPermissionAuthority, type PermissionAuthority } from './authority'
import type { PolicyPathsInput } from './classify-policy'
import type { FunctionLevel, PermissionFunction } from './functions'
import { gestureOf, permissionGestureOk } from './gesture'
import { type KeySealer, loadPermissionKeys } from './keys'
import { createPolicySigner, type PolicySigner } from './policy-file'
import { createPermissionStore, type IntegrityFinding } from './store'

const PERMISSIONS_DIR = 'permissions'
const SPAWN_CHECK_MS = 2_000
/** The child's fd that carries its key: stdio[3]. */
const PERMISSIONS_KEY_FD = 3

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

interface RegisterPermissionsDeps {
  ipcMain: IpcMainLike
  isTrustedSender: ConsentSenderGuard
  userDataDir: string
  paths: Omit<PolicyPathsInput, 'userDataDir'>
  door: ConsentDoor | null
  consent: () => ConsentRecord | null
  /** When main last saw real input reach this IPC sender (`lastTrustedInputAt(event.sender)`). */
  lastInputAt: (event: unknown) => number
  /** The OS sealing of the master key (safeStorage). Null ⇒ the authority runs Manual only. */
  sealer: KeySealer | null
  /** Main's native dialog for the Ignore permissions second confirm. */
  confirmIgnore: (request: { scope: string; key: string | null }) => Promise<boolean>
  /** V3-F2: main's native old → new confirm for raising a function's level. */
  confirmFunctionRaise?: (request: {
    fn: PermissionFunction
    from: FunctionLevel
    to: FunctionLevel
  }) => Promise<boolean>
  /** Pushes every new audit record to the app windows (Settings › Agent › Permissions, V3-A). */
  broadcast?: (seq: number) => void
}

let active: { authority: PermissionAuthority; signer: PolicySigner; audit: AuditLog } | null = null

const INTEGRITY_FILE_NAMES: Record<IntegrityFinding['file'], string> = {
  mode: 'the permission mode',
  functions: 'the function levels',
  grants: 'the permissions given',
  fnGrants: 'the function permissions given'
}

const INTEGRITY_EFFECTS: Record<IntegrityFinding['file'], string> = {
  mode: 'Manual everywhere until a mode is chosen again',
  functions: 'every function is Manual until chosen again',
  grants: 'none is in force',
  fnGrants: 'none is in force'
}

/** One audit line per state file not in force as written (store.ts `integrity`), written once per launch. */
export function integrityGapReason(finding: IntegrityFinding): string {
  const what = INTEGRITY_FILE_NAMES[finding.file]

  // An unverified functions file keeps its levels as a visible choice; only its pending rows are held at Manual — with
  // no signed base the loosening ones, with one every row it changed (store.ts readUnconfirmed).
  const effect =
    finding.file === 'functions' && finding.problem === 'unverified'
      ? 'its pending levels are Manual until confirmed on the system dialog'
      : INTEGRITY_EFFECTS[finding.file]

  const cause =
    finding.problem === 'tampered'
      ? 'was changed or damaged outside icloneOS and is not in force'
      : finding.problem === 'missing'
        ? 'is missing from disk'
        : 'was saved by an earlier version or while the Keychain was off and could not be verified'

  return `permission state integrity: ${what} ${cause}: ${effect}`
}

export function registerPermissions(deps: RegisterPermissionsDeps): PermissionAuthority {
  const dir = path.join(deps.userDataDir, PERMISSIONS_DIR)
  const keys = loadPermissionKeys(dir, deps.sealer)

  const audit = createAuditLog({
    dir: path.join(dir, 'audit'),
    key: keys.auditKey,
    kid: keys.kid,
    expectExisting: keys.status === 'sealed'
  })

  const signer = createPolicySigner(dir, keys)
  // A-1: the state files are authenticated under the launch's state key (store.ts); the store refuses to start without
  // the seal fact, as the authority does (R2-M4).
  const store = createPermissionStore(dir, keys)

  const authority = createPermissionAuthority({
    store,
    audit,
    signer,
    door: deps.door,
    consent: deps.consent,
    paths: { ...deps.paths, userDataDir: deps.userDataDir },
    guardPids: [process.pid],
    inftContracts: BUNDLED_REGISTRY.entries.map(entry => entry.contract),
    confirmIgnore: deps.confirmIgnore,
    confirmFunctionRaise: deps.confirmFunctionRaise,
    // Fixed for this launch: the master is loaded once above, so a Keychain switch turned on since launch takes effect
    // at the next launch (Settings › Permissions: "Restart now"). Review s4, M2.
    keysSealed: keys.sealed
  })

  audit.append({ src: 'main', kind: 'restart', reason: `main pid ${process.pid}` })

  if (!keys.sealed) {
    audit.append({
      src: 'main',
      kind: 'gap',
      reason:
        'the audit key could not be sealed by the system keychain: Manual only, and records cannot be authenticated after a restart'
    })
  }

  // A-1: a state file refused, deleted or unverified at launch is said in the record too, not only in the pane. The
  // reason names the file by role and what is in force instead; it never starts with `audit integrity:` (that prefix
  // is the chain's own anchor break, audit.ts) — it is a finding about the state, recorded in a chain that verifies.
  for (const finding of store.integrity()) {
    audit.append({ src: 'main', kind: 'gap', reason: integrityGapReason(finding) })
  }

  audit.onRecord(record => deps.broadcast?.(record.seq_main))
  authority.publish()
  active = { authority, signer, audit }
  setInterval(() => authority.checkSpawns(), SPAWN_CHECK_MS).unref()

  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  const gesture = (event: unknown, input: unknown) =>
    permissionGestureOk({ payload: gestureOf(input), lastInputAt: deps.lastInputAt(event), now: Date.now() })

  ipcMain.handle('iclone:permissions:set-mode', (event, input) => authority.setMode(input, gesture(event, input)))
  ipcMain.handle('iclone:permissions:set-function-level', (event, input) =>
    authority.setFunctionLevel(input, gesture(event, input))
  )
  ipcMain.handle('iclone:permissions:revoke', (event, input) =>
    authority.revoke((input as Record<string, unknown> | null)?.id, gesture(event, input))
  )
  ipcMain.handle('iclone:permissions:hermes-approval', (_event, input) => authority.hermesApproval(input, 'agent'))
  ipcMain.handle('iclone:permissions:state', (_event, input) =>
    authority.state((input as Record<string, unknown> | null)?.dir)
  )
  ipcMain.handle('iclone:permissions:tail', (_event, input) => {
    const since = Number((input as Record<string, unknown> | null)?.since ?? 0)

    return authority.tail(Number.isFinite(since) && since >= 0 ? since : 0, 200)
  })

  return authority
}

interface SpawnedChild {
  pid?: number | undefined
  once(event: 'exit', listener: () => void): unknown
}

/** What one Hermes spawn needs from the permission authority. */
interface PermissionsSpawn {
  /** Merged into the child's env: the lock, where its policy and the agent socket are, which fd has its key. */
  env: Record<string, string>
  /** Written to the child's fd 3 right after spawn, then the pipe is closed. Null: no key (the gate runs Manual). */
  keyLine: string | null
  /** Tells main which pid holds the key (its hello must match) and retires the key when the child exits. */
  attach: (child: SpawnedChild) => void
}

export function permissionsSpawn(socketDir: string): PermissionsSpawn {
  const env: Record<string, string> = {
    ICLONE_POLICY_LOCK: '1',
    ICLONE_POLICY_KEY_FD: String(PERMISSIONS_KEY_FD),
    ICLONE_POLICY_KEY_PPID: String(process.pid),
    ICLONE_PERM_SOCKET: path.join(socketDir, 'acp.sock'),
    ICLONE_PERM_TOKEN_FILE: path.join(socketDir, 'acp.token')
  }

  if (!active) {
    return { env, keyLine: null, attach: () => undefined }
  }

  const authority = active.authority
  const minted = authority.mintSpawnKey()

  return {
    env: { ...env, ICLONE_POLICY_FILE: minted.file },
    keyLine: `v1 ${minted.keyId} ${minted.key.toString('hex')}\n`,
    attach: child => {
      authority.spawned(minted.keyId, child.pid ?? null)
      child.once('exit', () => authority.exited(minted.keyId))
    }
  }
}

/** For the agent socket's `perm` verb. */
export function activePermissions(): { authority: PermissionAuthority | null; signer: PolicySigner | null } {
  return { authority: active?.authority ?? null, signer: active?.signer ?? null }
}

/** Re-signs the policy when something it folds in changed outside this module (a consent switch). */
export function republishPermissions(): void {
  active?.authority.publish()
}

/** What another front may record in the permission audit (never a mode, grant or answer: those are main's own). */
const FOREIGN_KINDS = ['gap', 'refuse', 'timeout', 'use'] as const

interface ForeignAuditEntry {
  kind: (typeof FOREIGN_KINDS)[number]
  reason: string
  hermes_pid?: number | null
  class?: AuditRecord['class']
  action?: AuditRecord['action']
  agent?: AuditAgent | null
}

function recordFrom(src: 'confinement' | 'payment' | 'watchdog', entry: ForeignAuditEntry): AuditRecord | null {
  if (!active || !(FOREIGN_KINDS as readonly string[]).includes(entry.kind) || typeof entry.reason !== 'string') {
    return null
  }

  return active.audit.append({
    src,
    kind: entry.kind,
    reason: entry.reason,
    hermes_pid: entry.hermes_pid ?? null,
    class: entry.class ?? null,
    action: entry.action ?? null,
    agent: entry.agent ?? null
  })
}

/**
 * V3-I: the acp watchdog's records, in the same hash-chained, HMAC'd log (src `watchdog`), written by main's one
 * writer. Null when the authority is not up or the entry is not a kind another front may write.
 */
export function recordWatchdog(entry: ForeignAuditEntry): AuditRecord | null {
  return recordFrom('watchdog', entry)
}

/** V3-G: a confinement refusal (src `confinement`), joined to tool calls by `agent.session_id` / `hermes_pid`. */
export function recordConfinement(entry: ForeignAuditEntry): AuditRecord | null {
  return recordFrom('confinement', entry)
}

/** V3-J: a payment decision (src `payment`, class `$`), named by the agent's profile slug ('' = nobody). */
export function recordPayment(
  entry: Pick<ForeignAuditEntry, 'kind' | 'reason'> & { agent: string }
): AuditRecord | null {
  const profile = typeof entry.agent === 'string' && entry.agent ? entry.agent : null
  const agent = profile ? { inft: null, profile, session_id: null, subagent_id: null, task_id: null } : null

  return recordFrom('payment', { kind: entry.kind, reason: entry.reason, class: '$', agent })
}

/**
 * REL-6: the ACP tools install (src `install`, class `I`). The owner's request with main's gesture verdict (a request
 * without one is recorded as refused), the outcome, and every refusal of a tree that does not verify. Null when the
 * authority is not up: the installer then refuses to install at all (iclone-acp-tools/ipc.ts `requestInstall`).
 */
export function recordInstall(entry: { kind: 'refuse' | 'use'; reason: string; gesture: boolean }): AuditRecord | null {
  if (!active || (entry.kind !== 'refuse' && entry.kind !== 'use') || typeof entry.reason !== 'string') {
    return null
  }

  return active.audit.append({
    src: 'install',
    kind: entry.kind,
    class: 'I',
    reason: entry.reason,
    gesture: entry.gesture === true,
    action: { tool: 'acp-tools.install', target: 'https://registry.npmjs.org/', project_root: null }
  })
}
