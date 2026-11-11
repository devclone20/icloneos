/**
 * V3-G — the confinement layer's composition root: one setting picks the backend, main generates the profiles at
 * boot, probes both backends, and folds `state` on demand. Flipping the backend edits the setting and nothing else
 * (G6). A permission mode never touches confinement: Ignore permissions only skips the asks. Confinement itself is on by
 * default and the user can turn it off (isolation-switch.ts is the only door, owner order G-98, replaces D2).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  type ActivityClass,
  type BackendStatusView,
  CONFINEMENT_ON_BY_DEFAULT,
  type ConfinementBackendId,
  type ConfinementReason,
  type ConfinementStateView,
  type HardlinkAckResultView,
  type HardlinkBlockView,
  isActivityClass,
  isConfinementBackendId,
  type KillResultView,
  REFUSALS_LISTED,
  type RefusalView,
  type StopRunResultView
} from '../../src/iclone-shared/confinement'
import { confinementMembersDir } from '../iclone-permissions/classify-policy'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { chmodFolderInRoot } from '../lib/no-follow-fs'

import type { ConfinementBackend } from './backend'
import { createContainerBackend } from './backend-container'
import {
  createSeatbeltBackend,
  type GeneratedProfile,
  generateProfiles,
  type HardlinkAppearedEvent,
  knownProfile,
  pluginSpec,
  profilesOnDisk,
  profileView
} from './backend-seatbelt'
import { type GitIdentity, gitIdentityEnv, readGlobalGitIdentity } from './git-identity'
import {
  bootSealedKey,
  createHardlinkGuard,
  type HardlinkAuditEvent,
  hardlinkFiles,
  pnpmStoreRoots,
  readHardlinkReportRoots,
  readSignedFile,
  type SealedKey,
  type SealedKeyStore,
  signedFile,
  type SignedFileRejection
} from './hardlinks'
import { createLauncher, type Launcher, type LauncherOptions, type LauncherState } from './launcher'
import { createLauncherPolicyMirror, type LauncherPass } from './launcher-policy'
import { createMemberProbe, ensureMembersDir, isRunToken, type MemberProbe, sweepTokens } from './members'
import { createOneShotLedger, oneFileLinkTarget, type OneFileRules, oneShotFolder, oneShotRoute } from './one-shot'
import { probeContainer, probeFailedView, probeSeatbelt } from './probe'
import { appOwnFiles, type ConfinementPaths, fileRunsOrHoldsKeys, realOrSelf } from './profiles'
import { createRefusalLog, refusalRecordDir, reportedRefusalsDir } from './refusals'
import {
  appendStop,
  capRuns,
  explainRefusals,
  foldAllRuns,
  orphanOwners,
  outsideGroupMembers,
  outsideGroupOf,
  readRunEvents,
  runFiles,
  runStarts
} from './runs'
import {
  generateRuntimeProfile,
  interpreterLinks,
  judgeHelperInterpreter,
  launcherLedgerDir,
  launcherSocketFile,
  type RuntimeFacts,
  type RuntimeParam,
  runtimeParamValues,
  type RuntimeProfile,
  runtimeProfileParams,
  runtimeRoots,
  runtimeSandboxArgv,
  runtimeTmpFolder,
  SANDBOX_EXEC_PATH
} from './runtime-profile'
import {
  type AuditSlice,
  foldState,
  PLUGIN_REASON_MAX,
  type PluginCommandsReport,
  type PsRow,
  readPs,
  type Snapshot,
  withMembership
} from './state'

const SETTINGS_FILE = 'settings.json'
/** A probe result is a status, not a count: re-measured when older than this. */
const PROBE_TTL_MS = 15_000

interface ConfinementSettings {
  v: 1
  backend: ConfinementBackendId
  enabled: boolean
  defaultClass: ActivityClass
}

export const DEFAULT_SETTINGS: ConfinementSettings = {
  v: 1,
  backend: 'seatbelt',
  enabled: CONFINEMENT_ON_BY_DEFAULT,
  defaultClass: 'project'
}

/**
 * T7 (F8): the settings file is trusted only under main's own signature (the key sealed with the hard-link record,
 * hardlinks.ts). A file that is unsigned, forged or unverifiable is ignored: confinement runs with its defaults, on,
 * and `ignored` says why so the pane can say it was ignored and index.ts can audit it once. Within a verified body,
 * anything but an explicit `false` is on.
 */
export function readSettings(
  dir: string,
  key: Buffer
): { settings: ConfinementSettings; ignored: SignedFileRejection | null } {
  const read = readSignedFile(path.join(dir, SETTINGS_FILE), key)

  if ('rejected' in read) {
    return { settings: DEFAULT_SETTINGS, ignored: read.rejected }
  }

  if (read.body === '') {
    return { settings: DEFAULT_SETTINGS, ignored: null }
  }

  try {
    const raw = JSON.parse(read.body) as Record<string, unknown>

    return {
      ignored: null,
      settings: {
        v: 1,
        backend: isConfinementBackendId(raw.backend) ? raw.backend : DEFAULT_SETTINGS.backend,
        enabled: raw.enabled !== false,
        defaultClass: isActivityClass(raw.defaultClass) ? raw.defaultClass : DEFAULT_SETTINGS.defaultClass
      }
    }
  } catch {
    return { settings: DEFAULT_SETTINGS, ignored: 'malformed' }
  }
}

function writeSettings(dir: string, settings: ConfinementSettings, key: Buffer): void {
  writeFileAtomicSync(path.join(dir, SETTINGS_FILE), signedFile(key, JSON.stringify(settings)), {
    mode: 0o600,
    dirMode: 0o700
  })
}

/** Hermes' terminal backend name for each of ours (agent/terminal_env_registry: never a built-in name). */
export const HERMES_BACKEND_NAME: Record<ConfinementBackendId, string> = {
  seatbelt: 'iclone_seatbelt',
  container: 'iclone_container'
}

