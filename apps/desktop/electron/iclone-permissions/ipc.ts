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
import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { currentConfinement } from '../iclone-confinement'
import { pnpmStoreRoots } from '../iclone-confinement/hardlinks'
import { gitRootOf } from '../iclone-confinement/launcher-policy'
import { execOnBehalfWrites, projectRootRefusal } from '../iclone-confinement/profiles'
import type { ConsentSenderGuard } from '../iclone-consent'
import { guardedHandler } from '../iclone-consent'
import type { ConsentRecord } from '../iclone-consent'
import type { ConsentDoor } from '../iclone-consent-door'
import { BUNDLED_REGISTRY } from '../iclone-ownership-registry'

import { type AuditAgent, type AuditLog, type AuditRecord, createAuditLog } from './audit'
import { createPermissionAuthority, type PermissionAuthority } from './authority'
import { type PolicyPathsInput, projectRootOf } from './classify-policy'
import type { FunctionLevel, PermissionFunction } from './functions'
import { gestureOf, permissionGestureOk } from './gesture'
import { type KeySealer, loadPermissionKeys } from './keys'
import { createPolicySigner, type PolicySigner } from './policy-file'
import { createPermissionStore, type IntegrityFinding } from './store'

const PERMISSIONS_DIR = 'permissions'
const SPAWN_CHECK_MS = 2_000
/** V-2: how long audit records are gathered into one `iclone:permissions:changed` for the windows. */
const BROADCAST_COALESCE_MS = 100
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
  /** fx26b: main's native folder dialog for "open a project": what the user picked, or nothing if cancelled. */
  pickFolderDialog?: (options: unknown) => Promise<string[]>
}

/** The sources that hand main a path to list, each by the user's click or key (fx26b). */
export const NAMED_FOLDER_SOURCES = ['typed', 'drag'] as const

export type NamedFolderSource = (typeof NAMED_FOLDER_SOURCES)[number]

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

/** The little of a webContents the held choice reads. */
interface WindowSender {
  id: number
  isDestroyed: () => boolean
  once: (event: 'destroyed', listener: () => void) => unknown
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

  // fx7 (A-M1): every body the authority publishes also reaches the confinement launcher by main's own hand, in the
  // launcher's ledger folder (launcher-policy.ts) — the launcher's ceiling on what a confined command may be given.
  const mirroredSigner: typeof signer = {
    ...signer,
    publish(body) {
      const gen = signer.publish(body)

      currentConfinement()?.publishLauncherPolicy(body)

      return gen
    }
  }

  // A-1: the state files are authenticated under the launch's state key (store.ts); the store refuses to start without
  // the seal fact, as the authority does (R2-M4).
  const store = createPermissionStore(dir, keys)

