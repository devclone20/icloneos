/**
 * iclone os — App Atualisation: the facts behind both update tracks.
 *
 * Track A is the Hermes runtime beneath the app (HERMES_HOME/hermes-agent),
 * which `hermes update` pulls RAW. `iclone:runtime-status` reports where it
 * stands from local reads only — HEAD, clean/dirty, the last update receipt,
 * the backups — and never spawns `hermes`. The behind-count for Track A is the
 * desktop's own updater (`hermes:updates:check`); this module does not repeat it.
 *
 * Track B is the iclone os source, which upstream reaches only through the
 * curated process. `iclone:upstream-check` is its COLLECT stage: git fetch +
 * counts + the newest release tag. It never merges, never rebuilds, never
 * touches the working tree.
 *
 * THE COUNTING TRAP. iclone os is a vendor SNAPSHOT of the upstream tree, not
 * a git fork: the root commit is a parentless import, so HEAD and
 * upstream/main share no ancestor at all. `rev-list --count HEAD..upstream/main`
 * therefore answers a different question than it looks like it answers — it
 * counts upstream's whole history. On 2026-08-30 it said 26354 while the true
 * distance was 486, and that number went straight into the mission the agent
 * receives. Every count here is anchored on the recorded import base
 * (`iclone/UPSTREAM_BASE`) instead, and when that anchor cannot be resolved
 * this module reports itself unavailable rather than returning a number that
 * is confidently wrong.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain } from 'electron'

import { errorMessage } from '../src/iclone-shared/errors'
import type {
  IcloneRuntimeStatus,
  IcloneUpstreamCheckOptions,
  IcloneUpstreamDiff,
  IcloneUpstreamStatus
} from '../src/iclone-shared/update-status'

import { readLastAgentUpdate } from './agent-update'
import { parseLatestReleaseTag } from './agent-update-tags'
import { normalizeHermesHomeRoot } from './backend-env'
import { readRuntimeVersion } from './iclone-app-update'
import { initIcloneCompat } from './iclone-compat'
import { readManagedStamp } from './iclone-managed-runtime'
import { appRuntimeRoot, devBackendRootsFor } from './iclone-runtime-location'
import { codePathEnv } from './packaged-env'

const UPSTREAM_REMOTE = 'upstream'
const BASE_FILE = path.join('iclone', 'UPSTREAM_BASE')
/** A fetch of an 18k-commit remote is not something a Settings click should repeat. */
export const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000
/** A failed fetch (offline, auth) is not retried by a non-forced check inside this window. */
export const UPSTREAM_FAILURE_TTL_MS = 5 * 60 * 1000

/**
 * Upstream's tags live in a namespace only this fetch writes. refs/tags is
 * shared with the fork's own tags (and origin's), where a fork `v*` tag would
 * read as upstream's newest release and become the re-import target.
 */
const UPSTREAM_TAG_REFS = `refs/remotes/${UPSTREAM_REMOTE}/tags`

/** `+` overwrites a tag upstream moved instead of rejecting the whole fetch. */
const UPSTREAM_REFSPECS = [
  `+refs/heads/main:refs/remotes/${UPSTREAM_REMOTE}/main`,
  `+refs/tags/*:${UPSTREAM_TAG_REFS}/*`
]

const RECEIPT_MAX_BYTES = 256 * 1024
const RECEIPT_DETAIL_MAX = 240

// ── Pure parsers ───────────────────────────────────────────────────────────

/**
 * The sha recorded in `iclone/UPSTREAM_BASE`: first bare 40-hex line, with
 * `#` comments and blank lines ignored. Null when the file says nothing
 * usable — callers must not invent a fallback number.
 */
export function parseUpstreamBase(text: string): null | string {
  for (const line of String(text ?? '').split('\n')) {
    const value = line.trim()

    if (!value || value.startsWith('#')) {
      continue
    }

    return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
  }

  return null
}

/**
 * Fallback anchor for a checkout that predates the base file: the import
 * commit names the sha it snapshotted, e.g.
 * `chore: import hermes-agent @ 10b38830 (upstream main, v0.20.6 era)`.
 */
export function parseImportCommitSubject(subject: string): null | string {
  const match = /\bimport\s+hermes-agent\s+@\s*([0-9a-f]{7,40})\b/i.exec(String(subject ?? ''))

  return match ? match[1].toLowerCase() : null
}