export interface ConfinementDeps {
  userDataDir: string
  home: string
  hermesHome: string
  hermesRoot: string | null
  /** The Hermes processes main started (their trees are where agent commands run). */
  hermesPids: () => number[]
  primaryPid?: () => number | null
  /** The V3-F audit tail, newest last. */
  audit: () => AuditSlice[]
  now?: () => Date
  ps?: () => Promise<PsRow[]>
  /** The Hermes runtime's Python, which asks the kernel which processes are confined (members.ts). Null: ancestry
   *  only, said in the pane. */
  memberPython?: string | null
  probes?: Partial<Record<ConfinementBackendId, () => Promise<BackendStatusView>>>
  sandboxExec?: string
  platform?: NodeJS.Platform
  /** T5: Electron's safeStorage when the owner's keychain policy allows it. Null or absent: hard-link allowances
   *  are session-only (the record on disk is never read back). */
  keyStore?: SealedKeyStore | null
  /** T2'': the pnpm store roots a `build` run may be linked into without a gesture. Absent: the two pnpm homes
   *  under `home` and `$PNPM_HOME` (`pnpmStoreRoots`). */
  pnpmStoreRoots?: readonly string[]
  /** Test seam: the runtime profile the state reads. Absent: the layer's own (`runtimeView`). */
  runtime?: () => { profileSha: string | null; reads: string[]; writes: string[]; denied: string[] } | null
  /** fx18 (F3): the user's own `user.name` and `user.email`, the only two values of the global git config a confined
   *  `git commit` carries (git-identity.ts). Absent: read from the files git reads, at every spawn. */
  gitIdentity?: () => GitIdentity
  /** Test seam: the launcher state the state reads. Absent: the layer's own (`launcherState`). */
  launcher?: () => 'down' | 'off' | 'up'
  /** Test seam: how the launcher is made (launcher.ts). */
  createLauncher?: (options: LauncherOptions) => Launcher
  /** Where the launcher's lifecycle lines go. Absent: nowhere. */
  log?: (line: string) => void
}

/** The facts the spawn site resolves (interpreter, venv, permission socket, …); the layer's own directories (run,
 *  ready, profiles, members, scratch, refusals, hard-link acks) come from its paths (runtime-profile.ts). */
export type RuntimeSpawnFacts = RuntimeFacts

/** One Hermes launch under the runtime profile: `command` is sandbox-exec, `args` carry the profile and defines. */
export interface RuntimeLaunch {
  command: string
  args: string[]
  profile: RuntimeProfile
}

/** The parameters every confined Hermes needs: one missing (unresolved, or dropped as unsafe) refuses the spawn. */
const RUNTIME_PARAMS_REQUIRED: readonly RuntimeParam[] = [
  'HERMES_HOME',
  'HOME_DIR',
  'RUNTIME_ROOT',
  'VENV_ROOT',
  'PYTHON_HOME',
  'PYTHON_EXE',
  'RUN_DIR',
  'READY_DIR',
  'LAUNCHER_SOCKET',
  'PROFILES_DIR',
  'MEMBERS_DIR',
  'SCRATCH_ROOT',
  'TMP',
  'REFUSALS_DIR',
  'HARDLINK_ACKS'
]

/** The parameters a spawn needs when it named the fact (the project is not here: dropping it only narrows). */
const RUNTIME_PARAMS_WHEN_GIVEN: ReadonlyArray<readonly [RuntimeParam, keyof RuntimeFacts]> = [
  ['WEB_DIST', 'webDist'],
  ['PLUGINS_DIR', 'pluginsDir'],
  ['CACHE', 'cacheDir'],
  ['PERM_DIR', 'permDir'],
  ['PERM_SOCKET', 'permSocket'],
  ['POLICY_FILE', 'policyFile'],
  ['PAY_SOCKET', 'paySocket']
]

/**
 * The `-D` list for one spawn, or a throw naming every parameter the profile would go without: a confined Hermes
 * never starts with less than it needs (it would fail in ways that read as bugs) nor with a wider stand-in.
 */
export function requiredRuntimeParams(paths: ConfinementPaths, facts: RuntimeFacts): string[] {
  const params = runtimeProfileParams(paths, facts)
  const passed = new Set(params.filter((_, index) => index % 2 === 1).map(define => define.split('=', 1)[0]))

  const wanted = [
    ...RUNTIME_PARAMS_REQUIRED,
    ...RUNTIME_PARAMS_WHEN_GIVEN.filter(([, fact]) => Boolean(facts[fact])).map(([name]) => name)
  ]

  const missing = wanted.filter(name => !passed.has(name))

  if (missing.length > 0) {
    throw new Error(`the runtime profile has no safe value for ${missing.join(', ')}`)
  }

  return params
}

/** What the runtime's own confinement allows, for the state fold (null while confinement is off or before a spawn). */
export interface RuntimeView {
  profileSha: string
  reads: string[]
  writes: string[]
  denied: string[]
}

/** The launcher's script inside a runtime (the confinement plugin's folder). */
export const launcherScript = (runtimeRoot: string): string =>
  path.join(runtimeRoot, 'plugins', 'iclone-confinement', 'launcher.py')

export function confinementPaths(
  deps: Pick<ConfinementDeps, 'hermesHome' | 'hermesRoot' | 'home' | 'userDataDir'>
): ConfinementPaths {
  return {
    home: deps.home,
    hermesHome: deps.hermesHome,
    userDataDir: deps.userDataDir,
    hermesRoot: deps.hermesRoot,
    profilesDir: path.join(deps.userDataDir, 'confinement', 'profiles'),
    // Outside userData, which the profiles deny whole (the app's own state, cookies, the permission chain).
    scratchRoot: path.join(deps.home, 'Library', 'Caches', 'iclone-os-confinement', 'scratch'),
    membersDir: confinementMembersDir(deps.home),
    xcrunCache: xcrunCacheFile()
  }
}

/** `confstr(_CS_DARWIN_USER_TEMP_DIR)/xcrun_db`: where xcrun keeps its SDK lookups (not TMPDIR, which we redirect). */
export function xcrunCacheFile(): string | null {
  if (process.platform !== 'darwin') {
    return null
  }

  try {
    const dir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 2_000 }).trim()

    return dir.startsWith('/') ? path.join(dir, 'xcrun_db') : null
  } catch {
    return null
  }
}

/** The refusals read for the pane's list (it shows the newest 100); a run's count comes from its own file. */
const RUN_REFUSALS_WINDOW = 1_000

/** Run tokens with no live member are removed at most this often (members.ts keeps young ones). */
const SWEEP_EVERY_MS = 60_000
/** A root the pane shows as refused is re-measured at most this often while it stays refused (the walk is cheap,
 *  the full scan is cached behind it). */
