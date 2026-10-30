/**
 * bootstrap-runner.ts
 *
 * Drives apps/desktop's first-launch install of Hermes Agent by spawning
 * scripts/install.ps1 stage-by-stage and streaming progress events back to
 * the renderer.
 *
 * Wired from electron/main.ts:
 *   import { runBootstrap }from './bootstrap-runner'
 *   const result = await runBootstrap({
 *     installStamp,        // INSTALL_STAMP from main.ts (may be null in dev)
 *     activeRoot,          // ACTIVE_HERMES_ROOT
 *     sourceRepoRoot,      // SOURCE_REPO_ROOT (for dev install.ps1 lookup)
 *     hermesHome,          // HERMES_HOME
 *     logRoot,             // HERMES_HOME/logs
 *     emit: ev => {...}    // event sink (sender.send or similar)
 *   })
 *
 * Emits BootstrapEvent objects (typed below) and resolves with the same shape
 * as the final 'complete' or 'failed' event so callers can await either way.
 *
 * NOT implemented yet (deferred to Phase 1E / 1F):
 *   - User-facing retry / cancel from the renderer (event channels exist;
 *     no UI consumes them yet)
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { errorMessage } from '../src/iclone-shared/errors'
import { latestReleaseAssetUrl } from '../src/iclone-shared/public-repo'

import { readRuntimeChoice, repairCommit } from './agent-update'
import { resolveWindowsPowerShell } from './bootstrap-platform'
import { managedStampFor, readManagedStamp, RUNTIME_MANIFEST_FILE, writeManagedStamp } from './iclone-managed-runtime'
import {
  beginInstallBudget,
  cpuProgressed,
  INSTALL_CEILING_MS,
  INSTALL_HEARTBEAT_MS,
  INSTALL_PROBE_DEADLINE_MS,
  INSTALL_SAMPLE_MS,
  INSTALL_STALL_MS,
  INSTALL_WATCHDOG_TAG,
  sampleTreeCpu,
  settleWithin,
  treeBytes,
  type TreeCpu
} from './install-liveness'
import { replaceDirAtomicSync, writeStreamAtomic } from './lib/atomic-write'
import { writeJsonAtomicSync } from './lib/fs-json'
import { runGit } from './lib/git'
import { codePathEnv } from './packaged-env'
import { RUNTIME_PIN } from './runtime-pin.generated'
import type { UpdatePolicy } from './update-policy'
import { hiddenWindowsChildOptions } from './windows-child-options'

// Downloads keep the mode a plain createWriteStream gave them under the usual 022 umask.
const DOWNLOAD_MODE = 0o644
const STAMP_COMMIT_RE = /^[0-9a-f]{7,40}$/i
const FALLBACK_COMMIT_RE = /^0{7,40}$/

// Contract P7 decision 13 (amended 2026-10-16, PLAN R front R1): a signed public
// app never fetches and runs a moving script. Every install, repair and
// alignment fetches install.sh at the BUNDLED runtime pin (iclone/RUNTIME_PIN.json
// -> runtime-pin.generated.ts), checks its sha256 and passes the pin as --commit.
// The source import base (iclone/UPSTREAM_BASE, Track B) is a different commit.
export const RUNTIME_PIN_LOG_TAG = '[iclone-runtime-pin]'
export const UPSTREAM_BASE_SHA = '10b388300a63d83857fac3ca4f8b05b64e01bc50'
export const RUNTIME_PIN_SHA: string = RUNTIME_PIN.sha
export const RUNTIME_PIN_INSTALL_SH_SHA256: string = RUNTIME_PIN.installShSha256
// Owner requirement: first launch needs nothing but an internet
// connection, so a fresh install takes the runtime source from the codeload
// tarball of the pin (sha256 recorded in the pin), not git.
export const RUNTIME_PIN_TARBALL_SHA256: string = RUNTIME_PIN.tarballSha256
const SOURCE_TARBALL_LOG_TAG = '[iclone-runtime-source]'
export const SOURCE_MARKER_FILE = '.iclone-source.json'
// The latest full release of the public repo publishes the runtime pin beside the app.
const RUNTIME_PIN_URL = latestReleaseAssetUrl('runtime.json')
const UPSTREAM_BRANCH = 'main'
const SHA40_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

function isPinnedCommit(commit: unknown): commit is string {
  return typeof commit === 'string' && STAMP_COMMIT_RE.test(commit) && !FALLBACK_COMMIT_RE.test(commit)
}

type ExecGitFn = (args: string[], cwd: string) => string
type ResolveHeadFn = (activeRoot: string | null | undefined) => string | null
type InstallerKind = 'posix' | 'powershell'
type StageState = 'failed' | 'running' | 'skipped' | 'succeeded'
/** install-stamp.json of a packaged build (main/env.ts loadInstallStamp keeps only stamps whose commit is a string). */
export type InstallStamp = { branch?: null | string; commit: string }
type ManifestStage = { category?: string; name: string; needs_user_input?: boolean; title?: string }
type InstallerManifest = { protocol_version?: number; protocolVersion?: number; stages: ManifestStage[] }
/** The one JSON frame a stage prints (`install.sh --stage <name> --json`, `install.ps1 -Stage <name> -Json`). */
export type StageResultJson = { [key: string]: unknown; ok: boolean; reason?: string; skipped?: boolean; stage: string }
/** Fields any event may carry: the run log and the runtime-update log read `line` without narrowing. */
type EventCommon = { error?: string; line?: string; stage?: string }
export type StageEvent = EventCommon & {
  durationMs?: number
  json?: null | StageResultJson
  name: string
  state: StageState
  type: 'stage'
}
/** Every event the runner emits; main/boot-progress.ts keeps the renderer's view of them. */
export type BootstrapEvent =
  | (EventCommon & { error: string; type: 'failed' })
  | (EventCommon & { line: string; stream?: 'stderr' | 'stdout'; type: 'log' })
  | (EventCommon & { marker: unknown; type: 'complete' })
  /** r2: the watchdog's heartbeat while a stage runs (idleMs = time since its last real progress). */
  | (EventCommon & { idleMs: number; type: 'stage-alive' })
  | (EventCommon & {
      protocolVersion: null | number
      /** K-RT2: this run replaces a previous release's runtime (the overlay says so, once). */
      purpose?: 'runtime-upgrade'
      stages: ManifestStage[]
      type: 'manifest'
    })
  | StageEvent
type BootstrapEmit = (ev: BootstrapEvent) => void
type StageExtra = Pick<StageEvent, 'error' | 'json'>
type SpawnOpts = {
  abortSignal?: AbortSignal
  emit?: BootstrapEmit
  hermesHome?: string
  /** V3-RT (ruling 36): HOME for this stage (the installer's uv and caches) — the runtime's private home. */
  home?: string
  /** r2: told the stage's process id once it is spawned (the watchdog samples its tree's CPU time). */
  onChild?: (pid: number | undefined) => void
  stageName?: string
}

/**
 * V3-RT (ruling 36): the app's runtime keeps everything its installer creates inside its own folder. With this set,
 * the stages that create uv, the pinned Python, PM's store and the dependency environment run with this HOME and
 * HERMES_HOME; `config` still seeds the user's HERMES_HOME; `products` is skipped (it would publish a `hermes` command
 * into the user's PATH and shell files, which the app never needs: it launches its runtime itself).
 */
export interface PrivateDependencies {
  hermesHome: string
  home: string
}

const PRIVATE_DEPENDENCY_STAGES = new Set(['venv', 'python-deps'])
export const PRODUCTS_SKIPPED_REASON =
  'the app launches its own runtime: no hermes command is published into your PATH or shell files'

/** Where a stage runs for a runtime with private dependencies: its HERMES_HOME and HOME, or a reason to skip it. */
export function placeStage(
  name: string,
  hermesHome: string,
  priv: null | PrivateDependencies | undefined
): { hermesHome: string; home?: string; skip?: string } {
  if (!priv) {
    return { hermesHome }
  }

  if (PRIVATE_DEPENDENCY_STAGES.has(name)) {
    return { hermesHome: priv.hermesHome, home: priv.home }
  }

  return name === 'products' ? { hermesHome, skip: PRODUCTS_SKIPPED_REASON } : { hermesHome }
}

type SpawnResult = {
  code: null | number
  killed: boolean
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}
let runtimeChoiceFileOf: () => null | string = () => null

/** Main binds where userData/runtime-choice.json lives once at startup; every later Repair reads it. */
export function bindRuntimeChoiceFile(resolve: () => null | string): void {
  runtimeChoiceFileOf = resolve
}

type PinOpts = {
  activeRoot: string
  /** Curated: the commit install.sh checks out — the user's chosen runtime (runtime-choice.json) or the pin. */
  curatedCommit?: string
  hermesHome: string
  installStamp?: InstallStamp | null
  pinCommit?: boolean
  policy?: UpdatePolicy
}
type RunStageOptions = PinOpts & {
  abortSignal?: AbortSignal
  emit: BootstrapEmit
  home?: string
  installerKind: InstallerKind
  scriptPath: string
  stage: ManifestStage
}
type InstallerSpawn = (
  script: string,
  args: string[],
  opts: SpawnOpts
) => Promise<{ code: null | number; stdout?: string }>
type PinnedUpdateOptions = { activeRoot: string; emit: BootstrapEmit; hermesHome: string; pin: RuntimePin }
type AlignCheckout = typeof alignCheckoutToPin
type AlignStageOpts = Pick<RunStageOptions, 'activeRoot' | 'emit' | 'stage'> & { align: AlignCheckout; sha: string }
type AlignPinOpts = PinnedUpdateOptions & { _alignCheckout: AlignCheckout; _spawn: InstallerSpawn; script: string }
type SourceStageOpts = Omit<RunStageOptions, 'installerKind' | 'scriptPath'> & {
  appVersion: string
  installSource: InstallSource
}
type SourceUpdateOpts = PinnedUpdateOptions & {
  _installSource: InstallSource
  _spawn: InstallerSpawn
  appVersion: string
  privateDependencies?: null | PrivateDependencies
}
type InstallSource = typeof installSourceTarball

/**
 * Read HEAD from a managed checkout. Used after bootstrap so fallback
 * (all-zero) install stamps still produce a marker that
 * isBootstrapComplete() accepts (pinnedCommit length >= 7).
 */
function resolveCheckoutHead(activeRoot: string | null | undefined, opts: { execGit?: ExecGitFn } = {}): string | null {
  if (!activeRoot) {
    return null
  }

  // A tarball install has no .git, and on a clean Mac /usr/bin/git is the
  // Command Line Tools shim: never run it there.
  if (!opts.execGit && !fs.existsSync(path.join(activeRoot, '.git'))) {
    return null
  }

  const run: ExecGitFn =
    opts.execGit ||
    ((args, cwd) =>
      execFileSync('git', args, {
        ...hiddenWindowsChildOptions(),
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000
      }).trim())

  try {
    const sha = run(['-c', 'windows.appendAtomically=false', 'rev-parse', 'HEAD'], activeRoot)

    return isPinnedCommit(sha) ? sha : null
  } catch {
    return null
  }
}

/** Prefer a real pin already written by install.ps1's bootstrap-marker stage. */
function readExistingPinnedCommit(activeRoot: string | null | undefined): string | null {
  if (!activeRoot) {
    return null
  }

  try {
    const raw = fs.readFileSync(path.join(activeRoot, '.hermes-bootstrap-complete'), 'utf8')
    const parsed = JSON.parse(raw)

    return parsed && isPinnedCommit(parsed.pinnedCommit) ? parsed.pinnedCommit : null
  } catch {
    return null
  }
}

