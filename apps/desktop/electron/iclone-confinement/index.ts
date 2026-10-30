/**
 * V3-G — the confinement layer's composition root: one setting picks the backend, main generates the profiles at
 * boot, probes both backends, and folds `state` on demand. Flipping the backend edits the setting and nothing else
 * (G6). Confinement stays on in every permission mode, Ignore permissions included: Ignore only skips the asks
 * (owner decision D2, contract default).
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
  type RefusalView
} from '../../src/iclone-shared/confinement'
import { confinementMembersDir } from '../iclone-permissions/classify-policy'
import { writeFileAtomicSync } from '../lib/atomic-write'

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
import { createMemberProbe, ensureMembersDir, sweepTokens } from './members'
import { probeContainer, probeFailedView, probeSeatbelt } from './probe'
import { type ConfinementPaths, realOrSelf } from './profiles'
import { createRefusalLog } from './refusals'
import { type AuditSlice, foldState, type PsRow, readPs, type Snapshot, withMembership } from './state'

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
}

function confinementPaths(
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

/** The pid the Hermes plugin wrote when it registered (`{"pid": n}`); a missing or malformed file acknowledges nothing. */
export function readAckPids(file: string): number[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const pid = Number(raw.pid)

    return Number.isInteger(pid) && pid > 1 ? [pid] : []
  } catch {
    return []
  }
}

export function createConfinement(deps: ConfinementDeps) {
  const paths = confinementPaths(deps)
  const settingsDir = path.join(deps.userDataDir, 'confinement')
  const now = deps.now ?? (() => new Date())
  const ps = deps.ps ?? readPs
  const refusals = createRefusalLog(path.join(settingsDir, 'refusals'))
  const ackFile = path.join(settingsDir, 'run', 'hermes-ack.json')
  const linkFiles = hardlinkFiles(deps.userDataDir)
  const audit = (event: HardlinkAuditEvent) => refusals.append(auditRow(event, now().toISOString()))

  // One key signs the hard-link record (T5) and the settings file (T7): sealed in safeStorage when the owner's
  // keychain policy allows it, else this session's, in which case nothing either file held before is read back.
  const sealedKey: SealedKey = bootSealedKey({
    keyFile: linkFiles.key,
    keyStore: deps.keyStore ?? null,
    onAudit: audit
  })

  let profiles: GeneratedProfile[] = generateProfiles(paths)

  // T2'': the pnpm store roots a `build` run may be linked into without a gesture; main's env names $PNPM_HOME.
  // r5 MINOR-2: never one of the denied directories (the profiles' list), the Hermes home or the app's own data.
  const storeDenied = [...(profiles[0]?.spec.denied ?? []), realOrSelf(deps.hermesHome), realOrSelf(deps.userDataDir)]
  const storeRoots = deps.pnpmStoreRoots ?? pnpmStoreRoots(process.env.PNPM_HOME, deps.home, storeDenied)
  const hardlinks = createHardlinkGuard({ ackFile: linkFiles.acks, sealedKey, now, onAudit: audit, storeRoots })
  const measuredAt = new Map<string, number>()
  const settingsFile = path.join(settingsDir, SETTINGS_FILE)
  let settingsIgnored: SignedFileRejection | null = null

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

    return read.settings
  }

  settings()

  ensureMembersDir(paths.membersDir)

  const memberProbe =
    deps.memberPython && fs.existsSync(deps.memberPython)
      ? createMemberProbe(paths.membersDir, deps.memberPython)
      : null

  const scan = async (): Promise<Snapshot> => withMembership(await ps(), memberProbe)
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
  const blockedProjects = (): HardlinkBlockView[] => {
    const at = now().getTime()
    const roots = new Set([...readHardlinkReportRoots(linkFiles.report), ...hardlinks.blocked().map(b => b.root)])

    for (const root of roots) {
      if (at - (measuredAt.get(root) ?? 0) >= BLOCK_RECHECK_MS) {
        measuredAt.set(root, at)
        hardlinks.check(root)
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

  return {
    paths,
    refusals,
    backend: (id: ConfinementBackendId) => backends[id],
    active: () => backends[settings().backend],
    settings,
    setBackend(id: ConfinementBackendId): void {
      writeSettings(settingsDir, { ...settings(), backend: id }, sealedKey.key)
    },
    /** T7: the only way confinement goes off is main writing it, signed (the caller holds the gesture: a real click
     *  on the Settings row, isTrustedSender). Without safeStorage it lasts until the app quits. */
    setEnabled(enabled: boolean): void {
      writeSettings(settingsDir, { ...settings(), enabled }, sealedKey.key)
    },
    /** True when an "off" written now outlives this main (the key is sealed in safeStorage). */
    settingsPersist: (): boolean => sealedKey.persistent,
    regenerate(): void {
      profiles = generateProfiles(paths)
    },
    profiles: () => profiles,
    scan,
    async state(): Promise<ConfinementStateView> {
      const current = settings()
      const [snapshot, ...statuses] = await Promise.all([scan(), probe('seatbelt'), probe('container')])
      const disk = profilesOnDisk(profiles)

      if (snapshot.verified && now().getTime() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = now().getTime()
        sweepTokens(paths.membersDir, membersOf(snapshot), lastSweep)
      }

      return foldState({
        now: now(),
        backend: current.backend,
        enabled: current.enabled,
        defaultClass: current.defaultClass,
        backends: statuses,
        profiles: profiles.map(profileView),
        known: [...profiles.map(knownProfile), ...disk.variants],
        tampered: disk.tampered,
        rows: snapshot.rows,
        verified: snapshot.verified,
        hermesPids: deps.hermesPids(),
        pluginAckPids: readAckPids(ackFile),
        audit: deps.audit(),
        refusals: refusals.recent(100),
        hardlinks: blockedProjects(),
        notes: [...(settingsIgnored ? [{ code: 'settings-ignored' } as const] : []), ...appearedNotes()]
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
    /** F7/T2: the owner allows the hard-linked files under one directory of this project, exactly the set the pane
     *  showed (ipc.ts has checked the gesture). */
    acknowledgeHardlink(root: string, dir: string, digest: string): HardlinkAckResultView {
      const result = hardlinks.acknowledgeGroup(root, dir, digest)

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
      if (!current.enabled || (deps.platform ?? process.platform) !== 'darwin') {
        return {}
      }

      return {
        ICLONE_CONFINEMENT: '1',
        ICLONE_CONFINEMENT_DIR: paths.profilesDir,
        ICLONE_CONFINEMENT_CLASS: current.defaultClass,
        // The hashes the plugin checks every profile against, and where it says it loaded (F2, F5).
        ICLONE_CONFINEMENT_SPEC: pluginSpec(paths, profiles, storeRoots),
        ICLONE_CONFINEMENT_ACK: ackFile,
        // Verifies the owner's hard-link acknowledgements (F7); popped at import like the spec.
        ICLONE_CONFINEMENT_LINK_KEY: hardlinks.keyHex(),
        TERMINAL_ENV: HERMES_BACKEND_NAME[current.backend]
      }
    }
  }
}

export type Confinement = ReturnType<typeof createConfinement>