/** `1324 files changed, 99189 insertions(+), 41677 deletions(-)` */
export function parseShortstat(text: string): IcloneUpstreamDiff | null {
  const value = String(text ?? '')
  const files = /(\d+)\s+files?\s+changed/.exec(value)

  if (!files) {
    return null
  }

  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(value)
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(value)

  return {
    deletions: deletions ? Number.parseInt(deletions[1], 10) : 0,
    files: Number.parseInt(files[1], 10),
    insertions: insertions ? Number.parseInt(insertions[1], 10) : 0
  }
}

/**
 * The for-each-ref format `parseLatestReleaseTag` reads over UPSTREAM_TAG_REFS:
 * tag name (refs/remotes/upstream/tags/ stripped), object, peeled object, date.
 */
const TAG_FORMAT = '%(refname:lstrip=4)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)'

function record(value: unknown): null | Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

interface UpdaterRootInputs {
  hasGit: (root: string) => boolean
  isSourceRoot: (root: string) => boolean
  override?: string
  packaged: boolean
  runtimeRoot: string
  sourceRoot: string
}

/**
 * The tree the desktop's own updater fetches and rewrites — main.ts
 * `resolveUpdateRoot()`, restated because that function is not exported.
 * In a dev run it is the FORK checkout, not the runtime.
 */
export function pickUpdaterRoot({
  hasGit,
  isSourceRoot,
  override,
  packaged,
  runtimeRoot,
  sourceRoot
}: UpdaterRootInputs): string {
  const candidates = [
    override ? path.resolve(override) : null,
    !packaged && isSourceRoot(sourceRoot) ? sourceRoot : null,
    isSourceRoot(runtimeRoot) ? runtimeRoot : null
  ].filter((root): root is string => Boolean(root))

  return candidates.find(hasGit) ?? candidates[0] ?? runtimeRoot
}

// ── The upstream cache ─────────────────────────────────────────────────────

interface UpstreamCacheEntry {
  at: number
  value: IcloneUpstreamStatus
}

interface UpstreamCache {
  /** The last attempt, when it failed after (or without) the good answer. */
  failure: null | UpstreamCacheEntry
  /** The last good answer. */
  good: null | UpstreamCacheEntry
}

export const EMPTY_UPSTREAM_CACHE: UpstreamCache = { failure: null, good: null }

export const UPSTREAM_NOT_CHECKED: IcloneUpstreamStatus = {
  available: false,
  reason: 'Not checked yet - press Check upstream now.',
  unchecked: true
}

/** The good answer carrying the failure that followed it, else the failure alone. */
function cacheAnswer({ failure, good }: UpstreamCache): IcloneUpstreamStatus | null {
  if (!good) {
    return failure?.value ?? null
  }

  return failure ? { ...good.value, refreshError: failure.value.reason ?? 'unavailable' } : good.value
}

/**
 * What the cache can answer without git — or null when the caller must fetch.
 * `cacheOnly` always answers (never null); `force` never does; otherwise a
 * good answer serves until `ttlMs` and a failure until `failureTtlMs`.
 */
export function cachedUpstream(
  cache: UpstreamCache,
  { cacheOnly = false, force = false }: IcloneUpstreamCheckOptions,
  now: number,
  ttlMs = UPSTREAM_TTL_MS,
  failureTtlMs = UPSTREAM_FAILURE_TTL_MS
): IcloneUpstreamStatus | null {
  if (cacheOnly) {
    return cacheAnswer(cache) ?? { ...UPSTREAM_NOT_CHECKED }
  }

  if (force) {
    return null
  }

  const goodFresh = cache.good !== null && now - cache.good.at < ttlMs
  const failureFresh = cache.failure !== null && now - cache.failure.at < failureTtlMs

  return goodFresh || failureFresh ? cacheAnswer(cache) : null
}

/** A good answer replaces everything; a failure never erases the last good answer. */
export function settleUpstream(
  cache: UpstreamCache,
  value: IcloneUpstreamStatus,
  now: number
): { answer: IcloneUpstreamStatus; cache: UpstreamCache } {
  const entry = { at: now, value }
  const next: UpstreamCache = value.available ? { failure: null, good: entry } : { failure: entry, good: cache.good }

  return { answer: cacheAnswer(next) ?? value, cache: next }
}

/**
 * The Collect stage behind one cache. Every git run is a real fetch of an
 * 18k-commit remote, so concurrent callers share the one in flight.
 */