/**
 * Pick the commit to store on the bootstrap-complete marker.
 * Packaged fallback stamps must NOT win (all-zero is not a real pin); after a
 * successful install the checkout's HEAD (or install.ps1's marker) does.
 */
function resolveMarkerPinnedCommit(
  installStamp: { commit?: string; branch?: string | null } | null | undefined,
  activeRoot: string | null | undefined,
  opts: { resolveHead?: ResolveHeadFn } = {}
): string | null {
  const resolveHead = opts.resolveHead || resolveCheckoutHead

  if (installStamp && isPinnedCommit(installStamp.commit)) {
    return installStamp.commit
  }

  const source = readSourceMarker(activeRoot)

  if (source) {
    return source.sha
  }

  const head = resolveHead(activeRoot)

  if (head) {
    return head
  }

  return readExistingPinnedCommit(activeRoot)
}

/**
 * Map an install stamp to the GitHub ref used to fetch install.ps1/sh.
 * Real CI/git stamps pin an immutable SHA. Non-git fallback stamps carry an
 * all-zero placeholder -- treat those as an unpinned branch ref so bootstrap
 * never asks GitHub for commit 0000000... (#50823).
 */
function installRefForStamp(installStamp: null | Partial<InstallStamp> | undefined) {
  // Only a packaged build carries a stamp (real or all-zero fallback). Either
  // way the fork's own commit is not an upstream ref; the runtime is pinned to
  // the upstream import base instead of following a branch.
  const commit = installStamp && installStamp.commit

  if (typeof commit !== 'string' || !(isPinnedCommit(commit) || FALLBACK_COMMIT_RE.test(commit))) {
    return null
  }

  return { ref: RUNTIME_PIN_SHA, cacheKey: `pin-${RUNTIME_PIN_SHA}`, pinned: true }
}

// Stages flagged needs_user_input=true in the manifest are skipped by the
// runner (passed -NonInteractive to install.ps1, which the install script
// itself handles by emitting skipped=true frames). The renderer / 1E onboarding
// overlay takes over for those concerns (API keys, model, persona, gateway).
// We let install.ps1's own -NonInteractive logic drive this rather than
// filtering client-side -- single source of truth.

// ---------------------------------------------------------------------------
// install.ps1 source resolution
// ---------------------------------------------------------------------------

function installScriptName() {
  return process.platform === 'win32' ? 'install.ps1' : 'install.sh'
}

function installScriptKind(): InstallerKind {
  return process.platform === 'win32' ? 'powershell' : 'posix'
}

function resolveLocalInstallScript(sourceRepoRoot: null | string | undefined) {
  if (!sourceRepoRoot) {
    return null
  }

  const candidate = path.join(sourceRepoRoot, 'scripts', installScriptName())

  try {
    fs.accessSync(candidate, fs.constants.R_OK)

    return candidate
  } catch {
    return null
  }
}

function bootstrapCacheDir(hermesHome: string) {
  return path.join(hermesHome, 'bootstrap-cache')
}

// The install.sh / install.ps1 that ships inside the already-installed agent
// checkout under ~/.hermes/hermes-agent. Used as a last-resort fallback when
// the pinned commit can't be fetched from GitHub (e.g. a locally-built desktop
// app stamped to an unpushed HEAD).
function installedAgentInstallScript(hermesHome: null | string | undefined) {
  if (!hermesHome) {
    return null
  }

  const candidate = path.join(hermesHome, 'hermes-agent', 'scripts', installScriptName())

  try {
    fs.accessSync(candidate, fs.constants.R_OK)

    return candidate
  } catch {
    return null
  }
}

function hasExistingGitCheckout(activeRoot: null | string | undefined) {
  if (!activeRoot) {
    return false
  }

  try {
    return fs.existsSync(path.join(activeRoot, '.git'))
  } catch {
    return false
  }
}

function sha256File(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// install.ps1 has no recorded hash (the release is macOS arm64 only); the pinned
// commit in its URL is still content-addressed.
function pinnedScriptMatches(file: string) {
  if (installScriptKind() !== 'posix') {
    return true
  }

  try {
    return sha256File(file) === RUNTIME_PIN_INSTALL_SH_SHA256
  } catch {
    return false
  }
}

function cachedScriptPath(hermesHome: string, commit: string) {
  return path.join(bootstrapCacheDir(hermesHome), `install-${commit}.${process.platform === 'win32' ? 'ps1' : 'sh'}`)
}

// The RUNTIME is upstream's: `hermes update` keeps it on NousResearch main,
// and the fork's own install.sh clones NousResearch too. Fetching the script
// from the (private) fork returned 404 on every fresh machine, and pinning the
// fork's commit sent `git fetch origin <fork sha>` to a repo that has never
// heard of it. So: upstream's script, upstream's main, no pin — the desktop
// app on top is what the fork ships, the backend underneath is Track A.
const BOOTSTRAP_REPO = 'NousResearch/hermes-agent'

function downloadInstallScript(ref: string, destPath: string) {
  // Fetch from GitHub raw at the install ref. Normal production builds pass a
  // pinned SHA (immutable). Non-git fallback builds pass an unpinned branch
  // ref so local builds can still bootstrap without pretending the all-zero
  // placeholder is a real GitHub commit.
  const scriptName = installScriptName()
  const url = `https://raw.githubusercontent.com/${BOOTSTRAP_REPO}/${ref}/scripts/${scriptName}`

  return new Promise<string>((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    const save = (res: NodeJS.ReadableStream) =>
      writeStreamAtomic(destPath, res, { mode: DOWNLOAD_MODE }).then(() => resolve(destPath), reject)

    https
      .get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // GitHub raw shouldn't redirect for a SHA URL, but follow once
          // defensively.
          if (!res.headers.location) {
            return reject(new Error(`Failed to download ${scriptName}: HTTP ${res.statusCode} without a location`))
          }

          https
            .get(res.headers.location, res2 => {
              if (res2.statusCode !== 200) {
                reject(
                  new Error(
                    `Failed to download ${scriptName}: HTTP ${res2.statusCode} from redirect ${res.headers.location}`
                  )
                )

                return
              }

              save(res2)
            })
            .on('error', reject)

          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download ${scriptName}: HTTP ${res.statusCode} from ${url}`))

          return
        }

        save(res)
      })
      .on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Pinned runtime source tarball
// ---------------------------------------------------------------------------

interface SourceMarker {
  installedAt: string
  /** V3-RT: a runtime built from this repository carries its manifest's sha256 (iclone-runtime-integrity.ts). */
  manifestSha256?: string
  sha: string
  sha256: string
  /** `repo`: this release's runtime from the app bundle (V3-RT); `codeload`: an upstream tarball (0.0.2 and earlier). */
  source: 'codeload' | 'repo'
}

/** V3-RT: the bundled pin is a runtime built from this repository; it exists only inside the app bundle. */
function isRepoPin(sha: string): boolean {
  return RUNTIME_PIN.source === 'repo' && sha === RUNTIME_PIN_SHA
}

interface SourceInstallResult {
  /** The tree that was at `targetDir` before, renamed aside (null when there was none or the pin was already there). */
  previousDir: null | string
  reused: boolean
  sha: string
}

type DownloadWithSha256 = (url: string, dest: string, opts?: { abortSignal?: AbortSignal }) => Promise<string>
type ExtractTarball = (archive: string, destDir: string, opts?: { abortSignal?: AbortSignal }) => Promise<void>

export function sourceTarballUrl(sha: string): string {
  return `https://codeload.github.com/${BOOTSTRAP_REPO}/tar.gz/${sha}`
}

// The pinned runtime ships inside the app (scripts/fetch-runtime-pin.mjs -> Resources/hermes-runtime): a fresh
// install takes the tarball and install.sh from there, sha256-checked again, and contacts GitHub only when the
// bundle is missing or corrupt (logged). Names must match fetch-runtime-pin.mjs.
export const RUNTIME_BUNDLE_LOG_TAG = '[iclone-runtime-bundle]'

export function bundledRuntimeTarballName(sha: string): string {
  return `hermes-agent-${sha}.tar.gz`
}

function bundledRuntimeDir(): null | string {
  const resources = (process as { resourcesPath?: string }).resourcesPath

  return resources ? path.join(resources, 'hermes-runtime') : null
}

async function sha256Stream(file: string): Promise<string> {
  const hash = createHash('sha256')

  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

/** The bundled tarball of `sha` when its bytes are the pin's; otherwise null, with the reason logged. */
async function verifiedBundledTarball(
  bundleDir: null | string | undefined,
  sha: string,
  sha256: string,
  say: (line: string) => void
): Promise<null | string> {
  if (!bundleDir) {
    return null
  }

  const file = path.join(bundleDir, bundledRuntimeTarballName(sha))

  if (!fs.existsSync(file)) {
    say(`no bundled runtime at ${file}; falling back to the pinned URL`)

    return null
  }

  const got = await sha256Stream(file)

  if (got !== sha256) {
    say(
      `bundled runtime failed its sha256 check (got ${got.slice(0, 12)}, expected ${sha256.slice(0, 12)}); falling back to the pinned URL`
    )

    return null
  }

  return file
}

export function readSourceMarker(dir: null | string | undefined): null | SourceMarker {
  if (!dir) {
    return null
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, SOURCE_MARKER_FILE), 'utf8'))

    return parsed && typeof parsed.sha === 'string' && SHA40_RE.test(parsed.sha) ? parsed : null
  } catch {
    return null
  }
}

/** Streams an https URL (at most 3 redirects) to `dest`; resolves with the sha256 of the bytes written. */
function downloadWithSha256(
  url: string,
  dest: string,
  { abortSignal, redirects = 3 }: { abortSignal?: AbortSignal; redirects?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error(`refusing a non-https download: ${url}`))

      return
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })

    https
      .get(url, { signal: abortSignal }, res => {
        const status = res.statusCode || 0

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()

          if (redirects <= 0) {
            reject(new Error(`too many redirects from ${url}`))

            return
          }

          const next = new URL(res.headers.location, url).toString()
          downloadWithSha256(next, dest, { abortSignal, redirects: redirects - 1 }).then(resolve, reject)

          return
        }

        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status} from ${url}`))

          return
        }

        const hash = createHash('sha256')

        // Hashed inside the writer's own read, so the digest covers exactly the bytes that reach the file.
        const hashed = (async function* () {
          for await (const chunk of res as AsyncIterable<Buffer>) {
            hash.update(chunk)
            yield chunk
          }
        })()

        writeStreamAtomic(dest, hashed, { mode: DOWNLOAD_MODE }).then(() => resolve(hash.digest('hex')), reject)
      })
      .on('error', reject)
  })
}

// macOS's own bsdtar (not a Command Line Tools shim). Without -P it refuses
// absolute member paths and `..` components.
const TAR_BIN = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar'

// K-RT10: the archive is gunzipped by this process's own zlib (the one the build compressed with) and tar reads the
// plain stream from stdin. Every caller verifies the archive's sha256 before extraction; what this function
// guarantees is that tar exited 0, i.e. it read the end-of-archive blocks.
export function extractTarball(
  archive: string,
  destDir: string,
  { abortSignal }: { abortSignal?: AbortSignal } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(TAR_BIN, ['-xf', '-', '-C', destDir, '--strip-components', '1', '--no-same-owner'], {
      signal: abortSignal,
      stdio: ['pipe', 'ignore', 'pipe']
    })

    let stderr = ''
    let streamError: Error | null = null
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    pipeline(fs.createReadStream(archive), createGunzip(), child.stdin).catch(error => {
      streamError = error as Error
      child.kill('SIGTERM')
    })
    child.on('close', code => {
      // tar stops reading at the end-of-archive blocks and exits 0 while the padding after them is still being
      // written to its stdin: that write fails with EPIPE / premature close. The archive's sha256 is verified by
      // every caller before extraction, and tar exit 0 means the end-of-archive blocks were read, so EPIPE /
      // premature close after that is tar closing stdin early, not corruption. Any other stream error is a failure.
      const tarClosedEarly = ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
        (streamError as NodeJS.ErrnoException | null)?.code ?? ''
      )

      if (code === 0 && (!streamError || tarClosedEarly)) {
        resolve()
      } else {
        reject(
          streamError
            ? new Error(`the runtime archive could not be decompressed: ${streamError.message}`)
            : new Error(`tar exited ${code}: ${stderr.trim().slice(-400)}`)
        )
      }
    })
  })
}

/**
 * Puts the runtime source tree of `sha` at `targetDir` from GitHub's codeload
 * tarball, checked against `sha256` before anything is unpacked. The tree is
 * unpacked beside the target and swapped in with a rename; whatever was at the
 * target is renamed aside, never deleted (an unknown tree keeps a unique name).
 */
export async function installSourceTarball({
  abortSignal,
  appVersion = 'unknown',
  cacheDir,
  emit,
  sha,
  sha256,
  targetDir,
  bundleDir = bundledRuntimeDir(),
  _download = downloadWithSha256,
  _extract = extractTarball
}: {
  _download?: DownloadWithSha256
  _extract?: ExtractTarball
  abortSignal?: AbortSignal
  /** In the tree's ICLONE_MANAGED.json (V3-S r3, m-d): which app version installed it. */
  appVersion?: string
  bundleDir?: null | string
  cacheDir: string
  emit: BootstrapEmit
  sha: string
  sha256: string
  targetDir: string
}): Promise<SourceInstallResult> {
  const say = (line: string) => emit({ type: 'log', stage: 'repository', line: `${SOURCE_TARBALL_LOG_TAG} ${line}` })

  if (!SHA40_RE.test(sha) || !SHA256_RE.test(sha256)) {
    throw new Error('A runtime source pin needs a 40-hex commit and a 64-hex sha256.')
  }

  const marker = readSourceMarker(targetDir)
  const repoPin = isRepoPin(sha)
  const source: SourceMarker['source'] = repoPin ? 'repo' : 'codeload'

  if (marker && marker.sha === sha && marker.sha256 === sha256 && (marker.source ?? 'codeload') === source) {
    say(`runtime source ${sha.slice(0, 12)} already in place`)

    // V3-RT (r4b): a managed tree carries the release's manifest at its root; a Repair puts it back if it is gone.
    if (repoPin && !fs.existsSync(path.join(targetDir, '.git'))) {
      copyBundledManifest(bundleDir, targetDir)
    }

    // V3-S r3 (m-d): this tree is this installer's own (its source marker is the pin's), so a tree from before the
    // stamp existed gets one here — a Repair makes it a runtime the permission gate may write. Never a git work tree.
    if (!readManagedStamp(targetDir) && !fs.existsSync(path.join(targetDir, '.git'))) {
      writeManagedStamp(targetDir, managedStampFor({ appVersion, lockHash: sha256, runtimeSha: sha }))
      say(`runtime source ${sha.slice(0, 12)} stamped as managed by icloneOS`)
    }

    return { previousDir: null, reused: true, sha }
  }

  const archive = path.join(cacheDir, `source-${sha}.tar.gz`)
  const staging = `${targetDir}.incoming`

  try {
    const bundled = await verifiedBundledTarball(bundleDir, sha, sha256, line =>
      emit({ type: 'log', stage: 'repository', line: `${RUNTIME_BUNDLE_LOG_TAG} ${line}` })
    )

    if (bundled) {
      say(`installing runtime source ${sha.slice(0, 12)} from the app bundle (sha256 verified; nothing downloaded)`)
    } else if (repoPin) {
      // The runtime of this release is built from icloneOS's own repository: no download source has it.
      throw new Error(
        'The agent runtime that ships inside icloneOS is missing or damaged; reinstall icloneOS. Nothing was installed.'
      )
    } else {
      say(`downloading runtime source ${sha.slice(0, 12)} (no git needed)`)
      const got = await _download(sourceTarballUrl(sha), archive, { abortSignal })

      if (got !== sha256) {
        throw new Error(
          `The runtime source failed its sha256 check (got ${got.slice(0, 12)}, expected ${sha256.slice(0, 12)}); nothing was installed.`
        )
      }
    }

    fs.rmSync(staging, { force: true, recursive: true })
    fs.mkdirSync(staging, { recursive: true })
    await _extract(bundled ?? archive, staging, { abortSignal })

    for (const required of ['pyproject.toml', path.join('scripts', 'install.sh')]) {
      if (!fs.existsSync(path.join(staging, required))) {
        throw new Error(`The runtime source has no ${required}; nothing was installed.`)
      }
    }

    // The marker travels inside the staged tree, so no crash window leaves an installed tree without it.
    const payload: SourceMarker = {
      installedAt: new Date().toISOString(),
      sha,
      sha256,
      source,
      ...(repoPin ? { manifestSha256: RUNTIME_PIN.manifestSha256 } : {})
    }

    writeJsonAtomicSync(path.join(staging, SOURCE_MARKER_FILE), payload)

    // V3-S r3 (m-d): the app installed this tree, so the permission gate may write its plugins into it.
    // V3-RT (r4b): the release's manifest, byte for byte, at the root of the tree it describes (the gate's check b).
    if (repoPin) {
      copyBundledManifest(bundleDir, staging)
    }

    writeManagedStamp(staging, managedStampFor({ appVersion, lockHash: sha256, runtimeSha: sha }))

    const previousDir = replaceDirAtomicSync(staging, targetDir, {
      keepPrevious: marker ? `${targetDir}.previous` : `${targetDir}.previous-${Date.now()}`
    })

    say(
      `runtime source ${sha.slice(0, 12)} installed (sha256 verified)${previousDir ? `; previous tree at ${previousDir}` : ''}`
    )

    return { previousDir, reused: false, sha }
  } finally {
    fs.rmSync(staging, { force: true, recursive: true })
    fs.rmSync(archive, { force: true })
  }
}

/**
 * V3-RT (V3-S r4b): copies the bundle's RUNTIME_MANIFEST.json into `dir`, only when its sha256 is the one the app pins.
 * Throws otherwise (nothing is installed from a bundle whose manifest is not the release's).
 */
function copyBundledManifest(bundleDir: null | string | undefined, dir: string): void {
  const source = bundleDir ? path.join(bundleDir, RUNTIME_MANIFEST_FILE) : null
  const bytes = source && fs.existsSync(source) ? fs.readFileSync(source) : null

  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== RUNTIME_PIN.manifestSha256) {
    throw new Error(`the app bundle's ${RUNTIME_MANIFEST_FILE} is not the one this release pins; reinstall icloneOS`)
  }

  writeFileAtomicBytes(path.join(dir, RUNTIME_MANIFEST_FILE), bytes)
}