  const authority = createPermissionAuthority({
    store,
    audit,
    signer: mirroredSigner,
    door: deps.door,
    consent: deps.consent,
    paths: { ...deps.paths, userDataDir: deps.userDataDir },
    guardPids: [process.pid],
    inftContracts: BUNDLED_REGISTRY.entries.map(entry => entry.contract),
    // fx13 (D13): an allowed ask becomes the launcher's pass for that folder and a time, never for a command text.
    pass: pass => currentConfinement()?.passFolder(pass),
    oneShot: {
      available: cwd => currentConfinement()?.oneShotAvailable(cwd) ?? false,
      issue: (command, cwd) => currentConfinement()?.issueOneShot(command, cwd) ?? false,
      fileAvailable: (file, ask) => currentConfinement()?.oneFileAvailable(file, deps.paths.home, ask) ?? false,
      fileLinkTarget: file => currentConfinement()?.oneFileLinkTarget(file) ?? null,
      issueFile: (file, by, link) => currentConfinement()?.issueOneFile(file, deps.paths.home, by, link) ?? false,
      issueRead: (file, by, link) => currentConfinement()?.issueOneRead(file, deps.paths.home, by, link) ?? false,
      fileRuns: file => currentConfinement()?.oneFileRuns(file, deps.paths.home) ?? false
    },
    seatbeltOff: () => currentConfinement()?.seatbeltOff() ?? false,
    askFolder: project => askedFolder(project, { home: deps.paths.home, userDataDir: deps.userDataDir }),
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
        'the audit key could not be sealed by the system keychain: a mode lasts until the app quits, and records cannot be authenticated after a restart'
    })
  }

  // A-1: a state file refused, deleted or unverified at launch is said in the record too, not only in the pane. The
  // reason names the file by role and what is in force instead; it never starts with `audit integrity:` (that prefix
  // is the chain's own anchor break, audit.ts) — it is a finding about the state, recorded in a chain that verifies.
  for (const finding of store.integrity()) {
    audit.append({ src: 'main', kind: 'gap', reason: integrityGapReason(finding) })
  }

  // V-2: one `changed` per burst, not per record. The first record of a burst arms one timer; when it fires the windows
  // get the newest seq, so a mode change (3-6 records) costs one re-read per window, and a steady stream still reaches
  // them every BROADCAST_COALESCE_MS (a throttle, so it cannot be starved by a busy agent). A re-verification from disk
  // that finished is a change too: the chain's health may have moved with no new record.
  let latestSeq = 0
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null

  const changed = (seq: number) => {
    latestSeq = Math.max(latestSeq, seq)

    if (!broadcastTimer) {
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null
        deps.broadcast?.(latestSeq)
      }, BROADCAST_COALESCE_MS)
      broadcastTimer.unref?.()
    }
  }

  audit.onRecord(record => changed(record.seq_main))
  audit.onVerified(report => changed(report.last.seq))
  authority.publish()
  active = { authority, signer, audit }
  setInterval(() => authority.checkSpawns(), SPAWN_CHECK_MS).unref()

  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  const gesture = (event: unknown, input: unknown) =>
    permissionGestureOk({ payload: gestureOf(input), lastInputAt: deps.lastInputAt(event), now: Date.now() })

  // fx20 (lens5 m5): the pane's "This project" comes from `$currentCwd`, which the runtime can name. A project mode, and
  // so a listing, is for a folder allow-folder's rules accept; the click is judged first.
  const never = { home: deps.paths.home, userDataDir: deps.userDataDir }

  // S11: a choice held for a window dies with it.
  const windowOf = (event: unknown) => (event as { sender?: WindowSender } | null)?.sender ?? null
  const watchedWindows = new Set<number>()

  const watchWindow = (sender: WindowSender) => {
    if (!watchedWindows.has(sender.id)) {
      watchedWindows.add(sender.id)
      sender.once('destroyed', () => {
        watchedWindows.delete(sender.id)
        authority.dropWindowChoice(sender.id)
      })
    }
  }

  ipcMain.handle('iclone:permissions:set-mode', async (event, input) => {
    const ok = gesture(event, input)
    const request = input as Record<string, unknown> | null
    const folder = ok && request?.scope === 'project' ? allowableFolder(request.key, never) : null

    if (folder && !folder.ok) {
      return { ok: false, error: 'invalid', message: folder.message }
    }

    const sender = windowOf(event)

    if (sender) {
      watchWindow(sender)
    }

    const result = await authority.setMode(input, ok, sender?.id)

    // A window that closed while the native alert was up holds nothing.
    if (sender?.isDestroyed()) {
      authority.dropWindowChoice(sender.id)
    }

    return result
  })
  ipcMain.handle('iclone:permissions:claim-window-choice', (event, input) =>
    authority.claimWindowChoice({
      windowId: windowOf(event)?.id,
      sessionId: (input as Record<string, unknown> | null)?.sessionId,
      inputAt: deps.lastInputAt(event)
    })
  )
  ipcMain.handle('iclone:permissions:set-function-level', (event, input) =>
    authority.setFunctionLevel(input, gesture(event, input))
  )
  ipcMain.handle('iclone:permissions:revoke', (event, input) =>
    authority.revoke((input as Record<string, unknown> | null)?.id, gesture(event, input))
  )
  ipcMain.handle('iclone:permissions:hermes-approval', (_event, input) => authority.hermesApproval(input, 'agent'))
  ipcMain.handle('iclone:permissions:state', (event, input) => {
    const found = authority.state((input as Record<string, unknown> | null)?.dir)
    const state = { ...found, pendingMode: authority.windowChoice(windowOf(event)?.id) }

    return state.project && !allowableFolder(state.project, never).ok ? { ...state, project: null } : state
  })
  ipcMain.handle('iclone:permissions:tail', (_event, input) => {
    const since = Number((input as Record<string, unknown> | null)?.since ?? 0)

    return authority.tail(Number.isFinite(since) && since >= 0 ? since : 0, 200)
  })

  // fx13 (D13), fx20 (lens5 H1): "Allow this folder" on a narrowed run in the Containers pane (Automatic and acceptEdits,
  // where nothing asks; cron and ACP folders). The store's folder list names it for the confinement launcher and stores
  // no mode, so what a command there may do stays what the modes say: no ask in Automatic, an allow after lowering to
  // Manual, nothing at Plan. Written by the user's own click only, for a folder that exists; the click is judged first,
  // so a script with no click learns nothing about which folders exist. It outlives a restart; Settings › Permissions
  // lists it with a Remove.
  // fx26b: the folders the user named go into main's own record, the store's folder list: userData, which the runtime
  // profile denies. That record outlives a restart, so a resumed session stays listed because of it, never because of
  // its row. Named means these sources and no others: the picker and a typed or dragged path here, the Allow this folder
  // click below, an allowed ask whose sheet showed the folder (askedFolder), and the default folder main itself spawns
  // in (listDefaultFolder, fx27: the user's own setting, re-judged at each start). A session row, a gateway answer, a
  // stored cwd and the sidebar's project tree (the gateway's answer) have no route here. A repo's root goes in with
  // the folder inside it: a command's project is the root. An allowed ask names that root on its sheet (askedFolder), so
  // its pass, its grant and its listing, which lasts as long as they do, all name the folder the command will run under.
  const listNamedFolder = (value: unknown): { ok: true; real: string } | { ok: false; message: string } => {
    const folder = allowableFolder(value, never)

    if (!folder.ok) {
      return folder
    }

    const root = listedRootOf(folder.real, never)

    authority.setFolder(folder.real, true)

    if (root !== null) {
      authority.setFolder(root, true)
    }

    // fx32p: named by the user now, so it is no longer the default's to take off when the default moves.
    forgetFromDefaultMemo(deps.userDataDir, [folder.real, root])

    return folder
  }

  ipcMain.handle('hermes:confinement:allow-folder', (event, input) => {
    if (!gesture(event, input)) {
      return Promise.resolve({ ok: false, error: 'gesture', message: 'A folder is listed by your own click or key.' })
    }

    const modes = authority.state().mode

    const folder = listNamedFolder((input as Record<string, unknown> | null)?.folder)

    if (!folder.ok) {
      return Promise.resolve({ ok: false, error: 'invalid', message: folder.message })
    }

    const existing = modes.projects[projectRootOf(folder.real) ?? folder.real]

    const level = existing ?? modes.standing
    const next = allowNext(true, level)

    return Promise.resolve({ ok: true, next })
  })
  ipcMain.handle('iclone:permissions:remove-folder', (event, input) => {
    const folder = (input as Record<string, unknown> | null)?.folder

    if (!gesture(event, input)) {
      return { ok: false, error: 'gesture', message: 'A folder is removed by your own click or key.' }
    }

    // Only what the list holds: nothing here can name a new row, and the folder may be gone from the disk by now.
    if (typeof folder !== 'string' || !authority.state().mode.folders?.includes(folder)) {
      return { ok: false, error: 'invalid', message: 'That folder is not listed.' }
    }

    authority.setFolder(folder, false)

    return { ok: true }
  })

  // The native dialog is the user's own act: the path comes from main's dialog and never from the renderer.
  // fx29 (round2 minor): the same guard as every channel that lists, a click or key of the user's own; and main's
  // refusal of what was picked reaches the user, as it does for a typed path (round2 medium).
  ipcMain.handle('hermes:confinement:pick-project-folder', async (event, input) => {
    if (!gesture(event, input)) {
      return { path: null, listed: false, message: 'A folder is listed by your own click or key.' }
    }

    const [picked] = (await deps.pickFolderDialog?.(input)) ?? []

    if (!picked) {
      return { path: null, listed: false }
    }

    const folder = listNamedFolder(picked)

    return folder.ok ? { path: picked, listed: true } : { path: picked, listed: false, message: folder.message }
  })
  // A path the user typed or dragged: the only sources that carry a path from the renderer, each by a click or key.
  // A caller that names no source, or any other, lists nothing. Without a gesture nothing is listed and nothing asks
  // again later: the run stays narrowed and its details offer Allow this folder.
  ipcMain.handle('hermes:confinement:note-folder', (event, input) => {
    const request = input as Record<string, unknown> | null

    if (!gesture(event, input)) {
      return { ok: false, error: 'gesture', message: 'A folder is listed by your own click or key.' }
    }

    if (!NAMED_FOLDER_SOURCES.some(source => source === request?.source)) {
      return { ok: false, error: 'source', message: 'Only a folder you typed or dragged is listed here.' }
    }

    const folder = listNamedFolder(request?.folder)

    return folder.ok ? { ok: true } : { ok: false, error: 'invalid', message: folder.message }
  })

  return authority
}