export function createUpstreamChecker(
  run: () => Promise<IcloneUpstreamStatus>,
  now: () => number = Date.now
): (options?: IcloneUpstreamCheckOptions) => Promise<IcloneUpstreamStatus> {
  let cache = EMPTY_UPSTREAM_CACHE
  let inflight: null | Promise<IcloneUpstreamStatus> = null

  return (options = {}) => {
    const hit = cachedUpstream(cache, options, now())

    if (hit) {
      return Promise.resolve(hit)
    }

    inflight ??= run()
      .catch((error: unknown): IcloneUpstreamStatus => ({ available: false, reason: errorMessage(error) }))
      .then(value => {
        const settled = settleUpstream(cache, value, now())
        cache = settled.cache

        return settled.answer
      })
      .finally(() => {
        inflight = null
      })

    return inflight
  }
}

// ── git + filesystem ───────────────────────────────────────────────────────

function git(cwd: string, args: string[], timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    // A credential prompt would hang the fetch for its whole timeout; LC_ALL=C
    // keeps git's messages English whatever the owner's locale is.
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C'
    }

    execFile('git', args, { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout.trim())

        return
      }

      const said = String(stderr ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(' ')

      const why = error.killed ? `timed out after ${Math.round(timeout / 1000)} s` : said

      reject(new Error(why ? `git ${args[0]}: ${why}` : error.message))
    })
  })
}

// Mirrors main.ts resolveHermesHome() for the platforms iclone os ships
// (macOS, Linux); the Windows registry and LOCALAPPDATA branches do not apply.
function hermesHome(): string {
  const homeOverride = codePathEnv('HERMES_HOME')

  if (homeOverride) {
    return normalizeHermesHomeRoot(homeOverride)
  }

  const userDataOverride = codePathEnv('HERMES_DESKTOP_USER_DATA_DIR')

  if (userDataOverride) {
    return path.join(path.resolve(userDataOverride), 'hermes-home')
  }

  return path.join(app.getPath('home'), '.hermes')
}

function directoryExists(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// Mirrors main.ts isHermesSourceRoot()/resolveUpdateRoot(): a worktree's
// `.git` FILE does not count there, so it must not count here either.
function isHermesSourceRoot(root: string): boolean {
  return directoryExists(root) && existsSync(path.join(root, 'hermes_cli', 'main.py'))
}

function forkRoot(): null | string {
  // dev: appPath = apps/desktop inside the fork checkout; packaged builds
  // have no checkout — the pane then explains where curation happens.
  const candidate = path.resolve(app.getAppPath(), '..', '..')

  return existsSync(path.join(candidate, '.git')) ? candidate : null
}

// ── Track A: the runtime ───────────────────────────────────────────────────

interface RuntimeStatusInputs {
  /** HERMES_HOME. */
  home: string
  /**
   * V3-RT (M2, ruling 36): the app's own runtime (`<userData>/hermes-runtime/<sha>`). A packaged app describes this
   * tree from its stamp and never runs git anywhere — least of all in the user's `~/.hermes/hermes-agent`.
   */
  managedRoot?: string
  packaged: boolean
  /** The checkout a dev run is built from (apps/desktop/../..). */
  sourceRoot: string
  /** HERMES_DESKTOP_HERMES_ROOT. */
  updaterOverride?: string
}

function runtimeInputs(): RuntimeStatusInputs {
  const packaged = app.isPackaged || Boolean(codePathEnv('HERMES_DESKTOP_IS_PACKAGED'))

  return {
    home: hermesHome(),
    ...(packaged ? { managedRoot: appRuntimeRoot(app.getPath('userData')) } : {}),
    packaged: app.isPackaged || Boolean(codePathEnv('HERMES_DESKTOP_IS_PACKAGED')),
    sourceRoot: path.resolve(app.getAppPath(), '..', '..'),
    updaterOverride: codePathEnv('HERMES_DESKTOP_HERMES_ROOT')
  }
}

export async function readRuntimeStatus({
  home,
  managedRoot,
  packaged,
  sourceRoot,
  updaterOverride
}: RuntimeStatusInputs): Promise<IcloneRuntimeStatus> {
  if (packaged && managedRoot) {
    return managedRuntimeStatus(home, managedRoot)
  }

  const runtimeRoot = path.join(home, 'hermes-agent')

  const updaterRoot = pickUpdaterRoot({
    hasGit: root => directoryExists(path.join(root, '.git')),
    isSourceRoot: isHermesSourceRoot,
    override: updaterOverride,
    packaged,
    runtimeRoot,
    sourceRoot
  })

  // H1b: the old updater's receipt list, zips and rollback clones are no longer read (moved to the Trash once,
  // electron/legacy-update-cleanup.ts). U1: the last update alone, as the pane's receipt card.
  const base = {
    // V3-S r4 (ruling 36): a dev-backend checkout runs instead of the app's own runtime.
    unmanaged:
      devBackendRootsFor({ isSourceRoot: isHermesSourceRoot, override: updaterOverride, packaged, sourceRoot }).length >
      0,
    backupZip: null,
    branch: null,
    dirty: null,
    head: null,
    lastUpdate: readLastAgentUpdate(home),
    readAt: new Date().toISOString(),
    receipt: null,
    rollbackClones: [],
    runtimeRoot,
    shallow: null,
    updaterRoot,
    updaterRootIsRuntime: path.resolve(updaterRoot) === path.resolve(runtimeRoot),
    version: readRuntimeVersion(runtimeRoot)
  }

  if (!existsSync(path.join(runtimeRoot, '.git'))) {
    return { ...base, available: false, reason: `${runtimeRoot} is not a git checkout.` }
  }

  try {
    const [headRaw, branch, porcelain, shallow] = await Promise.all([
      git(runtimeRoot, ['log', '-1', '--format=%H%x09%cI%x09%s', 'HEAD']),
      git(runtimeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      git(runtimeRoot, ['status', '--porcelain']).then(
        out => out.length > 0,
        () => null
      ),
      git(runtimeRoot, ['rev-parse', '--is-shallow-repository']).catch(() => '')
    ])

    const [sha = '', date = '', ...subject] = headRaw.split('\t')

    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ...base, available: false, reason: `git could not read HEAD in ${runtimeRoot}.` }
    }

    return {
      ...base,
      available: true,
      branch: branch && branch !== 'HEAD' ? branch : null,
      dirty: porcelain,
      head: { date, sha, short: sha.slice(0, 10), subject: subject.join('\t') },
      shallow: shallow === 'true' ? true : shallow === 'false' ? false : null
    }
  } catch (error) {
    return { ...base, available: false, reason: errorMessage(error) }
  }
}