function writeFileAtomicBytes(file: string, bytes: Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, bytes, { mode: 0o644 })
  fs.renameSync(tmp, file)
}

/** Undo `installSourceTarball`: the freshly unpacked tree goes, the previous one comes back. */
function restoreSourceTree(targetDir: string, previousDir: null | string) {
  if (!previousDir || !fs.existsSync(previousDir)) {
    return
  }

  fs.rmSync(targetDir, { force: true, recursive: true })
  fs.renameSync(previousDir, targetDir)
}

// install.sh's prerequisites (check_git) and repository (git clone) stages need
// git; on a clean Mac /usr/bin/git is the shim that opens the Command Line Tools
// installer. A fresh install replaces exactly those two stages: uv, Python and
// Node are fetched by the venv / python-deps / node-deps stages themselves.
const SOURCE_TARBALL_STAGES = new Set(['prerequisites', 'repository'])

/** Emits a stage's final event and returns it: every stage runner resolves with that event. */
function finishStage(emit: BootstrapEmit, name: string, state: StageState, durationMs: number, extra: StageExtra = {}) {
  const ev: StageEvent = { type: 'stage', name, state, durationMs, ...extra }
  emit(ev)

  return ev
}

async function runSourceStage({
  stage,
  emit,
  hermesHome,
  activeRoot,
  abortSignal,
  appVersion,
  installSource
}: SourceStageOpts) {
  const startedAt = Date.now()
  emit({ type: 'stage', name: stage.name, state: 'running' })

  if (stage.name === 'prerequisites') {
    const json = {
      ok: true,
      skipped: true,
      stage: stage.name,
      reason: 'source tarball install: git and the Command Line Tools are not needed'
    }

    return finishStage(emit, stage.name, 'skipped', Date.now() - startedAt, { json })
  }

  try {
    const result = await installSource({
      abortSignal,
      appVersion,
      cacheDir: bootstrapCacheDir(hermesHome),
      emit,
      sha: RUNTIME_PIN_SHA,
      sha256: RUNTIME_PIN_TARBALL_SHA256,
      targetDir: activeRoot
    })

    const json = { ok: true, stage: stage.name, source: 'tarball', sha: result.sha, reused: result.reused }

    return finishStage(emit, stage.name, 'succeeded', Date.now() - startedAt, { json })
  } catch (err) {
    const error = abortSignal && abortSignal.aborted ? 'cancelled by user' : errorMessage(err)

    return finishStage(emit, stage.name, 'failed', Date.now() - startedAt, { error })
  }
}