/**
 * The folder "Allow this folder" may list: an absolute path, spelled as the folder itself is (its real path), a
 * directory that exists, and never the user's home, anything under `~/Library`, the app's own data, or a `.git`.
 */
export function allowableFolder(
  value: unknown,
  paths: { home: string; userDataDir: string }
): { ok: true; real: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    return { ok: false, message: 'The folder must be an absolute path.' }
  }

  // fx27 (F1 medium 4, F2 major 3): a trailing separator or a `..` is the user's spelling of the folder it names, so
  // it is resolved lexically first; the identity check then runs on that path. A link, another case or another
  // Unicode form still resolves elsewhere and is refused: realpathSync.native gives the on-disk spelling (F1 medium 1).
  const named = path.resolve(value)
  let real: string

  try {
    real = realpathSync.native(named)

    if (!statSync(real).isDirectory()) {
      return { ok: false, message: 'That path is not a folder.' }
    }
  } catch {
    return { ok: false, message: 'That folder does not exist.' }
  }

  if (real !== named) {
    return { ok: false, message: 'The folder must be named by its own path, not through a link or another spelling.' }
  }

  const home = realOrSame(paths.home)
  const userData = realOrSame(paths.userDataDir)
  const under = (root: string) => real === root || real.startsWith(`${root}${path.sep}`)

  if (real === home || real === '/' || home.startsWith(`${real}${path.sep}`)) {
    return { ok: false, message: 'Your home folder, and anything above it, cannot be a project.' }
  }

  if (under(path.join(home, 'Library')) || under(userData)) {
    return { ok: false, message: 'Folders of the app and of macOS cannot be a project.' }
  }

  if (real.split(path.sep).includes('.git')) {
    return { ok: false, message: 'A repository\'s own .git folder cannot be a project.' }
  }

  // fx32p: the launcher's own rules (core.py mirrors profiles.ts), so what it will never take is refused here, in words.
  const refusal = projectRootRefusal(
    real,
    { denied: [], protectedWrites: execOnBehalfWrites(home) },
    home,
    pnpmStoreRoots(process.env.PNPM_HOME, home)
  )

  if (refusal === 'store') {
    return { ok: false, message: 'A package store cannot be a project.' }
  }

  if (refusal === 'shell') {
    return { ok: false, message: 'This folder is, holds or sits inside a folder your own shell or tools run from, so it cannot be a project.' }
  }

  return { ok: true, real }
}