/**
 * V3-RT (M2): the app's own runtime, described without git — the stamp the installer wrote names the runtime sha, and
 * the integrity check before every spawn holds the tree to the release's manifest (so it is never "dirty"). No
 * rollback is offered from here: the runtime is the one this release ships.
 */
function managedRuntimeStatus(home: string, managedRoot: string): IcloneRuntimeStatus {
  const stamp = readManagedStamp(managedRoot)

  const base = {
    backupZip: null,
    branch: null,
    dirty: null,
    head: null,
    lastUpdate: readLastAgentUpdate(home),
    readAt: new Date().toISOString(),
    receipt: null,
    rollbackClones: [],
    runtimeRoot: managedRoot,
    shallow: null,
    unmanaged: false,
    updaterRoot: managedRoot,
    updaterRootIsRuntime: true,
    version: readRuntimeVersion(managedRoot)
  }

  if (!stamp || !/^[0-9a-f]{40}$/.test(stamp.runtimeSha)) {
    return { ...base, available: false, reason: `the app's runtime is not installed yet (${managedRoot}).` }
  }

  return {
    ...base,
    available: true,
    dirty: false,
    head: {
      date: stamp.installedAt,
      sha: stamp.runtimeSha,
      short: stamp.runtimeSha.slice(0, 10),
      subject: "icloneOS runtime, verified against this release's manifest"
    },
    shallow: false
  }
}

// ── Track B: the fork vs upstream ──────────────────────────────────────────

/** The import anchor: the base file first, the root commit's subject second. */
async function resolveUpstreamBase(root: string): Promise<null | string> {
  const file = path.join(root, BASE_FILE)

  if (existsSync(file)) {
    const recorded = parseUpstreamBase(readFileSync(file, 'utf8'))

    if (recorded) {
      return recorded
    }
  }

  try {
    const subject = await git(root, ['log', '--reverse', '--format=%s', '--max-parents=0', '-1'])
    const sha = parseImportCommitSubject(subject)

    // A short sha cannot be fetched by name; only a full one is an anchor.
    return sha && sha.length === 40 ? sha : null
  } catch {
    return null
  }
}