async function resolveInstallScript({
  installStamp,
  sourceRepoRoot,
  hermesHome,
  emit,
  bundleDir = bundledRuntimeDir(),
  _download = downloadInstallScript
}: {
  _download?: (ref: string, dest: string) => Promise<unknown>
  bundleDir?: null | string
  emit: BootstrapEmit
  hermesHome: string
  installStamp?: InstallStamp | null
  sourceRepoRoot?: null | string
}) {
  // 1. Dev shortcut: prefer a local checkout's installer so we can iterate
  //    without pushing. SOURCE_REPO_ROOT comes from main.ts (path.resolve
  //    of APP_ROOT/../..).
  const localScript = resolveLocalInstallScript(sourceRepoRoot)

  if (localScript) {
    emit({ type: 'log', line: `[bootstrap] using local ${installScriptName()} at ${localScript}` })

    return { path: localScript, source: 'local', kind: installScriptKind() }
  }

  // 2. Packaged path: download from GitHub at the install stamp's ref.
  // Non-git fallback builds carry an all-zero commit; treat that as an
  // unpinned branch ref instead of trying to fetch a non-existent SHA.
  const installRef = installRefForStamp(installStamp)

  if (!installRef) {
    throw new Error(
      `Cannot resolve ${installScriptName()}: no SOURCE_REPO_ROOT and no install stamp. ` +
        'This packaged build was produced without a valid build-time stamp.'
    )
  }

  const cached = cachedScriptPath(hermesHome, installRef.cacheKey)
  const resolvedCommit = installRef.pinned ? installRef.ref : null

  // The installer that ships with the bundled runtime pin (Resources/hermes-runtime/install.sh), sha256-checked.
  if (installRef.pinned && installScriptKind() === 'posix' && bundleDir) {
    const bundledScript = path.join(bundleDir, 'install.sh')

    if (fs.existsSync(bundledScript) && pinnedScriptMatches(bundledScript)) {
      fs.mkdirSync(path.dirname(cached), { recursive: true })
      fs.copyFileSync(bundledScript, cached)
      emit({
        type: 'log',
        line: `${RUNTIME_BUNDLE_LOG_TAG} install.sh @${installRef.ref.slice(0, 12)} from the app bundle (sha256 verified)`
      })

      return { path: cached, source: 'bundle', commit: resolvedCommit, kind: installScriptKind() }
    }

    emit({
      type: 'log',
      line: `${RUNTIME_BUNDLE_LOG_TAG} no verified install.sh in the app bundle at ${bundleDir}; falling back to the pinned URL`
    })
  }

  try {
    await fsp.access(cached, fs.constants.R_OK)

    if (installRef.pinned && !pinnedScriptMatches(cached)) {
      fs.rmSync(cached, { force: true })
      throw new Error('cached installer does not match the recorded sha256')
    }

    emit({
      type: 'log',
      line: `[bootstrap] using cached ${installScriptName()} for ${installRef.ref.slice(0, 12)}`
    })

    return { path: cached, source: 'cache', commit: resolvedCommit, kind: installScriptKind() }
  } catch {
    // not cached; download
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] fetching ${installScriptName()} for ${installRef.ref.slice(0, 12)} from GitHub` +
      (installRef.pinned ? '' : ' (fallback, unpinned)')
  })

  try {
    await _download(installRef.ref, cached)

    if (installRef.pinned && !pinnedScriptMatches(cached)) {
      fs.rmSync(cached, { force: true })
      throw new Error(
        `${RUNTIME_PIN_LOG_TAG} ${installScriptName()} at ${RUNTIME_PIN_SHA.slice(0, 12)} does not match the recorded sha256; refusing to run it`
      )
    }

    emit({ type: 'log', line: `[bootstrap] saved to ${cached}` })

    if (installRef.pinned) {
      emit({
        type: 'log',
        line: `${RUNTIME_PIN_LOG_TAG} ${installScriptName()} @${RUNTIME_PIN_SHA.slice(0, 12)} sha256 verified`
      })
    }

    return { path: cached, source: 'download', commit: resolvedCommit, kind: installScriptKind() }
  } catch (err) {
    // The pinned commit may not be fetchable from GitHub -- most commonly a
    // locally-built desktop app stamped to an unpushed HEAD (see
    // write-build-stamp.mjs fromLocalGit). Fall back to the installer that
    // ships inside the already-installed agent checkout so dev/self-builds can
    // still bootstrap instead of dying with a fatal 404.
    const installed = installedAgentInstallScript(hermesHome)

    // A pinned build only falls back to a byte-identical installer.
    if (installed && (!installRef.pinned || pinnedScriptMatches(installed))) {
      emit({
        type: 'log',
        line:
          `[bootstrap] GitHub fetch failed (${errorMessage(err)}); ` +
          `falling back to installed agent ${installScriptName()} at ${installed}`
      })

      try {
        fs.mkdirSync(path.dirname(cached), { recursive: true })
        fs.copyFileSync(installed, cached)

        return { path: cached, source: 'installed-agent', commit: resolvedCommit, kind: installScriptKind() }
      } catch {
        // Cache copy failed (read-only FS, etc.) -- use the source path directly.
        return { path: installed, source: 'installed-agent', commit: resolvedCommit, kind: installScriptKind() }
      }
    }

    throw err
  }
}

// ---------------------------------------------------------------------------
// powershell wrapper
// ---------------------------------------------------------------------------

function spawnPowerShell(scriptPath: string, args: string[], opts: SpawnOpts = {}) {
  const { emit, stageName, abortSignal, hermesHome, onChild } = opts

  return new Promise<SpawnResult>((resolve, reject) => {
    const ps = process.platform === 'win32' ? resolveWindowsPowerShell() : 'pwsh'
    const fullArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args]

    const child = spawn(ps, fullArgs, {
      ...hiddenWindowsChildOptions(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Pass HERMES_HOME through so install.ps1 respects the caller's
        // choice rather than re-computing the default.
        HERMES_HOME: hermesHome || codePathEnv('HERMES_HOME') || ''
      }
    })

    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    // A stop is reported at once (the grandchildren may hold the pipes; critic M3). Windows has no POSIX groups here.
    const onAbort = () => {
      killed = true

      try {
        child.kill('SIGTERM')
      } catch {
        void 0
      }

      if (!settled) {
        settled = true
        resolve({ stdout, stderr, code: null, signal: 'SIGTERM', killed: true })
      }
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    onChild?.(child.pid)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    // Stream stdout line-by-line so the renderer sees progress in real time.
    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuf += chunk
      let nl

      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)

        if (line && !killed) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
        }
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      stderr += chunk
      stderrBuf += chunk
      let nl

      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)

        if (line && !killed) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
        }
      }
    })

    child.on('error', err => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      if (!settled) {
        settled = true
        reject(err)
      }
    })

    child.on('close', (code, signal) => {
      if (settled) {
        return
      }

      settled = true

      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      // Flush any trailing bytes
      if (stdoutBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' })
      }

      if (stderrBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' })
      }

      resolve({ stdout, stderr, code, signal, killed })
    })
  })
}

/** Grace between SIGTERM and SIGKILL when a stage's process group is stopped. */
export const STAGE_KILL_GRACE_MS = 5_000

/**
 * Stop an installer stage's whole process group (the stage was spawned `detached`, so its pid is the group id):
 * SIGTERM now, SIGKILL after STAGE_KILL_GRACE_MS for whatever ignored it. Never throws; a group already gone is fine.
 */
export function stopProcessGroup(pid: number | undefined, graceMs = STAGE_KILL_GRACE_MS) {
  if (typeof pid !== 'number' || pid <= 1) {
    return
  }

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)

      return true
    } catch {
      return false
    }
  }

  if (signalGroup('SIGTERM')) {
    const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs)

    timer.unref?.()
  }
}

function spawnBash(
  scriptPath: string,
  args: string[],
  { emit, stageName, abortSignal, hermesHome, home, onChild }: SpawnOpts = {}
) {
  return new Promise<SpawnResult>((resolve, reject) => {
    // r2 (critic M3): its own process group, so a stop reaches PM, uv and tar too, not only bash.
    const child = spawn('bash', [scriptPath, ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(home ? { HOME: home, XDG_CACHE_HOME: path.join(home, '.cache') } : {}),
        HERMES_HOME: hermesHome || codePathEnv('HERMES_HOME') || ''
      }
    })

    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false

    // A stop (Cancel, or the watchdog's verdict) terminates the WHOLE group and is reported at once: the stage's
    // grandchildren hold its pipes, so waiting for 'close' would wait for them (critic M3).
    const onAbort = () => {
      killed = true
      stopProcessGroup(child.pid)

      if (!settled) {
        settled = true
        resolve({ stdout, stderr, code: null, signal: 'SIGTERM', killed: true })
      }
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    onChild?.(child.pid)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdoutBuf = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      stdoutBuf += chunk
      let nl

      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)

        if (line && !killed) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stdout' })
        }
      }
    })

    let stderrBuf = ''
    child.stderr.on('data', chunk => {
      stderr += chunk
      stderrBuf += chunk
      let nl

      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
        stderrBuf = stderrBuf.slice(nl + 1)

        if (line && !killed) {
          emit && emit({ type: 'log', stage: stageName, line, stream: 'stderr' })
        }
      }
    })

    child.on('error', err => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      if (!settled) {
        settled = true
        reject(err)
      }
    })

    child.on('close', (code, signal) => {
      if (settled) {
        return
      }

      settled = true

      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }

      if (stdoutBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stdoutBuf, stream: 'stdout' })
      }

      if (stderrBuf) {
        emit && emit({ type: 'log', stage: stageName, line: stderrBuf, stream: 'stderr' })
      }

      resolve({ stdout, stderr, code, signal, killed })
    })
  })
}

// ---------------------------------------------------------------------------
// Manifest + stage dispatch
// ---------------------------------------------------------------------------

// Build the installer branch/pin args from the install stamp. The commit pin
// is fresh-install only: once a managed checkout already exists, bootstrap is
// a repair/update path and must not let an old packaged app detach the checkout
// back to the commit baked into that app. All-zero fallback stamps are never
// passed as -Commit/--commit — only the branch is used (#50823 / #50864 review).
function buildPinArgs(
  installStamp: null | Partial<InstallStamp> | undefined,
  { pinCommit: _pinCommit = true }: { pinCommit?: boolean } = {}
) {
  const args: string[] = []

  // See BOOTSTRAP_REPO: the fork's sha is not an upstream commit, so it is
  // never handed to the installer as a pin.

  if (installStamp && installStamp.branch) {
    args.push('-Branch', installStamp.branch)
  }

  return args
}

// Windows (2026-10-16): R1 is mac-only; install.ps1 is still handed no -Commit,
// so a Windows install follows the branch (future ticket).
function buildPosixPinArgs({
  installStamp,
  activeRoot,
  curatedCommit = RUNTIME_PIN_SHA,
  hermesHome,
  pinCommit = true,
  policy = 'developer'
}: PinOpts) {
  const args = ['--dir', activeRoot, '--hermes-home', hermesHome]

  // Curated: every invocation (fresh, repair) carries a commit — the bundled pin, or the runtime the user chose (U1).
  // Developer: a packaged-stamp fresh install is pinned; a repair keeps the branch.
  if ((pinCommit && installRefForStamp(installStamp)) || policy === 'curated') {
    args.push('--branch', UPSTREAM_BRANCH, '--commit', policy === 'curated' ? curatedCommit : RUNTIME_PIN_SHA)

    return args
  }

  if (installStamp && installStamp.branch) {
    args.push('--branch', installStamp.branch)
  }

  return args
}

async function fetchManifest({
  scriptPath,
  installerKind,
  emit,
  hermesHome,
  activeRoot,
  installStamp,
  pinCommit,
  curatedCommit,
  policy
}: Omit<RunStageOptions, 'abortSignal' | 'stage'>): Promise<InstallerManifest> {
  const isPosix = installerKind === 'posix'

  const args = isPosix
    ? ['--manifest', ...buildPosixPinArgs({ installStamp, activeRoot, curatedCommit, hermesHome, pinCommit, policy })]
    : ['-Manifest', ...buildPinArgs(installStamp, { pinCommit })]

  const result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
    emit,
    stageName: '__manifest__',
    hermesHome
  })

  if (result.code !== 0) {
    throw new Error(
      `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} failed: exit ${result.code}\n${result.stderr || result.stdout}`
    )
  }

  const parsed = parseManifest(result.stdout)

  if (parsed) {
    return parsed
  }

  throw new Error(
    `${isPosix ? 'install.sh --manifest' : 'install.ps1 -Manifest'} produced no parseable JSON payload\n${result.stdout}`
  )
}

// The manifest is the LAST JSON line on stdout (install.ps1 may print
// banner / info lines first depending on Console.OutputEncoding effects).
// Find the last line that parses as JSON with a `stages` field.
function parseManifest(stdout: string | undefined): null | InstallerManifest {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])

      if (parsed && Array.isArray(parsed.stages)) {
        return parsed
      }
    } catch {
      void 0
    }
  }

  return null
}

// Parse the JSON result frame from a stage run. The protocol guarantees
// exactly one JSON line per stage in -Json or -Stage mode (post #27224 fix
// for the double-emit bug we addressed in the install.ps1 PR).
function parseStageResult(stdout: string): null | StageResultJson {
  const lines = stdout.split(/\r?\n/).filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])

      if (parsed && typeof parsed.ok === 'boolean' && typeof parsed.stage === 'string') {
        return parsed
      }
    } catch {
      void 0
    }
  }

  return null
}

/** Ruling 42 (amended, r2): an install stage is stuck only after INSTALL_STALL_MS without real progress of its
 * process tree (a line of output, CPU time, or bytes written under its target); a stage never runs past
 * INSTALL_CEILING_MS. Constants (electron/install-liveness.ts): no option or env changes them. */
export {
  INSTALL_CEILING_MS as INSTALL_STAGE_CEILING_MS,
  INSTALL_STALL_MS as INSTALL_STAGE_STALL_MS
} from './install-liveness'
export { INSTALL_WATCHDOG_TAG } from './install-liveness'

export interface StageProgressProbes {
  /** CPU per pid of the tree under the stage's process (default: one `/bin/ps` of the table). */
  /** null = unknown (ps failed). */
  sampleCpu?: (rootPid: number) => Promise<null | TreeCpu>
  /** Bytes under the stage's target (default: none). Null: unknown. Async: it must never block main (r2c). */
  sampleBytes?: () => null | number | Promise<null | number>
  /** The first-launch budget's deadline (epoch ms); default: a fresh INSTALL_CEILING_MS from now. */
  deadlineAt?: number
}

interface StageWatchdogTiming {
  stallMs: number
  sampleMs: number
  heartbeatMs: number
}

/**
 * The stage watchdog with its timing as parameters — for tests with a real child process only (short timings).
 * Production code calls armStageWatchdog, which fixes the timing to the ruling's constants.
 */
export function createStageWatchdog(
  emit: BootstrapEmit,
  abortSignal: AbortSignal | undefined,
  stage: string,
  probes: StageProgressProbes,
  timing: StageWatchdogTiming
) {
  const controller = new AbortController()
  const sampleCpu = probes.sampleCpu ?? sampleTreeCpu
  const deadlineAt = probes.deadlineAt ?? Date.now() + INSTALL_CEILING_MS
  let reason: null | string = null
  let rootPid: null | number = null
  let lastProgressAt = Date.now()
  let output = false
  let cpu: TreeCpu = new Map()
  let bytes: null | number = null
  let sampling = false
  let bytesInFlight = false
  let stopped = false
  let lastHeartbeatAt = Date.now()

  const trip = (why: string) => {
    if (!controller.signal.aborted) {
      reason = why
      controller.abort()
    }
  }

  const sample = async () => {
    if (sampling || controller.signal.aborted) {
      return
    }

    sampling = true

    try {
      let progressed = output
      output = false

      // A probe that throws is "unknown" for this sample — never progress, and never a reason to skip the stall
      // check below (critic r2c minor D).
      // Each probe has its own deadline (r2c3 F): a probe that hangs is unknown for this sample, it never holds the
      // verdict. A size walk still running from an earlier sample is not started twice.
      if (rootPid !== null) {
        let next: null | TreeCpu = null

        try {
          next = await settleWithin(sampleCpu(rootPid), INSTALL_PROBE_DEADLINE_MS, null)
        } catch {
          next = null
        }

        if (next) {
          progressed = cpuProgressed(cpu, next) || progressed
          cpu = next
        }
      }

      if (!progressed && probes.sampleBytes && !bytesInFlight) {
        let next: null | number = null

        try {
          bytesInFlight = true
          const walk = Promise.resolve(probes.sampleBytes())
          void walk.finally(() => (bytesInFlight = false)).catch(() => undefined)
          next = await settleWithin(walk, INSTALL_PROBE_DEADLINE_MS, null)
        } catch {
          bytesInFlight = false
          next = null
        }

        // "Unknown" (null) is never progress, and never replaces the last known size (critic r2c minor E).
        progressed = next !== null && bytes !== null && next !== bytes
        bytes = next ?? bytes
      }

      if (stopped || controller.signal.aborted) {
        return
      }

      const now = Date.now()

      if (progressed) {
        lastProgressAt = now
      } else if (now - lastProgressAt >= timing.stallMs) {
        trip(
          `${INSTALL_WATCHDOG_TAG} no progress (output, CPU or bytes written) for ${Math.round(timing.stallMs / 1000)} s`
        )

        return
      }

      if (now - lastHeartbeatAt >= timing.heartbeatMs) {
        lastHeartbeatAt = now
        emit({ type: 'stage-alive', stage, idleMs: now - lastProgressAt })
      }
    } finally {
      sampling = false
    }
  }

  const sampler = setInterval(() => void sample(), timing.sampleMs)

  const ceilingTimer = setTimeout(
    () => trip(`${INSTALL_WATCHDOG_TAG} ceiling ${INSTALL_CEILING_MS / 1000} s reached`),
    Math.max(0, deadlineAt - Date.now())
  )

  const onCallerAbort = () => controller.abort()

  if (abortSignal?.aborted) {
    controller.abort()
  } else {
    abortSignal?.addEventListener('abort', onCallerAbort, { once: true })
  }

  // The first size, in the background; a probe that throws even synchronously is just "unknown" (r2c3 D2). It counts
  // as the walk in flight: no sample starts a second one while it runs (critic r2c3 F2).
  if (probes.sampleBytes) {
    try {
      bytesInFlight = true
      const first = Promise.resolve(probes.sampleBytes())
      void first.then(
        size => {
          bytesInFlight = false
          bytes = bytes ?? size
        },
        () => {
          bytesInFlight = false
        }
      )
    } catch {
      bytesInFlight = false
    }
  }

  return {
    /** Name the stage's process: its tree's CPU time counts as progress from now on. */
    attach: (pid: number | undefined) => {
      rootPid = typeof pid === 'number' ? pid : null
    },
    emit: ((ev: BootstrapEvent) => {
      if (ev.type === 'log' && !controller.signal.aborted) {
        output = true
      }

      emit(ev)
    }) as BootstrapEmit,
    reason: () => reason,
    signal: controller.signal,
    stop: () => {
      stopped = true
      clearInterval(sampler)
      clearTimeout(ceilingTimer)
      abortSignal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

/**
 * Arms the stage watchdog over `abortSignal` (ruling 42 r2). Every INSTALL_SAMPLE_MS it asks whether the stage
 * progressed — a log line, CPU time in its process tree (once `attach(pid)` named the stage's process), or a change in
 * the bytes under its target (walked only when neither cheap signal moved). INSTALL_STALL_MS without any of them stops
 * the stage; so does the first-launch budget's deadline (one 15-minute budget for the whole first launch, no per-stage
 * cap). Every INSTALL_HEARTBEAT_MS it emits `stage-alive` (the renderer follows main; it never judges the stage). The
 * stop goes through the Cancel path (the whole process group); `reason()` names what tripped it.
 */
export function armStageWatchdog(
  emit: BootstrapEmit,
  abortSignal: AbortSignal | undefined,
  stage = '',
  probes: StageProgressProbes = {}
) {
  return createStageWatchdog(emit, abortSignal, stage, probes, {
    heartbeatMs: INSTALL_HEARTBEAT_MS,
    sampleMs: INSTALL_SAMPLE_MS,
    stallMs: INSTALL_STALL_MS
  })
}

async function runStage({
  scriptPath,
  installerKind,
  stage,
  emit,
  hermesHome,
  home,
  activeRoot,
  abortSignal,
  installStamp,
  pinCommit,
  curatedCommit,
  policy = 'developer'
}: RunStageOptions): Promise<StageEvent> {
  const startedAt = Date.now()
  emit({ type: 'stage', name: stage.name, state: 'running' })

  const isPosix = installerKind === 'posix'

  const args = isPosix
    ? [
        '--stage',
        stage.name,
        '--non-interactive',
        '--json',
        ...buildPosixPinArgs({ installStamp, activeRoot, curatedCommit, hermesHome, pinCommit, policy })
      ]
    : ['-Stage', stage.name, '-NonInteractive', '-Json', ...buildPinArgs(installStamp, { pinCommit })]

  // r2: the stage's target is where it writes (the runtime root): bytes landing there are progress too.
  const target = activeRoot || null

  const watchdog = armStageWatchdog(emit, abortSignal, stage.name, {
    deadlineAt: beginInstallBudget(),
    ...(target ? { sampleBytes: () => treeBytes(target) } : {})
  })

  let result: SpawnResult

  try {
    result = await (isPosix ? spawnBash : spawnPowerShell)(scriptPath, args, {
      onChild: watchdog.attach,
      emit: watchdog.emit,
      stageName: stage.name,
      abortSignal: watchdog.signal,
      hermesHome,
      ...(home ? { home } : {})
    })
  } finally {
    watchdog.stop()
  }

  const durationMs = Date.now() - startedAt

  if (result.killed) {
    return finishStage(emit, stage.name, 'failed', durationMs, { error: watchdog.reason() ?? 'cancelled by user' })
  }

  const json = parseStageResult(result.stdout)

  if (!json) {
    const error = `${isPosix ? 'install.sh --stage' : 'install.ps1 -Stage'} ${stage.name} produced no JSON result frame (exit=${result.code})`

    return finishStage(emit, stage.name, 'failed', durationMs, { error, json: null })
  }

  if (json.ok && json.skipped) {
    return finishStage(emit, stage.name, 'skipped', durationMs, { json })
  }

  if (json.ok) {
    return finishStage(emit, stage.name, 'succeeded', durationMs, { json })
  }

  return finishStage(emit, stage.name, 'failed', durationMs, { json, error: json.reason || `exit code ${result.code}` })
}

// ---------------------------------------------------------------------------
// Per-run log file
// ---------------------------------------------------------------------------

/** The run log is best effort: a log root that cannot be created, opened or written (EACCES, ENOSPC) only loses the log. */
function openRunLog(logRoot: string) {
  try {
    fs.mkdirSync(logRoot, { recursive: true })
  } catch {
    // The stream's open fails below and is swallowed by its 'error' listener.
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logRoot, `bootstrap-${ts}.log`)
  const stream = fs.createWriteStream(logPath, { flags: 'a' })

  // Without a listener an open or write error is an uncaught exception in main; closeRunLog's finished() still sees it.
  stream.on('error', () => {})

  return { path: logPath, stream }
}

/** Ends the run log and waits until it is closed, so the file holds every event once the run returns. Never throws. */
async function closeRunLog(stream: fs.WriteStream) {
  try {
    stream.end()
    await finished(stream)
  } catch {
    // finished() rejects with the open/write error openRunLog's listener already absorbed.
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

async function runBootstrap(opts: {
  _alignCheckout?: AlignCheckout
  _fetchManifest?: (opts: Omit<RunStageOptions, 'abortSignal' | 'stage'>) => Promise<InstallerManifest>
  _installSource?: InstallSource
  _resolveInstallScript?: (
    opts: Parameters<typeof resolveInstallScript>[0]
  ) => Promise<{ kind?: InstallerKind; path: string }>
  _runStage?: (opts: RunStageOptions) => Promise<{ error?: string; state: string }>
  abortSignal?: AbortSignal
  activeRoot: string
  hermesHome: string
  installStamp?: InstallStamp | null
  logRoot?: null | string
  onEvent?: BootstrapEmit
  policy?: UpdatePolicy
  /** userData/runtime-choice.json (default: the file main bound at startup). */
  runtimeChoiceFile?: null | string
  /** For tests: the checkout HEAD reader. */
  _resolveHead?: (activeRoot: string) => null | string
  sourceRepoRoot?: null | string
  /** In ICLONE_MANAGED.json when this run installs the runtime from the pinned tarball (V3-S r3, m-d). */
  appVersion?: string
  /** V3-RT (ruling 36): the app's own runtime keeps uv, Python, PM's store and its environment inside its folder. */
  privateDependencies?: null | PrivateDependencies
  /** K-RT2: this run installs the app's own runtime for a user who had a previous release (one notice says so). */
  purpose?: 'runtime-upgrade'
  writeMarker?: (payload: { pinnedBranch: null | string | undefined; pinnedCommit: null | string }) => unknown
}) {
  const {
    installStamp,
    activeRoot,
    sourceRepoRoot,
    hermesHome,
    logRoot,
    onEvent,
    abortSignal,
    writeMarker, // callback to write the bootstrap-complete marker; main.ts provides
    appVersion = 'unknown',
    privateDependencies = null,
    purpose,
    policy = 'developer', // update policy (update-policy.ts); curated pins every install.sh run
    runtimeChoiceFile = runtimeChoiceFileOf(),
    _resolveHead = resolveCheckoutHead,
    _installSource = installSourceTarball,
    _resolveInstallScript = resolveInstallScript,
    _fetchManifest = fetchManifest,
    _runStage = runStage,
    _alignCheckout = alignCheckoutToPin
  } = opts

  // Bail before spawning anything if the user already cancelled — otherwise an
  // already-aborted signal would still fetch the manifest (a spawn) before the
  // in-loop abort check fires.
  if (abortSignal && abortSignal.aborted) {
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type: 'failed', error: 'bootstrap cancelled by user' })
      } catch {
        void 0
      }
    }

    return { ok: false, cancelled: true }
  }

  const runLog = openRunLog(logRoot || path.join(hermesHome, 'logs'))

  // Tee every event to the runLog AND the caller's onEvent. This gives us a
  // forensic trail per bootstrap run AND lets the renderer subscribe live.
  const emit: BootstrapEmit = ev => {
    try {
      runLog.stream.write(JSON.stringify(ev) + '\n')
    } catch {
      void 0
    }

    try {
      if (typeof onEvent === 'function') {
        onEvent(ev)
      }
    } catch (err) {
      // Don't let a subscriber bug crash the bootstrap
      runLog.stream.write(`emit error: ${errorMessage(err)}\n`)
    }
  }

  emit({
    type: 'log',
    line:
      `[bootstrap] starting at ${new Date().toISOString()}; ` +
      `activeRoot=${activeRoot}; ` +
      `stamp=${installStamp ? installStamp.commit.slice(0, 12) : '<none>'}; ` +
      `runLog=${runLog.path}`
  })

  try {
    const existingCheckout = hasExistingGitCheckout(activeRoot)
    // Curated: a repair of an existing checkout is pinned too (install.sh without
    // --commit would move it to origin/main — an automatic upstream update).
    const pinCommit = !existingCheckout || policy === 'curated'

    // U1: Repair never downgrades a runtime the user chose (door agent-latest) while HEAD still is it.
    const curatedCommit = existingCheckout
      ? repairCommit({
          choice: runtimeChoiceFile ? readRuntimeChoice(runtimeChoiceFile) : null,
          head: _resolveHead(activeRoot),
          pinSha: RUNTIME_PIN_SHA
        })
      : RUNTIME_PIN_SHA

    if (existingCheckout && installStamp && installStamp.commit) {
      emit({
        type: 'log',
        line:
          `[bootstrap] existing checkout detected at ${activeRoot}; ` +
          `not pinning to packaged install stamp ${installStamp.commit.slice(0, 12)}`
      })
    }

    // 1. Resolve the platform installer.
    const scriptInfo = await _resolveInstallScript({ installStamp, sourceRepoRoot, hermesHome, emit })
    const installerKind = scriptInfo.kind || 'powershell'
    const sourceTarball = installerKind === 'posix' && !existingCheckout && Boolean(installRefForStamp(installStamp))

    if (sourceTarball) {
      emit({
        type: 'log',
        line: `${SOURCE_TARBALL_LOG_TAG} fresh install from the pinned source tarball ${RUNTIME_PIN_SHA.slice(0, 12)}; git is not used`
      })
    }

    // Curated repair of an existing checkout: the repository stage is the in-app,
    // content-addressed alignment (install.sh's would fetch and reset to origin/main first).
    const curatedAlign = existingCheckout && policy === 'curated' && installerKind === 'posix'

    if (curatedAlign) {
      emit({
        type: 'log',
        line: `${RUNTIME_PIN_LOG_TAG} existing checkout: repository stage = in-app alignment to ${curatedCommit.slice(0, 12)}${curatedCommit === RUNTIME_PIN_SHA ? '' : ' (the runtime you chose)'}`
      })
    }

    // 2. Fetch manifest
    const manifest = await _fetchManifest({
      scriptPath: scriptInfo.path,
      installerKind,
      emit,
      hermesHome,
      activeRoot,
      installStamp,
      pinCommit,
      curatedCommit,
      policy
    })

    const stages = curatedAlign ? stagesWithAlignment(manifest.stages) : manifest.stages

    emit({
      type: 'manifest',
      stages,
      protocolVersion: manifest.protocol_version || manifest.protocolVersion || null,
      ...(purpose ? { purpose } : {})
    })

    // 3. Iterate stages in order. Stages flagged needs_user_input are still
    //    invoked -- install.ps1's own -NonInteractive handler in those stages
    //    emits skipped=true. We trust the protocol rather than filtering
    //    client-side.
    for (const stage of stages) {
      if (abortSignal && abortSignal.aborted) {
        emit({ type: 'failed', error: 'bootstrap cancelled by user' })

        return { ok: false, cancelled: true }
      }

      const placed = placeStage(stage.name, hermesHome, privateDependencies)

      if (placed.skip) {
        emit({ type: 'log', stage: stage.name, line: `[bootstrap] ${stage.name} skipped: ${placed.skip}` })
        finishStage(emit, stage.name, 'skipped', 0, {
          json: { ok: true, reason: placed.skip, skipped: true, stage: stage.name }
        })

        continue
      }

      const ev = await (curatedAlign && stage.name === 'repository'
        ? runAlignStage({ stage, emit, activeRoot, sha: curatedCommit, align: _alignCheckout })
        : sourceTarball && SOURCE_TARBALL_STAGES.has(stage.name)
          ? runSourceStage({
              stage,
              emit,
              hermesHome,
              activeRoot,
              abortSignal,
              appVersion,
              installSource: _installSource
            })
          : _runStage({
              scriptPath: scriptInfo.path,
              installerKind,
              stage,
              emit,
              hermesHome: placed.hermesHome,
              ...(placed.home ? { home: placed.home } : {}),
              activeRoot,
              abortSignal,
              installStamp,
              pinCommit,
              curatedCommit,
              policy
            }))

      if (ev.state === 'failed') {
        emit({ type: 'failed', stage: stage.name, error: ev.error || 'stage failed' })

        return { ok: false, failedStage: stage.name, error: ev.error }
      }
    }

    // 4. Write the bootstrap-complete marker. Fallback (all-zero) stamps are
    // not real pins -- resolve HEAD from the checkout we just installed so
    // isBootstrapComplete() (pinnedCommit.length >= 7) accepts the marker
    // instead of re-running bootstrap on every launch (#50823 review).
    const pinnedCommit = resolveMarkerPinnedCommit(installStamp, activeRoot)

    if (!pinnedCommit) {
      emit({
        type: 'log',
        line:
          '[bootstrap] WARNING: could not resolve a real pinnedCommit for the ' +
          'bootstrap-complete marker; subsequent launches may re-run bootstrap'
      })
    } else if (installStamp && !isPinnedCommit(installStamp.commit)) {
      emit({
        type: 'log',
        line: `[bootstrap] fallback stamp resolved marker pin to ${pinnedCommit.slice(0, 12)} from checkout`
      })
    }

    const markerPayload = {
      pinnedCommit,
      pinnedBranch: installStamp ? installStamp.branch : null
    }

    const marker = typeof writeMarker === 'function' ? writeMarker(markerPayload) : markerPayload
    emit({ type: 'complete', marker })

    return { ok: true, marker }
  } catch (err) {
    emit({ type: 'failed', error: errorMessage(err) })

    return { ok: false, error: errorMessage(err) }
  } finally {
    await closeRunLog(runLog.stream)
  }
}

// ---------------------------------------------------------------------------
// Pinned runtime update (packaged Track A "Update now", contract decision 13b)
// ---------------------------------------------------------------------------

interface RuntimePin {
  /** sha256 of install.sh at `sha` (the bundled pin always has it). */
  installShSha256?: string
  minApp: string
  sha: string
  /** sha256 of the codeload tarball of `sha`; required to update a tarball (non-git) install. */
  tarballSha256?: string
}

/** `{"sha": "<40-hex>", "min_app": "x.y.z"}` from the release's runtime.json, or null. */
export function parseRuntimePin(raw: unknown): null | RuntimePin {
  let value = raw

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const {
    sha,
    min_app: minApp,
    tarball_sha256: tarballSha256
  } = value as { min_app?: unknown; sha?: unknown; tarball_sha256?: unknown }

  if (typeof sha !== 'string' || !SHA40_RE.test(sha) || typeof minApp !== 'string' || !SEMVER_RE.test(minApp)) {
    return null
  }

  if (tarballSha256 === undefined) {
    return { minApp, sha }
  }

  return typeof tarballSha256 === 'string' && SHA256_RE.test(tarballSha256) ? { minApp, sha, tarballSha256 } : null
}

// A tarball install has no .git for install.sh's update path, so the new source
// tree is swapped in and the stages after `repository` run from it. The old
// venv moves across first: the running runtime keeps importing from the same
// path, and python-deps syncs it in place (the venv stage would recreate it).
// These are install.sh's own stage names at the pin (stage_names: prerequisites repository venv python-deps config
// products setup gateway complete); setup and gateway need a person. V3-RT: the list named `node-deps` and `path`,
// which install.sh at 1ac3f97 answers with "unknown stage" (exit 2), so every tarball Update/Repair failed.
export const SOURCE_UPDATE_STAGES = ['python-deps', 'config', 'products']

async function runSourceRuntimeUpdate({
  activeRoot,
  appVersion,
  emit,
  hermesHome,
  pin,
  privateDependencies = null,
  _installSource,
  _spawn
}: SourceUpdateOpts) {
  const sha256 = pin.tarballSha256 || (pin.sha === RUNTIME_PIN_SHA ? RUNTIME_PIN_TARBALL_SHA256 : null)

  if (!sha256) {
    emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} runtime.json has no tarball_sha256 for a tarball install` })

    return {
      ok: false,
      error: 'pin-no-tarball',
      message: 'This runtime release has no source checksum. iclone os keeps running on the current runtime.',
      sha: pin.sha
    }
  }

  const stageEvent = (name: string, state: StageState, durationMs?: number, error?: string) =>
    emit({
      type: 'stage',
      name,
      state,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error ? { error } : {})
    })

  let started = Date.now()
  stageEvent('repository', 'running')

  let installed: SourceInstallResult

  try {
    installed = await _installSource({
      appVersion,
      cacheDir: bootstrapCacheDir(hermesHome),
      emit,
      sha: pin.sha,
      sha256,
      targetDir: activeRoot
    })
  } catch (error) {
    stageEvent('repository', 'failed', Date.now() - started, errorMessage(error))
    throw error
  }

  stageEvent('repository', 'succeeded', Date.now() - started)

  if (installed.reused) {
    return { ok: true, code: 0, message: 'The runtime is already at this version.', sha: pin.sha }
  }

  const oldVenv = installed.previousDir ? path.join(installed.previousDir, 'venv') : null
  const stages = [...SOURCE_UPDATE_STAGES]

  if (oldVenv && fs.existsSync(oldVenv)) {
    fs.renameSync(oldVenv, path.join(activeRoot, 'venv'))
  } else {
    stages.unshift('venv')
  }

  const script = path.join(activeRoot, 'scripts', 'install.sh')

  for (const name of stages) {
    const placed = placeStage(name, hermesHome, privateDependencies)

    if (placed.skip) {
      emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} ${name} skipped: ${placed.skip}` })
      stageEvent(name, 'skipped', 0)

      continue
    }

    started = Date.now()
    stageEvent(name, 'running')

    const result = await _spawn(
      script,
      ['--stage', name, '--non-interactive', '--json', '--dir', activeRoot, '--hermes-home', placed.hermesHome],
      {
        emit,
        hermesHome: placed.hermesHome,
        ...(placed.home ? { home: placed.home } : {}),
        stageName: `runtime-update:${name}`
      }
    )

    const json = parseStageResult(result.stdout || '')

    stageEvent(
      name,
      result.code === 0 && json?.ok ? 'succeeded' : 'failed',
      Date.now() - started,
      result.code === 0 && json?.ok ? undefined : json?.reason || `exit ${result.code}`
    )

    if (result.code !== 0 || !json || !json.ok) {
      const venv = path.join(activeRoot, 'venv')

      if (oldVenv && installed.previousDir && fs.existsSync(venv) && !fs.existsSync(oldVenv)) {
        fs.renameSync(venv, oldVenv)
      }

      restoreSourceTree(activeRoot, installed.previousDir)
      emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} stage ${name} failed; previous runtime tree restored` })

      return {
        ok: false,
        code: result.code,
        error: 'runtime-update-failed',
        message: `Runtime update failed (${name}). iclone os keeps running on the current runtime.`,
        sha: pin.sha
      }
    }
  }

  emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} runtime now at ${pin.sha.slice(0, 12)} (source tarball)` })

  return { ok: true, code: 0, manualRestart: true, message: 'Runtime updated — reopen iclone os', sha: pin.sha }
}

/** True when `appVersion` (x.y.z) is at least `minApp`; anything unparseable answers false. */
export function appMeetsMinimum(appVersion: string, minApp: string): boolean {
  const a = SEMVER_RE.exec(String(appVersion))
  const b = SEMVER_RE.exec(String(minApp))

  if (!a || !b) {
    return false
  }

  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i])

    if (d !== 0) {
      return d > 0
    }
  }

  return true
}

const PIN_MAX_BYTES = 64 * 1024

function httpsGetText(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/octet-stream' } }, res => {
        const status = res.statusCode || 0

        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume()
          resolve(httpsGetText(new URL(res.headers.location, url).toString(), redirects - 1))

          return
        }

        if (status !== 200) {
          res.resume()
          reject(new Error(`HTTP ${status} from ${url}`))

          return
        }

        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk

          if (body.length > PIN_MAX_BYTES) {
            res.destroy(new Error('runtime.json is larger than expected'))
          }
        })
        res.on('end', () => resolve(body))
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

async function fetchRuntimePin(get: (url: string) => Promise<string> = httpsGetText): Promise<RuntimePin> {
  const pin = parseRuntimePin(await get(RUNTIME_PIN_URL))

  if (!pin) {
    throw new Error('runtime.json of the latest release is not a valid pin')
  }

  return pin
}

let pinnedRuntimeUpdateRunning = false

// The downloaded install.sh is verified at the pin, always: the bundled pin
// carries its hash; a fetched developer pin without one is refused.
function scriptMatchesPin(file: string, pin: RuntimePin & { installShSha256?: string }) {
  if (installScriptKind() !== 'posix') {
    return true
  }

  const want = pin.installShSha256 || (pin.sha === RUNTIME_PIN_SHA ? RUNTIME_PIN_INSTALL_SH_SHA256 : null)

  try {
    return Boolean(want) && sha256File(file) === want
  } catch {
    return false
  }
}

/** True while a pinned runtime update runs in this process (the app updater must not install meanwhile). */
export function isPinnedRuntimeUpdateRunning(): boolean {
  return pinnedRuntimeUpdateRunning
}

// ---------------------------------------------------------------------------
// Content-addressed alignment of an existing git checkout (curated policy)
// ---------------------------------------------------------------------------

interface GitResult {
  code: null | number
  stderr: string
  stdout: string
}

type GitRunner = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitResult>

/** Runs git in `cwd`; never throws, never prompts. */
/** git through electron/lib/git (non-interactive, output capped); never rejects: a spawn failure reads as `code: null`. */
function gitResult(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitResult> {
  return runGit(args, { cwd, timeoutMs }).then(
    ({ code, stderr, stdout }) => ({ code, stderr, stdout }),
    () => ({ code: null, stderr: '', stdout: '' })
  )
}

interface CheckoutAlignResult {
  error?: string
  /** The pin object was missing locally and was fetched by its sha. */
  fetched: boolean
  from: null | string
  message: string
  ok: boolean
  /**
   * Set only while local changes are still parked in a stash under this name: the
   * re-apply after the checkout (or the restore after a failure) did not apply cleanly.
   */
  stash?: string
}

/**
 * Moves an existing runtime checkout to `sha` by content only: `git fetch origin
 * <sha>` when the object is missing, then `git checkout --detach <sha>`. It never
 * fetches a branch and never passes through another commit, so a failure leaves
 * the checkout where it was. install.sh's repository stage is not used for this:
 * it fetches and resets to origin/<branch> before it pins.
 *
 * Local changes follow install.sh's autostash: package-lock.json churn is discarded
 * (unless its package.json is dirty too), the rest is stashed, then re-applied with
 * `git stash pop --index` on the moved checkout. A re-apply that conflicts resets the
 * tree to the pin and keeps the stash, named in the result.
 */
async function alignCheckoutToPin({
  activeRoot,
  emit,
  sha,
  _git = gitResult
}: {
  _git?: GitRunner
  activeRoot: string
  emit: BootstrapEmit
  sha: string
}): Promise<CheckoutAlignResult> {
  const say = (line: string) => emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} ${line}` })
  const pin = String(sha || '').toLowerCase()

  const fail = (error: string, message: string, from: null | string = null, fetched = false, stash?: string) => {
    say(`align ${pin.slice(0, 12) || 'n/a'} failed: ${message}`)

    return { ok: false, error, message, from, fetched, ...(stash ? { stash } : {}) }
  }

  if (!SHA40_RE.test(pin)) {
    return fail('pin-invalid', 'the runtime pin is not a 40-hex commit')
  }

  const head = await _git(['rev-parse', '--verify', 'HEAD'], activeRoot)
  const from = head.code === 0 ? head.stdout.trim().toLowerCase() : null

  if (!from || !SHA40_RE.test(from)) {
    return fail('checkout-unreadable', `cannot read HEAD in ${activeRoot}`)
  }

  if (from === pin) {
    say(`checkout already at ${pin.slice(0, 12)}`)

    return { ok: true, fetched: false, from, message: 'Runtime already at the pin.' }
  }

  const hasPin = async () => (await _git(['cat-file', '-e', `${pin}^{commit}`], activeRoot)).code === 0
  let fetched = false

  if (!(await hasPin())) {
    say(`fetching ${pin.slice(0, 12)} by sha (content-addressed; no branch)`)

    const res = await _git(
      [
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        pin
      ],
      activeRoot,
      300_000
    )

    fetched = true

    if (res.code !== 0 || !(await hasPin())) {
      return fail('pin-fetch-failed', `cannot fetch ${pin.slice(0, 12)} from origin`, from, fetched)
    }
  }

  await discardLockfileChurn(_git, activeRoot)

  let stash: string | undefined
  const status = await _git(['status', '--porcelain'], activeRoot)

  if (status.code !== 0) {
    return fail('checkout-unreadable', 'git status failed', from, fetched)
  }

  if (status.stdout.trim()) {
    const unmerged = await _git(['ls-files', '--unmerged'], activeRoot)

    if (unmerged.stdout.trim() && (await _git(['reset', '-q'], activeRoot)).code !== 0) {
      return fail('local-changes-blocked', 'cannot clear the unmerged index', from, fetched)
    }

    stash = `iclone-align-autostash-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`

    if ((await _git(['stash', 'push', '--include-untracked', '-m', stash], activeRoot)).code !== 0) {
      return fail('local-changes-blocked', 'could not stash local changes; commit or move them aside', from, fetched)
    }

    say(`local changes stashed as ${stash}`)
  }

  const symbolicHead = async () => {
    const ref = await _git(['symbolic-ref', '-q', 'HEAD'], activeRoot)

    return ref.code === 0 ? ref.stdout.trim() : null
  }

  const branch = await symbolicHead()

  // A failed checkout puts HEAD (branch or detached) and the parked changes back; a stash
  // that cannot be re-applied cleanly stays parked and is named in the failure message.
  const failRestored = async (error: string, message: string) => {
    const now = await _git(['rev-parse', '--verify', 'HEAD'], activeRoot)
    const moved = now.stdout.trim().toLowerCase() !== from || (await symbolicHead()) !== branch

    if (moved) {
      const back = branch
        ? ['checkout', '-q', branch.replace(/^refs\/heads\//, ''), '--']
        : ['checkout', '-q', '--detach', from]

      const check =
        (await _git(back, activeRoot)).code === 0 ? await _git(['rev-parse', '--verify', 'HEAD'], activeRoot) : null

      if (!check || check.stdout.trim().toLowerCase() !== from) {
        const parked = stash ? `; local changes kept in stash ${stash}` : ''

        return fail(
          error,
          `${message}; could not return the checkout to ${from.slice(0, 12)}${parked}`,
          from,
          fetched,
          stash
        )
      }
    }

    if (!stash) {
      return fail(error, `${message}; checkout left at ${from.slice(0, 12)}`, from, fetched)
    }

    const top = await _git(['stash', 'list', '--max-count=1', '--format=%gs'], activeRoot)

    const popped =
      top.code === 0 && top.stdout.includes(stash) && (await _git(['stash', 'pop', '--index'], activeRoot)).code === 0

    if (!popped) {
      return fail(
        error,
        `${message}; checkout left at ${from.slice(0, 12)}; local changes kept in stash ${stash} (git stash pop --index did not apply cleanly)`,
        from,
        fetched,
        stash
      )
    }

    say(`local changes restored from ${stash}`)

    return fail(error, `${message}; checkout left at ${from.slice(0, 12)} with its local changes`, from, fetched)
  }

  if ((await _git(['checkout', '-q', '--detach', pin], activeRoot)).code !== 0) {
    return failRestored('checkout-failed', `git checkout --detach ${pin.slice(0, 12)} failed`)
  }

  const after = await _git(['rev-parse', '--verify', 'HEAD'], activeRoot)

  if (after.code !== 0 || after.stdout.trim().toLowerCase() !== pin) {
    return failRestored('checkout-not-at-pin', `HEAD is not ${pin.slice(0, 12)} after the checkout`)
  }

  // git exits 0 when it cannot write a file (read-only dir, full disk): only a clean tracked tree is "at the pin".
  const tree = await _git(['status', '--porcelain', '--untracked-files=no'], activeRoot)

  if (tree.code !== 0 || tree.stdout.trim()) {
    return failRestored('checkout-incomplete', `the checkout of ${pin.slice(0, 12)} left tracked files unwritten`)
  }

  say(`checkout ${from.slice(0, 12)} -> ${pin.slice(0, 12)}${fetched ? ' (pin fetched by sha)' : ''}`)

  if (!stash) {
    return { ok: true, fetched, from, message: 'Runtime checkout at the pin.' }
  }

  const top = await _git(['stash', 'list', '--max-count=1', '--format=%gs'], activeRoot)

  if (
    top.code === 0 &&
    top.stdout.includes(stash) &&
    (await _git(['stash', 'pop', '--index'], activeRoot)).code === 0
  ) {
    say(`local changes re-applied from ${stash}`)

    return { ok: true, fetched, from, message: 'Runtime checkout at the pin with its local changes.' }
  }

  await _git(['reset', '-q', '--hard', 'HEAD'], activeRoot)
  say(`local changes conflict with ${pin.slice(0, 12)}; kept in stash ${stash}`)

  return {
    ok: true,
    fetched,
    from,
    message: `Runtime checkout at the pin; local changes conflict with it and are kept in stash ${stash} (git stash apply to restore them).`,
    stash
  }
}

/** install.sh's discard_update_lockfile_churn: a dirty package-lock.json whose package.json is clean is npm noise. */
async function discardLockfileChurn(_git: GitRunner, activeRoot: string) {
  const diff = await _git(['diff', '--name-only'], activeRoot)

  if (diff.code !== 0) {
    return
  }

  const dirty = diff.stdout.split('\n').filter(Boolean)

  const packageDirs = new Set(
    dirty.filter(f => path.posix.basename(f) === 'package.json').map(f => path.posix.dirname(f))
  )

  for (const lock of dirty) {
    if (path.posix.basename(lock) === 'package-lock.json' && !packageDirs.has(path.posix.dirname(lock))) {
      await _git(['checkout', '--', lock], activeRoot)
    }
  }
}

/** The repository stage of a curated existing-checkout run: the in-app alignment, with stage events. */
async function runAlignStage({ stage, emit, activeRoot, sha, align }: AlignStageOpts) {
  const startedAt = Date.now()
  emit({ type: 'stage', name: stage.name, state: 'running' })
  const res: CheckoutAlignResult = await align({ activeRoot, emit, sha })
  const durationMs = Date.now() - startedAt

  return res.ok
    ? finishStage(emit, stage.name, 'succeeded', durationMs, { json: { ok: true, stage: stage.name, aligned: sha } })
    : finishStage(emit, stage.name, 'failed', durationMs, { error: `${res.error}: ${res.message}` })
}

/** Manifest order with the repository stage guaranteed (first when the manifest omits it). */
function stagesWithAlignment(stages: { name: string }[]): { name: string }[] {
  return stages.some(s => s.name === 'repository') ? stages : [{ name: 'repository' }, ...stages]
}

/**
 * Curated alignment of an existing checkout to the bundled pin: the repository
 * stage is the in-app content-addressed checkout; every other stage of the pinned
 * installer runs alone (`--stage <name>`), so install.sh never touches git here.
 */
async function alignBundledPin({ activeRoot, emit, hermesHome, pin, script, _alignCheckout, _spawn }: AlignPinOpts) {
  const pinArgs = ['--dir', activeRoot, '--hermes-home', hermesHome, '--branch', UPSTREAM_BRANCH, '--commit', pin.sha]
  const kept = 'iclone os keeps running on the current runtime.'
  // Once the checkout is at the pin a later stage failure no longer leaves the old runtime in place.
  let after = kept
  let parked = ''
  const listed = await _spawn(script, ['--manifest', ...pinArgs], { emit, hermesHome, stageName: '__manifest__' })
  const manifest = listed && listed.code === 0 ? parseManifest(listed.stdout) : null

  if (!manifest) {
    return {
      ok: false,
      code: listed?.code ?? null,
      error: 'runtime-update-failed',
      message: `The pinned installer printed no stage list. ${kept}`,
      sha: pin.sha
    }
  }

  for (const stage of stagesWithAlignment(manifest.stages)) {
    if (stage.name === 'repository') {
      const aligned: CheckoutAlignResult = await _alignCheckout({ activeRoot, emit, sha: pin.sha })

      if (!aligned.ok) {
        return {
          ok: false,
          error: 'runtime-update-failed',
          message: `Runtime alignment failed (${aligned.message}). ${kept}`,
          sha: pin.sha
        }
      }

      after = `The runtime checkout is already at ${pin.sha.slice(0, 7)}; Repair or reopening iclone os finishes the update.`
      parked = aligned.stash
        ? ` Local changes conflict with the pin and are kept in stash ${aligned.stash} (git stash apply to restore them).`
        : ''

      continue
    }

    const run = await _spawn(script, ['--stage', stage.name, '--non-interactive', '--json', ...pinArgs], {
      emit,
      hermesHome,
      stageName: `runtime-update:${stage.name}`
    })

    const frame = parseStageResult(String(run?.stdout ?? ''))

    if (run?.code !== 0 || (frame && !frame.ok)) {
      return {
        ok: false,
        code: run?.code ?? null,
        error: 'runtime-update-failed',
        message: `Runtime update failed at ${stage.name} (exit ${run?.code}). ${after}${parked}`,
        sha: pin.sha
      }
    }
  }

  emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} runtime now at ${pin.sha.slice(0, 12)} (content-addressed)` })

  return {
    ok: true,
    code: 0,
    manualRestart: true,
    message: `Runtime updated — reopen iclone os${parked ? `.${parked}` : ''}`,
    sha: pin.sha
  }
}

/** @public Named by inferred types of electron/main exports (declaration emit). */
export interface PinnedRuntimeUpdateResult {
  code?: null | number
  error?: string
  /** The app keeps running on the old runtime until the owner reopens it (renderer: manual-restart state). */
  manualRestart?: boolean
  message: string
  ok: boolean
  sha?: string
}

/**
 * Moves the runtime checkout to the curated pin with the installer of that same
 * commit (`install.sh --commit <sha>`; a commit URL is content-addressed). The
 * app keeps running and does not relaunch itself, so the result says so.
 */
export async function runPinnedRuntimeUpdate({
  activeRoot,
  appUpdatePending = false,
  appVersion,
  emit,
  hermesHome,
  pin: bundledPin,
  privateDependencies = null,
  _download = downloadInstallScript,
  _fetchPin = () => fetchRuntimePin(),
  _installSource = installSourceTarball,
  _spawn = spawnBash,
  _alignCheckout = alignCheckoutToPin
}: {
  _alignCheckout?: typeof alignCheckoutToPin
  _download?: (ref: string, dest: string) => Promise<unknown>
  _fetchPin?: () => Promise<RuntimePin>
  _installSource?: typeof installSourceTarball
  _spawn?: InstallerSpawn
  activeRoot: string
  /** An app bundle is downloading or downloaded: the two updaters never run at once. */
  appUpdatePending?: boolean
  appVersion: string
  emit: BootstrapEmit
  hermesHome: string
  /** The pin this app bundles (curated): no fetch, no min_app check (it is this app's own). */
  pin?: RuntimePin
  /** V3-RT (ruling 36): the app's own runtime keeps its installer's outputs inside its folder. */
  privateDependencies?: null | PrivateDependencies
}): Promise<PinnedRuntimeUpdateResult> {
  if (appUpdatePending) {
    emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} runtime update refused: an app update is downloading or ready` })

    return {
      ok: false,
      error: 'app-update-pending',
      message: 'An iclone os update is ready — restart to install it first, then update the runtime.'
    }
  }

  if (pinnedRuntimeUpdateRunning) {
    return { ok: false, error: 'update-already-running', message: 'A runtime update is already running.' }
  }

  pinnedRuntimeUpdateRunning = true

  try {
    const pin = bundledPin ?? (await _fetchPin())

    if (!bundledPin && !appMeetsMinimum(appVersion, pin.minApp)) {
      return {
        ok: false,
        error: 'app-too-old',
        message: `This runtime needs iclone os ${pin.minApp} or newer — update the app first.`
      }
    }

    emit({
      type: 'log',
      line: `${RUNTIME_PIN_LOG_TAG} runtime update -> ${pin.sha.slice(0, 12)} (${bundledPin ? 'bundled pin' : 'runtime.json'})`
    })

    if (!hasExistingGitCheckout(activeRoot)) {
      return await runSourceRuntimeUpdate({
        activeRoot,
        appVersion,
        emit,
        hermesHome,
        pin,
        privateDependencies,
        _installSource,
        _spawn
      })
    }

    const script = cachedScriptPath(hermesHome, `runtime-${pin.sha}`)

    if (!fs.existsSync(script)) {
      await _download(pin.sha, script)
    }

    if (!scriptMatchesPin(script, pin)) {
      fs.rmSync(script, { force: true })

      return { ok: false, error: 'pin-mismatch', message: 'The pinned installer failed its sha256 check.' }
    }

    if (bundledPin) {
      return await alignBundledPin({ activeRoot, emit, hermesHome, pin, script, _alignCheckout, _spawn })
    }

    const result = await _spawn(
      script,
      [
        '--skip-setup',
        '--non-interactive',
        '--dir',
        activeRoot,
        '--hermes-home',
        hermesHome,
        '--branch',
        UPSTREAM_BRANCH,
        '--commit',
        pin.sha
      ],
      { emit, hermesHome, stageName: 'runtime-update' }
    )

    if (result.code !== 0) {
      return {
        ok: false,
        code: result.code,
        error: 'runtime-update-failed',
        message: `Runtime update failed (exit ${result.code}). iclone os keeps running on the current runtime.`,
        sha: pin.sha
      }
    }

    emit({ type: 'log', line: `${RUNTIME_PIN_LOG_TAG} runtime now at ${pin.sha.slice(0, 12)}` })

    return { ok: true, code: 0, manualRestart: true, message: 'Runtime updated — reopen iclone os', sha: pin.sha }
  } catch (err) {
    return { ok: false, error: 'runtime-pin-unavailable', message: `Runtime update unavailable: ${errorMessage(err)}` }
  } finally {
    pinnedRuntimeUpdateRunning = false
  }
}

export {
  alignCheckoutToPin,
  buildPinArgs,
  buildPosixPinArgs,
  cachedScriptPath,
  hasExistingGitCheckout,
  installedAgentInstallScript,
  installRefForStamp,
  isPinnedCommit,
  resolveCheckoutHead,
  resolveInstallScript,
  resolveMarkerPinnedCommit,
  runAlignStage,
  runBootstrap,
  gitResult as runGit,
  /** For the real-process watchdog tests (critic minor 7): the stage spawner itself. */
  spawnBash as spawnInstallerStage
}