/** The repository root that goes with `real`: only one the same rules allow, and never the home folder (gitRootOf). */
const listedRootOf = (real: string, paths: { home: string; userDataDir: string }): string | null => {
  const root = gitRootOf(real, realOrSame(paths.home))

  return root !== null && root !== real && allowableFolder(root, paths).ok ? root : null
}

const directoryIdentity = (real: string): { dev: number; ino: number } | null => {
  try {
    const stat = lstatSync(real)

    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null
  } catch {
    return null
  }
}

/**
 * fx20 (lens5 H2): the folder an ask may name to the user, judged when it is asked by allowableFolder's rules, with its
 * identity; `same` compares when the user answers, so a link planted or repointed while the sheet is up names nothing.
 * Null: the sheet shows no folder, nothing is listed and no pass names it. fx32p: a folder inside a repository is asked
 * for as the repository's root, the folder the launcher will run the command under; the runtime cannot see that root.
 */
export function askedFolder(
  project: string | null,
  paths: { home: string; userDataDir: string }
): { project: string; same: () => boolean } | null {
  const folder = project === null ? null : allowableFolder(project, paths)
  const shown = folder?.ok ? (listedRootOf(folder.real, paths) ?? folder.real) : null
  const identity = shown === null ? null : directoryIdentity(shown)

  if (shown === null || !identity) {
    return null
  }

  return {
    project: shown,
    same: () => {
      const now = directoryIdentity(shown)

      return now?.dev === identity.dev && now.ino === identity.ino && realOrSame(shown) === shown
    }
  }
}