const BLOCK_RECHECK_MS = 5_000
/** A link that appeared during a run (T3) is said in the pane for this long after the run. */
const APPEARED_NOTE_MS = 10 * 60_000

/** T3: a refusal-class row for every path the post-exit scan found (up to the three it names, then the rest as one
 *  row with the count), so the owner's record says what the run could reach. */
function appearedRows(event: HardlinkAppearedEvent, ts: string): RefusalView[] {
  const operation = event.block.kind === 'hard-links' ? 'hard-link-appeared' : 'cannot-scan-after-run'
  const rest = event.block.count - event.block.paths.length
  const targets = [...event.block.paths, ...(rest > 0 ? [`… and ${rest} more under ${event.root}`] : [])]

  return targets.map(target => ({
    ts,
    pid: event.pid,
    process: 'hard-link',
    operation,
    target,
    sessionId: event.sessionId,
    root: event.root
  }))
}

/** T5: what the guard refused to trust at boot, as one row each. */
const auditRow = (event: HardlinkAuditEvent, ts: string): RefusalView => ({
  ts,
  pid: process.pid,
  process: 'icloneOS',
  operation: `hardlink-${event.kind}`,
  target: `${event.file} (${event.detail})`,
  sessionId: null
})

const membersOf = (snapshot: Snapshot) =>
  new Map(snapshot.rows.filter(row => row.run !== undefined).map(row => [row.pid, row.run ?? null]))

/**
 * G22 B1: each runtime acknowledges in its own file beside the path main hands every spawn (`hermes-ack.<pid>.json`,
 * core.py `ack_file_of`): the window's runtime and a profile's run together, so one file would hold only the last word.
 * A name that does not match its body's pid, or anything malformed, acknowledges nothing.
 */
function ackFiles(file: string): { file: string; pid: number }[] {
  const { dir, name, ext } = path.parse(file)
  const prefix = `${name}.`

  try {
    return fs.readdirSync(dir).flatMap(entry => {
      const middle =
        entry.startsWith(prefix) && entry.endsWith(ext) ? entry.slice(prefix.length, entry.length - ext.length) : ''

      return /^[1-9]\d*$/.test(middle) ? [{ file: path.join(dir, entry), pid: Number(middle) }] : []
    })
  } catch {
    return []
  }
}

function readAcks(file: string): { pid: number; raw: Record<string, unknown> }[] {
  return ackFiles(file).flatMap(ack => {
    try {
      const raw = JSON.parse(fs.readFileSync(ack.file, 'utf8')) as Record<string, unknown>

      return ack.pid > 1 && Number(raw.pid) === ack.pid ? [{ pid: ack.pid, raw }] : []
    } catch {
      return []
    }
  })
}

/** The pids that wrote the plugin's acknowledgement when they registered; a missing or malformed file acknowledges nothing. */
export function readAckPids(file: string): number[] {
  return readAcks(file).map(ack => ack.pid)
}

/**
 * What each runtime's plugin last said about the agent's commands (`{"commands": {"available", "reason"}}`, rewritten
 * whenever its answer changes): the runtime's own word, which the fold may only turn into a red reason. A missing,
 * malformed or older file (no `commands`) says nothing.
 */