/**
 * The Collect stage in the checkout at `root` (null: this build has none).
 * It fetches upstream into its own refs and measures; it never merges.
 */
export async function checkUpstreamOnce(root: null | string): Promise<IcloneUpstreamStatus> {
  if (!root) {
    return {
      available: false,
      reason:
        'This installed build carries no git checkout, so Track B cannot be measured from here. ' +
        'It runs in the iclone os source checkout: open this pane from a dev run there, or start ' +
        'the mission and Hermes runs the Collect stage itself.'
    }
  }

  try {
    const remotes = await git(root, ['remote'])

    if (!remotes.split('\n').includes(UPSTREAM_REMOTE)) {
      return { available: false, reason: `Remote "${UPSTREAM_REMOTE}" is not configured in this checkout.` }
    }

    const upstreamBase = await resolveUpstreamBase(root)

    if (!upstreamBase) {
      return {
        available: false,
        reason:
          `Cannot resolve the upstream import base: ${BASE_FILE} is missing or malformed and the ` +
          'root commit does not name the sha it imported. Without that anchor every distance is ' +
          'meaningless — this fork shares no ancestor with upstream. Record the sha in that file.'
      }
    }

    await git(root, ['fetch', '--quiet', '--no-tags', UPSTREAM_REMOTE, ...UPSTREAM_REFSPECS], 180000)

    // The anchor is an upstream commit; a shallow or partial object store may
    // not have it yet. Fetching it by sha only adds objects.
    try {
      await git(root, ['cat-file', '-e', `${upstreamBase}^{commit}`])
    } catch {
      await git(root, ['fetch', '--quiet', '--no-tags', UPSTREAM_REMOTE, upstreamBase], 180000)
    }

    const range = `${upstreamBase}..${UPSTREAM_REMOTE}/main`

    const [base, baseSubject, behindRaw, recentRaw, tip, shortstat, tagsRaw, ownRaw] = await Promise.all([
      git(root, ['rev-parse', '--short', 'HEAD']),
      git(root, ['log', '-1', '--format=%s', 'HEAD']),
      git(root, ['rev-list', '--count', range]),
      git(root, ['log', '--format=%h %s', '-8', `${UPSTREAM_REMOTE}/main`]),
      git(root, ['log', '-1', '--format=%h %s', `${UPSTREAM_REMOTE}/main`]),
      // Two dots, not three: `...` needs a merge base, which does not exist.
      git(root, ['diff', '--shortstat', upstreamBase, `${UPSTREAM_REMOTE}/main`], 120000),
      git(root, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, `${UPSTREAM_TAG_REFS}/v*`]).catch(
        () => ''
      ),
      // --min-parents=1 leaves out the parentless import: it is replaced, not replayed.
      git(root, ['rev-list', '--count', '--min-parents=1', 'HEAD', '--not', upstreamBase]).catch(() => '')
    ])

    const behind = Number.parseInt(behindRaw, 10)

    if (!Number.isFinite(behind)) {
      return { available: false, reason: `git could not count the range ${range}: "${behindRaw}"` }
    }

    const ownCommits = Number.parseInt(ownRaw, 10)

    return {
      available: true,
      baseCommit: base,
      baseSubject,
      behind,
      diff: parseShortstat(shortstat) ?? undefined,
      fetchedAt: new Date().toISOString(),
      latestTag: parseLatestReleaseTag(tagsRaw),
      ownCommits: Number.isFinite(ownCommits) ? ownCommits : undefined,
      recent: recentRaw ? recentRaw.split('\n') : [],
      upstreamBase: upstreamBase.slice(0, 10),
      upstreamTip: tip
    }
  } catch (error) {
    return { available: false, reason: errorMessage(error) }
  }
}

export { parseLatestReleaseTag }

let initialized = false

export function initIcloneUpdates() {
  if (initialized) {
    return
  }

  initialized = true

  const checkUpstream = createUpstreamChecker(() => checkUpstreamOnce(forkRoot()))

  ipcMain.handle('iclone:upstream-check', (_event, options: unknown) => {
    const asked = record(options)

    return checkUpstream({ cacheOnly: asked?.cacheOnly === true, force: asked?.force === true })
  })
  ipcMain.handle('iclone:runtime-status', () => readRuntimeStatus(runtimeInputs()))
  initIcloneCompat()
}