/** The on-disk spelling (case and Unicode form included), or the value itself when it is not on the disk. */
const realOrSame = (value: string): string => {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
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
/** fx19: what happens next, for the row. Listing never widens: Manual still asks before each write (an unsealed run is
 *  Manual whatever is stored), Plan still refuses. */
export const allowNext = (sealed: boolean, level: string): 'asks' | 'plan' | 'writes' =>
  !sealed || level === 'manual' ? 'asks' : level === 'plan' ? 'plan' : 'writes'

export function activePermissions(): { authority: PermissionAuthority | null; signer: PolicySigner | null } {
  return { authority: active?.authority ?? null, signer: active?.signer ?? null }
}

const DEFAULT_FOLDER_FILE = 'default-folder.json'

/** What the default itself put on the list; an older memo named the folder alone. */
const readDefaultMemo = (memo: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(memo, 'utf8'))

    return typeof parsed === 'string'
      ? [parsed]
      : Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
  } catch {
    return []
  }
}

const forgetFromDefaultMemo = (userDataDir: string, named: readonly (string | null)[]): void => {
  const memo = path.join(userDataDir, DEFAULT_FOLDER_FILE)
  const previous = readDefaultMemo(memo)
  const kept = previous.filter(item => !named.includes(item))

  if (kept.length === previous.length) {
    return
  }

  try {
    writeFileSync(memo, JSON.stringify(kept), 'utf8')
  } catch {
    // The memo is a convenience for the re-judgement; the record itself is the store's.
  }
}

/**
 * fx27 (F1 medium 2): the folder main's own spawn starts in (Settings "Default project directory", HERMES_DESKTOP_CWD
 * from main's own launch environment, the dev checkout) is the user's own setting, so it is a source of its own,
 * 'default-folder': judged by allowableFolder and the never list, written to main's folder record (visible and
 * removable under Permissions), and re-judged at each start: the folder listed at the previous start is taken off
 * when the setting now names another, or none the never list allows. No IPC reaches this; the path is main's own
 * (resolveHermesCwd), never the renderer's or the runtime's. Returns what is listed now, or null.
 */
export function listDefaultFolder(value: unknown, paths: { home: string; userDataDir: string }): string | null {
  const authority = active?.authority

  if (!authority) {
    return null
  }

  const memo = path.join(paths.userDataDir, DEFAULT_FOLDER_FILE)
  // fx29 (round2 mediums): the memo holds what the default itself put on the list, the folder and the root of the
  // repository it is in (the same step as listNamedFolder), and only what was not listed already; an older memo named
  // the folder alone. Moving the default takes off only those: a folder the user named stays.
  const previous = readDefaultMemo(memo)
  const folder = allowableFolder(value, paths)
  const next = folder.ok ? folder.real : null
  const rootNext = next === null ? null : listedRootOf(next, paths)
  const wanted = [next, rootNext].filter((item): item is string => item !== null)
  const listedBefore = authority.state().mode.folders ?? []

  for (const old of previous) {
    if (!wanted.includes(old) && listedBefore.includes(old)) {
      authority.setFolder(old, false)
    }
  }

  const put = wanted.filter(item => previous.includes(item) || !listedBefore.includes(item))

  for (const item of wanted) {
    authority.setFolder(item, true)
  }

  try {
    writeFileSync(memo, JSON.stringify(put), 'utf8')
  } catch {
    // The memo is a convenience for the re-judgement; the record itself is the store's.
  }

  return next
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