export function readAckCommands(file: string): PluginCommandsReport[] {
  return readAcks(file).flatMap(({ pid, raw }) => {
    const commands = raw.commands as Record<string, unknown> | undefined

    if (typeof commands !== 'object' || commands === null || typeof commands.available !== 'boolean') {
      return []
    }

    const reason = typeof commands.reason === 'string' ? commands.reason.slice(0, PLUGIN_REASON_MAX) : ''

    const note =
      typeof commands.note === 'string' && commands.note ? commands.note.slice(0, PLUGIN_REASON_MAX) : undefined

    return [{ pid, available: commands.available, reason, ...(note ? { note } : {}) }]
  })
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Before a runtime is spawned: a dead runtime's word goes, and an older version's single file with it. Pids are reused,
 *  and a stale file must never speak for a process that did not write it. */
export function sweepAcks(file: string, alive: (pid: number) => boolean = pidAlive): void {
  for (const ack of ackFiles(file)) {
    if (!alive(ack.pid)) {
      fs.rmSync(ack.file, { force: true })
    }
  }

  fs.rmSync(file, { force: true })
}

export function createConfinement(deps: ConfinementDeps) {
  const paths = confinementPaths(deps)
  const settingsDir = path.join(deps.userDataDir, 'confinement')
  const now = deps.now ?? (() => new Date())
  const ps = deps.ps ?? readPs
  // Main's own record (kernel refusals, its own audit rows, each run's count) lies in no hole of the runtime profile;
  // the runtime's report folder is read beside it for the plugin's hard-link rows only (refusals.ts).
  const refusals = createRefusalLog(refusalRecordDir(deps.userDataDir), reportedRefusalsDir(deps.userDataDir))
  const runDir = path.join(settingsDir, 'run')
  const ackFile = path.join(runDir, 'hermes-ack.json')

  // This process has spawned nothing yet, so no acknowledgement on disk is one of its runtimes (a reboot reuses pids).
  sweepAcks(ackFile, () => false)

  const launcherSocket = path.join(runDir, 'launcher.sock')
  const linkFiles = hardlinkFiles(deps.userDataDir)
  const ledgerFiles = runFiles(deps.userDataDir)
  const audit = (event: HardlinkAuditEvent) => refusals.append(auditRow(event, now().toISOString()))

  // One key signs the hard-link record (T5) and the settings file (T7): sealed in safeStorage when the owner's
  // keychain policy allows it, else this session's, in which case nothing either file held before is read back.
  const sealedKey: SealedKey = bootSealedKey({
    keyFile: linkFiles.key,
    keyStore: deps.keyStore ?? null,
    onAudit: audit
  })

  let profiles: GeneratedProfile[] = generateProfiles(paths)

  // G23: the same facts the launcher judges again from pluginSpec.
  const oneFileRules = (): OneFileRules => ({
    appFiles: appOwnFiles(paths),
    denied: profiles[0]?.spec.denied ?? [],
    protectedWrites: profiles[0]?.spec.protectedWrites ?? [],
    storeRoots
  })

  // T2'': the pnpm store roots a `build` run may be linked into without a gesture; main's env names $PNPM_HOME.
  // r5 MINOR-2: never one of the denied directories (the profiles' list), the Hermes home or the app's own data.
  const storeDenied = [...(profiles[0]?.spec.denied ?? []), realOrSelf(deps.hermesHome), realOrSelf(deps.userDataDir)]
  const storeRoots = deps.pnpmStoreRoots ?? pnpmStoreRoots(process.env.PNPM_HOME, deps.home, storeDenied)

  // A3-m2: a resident tree that died or outgrew its bound is rescanned in a worker; the drop is counted (the guard's
  // `event.count`) and said here (main's log), never in the refusal record: a run of them is a crashing tree or a
  // starved machine.
  const hardlinks = createHardlinkGuard({
    ackFile: linkFiles.acks,
    sealedKey,
    now,
    onAudit: audit,
    storeRoots,
    onTreeDropped: event => {
      console.warn(
        `[confinement] hard-link tree of ${event.root} dropped (${event.why}: ${event.detail}); rescanning in a worker (drop ${event.count} of this root this session)`
      )
    },
    onRootReleased: (root, why) => {
      console.info(`[confinement] hard-link tree of ${root} released (${why}); its next check scans it again`)
    }
  })

  const measuredAt = new Map<string, number>()
  const settingsFile = path.join(settingsDir, SETTINGS_FILE)
  let settingsIgnored: SignedFileRejection | null = null
  // F41: what main last wrote this session. A signed "off" saved while isolation was off and put back after the user
  // turned it on is a true signature on an old answer: it is never believed over main's own memory of that click.
  let turnedOnThisSession = false

  if (!sealedKey.persistent) {
    // Session-only: whatever the file says (an "off" from a past session, or a forgery) is not trusted; the
    // defaults are written under this session's key, so an "off" set through the pane lasts until the app quits.
    writeSettings(settingsDir, DEFAULT_SETTINGS, sealedKey.key)
  }

  // Read on every use, never cached: a file forged while the app runs is ignored from the next read, and the
  // rejection is audited once per change of reason (not once per poll).
  const settings = (): ConfinementSettings => {
    const read = readSettings(settingsDir, sealedKey.key)

    if (read.ignored !== settingsIgnored) {
      settingsIgnored = read.ignored

      if (read.ignored) {
        audit({ kind: 'settings-rejected', file: settingsFile, detail: read.ignored })
      }
    }

    return read.settings.enabled || !turnedOnThisSession ? read.settings : { ...read.settings, enabled: true }
  }

  settings()

  ensureMembersDir(paths.membersDir)

  const log = deps.log ?? (() => undefined)
  // The facts of the Hermes the launcher was started for: its roots are the runtime's (home, scratch, temp, runtime,
  // venv, interpreter, web build). Another Hermes of the same runtime differs in its project at most, and a run's
  // project is admitted through its own PROJECT_ROOT, so the launcher is not restarted for it.
  let launcherFacts: RuntimeFacts | null = null

  // The interpreter main's own helpers run with (the membership probe, the launcher), OUTSIDE every sandbox: the
  // runtime's, as the last confined spawn named it, else the active venv's. Resolved at every use, never once at boot:
  // a fresh install has no runtime Python when the layer is made, and a dev run may name its interpreter elsewhere
  // (the spawn's own command). Each candidate is judged first (judgeHelperInterpreter): one the confined runtime could
  // replace — a binary or a link on its way inside a folder the runtime profile lets it write — is never run, and the
  // helpers go without rather than fall back to it.
  let spawnPython: string | null = null
  let probePython: string | null = null
  let memberProbe: MemberProbe | null = null
  let helperRefusalSaid: string | null = null

  const helperInterpreter = (): { python: string | null; refusals: string[] } => {
    const refusals: string[] = []

    for (const candidate of [spawnPython, deps.memberPython]) {
      if (!candidate || !fs.existsSync(candidate)) {
        continue
      }

      const verdict = judgeHelperInterpreter(paths, candidate, launcherFacts)

      if (verdict.trusted) {
        return { python: candidate, refusals }
      }

      refusals.push(verdict.reason)
    }

    return { python: null, refusals }
  }

  const helperPython = (): string | null => {
    const { python, refusals } = helperInterpreter()
    const said = refusals.join('; ')

    // Said once per change, not once per poll: the pane asks every second.
    if (said && said !== helperRefusalSaid) {
      log(`[confinement] an interpreter is not trusted to run outside the sandbox: ${said}`)
    }

    helperRefusalSaid = said

    return python
  }

  const currentProbe = (): MemberProbe | null => {
    const python = helperPython()

    if (python !== probePython) {
      probePython = python
      memberProbe = python ? createMemberProbe(paths.membersDir, python) : null
    }

    return memberProbe
  }

  /** g17: Stop on an approved background command: no kernel token holds it, so its group ends, and the launcher need not
   *  be alive. TERM, then KILL, as the launcher's own stop. */
  const stopOutsideGroup = async (run: string, group: number): Promise<StopRunResultView> => {
    const living = async () => outsideGroupMembers(group, await ps()).map(row => row.pid)
    const killed = await living()

    appendStop(ledgerFiles.stopsFile, run, now().toISOString())

    for (const [signal, graceMs] of [
      ['SIGTERM', 2_000],
      ['SIGKILL', 1_000]
    ] as const) {
      try {
        process.kill(-group, signal)
      } catch {
        break
      }

      for (const until = Date.now() + graceMs; Date.now() < until && (await living()).length > 0;) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    const survivors = await living()

    if (survivors.length > 0) {
      appendStop(ledgerFiles.stopsFile, run, now().toISOString(), 'failed')

      return { ok: false, run, reason: 'survivors', survivors, error: 'processes of this command outlived the kill' }
    }

    return { ok: true, run, killed }
  }

  const scan = async (): Promise<Snapshot> => {
    const rows = await ps()
    // fx29 (round2 minor): the moment the rows were read, carried on the snapshot: the probes after it take time.
    const readAtMs = now().getTime()

    return { ...(await withMembership(rows, currentProbe())), readAtMs }
  }

  let lastSweep = 0

  const backends: Record<ConfinementBackendId, ConfinementBackend> = {
    seatbelt: createSeatbeltBackend({
      paths,
      profiles: () => profiles,
      scan,
      hardlinks,
      storeRoots,
      onHardlinkAppeared: event => {
        measuredAt.set(event.root, now().getTime())

        for (const row of appearedRows(event, now().toISOString())) {
          refusals.append(row)
        }
      },
      probe: deps.probes?.seatbelt ?? (() => probeSeatbelt()),
      sandboxExec: deps.sandboxExec
    }),
    container: createContainerBackend({ probe: deps.probes?.container ?? (() => probeContainer()) })
  }

  const probes = new Map<ConfinementBackendId, { at: number; view: BackendStatusView }>()
  const inFlight = new Map<ConfinementBackendId, Promise<BackendStatusView>>()

  // G3 r2 m-3: one probe per backend at a time. Overlapping reads (the pane polls every second; a container check can
  // take 3 s) share the probe in flight instead of each starting another, so an older answer, a timeout landing last,
  // can never overwrite a newer one; the answer is kept for PROBE_TTL_MS from when it landed.
  const probe = (id: ConfinementBackendId): Promise<BackendStatusView> => {
    const last = probes.get(id)

    if (last && now().getTime() - last.at < PROBE_TTL_MS) {
      return Promise.resolve(last.view)
    }

    const pending = inFlight.get(id)

    if (pending) {
      return pending
    }

    const started = backends[id]
      .probe()
      .catch((error: unknown) => probeFailedView(id, error))
      .then(view => {
        probes.set(id, { at: now().getTime(), view })
        inFlight.delete(id)

        return view
      })

    inFlight.set(id, started)

    return started
  }

  // The roots main refused and the roots the plugin reported, each measured by main itself (the plugin's report
  // names roots only): what the pane offers is main's scan, grouped, and a root is re-measured every few seconds
  // while it stays refused, so a link the owner removed by hand clears without a new command.
  // The measure is asynchronous (hardlinks.ts) and never waited for here: a root being walked shows its last answer
  // and the next read shows the new one; one re-measure per root at a time, so a slow walk never queues more.
  const remeasuring = new Set<string>()

  const blockedProjects = (): HardlinkBlockView[] => {
    const at = now().getTime()
    const roots = new Set([...readHardlinkReportRoots(linkFiles.report), ...hardlinks.blocked().map(b => b.root)])

    for (const root of roots) {
      if (!remeasuring.has(root) && at - (measuredAt.get(root) ?? 0) >= BLOCK_RECHECK_MS) {
        measuredAt.set(root, at)
        remeasuring.add(root)
        // I7 (F-5): not a use, and never scans a released root back in.
        void hardlinks.recheckBlocked(root).finally(() => remeasuring.delete(root))
      }
    }

    return hardlinks.blocked()
  }

  // T3: the links that appeared during a run, from their rows (one source: the refusal record), while recent.
  const appearedNotes = (): ConfinementReason[] => {
    const since = now().getTime() - APPEARED_NOTE_MS
    const seen = new Set<string>()
    const notes: ConfinementReason[] = []

    for (const row of refusals.recent(100)) {
      if (row.operation !== 'hard-link-appeared' || !row.root || new Date(row.ts).getTime() < since) {
        continue
      }

      const key = `${row.pid}\0${row.root}`

      if (!seen.has(key)) {
        seen.add(key)
        notes.push({ code: 'hardlink-appeared', pid: row.pid, root: row.root, path: row.target })
      }
    }

    return notes
  }

  // The runtime's own confinement: Hermes under the runtime profile, confined commands started by the launcher.
  // Only when confinement is on and the platform is darwin; otherwise none of it exists (no launcher, no profile).
  const runtimeConfined = (): boolean => settings().enabled && (deps.platform ?? process.platform) === 'darwin'
  let launcher: Launcher | null = null
  let launcherStartedAt = 0
  let launcherFor: string | null = null
  let nextLease = 0
  const leases = new Set<number>()
  let runtimeProfile: RuntimeProfile | null = null
  // The profile text is the same for every spawn of one interpreter (per-spawn paths are its parameters; the links
  // the interpreter is reached through are its only literals): generated once per link chain.
  let runtimeText: RuntimeProfile | null = null
  let runtimeTextLinks: string | null = null

  // fx7: main's copy of the permission policy, in the launcher's ledger folder (the runtime profile denies it).
  const oneShots = createOneShotLedger(launcherLedgerDir(deps.userDataDir))
  const launcherPolicy = createLauncherPolicyMirror(launcherLedgerDir(deps.userDataDir), log, Date.now, deps.home)

  const stopLauncher = async (): Promise<void> => {
    const running = launcher

    launcher = null
    launcherFor = null
    await running?.stop()
  }

  const ensureLauncher = async (runtimeRoot: string, facts: RuntimeFacts): Promise<LauncherState> => {
    // V-1b: the project this Hermes is spawned on is known now; its hard-link scan and stream start before its first
    // command (only an acceptable project root: runtimeParamValues drops the home, a denied folder, userData).
    const project = runtimeParamValues(paths, facts).PROJECT

    if (project) {
      void hardlinks.prewarm(project)
    }

    const { python, refusals } = helperInterpreter()

    if (!python) {
      log(
        `[confinement] launcher not started: ${refusals.length > 0 ? refusals.join('; ') : 'the runtime has no Python yet'}`
      )

      return 'down'
    }

    const script = launcherScript(runtimeRoot)

    // A different runtime (a switch, a dev checkout) gets its own launcher; never two at once.
    if (launcher && launcherFor !== script) {
      await stopLauncher()
    }

    // fx24 (r2-B finding 3): a launcher left up serves whichever project this runtime was spawned on. The roots it judges
    // "the runtime's" are read from the policy file at each request, not fixed at its own start.
    launcherFacts = facts
    launcherPolicy.setRuntimeRoots(runtimeRoots(paths, facts))

    if (!launcher) {
      launcherStartedAt = now().getTime()
      launcher = (deps.createLauncher ?? createLauncher)({
        python,
        script,
        socketPath: launcherSocket,
        journalDir: launcherLedgerDir(deps.userDataDir),
        home: deps.home,
        hermesHome: deps.hermesHome,
        // Read at every (re)start: the hashes of the profiles main holds now, and the runtime's roots.
        spec: () => pluginSpec(paths, profiles, storeRoots),
        roots: () => runtimeRoots(paths, launcherFacts ?? facts),
        log
      })
      launcherFor = script
    }

    // The policy is on disk before the launcher answers its first request (a fresh ledger folder included).
    launcherPolicy.rewrite()

    return launcher.start()
  }

  /** A launcher that is up validates against the spec it was started with: new profiles mean a new launcher. */
  const restartLauncher = async (): Promise<void> => {
    const running = launcher

    if (running && running.state() === 'up') {
      await running.stop()

      if (launcher === running) {
        await running.start()
      }
    }
  }

  const layer = {
    paths,
    refusals,
    backend: (id: ConfinementBackendId) => backends[id],
    active: () => backends[settings().backend],
    settings,
    setBackend(id: ConfinementBackendId): void {
      writeSettings(settingsDir, { ...settings(), backend: id }, sealedKey.key)
    },
    /** T7: the only way confinement goes off is main writing it, signed. The caller holds the gesture and, for off, the
     *  native dialog (isolation-switch.ts is the only caller). Without safeStorage an off lasts until the app quits. */
    setEnabled(enabled: boolean): void {
      turnedOnThisSession = enabled
      writeSettings(settingsDir, { ...settings(), enabled }, sealedKey.key)
    },
    /** True when an "off" written now outlives this main (the key is sealed in safeStorage). */
    settingsPersist: (): boolean => sealedKey.persistent,
    /** Whether a Hermes spawned now runs under the runtime profile, with the launcher (on + darwin). */
    runtimeConfined,
    /** Starts the launcher for this runtime (or finds it up). Resolves `down` when it is not ready in time: Hermes
     *  still runs confined and its commands are refused until the launcher answers. */
    ensureLauncher,
    /** fx7: the policy body main just published, written where the launcher reads it (launcher-policy.ts). The
     *  permission authority's signer calls this on every publish; a mode change in the UI is on disk at once. */
    publishLauncherPolicy: launcherPolicy.publish,
    /** fx13 (D13): the user allowed an ask — a pass for the folder it named and a time, never for a command text.
     *  The folder is one the user named (S2: "named in a permission"), and so listed, only when the sheet showed it
     *  (lens3-policy H3); a pass for a folder the user never saw is written as asked and lifts nothing, since the
     *  launcher narrows an unlisted folder before any pass is read. fx17 (lens4-pass M2): listed only while a pass
     *  or a grant for it is live, never for the app's lifetime as an opened folder is. */
    /** G28: the owner turned the Seatbelt off, the state spawnEnv tells the runtime. Not an unsupported platform. */
    seatbeltOff: (): boolean => (deps.platform ?? process.platform) === 'darwin' && !settings().enabled,
    /** G-98 F42: a launcher is listening, so an approved shell command can run once outside; and its record. */
    oneShotAvailable(cwd: string): boolean {
      return oneShotFolder(cwd) !== null && fs.existsSync(launcherSocketFile(deps.userDataDir))
    },
    issueOneShot(command: string, cwd: string): boolean {
      return oneShots.issue(command, cwd)
    },
    oneFileAvailable(file: string, home: string, ask: { link?: string | null; ignore?: boolean } = {}): boolean {
      return (
        oneShotRoute(file, home, oneFileRules(), { by: ask.ignore ? 'ignore' : undefined, link: ask.link }) &&
        fs.existsSync(launcherSocketFile(deps.userDataDir))
      )
    },
    oneFileLinkTarget,
    issueOneFile(file: string, home: string, by?: 'ignore', link?: string | null): boolean {
      return oneShots.issueFile(file, home, oneFileRules(), by, link)
    },
    issueOneRead(file: string, home: string, by?: 'ignore', link?: string | null): boolean {
      return oneShots.issueRead(file, home, oneFileRules(), by, link)
    },
    oneFileRuns(file: string, home: string): boolean {
      const spec = profiles[0]?.spec

      return spec ? fileRunsOrHoldsKeys(file, spec, home) : false
    },
    passFolder(pass: LauncherPass & { readonly shown: boolean; readonly grantId?: string | null }): void {
      launcherPolicy.noteAllowedAsk(pass)
    },
    /** fx12 (c): a folder a window has open; a confined command writes only inside a folder main lists. */
    noteProject: launcherPolicy.noteProject,
    /** Why `command` may not run outside the sandbox (judgeHelperInterpreter), or null when it may: asked before any
     *  unconfined probe of a spawn's interpreter, since the runtime must never choose what main runs unconfined. */
    interpreterRefusal(command: string): string | null {
      const trust = judgeHelperInterpreter(paths, command, launcherFacts)

      return trust.trusted ? null : trust.reason
    },
    /** The interpreter main's helpers run with now, or null and why not (for the state and the log). */
    helperInterpreter,
    /** A claim on the running launcher by one confined Hermes (the window's backend or a pool backend). The launcher
     *  stops when the last live claim is released; a replaced Hermes releasing its claim stops nothing while a newer
     *  one holds its own. Releasing twice is releasing once. */
    leaseLauncher(): () => Promise<void> {
      const lease = (nextLease += 1)

      leases.add(lease)

      return () => {
        if (!leases.delete(lease) || leases.size > 0) {
          return Promise.resolve()
        }

        // No confined Hermes is left: neither its launcher nor its profile is expected any more.
        runtimeProfile = null

        return stopLauncher()
      }
    },
    stopLauncher,
    /** `off` only when runtime confinement is not configured (confinement off, or not macOS); configured, a launcher
     *  that is not running is `down` like one that does not answer: either way every command is refused. */
    launcherState(): 'down' | 'off' | 'up' {
      if (!runtimeConfined()) {
        return 'off'
      }

      return launcher?.state() ?? 'down'
    },
    /** fx22: when the launcher running now started; null with none up. */
    launcherSince(): null | number {
      return launcher?.state() === 'up' ? launcherStartedAt : null
    },
    /** The runtime profile of the last Hermes spawn, for the state; null when off or before a spawn. */
    runtimeView(): RuntimeView | null {
      if (!runtimeConfined() || !runtimeProfile) {
        return null
      }

      const { reads, writes, denied } = runtimeProfile.view

      return { profileSha: runtimeProfile.sha256, reads: [...reads], writes: [...writes], denied: [...denied] }
    },
    /**
     * The runtime-only temp folder (beside the scratch root, 0700), set as the confined Hermes' TMPDIR and passed to
     * the runtime profile as TMP: never the whole per-user temp folder, and short enough for a unix socket made in it
     * (runtime-profile.ts). Throws when it is not a plain directory of ours.
     */
    runtimeTmpDir(): string {
      const dir = runtimeTmpFolder(paths.scratchRoot)

      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

      const stat = fs.lstatSync(dir)

      if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('the runtime temp folder is not a directory of this user')
      }

      // Through a descriptor: the runtime writes this folder and can replace it with a link after the check above.
      chmodFolderInRoot(path.dirname(dir), dir, 0o700)

      return realOrSelf(dir)
    },
    /** `command args` wrapped in the runtime profile: sandbox-exec with the profile text and this spawn's defines,
     *  then the command. Throws when a parameter the runtime needs cannot be given a safe value. */
    runtimeSpawn(command: string, args: readonly string[], facts: RuntimeSpawnFacts): RuntimeLaunch {
      const params = requiredRuntimeParams(paths, facts)

      // The command is what the kernel execs (the venv's `bin/python` beside its real folder); the interpreter fact
      // is the same binary by real path. Every link on either way is a literal the profile needs, or the spawn is
      // refused by name.
      const links = interpreterLinks(paths, [...new Set([command, facts.python])], facts)

      // The same binary is what main's helpers run next, outside every sandbox (spawnPython below): one the confined
      // runtime could replace is refused here too, so it never becomes a candidate.
      const trust = judgeHelperInterpreter(paths, command, facts)

      if (!trust.trusted) {
        throw new Error(`the agent runtime's interpreter is not trusted: ${trust.reason}`)
      }

      if (!runtimeText || runtimeTextLinks !== links.join('\n')) {
        runtimeText = generateRuntimeProfile(paths, { links })
        runtimeTextLinks = links.join('\n')
      }

      const profile = runtimeText
      const [head, flag, text, ...rest] = runtimeSandboxArgv(profile, params, command, args)

      if (head !== SANDBOX_EXEC_PATH || flag !== '-p' || text !== profile.text) {
        throw new Error('the runtime profile did not produce a sandbox-exec launch')
      }

      runtimeProfile = profile
      spawnPython = command

      return { command: head, args: [flag, text, ...rest], profile }
    },
    regenerate(): Promise<void> {
      profiles = generateProfiles(paths)

      return restartLauncher()
    },
    profiles: () => profiles,
    scan,
    async state(): Promise<ConfinementStateView> {
      const current = settings()
      const [snapshot, ...statuses] = await Promise.all([scan(), probe('seatbelt'), probe('container')])
      const disk = profilesOnDisk(profiles)
      const events = readRunEvents(ledgerFiles)
      const starts = runStarts(events)
      const specs = profiles.map(profile => profile.spec)
      const explained = explainRefusals(refusals.recent(RUN_REFUSALS_WINDOW), specs, starts, current.defaultClass)

      if (snapshot.verified && now().getTime() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = now().getTime()
        const live = membersOf(snapshot)

        sweepTokens(paths.membersDir, live, lastSweep)
        // A run still alive or still in the ledger keeps its count, however long since its last refusal.
        refusals.sweepRuns(lastSweep, [
          ...starts.keys(),
          ...[...live.values()].filter((run): run is string => run !== null)
        ])
      }

      const listed = capRuns(
        foldAllRuns({
          nowMs: snapshot.readAtMs ?? now().getTime(),
          events,
          rows: snapshot.rows,
          verified: snapshot.verified,
          // Each run's own file, not the newest window of the shared log: the number the row and the inspector show
          // does not move when the run ends or when other runs refuse more.
          refusals: refusals.runCounts(starts.keys())
        })
      )

      return foldState({
        now: now(),
        backend: current.backend,
        enabled: current.enabled,
        settingsPersist: sealedKey.persistent,
        defaultClass: current.defaultClass,
        backends: statuses,
        profiles: profiles.map(profileView),
        known: [...profiles.map(knownProfile), ...disk.variants],
        tampered: disk.tampered,
        rows: snapshot.rows,
        verified: snapshot.verified,
        membership: snapshot.probe,
        hermesPids: deps.hermesPids(),
        primaryPid: deps.primaryPid?.(),
        pluginAckPids: readAckPids(ackFile),
        pluginCommands: readAckCommands(ackFile),
        audit: deps.audit(),
        refusals: explained.slice(0, REFUSALS_LISTED),
        hardlinks: blockedProjects(),
        notes: [...(settingsIgnored ? [{ code: 'settings-ignored' } as const] : []), ...appearedNotes()],
        runs: listed.runs,
        runsCut: listed.cut,
        // The runtime profile and launcher main holds now; the deps override them only in tests.
        runtimeProfile: deps.runtime ? deps.runtime() : layer.runtimeView(),
        launcher: deps.launcher ? deps.launcher() : layer.launcherState(),
        darwin: (deps.platform ?? process.platform) === 'darwin'
      })
    },
    async kill(pid: number): Promise<KillResultView> {
      const snapshot = await scan()

      for (const backend of Object.values(backends)) {
        if (backend.list(snapshot).some(item => item.pid === pid)) {
          return backend.kill(pid)
        }
      }

      return { ok: false, pid, reason: 'not-confined', survivors: [], error: 'not a confined process' }
    },
    /**
     * The owner's Stop on one run: a fresh scan, then every process the kernel holds in that run's token, through the
     * backend's own kill (SIGTERM, then stopped-and-killed rounds until a scan finds none alive). The stop is recorded
     * before the first signal, so the ledger reads `stopped`, never `failed`, once the run ends; a kill that reports
     * survivors adds its outcome, so a run that later ends by itself never reads as stopped. The record never outranks
     * the signal: when the write fails (a full disk) the kill still goes out, and only the label is lost.
     */
    async stopRun(run: string): Promise<StopRunResultView> {
      if (!isRunToken(run)) {
        return { ok: false, run: '', reason: 'invalid', survivors: [], error: 'invalid run' }
      }

      const snapshot = await scan().catch((error: unknown) => {
        log(`[confinement] the scan for the stop of ${run} failed: ${String(error)}`)

        return null
      })

      if (!snapshot?.verified) {
        return {
          ok: false,
          run,
          reason: 'unverified',
          survivors: [],
          error: 'the kernel could not be asked which processes belong to this run'
        }
      }

      // The oldest member first: the root while it lives, so the backend's kill takes its tree and its token together.
      const own = snapshot.rows.filter(row => row.run === run)

      // fx26a, fx28: a process whose token is gone has one owner at most (orphanOwners), and this Stop is that row's.
      const adopted =
        orphanOwners({
          events: readRunEvents(ledgerFiles),
          nowMs: snapshot.readAtMs ?? now().getTime(),
          rows: snapshot.rows,
          verified: true
        }).owners.get(run) ?? []

      const members = [...own, ...adopted].sort((a, b) => b.elapsedSec - a.elapsedSec)

      const backend = Object.values(backends).find(item =>
        item.list(snapshot).some(process => members.some(member => member.pid === process.pid))
      )

      if (members.length === 0) {
        const group = outsideGroupOf(readRunEvents(ledgerFiles), run)

        if (
          group !== undefined &&
          outsideGroupMembers(group, snapshot.rows).length > 0 &&
          !snapshot.rows.some(row => row.pid === process.pid && row.pgid === group)
        ) {
          return stopOutsideGroup(run, group)
        }
      }

      if (members.length === 0 || !backend) {
        return { ok: false, run, reason: 'not-running', survivors: [], error: 'no process of this run is alive' }
      }

      const pressedAt = now().toISOString()

      const recordStop = (outcome?: 'failed') => {
        try {
          appendStop(ledgerFiles.stopsFile, run, pressedAt, outcome)
        } catch (error) {
          log(`[confinement] could not record the stop of ${run}: ${String(error)}`)
        }
      }

      recordStop()

      const listed = new Set(backend.list(snapshot).map(process => process.pid))
      const target = members.find(member => listed.has(member.pid)) as (typeof members)[number]

      const result = await backend.kill(target.pid).catch((error: unknown) => {
        log(`[confinement] the kill of ${run} failed: ${String(error)}`)

        return {
          ok: false as const,
          pid: target.pid,
          reason: 'survivors' as const,
          survivors: members.map(member => member.pid),
          error: String(error)
        }
      })

      // Each adopted process may be its own root: the kill above took only the tree of the first. One already gone with
      // that tree answers not-confined. Any survivor makes the whole Stop a failed one: it did not end the run.
      const killed = result.ok ? [...result.killed] : []
      const survivors = result.ok ? [] : [...result.survivors]
      let failure = result.ok ? null : result

      for (const other of adopted.filter(row => row.pid !== target.pid)) {
        const answer = await backend.kill(other.pid).catch((error: unknown) => ({
          ok: false as const,
          pid: other.pid,
          reason: 'survivors' as const,
          survivors: [other.pid],
          error: String(error)
        }))

        if (answer.ok) {
          killed.push(...answer.killed)
        } else if (answer.reason !== 'not-confined') {
          survivors.push(...answer.survivors)
          failure = failure ?? answer
        }
      }

      if (failure) {
        recordStop('failed')

        return { ok: false, run, reason: failure.reason, survivors, error: failure.error }
      }

      return { ok: true, run, killed }
    },
    /** F7/T2: the owner allows the hard-linked files under one directory of this project, exactly the set the pane
     *  showed (ipc.ts has checked the gesture). */
    async acknowledgeHardlink(root: string, dir: string, digest: string): Promise<HardlinkAckResultView> {
      const result = await hardlinks.acknowledgeGroup(root, dir, digest)

      measuredAt.delete(root)

      return result.ok ? { ok: true, dir: result.dir, count: result.count } : result
    },
    async explain(pid: number): Promise<string[]> {
      return backends[settings().backend].explain(pid, await scan())
    },
    /** The env one Hermes spawn needs to route its terminal through the layer. */
    spawnEnv(): Record<string, string> {
      const current = settings()

      // Linux and Windows backends are not in this release (owner decision D3): their shell stays as it was, and
      // the state reads the backend as unsupported rather than pretending.
      if ((deps.platform ?? process.platform) !== 'darwin') {
        return {}
      }

      // Off is a state the runtime is told, by the value only main sets at exec: no profile, no launcher, no pin, and an
      // ICLONE_CONFINEMENT inherited or written by a dotenv means nothing (iclone_policy_env.isolation_off).
      if (!current.enabled) {
        return { ICLONE_CONFINEMENT: 'off' }
      }

      sweepAcks(ackFile)

      return {
        ICLONE_CONFINEMENT: '1',
        ICLONE_CONFINEMENT_DIR: paths.profilesDir,
        ICLONE_CONFINEMENT_CLASS: current.defaultClass,
        // The hashes the plugin checks every profile against, and where it says it loaded (F2, F5).
        ICLONE_CONFINEMENT_SPEC: pluginSpec(paths, profiles, storeRoots),
        ICLONE_CONFINEMENT_ACK: ackFile,
        // Verifies the owner's hard-link acknowledgements (F7); popped at import like the spec.
        ICLONE_CONFINEMENT_LINK_KEY: hardlinks.keyHex(),
        TERMINAL_ENV: HERMES_BACKEND_NAME[current.backend],
        // Hermes runs under the runtime profile; its confined commands go through the launcher on this socket.
        ICLONE_CONFINEMENT_LAUNCHER: launcherSocket,
        ICLONE_RUNTIME_CONFINED: '1',
        // fx18 (F3): the user's name and e-mail for the session's own git config, and nothing else of ~/.gitconfig.
        ...gitIdentityEnv(
          deps.gitIdentity ? deps.gitIdentity() : readGlobalGitIdentity(deps.home, process.env.XDG_CONFIG_HOME)
        )
      }
    }
  }

  registry.layer = layer

  return layer
}

export type Confinement = ReturnType<typeof createConfinement>

/** One slot, replaced by every createConfinement: which layer the Hermes spawn path asks (never a count of anything). */
const registry: { layer: Confinement | null } = { layer: null }

/** The layer main registered (the latest one created), for the Hermes spawn path; null before registration. */
export function currentConfinement(): Confinement | null {
  return registry.layer
}
