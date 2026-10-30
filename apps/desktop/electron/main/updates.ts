// Self-update support: branch resolution, upstream comparison, update gate and the POSIX/Windows hand-off.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { app, BrowserWindow, dialog } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { isRecord } from '../../src/iclone-shared/guards'
import { classifyActiveRuntime } from '../active-runtime-state'
import { canImportHermesCli, shouldTrustHermesOverride, verifyHermesCli } from '../backend-probes'
import { isWindowsBinaryPathInWsl } from '../bootstrap-platform'
import { readSourceMarker, resolveCheckoutHead, runPinnedRuntimeUpdate } from '../bootstrap-runner'
import { clearStaleGitLocks } from '../gitlock'
import { readAndConsumeHandoffResult } from '../handoff-result'
import { type FreshDependencyInstall, isRecordedInstall, sealRuntimeDependencies } from '../iclone-runtime-closed'
import { isolatePythonEnv } from '../iclone-spawn-env'
import { readJsonFileSync } from '../lib/fs-json'
import { codePathEnv } from '../packaged-env'
import {
  compareApiUrl,
  parseCompareBehindCount,
  resolveBehindCount,
  resolveCommitLogSelection,
  shouldCountCommits
} from '../update-count'
import { waitForUpdateClearance } from '../update-gate'
import { readLiveUpdateMarker, updateHandoffConflict, writeUpdateMarker } from '../update-marker'
import { BUNDLED_RUNTIME_PIN, runtimePinStatus } from '../update-policy'
import { isOfficialSshRemote, OFFICIAL_REPO_HTTPS_URL } from '../update-remote'
import {
  checkRuntimeHealthCommit,
  CURATED_CONFIG_MARKER_FILE,
  ensureCuratedRuntimeConfig,
  type HealthCommitCheck,
  readJsonFile,
  RUNTIME_ALIGN_FILE,
  type RuntimeAlignRecord,
  spawnCapped
} from '../update-runtime-align'
import { handoffRestartCopy, mayReplaceRunningBundle } from '../update-swap-guard'
import {
  collectRelaunchArgs,
  observeUpdaterHandoff,
  resolvePosixScriptHandoff,
  resolveStagedUpdaterBinary,
  sandboxFallbackFromEnv,
  spawnUpdaterProcess
} from '../updater-process'

import { advanceBootProgress } from './boot-progress'
import { readDesktopUpdateConfig, writeDesktopUpdateConfig } from './desktop-settings'
import {
  ACTIVE_HERMES_ROOT,
  activeVenvRoot,
  directoryExists,
  fileExists,
  HERMES_HOME,
  INSTALL_STAMP,
  IS_MAC,
  IS_PACKAGED,
  IS_WINDOWS,
  IS_WSL,
  isHermesSourceRoot,
  pathWithHermesManagedNode,
  resolveUpdateRoot,
  runtimePrivateDependencies,
  SOURCE_REPO_ROOT
} from './env'
import {
  findOnPath,
  findSystemPython,
  getVenvPython,
  isCommandScript,
  looksLikeDesktopAppBinary,
  unwrapWindowsVenvHermesCommand
} from './executables'
import { runResolvedGit } from './executables'
import { checkRuntimeIntegrity } from './iclone-gate'
import { rememberLog, updatePolicy } from './log'
import { BOOTSTRAP_COMPLETE_MARKER, BOOTSTRAP_MARKER_SCHEMA_VERSION } from './paths'
import { createActiveBackend, createPythonBackend, curatedRuntimeConfig, type HermesBackendSpec } from './runtime'
import { bootState, quitState } from './state'

// --- in-app update mutual exclusion (#50238) -------------------------------
// The Tauri updater writes HERMES_HOME/.hermes-update-in-progress for the whole
// duration of an `--update` run (see update.rs UpdateMarkerGuard). If the user
// relaunches the desktop mid-update — because the window vanished with no
// progress and looks crashed — a fresh instance must NOT spawn its own local
// backend: that backend re-locks the venv shim, the updater's straggler cleanup
// (`force_kill_other_hermes`, taskkill /IM hermes.exe) kills it, the launch
// fails with the 45s "backend didn't come up" error, and the relaunch/kill
// cycle loops. Instead the fresh instance parks until the update finishes, then
// brings the backend up itself (it is the surviving instance — the updater's
// own relaunch hits our single-instance lock and quits). Marker parsing +
// staleness self-heal live in update-marker.ts (unit-tested).

// How long we'll park the launch waiting for a live update to finish before
// giving up and starting the backend anyway (belt-and-suspenders alongside the
// marker's own age ceiling; covers a stuck-but-alive updater).
export const UPDATE_WAIT_TIMEOUT_MS = 20 * 60 * 1000
export const UPDATE_WAIT_POLL_MS = 1000
// How long the desktop lingers on the "updating, don't reopen" overlay after
// spawning the detached updater, before it quits to release the venv shim. The
// old 600ms was long enough to register the child process but far too short for
// the user to READ the overlay — the window just vanished, looked like a crash,
// and the user relaunched mid-update (the #50238 restart-loop trigger). A
// couple of seconds lets the message land and bridges the gap until the
// updater's own progress window appears. (#50419)
export const UPDATE_HANDOFF_DWELL_MS = 2500

// Gate deps shared by the primary-window boot path and the pool-backend
// spawn path. Consulting BOTH the on-disk marker and the in-process
// updateInFlight flag is load-bearing (#73822): applyUpdates kills its own
// backend BEFORE the Windows venv-blocker scan but only writes the marker
// AFTER it, so a marker-only gate lets the renderer's ~1s reconnect respawn
// a backend inside the update's own critical section — which the scan then
// reports as a blocker, aborting every update attempt.
export function updateGateDeps() {
  return {
    hasLiveMarker: () => Boolean(readLiveUpdateMarker(HERMES_HOME)),
    isUpdateInFlight: () => quitState.updateInFlight
  }
}

// Block until no live update is in progress (or we hit the wait timeout).
// Emits a boot-progress phase so the renderer shows "Update in progress…"
// rather than a frozen splash. Returns true if it parked at all.
// The upstream hand-off (posix.sh / windows.ps1) and the agent update (iclone-agent-update.sh) log separately.
function newestHandoffLog(): string {
  const logs = ['desktop-update-handoff.log', 'iclone-agent-update.log'].map(name =>
    path.join(HERMES_HOME, 'logs', name)
  )

  const mtime = (file: string) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0)

  return logs.reduce((a, b) => (mtime(b) > mtime(a) ? b : a))
}

export async function waitForUpdateToFinish() {
  let announced = false

  const outcome = await waitForUpdateClearance(updateGateDeps(), {
    onWaitTick: async reason => {
      if (!announced) {
        announced = true
        rememberLog(`[updates] update in progress (${reason}); deferring backend start until it finishes`)
      }

      await advanceBootProgress(
        'backend.update-wait',
        'An update is finishing — Hermes will start automatically when it completes…',
        12
      )
    },
    pollMs: UPDATE_WAIT_POLL_MS,
    timeoutMs: UPDATE_WAIT_TIMEOUT_MS
  })

  // The detached hand-off script (scripts/desktop-update/windows.ps1) runs hidden;
  // its result file is the ONLY way the user learns a detached update
  // failed. Consume it exactly once, here, right where boot passes the
  // update gate — success gets a log line, failure gets a real dialog
  // (previously a failed detached update was indistinguishable from
  // "nothing happened").
  try {
    const result = readAndConsumeHandoffResult(HERMES_HOME)

    if (result && result.ok && result.manual) {
      // Update landed but the user must act (reopen/reinstall/sandbox). On
      // machines with no shim browser and no notifier this dialog is the
      // FIRST time the message is visible — it must not be a log line.
      rememberLog(`[updates] detached update finished with manual action (branch ${result.branch}): ${result.message}`)
      dialog.showMessageBox({
        type: 'warning',
        title: 'iclone os update',
        message: 'The update finished, but needs one more step',
        detail: result.message
      })
    } else if (result && result.ok) {
      rememberLog(`[updates] detached update finished OK (branch ${result.branch})`)
    } else if (result) {
      rememberLog(`[updates] detached update FAILED (exit ${result.exitCode}): ${result.message}`)
      dialog.showErrorBox('Hermes update did not finish', `${result.message}\n\nDetails: ${newestHandoffLog()}`)
    }
  } catch (err) {
    rememberLog(`[updates] could not read hand-off result: ${errorMessage(err)}`)
  }

  if (outcome === 'clear') {
    return false
  }

  if (outcome === 'timeout') {
    rememberLog('[updates] update still in progress after wait timeout; starting backend anyway')
  } else {
    rememberLog('[updates] update finished; proceeding with backend start')
  }

  return true
}

const firstLine = (text: string) => (text || '').split('\n').find(Boolean) || ''

export async function getOriginUrl(updateRoot: string) {
  const origin = await runResolvedGit(['remote', 'get-url', 'origin'], boundedGit(updateRoot))

  return origin.code === 0 ? origin.stdout.trim() : ''
}

export function emitUpdateProgress(payload: Record<string, unknown>) {
  const merged = { stage: 'idle', message: '', percent: null, error: null, ...payload, at: Date.now() }
  rememberLog(`[updates] ${merged.stage}: ${merged.message || merged.error || ''}`)

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('hermes:updates:progress', merged)
  }
}

// Self-heal the tracked update branch: if origin no longer publishes it (e.g.
// bb/gui was merged into main and deleted), fall back to main and persist so
// every later check/apply follows main — no manual flip, even for already-
// installed clients. Read-only ls-remote probe; only flips on a definitive
// "ref absent" (exit 2), never on a transient network error, so a flaky
// connection can't strand a user on the wrong branch.
export async function resolveHealedBranch(updateRoot: string, branch: string) {
  if (!branch || branch === 'main') {
    return branch || 'main'
  }

  const originUrl = await getOriginUrl(updateRoot)
  const remote = isOfficialSshRemote(originUrl) ? OFFICIAL_REPO_HTTPS_URL : 'origin'
  const probe = await runResolvedGit(['ls-remote', '--exit-code', '--heads', remote, branch], boundedGit(updateRoot))

  if (probe.code !== 2) {
    return branch
  }

  rememberLog(`[updates] origin/${branch} is gone (merged?); falling back to main`)
  const config = readDesktopUpdateConfig()

  if (config.branch !== 'main') {
    writeDesktopUpdateConfig({ ...config, branch: 'main' })
  }

  return 'main'
}

function runtimeHead(root = resolveUpdateRoot()): null | string {
  return resolveCheckoutHead(root) || readSourceMarker(root)?.sha || null
}

// iclone-seam: r1-policy — the automatic check is local in BOTH policies: runtime HEAD vs the bundled pin. No git,
// no https. The upstream compare is only `hermes:updates:compare-upstream` (an explicit developer click).
export async function checkUpdates() {
  return {
    ...runtimePinStatus({ head: runtimeHead(), policy: updatePolicy() }),
    branch: readDesktopUpdateConfig().branch,
    align: readJsonFile(path.join(app.getPath('userData'), RUNTIME_ALIGN_FILE)),
    health: runtimeHealthCheck
  }
}

export async function compareWithUpstream() {
  const updateRoot = resolveUpdateRoot()
  let { branch } = readDesktopUpdateConfig()
  const gitDir = path.join(updateRoot, '.git')

  if (!directoryExists(gitDir)) {
    return {
      supported: false,
      reason: 'not-a-git-checkout',
      message: `${updateRoot} isn't a git checkout — desktop self-update only runs against a source install.`,
      hermesRoot: updateRoot,
      branch
    }
  }

  branch = await resolveHealedBranch(updateRoot, branch)
  const originUrl = await getOriginUrl(updateRoot)

  if (isOfficialSshRemote(originUrl)) {
    const git = (args: readonly string[]) => runResolvedGit(args, boundedGit(updateRoot)).then(r => r.stdout.trim())

    const [currentSha, target, dirtyStr, currentBranch] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      runResolvedGit(['ls-remote', OFFICIAL_REPO_HTTPS_URL, `refs/heads/${branch}`], boundedGit(updateRoot)),
      git(['status', '--porcelain']),
      git(['rev-parse', '--abbrev-ref', 'HEAD'])
    ])

    const targetSha = firstLine(target.stdout).split(/\s+/)[0] || ''

    if (target.code !== 0 || !targetSha) {
      return {
        supported: true,
        branch,
        error: 'fetch-failed',
        message: firstLine(target.stderr) || 'git ls-remote failed.',
        hermesRoot: updateRoot,
        fetchedAt: Date.now()
      }
    }

    // Passive SSH-official checks only know tip SHAs (ls-remote) — never
    // fabricate a "1 commit behind". Recover the exact count via the GitHub
    // compare API when possible; otherwise behind stays null ("update
    // available, count unknown") and updateAvailable carries the signal.
    // ahead_by === 0 with differing tips means the remote tip is reachable
    // from our HEAD — a local carried commit sitting AHEAD, not behind:
    // flagging that as an update nudges the user into wiping their work.
    const tipsEqual = Boolean(currentSha && currentSha === targetSha)

    const sshBehind = tipsEqual
      ? 0
      : await fetchCompareBehindCount({ currentSha, originUrl: OFFICIAL_REPO_HTTPS_URL, targetSha })

    const upToDate = tipsEqual || sshBehind === 0

    return {
      supported: true,
      branch,
      currentBranch,
      behind: upToDate ? 0 : sshBehind,
      updateAvailable: !upToDate,
      currentSha,
      targetSha,
      commits: [],
      dirty: dirtyStr.length > 0,
      hermesRoot: updateRoot,
      fetchedAt: Date.now()
    }
  }

  // Self-heal abandoned git lock files before fetching. A stale
  // .git/shallow.lock from a crashed/interrupted fetch otherwise fails every
  // later fetch ("Unable to create '.git/shallow.lock': File exists") and this
  // check reports 'fetch-failed' forever — git never removes these itself.
  await clearStaleGitLocks(updateRoot)

  const fetched = await runResolvedGit(['fetch', '--quiet', 'origin', branch], boundedGit(updateRoot))

  if (fetched.code !== 0) {
    return {
      supported: true,
      branch,
      error: 'fetch-failed',
      message: firstLine(fetched.stderr) || 'git fetch failed.',
      hermesRoot: updateRoot,
      fetchedAt: Date.now()
    }
  }

  const git = (args: readonly string[]) => runResolvedGit(args, boundedGit(updateRoot)).then(r => r.stdout.trim())

  const [currentSha, targetSha, dirtyStr, currentBranch, shallowStr] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', `origin/${branch}`]),
    git(['status', '--porcelain']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--is-shallow-repository'])
  ])

  const isShallow = shallowStr === 'true'

  // A shallow graph cannot provide a trustworthy exact count, even when it has
  // a visible merge-base. Skip the ancestry walk and use the SHA fallback.
  const countStr = shouldCountCommits({ isShallow }) ? await git(['rev-list', `HEAD..origin/${branch}`, '--count']) : ''

  // A positive directional ancestry result remains trustworthy in a shallow
  // graph and prevents a local commit on top of origin from looking outdated.
  const targetIsAncestorOfHead =
    isShallow &&
    currentSha !== targetSha &&
    (await runResolvedGit(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], boundedGit(updateRoot))).code ===
      0

  let behind = resolveBehindCount({
    countStr,
    currentSha,
    targetSha,
    isShallow,
    targetIsAncestorOfHead
  })

  // Recover the exact count a shallow clone can't compute: the GitHub compare
  // API knows the full graph regardless of local clone depth. Best-effort —
  // offline, rate-limited, or non-GitHub origins keep the honest null
  // ("update available", no fabricated number).
  if (behind === null) {
    behind = await fetchCompareBehindCount({ currentSha, originUrl, targetSha })
  }

  // behind === null means "update available, exact count unknown" (shallow
  // clone): still list what origin offers — resolveCommitLogSelection keeps
  // the shallow log to the fetched tip so the range walk can't enumerate the
  // contaminated ancestry — so "See what's new" stays useful and honest.
  const commits = behind !== 0 ? await readCommitLog(updateRoot, branch, isShallow) : []

  return {
    supported: true,
    branch,
    currentBranch,
    behind,
    updateAvailable: behind === null || behind > 0,
    currentSha,
    targetSha,
    commits,
    dirty: dirtyStr.length > 0,
    hermesRoot: updateRoot,
    fetchedAt: Date.now()
  }
}

// Best-effort exact behind-count for graphs the local clone can't measure.
// Delegates URL building + response parsing to update-count.ts (pure, unit
// tested); this wrapper only does the bounded network call. Any failure —
// offline, 4xx/5xx, rate limit, shape surprise — returns null so callers keep
// the honest "update available, count unknown" state.
async function fetchCompareBehindCount({ currentSha, originUrl, targetSha }: Parameters<typeof compareApiUrl>[0]) {
  const url = compareApiUrl({ currentSha, originUrl, targetSha })

  if (!url) {
    return null
  }

  try {
    const payload = await new Promise((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            // GitHub requires a UA on api.github.com; requests without one 403.
            'User-Agent': 'hermes-desktop-update-check'
          },
          timeout: 10_000
        },
        res => {
          const chunks: Buffer[] = []
          res.on('error', reject)
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => {
            if ((res.statusCode || 500) >= 400) {
              reject(new Error(`compare API ${res.statusCode}`))

              return
            }

            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
              reject(error)
            }
          })
        }
      )

      req.on('timeout', () => req.destroy(new Error('compare API timeout')))
      req.on('error', reject)
    })

    return parseCompareBehindCount(payload)
  } catch {
    return null
  }
}

/**
 * V3-RT (M2, K-RT9 class): git in the update root never walks out of it — a packaged app's root is its own runtime
 * folder (no `.git`) inside the user's home, which may itself be a repository — and never takes an index lock.
 */
function boundedGit(cwd: string): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd, env: { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)), GIT_OPTIONAL_LOCKS: '0' } }
}

async function readCommitLog(cwd: string, branch: string, isShallow: boolean) {
  const SEP = '\x1f'
  const REC = '\x1e'
  const { limit, revision } = resolveCommitLogSelection({ branch, isShallow })

  const { stdout } = await runResolvedGit(
    ['log', revision, `--pretty=format:%H${SEP}%s${SEP}%an${SEP}%at${REC}`, '-n', String(limit)],
    boundedGit(cwd)
  )

  return stdout
    .split(REC)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [sha, summary, author, at] = line.split(SEP)

      return { sha, summary, author, at: Number.parseInt(at, 10) * 1000 }
    })
}

// Resolve the staged updater binary the desktop may hand an update to. On
// Windows that binary owns ALL repo mutation — running `hermes update` +
// rebuilding the desktop — so the desktop never touches its own bits while
// running. macOS/Linux stage the same binary but deliberately do not use it;
// see resolveStagedUpdaterBinary for the policy and for #74836. Returns null
// whenever no hand-off applies; callers degrade gracefully.
export function resolveUpdaterBinary() {
  return resolveStagedUpdaterBinary(HERMES_HOME, { fileExists, isWindows: IS_WINDOWS })
}

export function repairMacUpdaterHelper(updater: string | null) {
  if (!IS_MAC || !updater) {
    return
  }

  try {
    execFileSync('/usr/bin/xattr', ['-cr', updater], { stdio: 'ignore' })
  } catch (err) {
    rememberLog(`[updates] macOS updater helper quarantine repair skipped: ${errorMessage(err)}`)
  }

  try {
    execFileSync('/usr/bin/codesign', ['--verify', updater], { stdio: 'ignore' })

    return
  } catch {
    // Unsigned or invalid helper. Apply a local ad-hoc signature so Gatekeeper
    // does not block the staged updater before it can run.
  }

  try {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', updater], { stdio: 'ignore' })
    rememberLog('[updates] repaired macOS updater helper signature')
  } catch (err) {
    rememberLog(`[updates] macOS updater helper signature repair skipped: ${errorMessage(err)}`)
  }
}

// Path to the venv shim whose lock decides whether `hermes update` can write
// fresh entry points. On Windows this is the file the running backend
// `hermes.exe` holds open; on POSIX it's never mandatory-locked.
export function venvHermesShimPath(updateRoot: string) {
  return IS_WINDOWS
    ? path.join(updateRoot, 'venv', 'Scripts', 'hermes.exe')
    : path.join(updateRoot, 'venv', 'bin', 'hermes')
}

// Best-effort lock probe mirroring the Rust updater's is_locked(): a running
// .exe on Windows refuses an O_RDWR open with a sharing violation. On POSIX
// this practically always succeeds (no mandatory locking), so it returns false
// — correct, since the shim-contention brick is Windows-only.
export function isShimLocked(shimPath: string) {
  if (!IS_WINDOWS) {
    return false
  }

  let fd

  try {
    fd = fs.openSync(shimPath, 'r+')

    return false
  } catch (err) {
    // ENOENT ⇒ not there ⇒ nothing locking it. Anything else (EBUSY/EPERM/
    // EACCES) on Windows means a live handle holds it.
    return err && (err as NodeJS.ErrnoException).code !== 'ENOENT'
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        void 0
      }
    }
  }
}

// The running app's .app bundle (packaged macOS): execPath is
// <App>.app/Contents/MacOS/<exe>; climb three levels to the bundle root.
export function runningAppBundle() {
  if (!IS_MAC) {
    return null
  }

  let dir = path.dirname(app.getPath('exe')) // .../Contents/MacOS

  for (let i = 0; i < 2; i++) {
    dir = path.dirname(dir)
  } // -> .../X.app

  return dir.endsWith('.app') ? dir : null
}

// ── Pre-flight state.db integrity guard (#68474) ─────────────────────
// Take an emergency snapshot of state.db and verify the live copy is
// intact before any update process mutates the install.  Runs in the
// desktop Electron process itself, before the backend is killed and
// before the updater is spawned — a separate safety net from the
// Python-level pre-update snapshot inside `hermes update`.
export function preflightStateDb(hermesHome: string, rememberLog: (chunk: string) => void) {
  const stateDbPath = path.join(hermesHome, 'state.db')

  if (!fileExists(stateDbPath)) {
    rememberLog('[updates] state.db pre-flight: not found (fresh install?)')

    return
  }

  try {
    const stat = fs.statSync(stateDbPath)

    if (stat.size > 100) {
      const fd = fs.openSync(stateDbPath, 'r')
      const header = Buffer.alloc(16)

      fs.readSync(fd, header, 0, 16, 0)
      fs.closeSync(fd)

      const expectedHeader = Buffer.from('SQLite format 3\0')
      const headerOk = header.equals(expectedHeader)

      rememberLog(
        `[updates] state.db pre-flight: size=${stat.size}, ` +
          `headerOk=${headerOk}, headerHex=${header.toString('hex')}`
      )

      if (!headerOk) {
        rememberLog(
          '[updates] state.db header is INVALID before update — ' +
            'this indicates pre-existing corruption or a concurrent write issue'
        )
      }

      // Emergency timestamped backup, separate from the Python-level snapshot.
      const ts = new Date().toISOString().replace(/[:.]/g, '-')

      const emergencyPath = path.join(hermesHome, `state.db.pre-update-emergency-${ts}.bak`)

      try {
        fs.copyFileSync(stateDbPath, emergencyPath)
        const emergStat = fs.statSync(emergencyPath)

        rememberLog(`[updates] emergency state.db backup: ${emergencyPath} ` + `(${emergStat.size} bytes)`)

        // Prune to the 2 most recent emergency backups.
        try {
          const homeDir = fs.readdirSync(hermesHome)

          const backups = homeDir
            .filter(
              f =>
                f.startsWith('state.db.pre-update-emergency-') &&
                f.endsWith('.bak') &&
                f !== path.basename(emergencyPath)
            )
            .sort()
            .reverse()

          for (const old of backups.slice(2)) {
            try {
              fs.unlinkSync(path.join(hermesHome, old))
            } catch {
              void 0
            }
          }
        } catch {
          void 0
        }
      } catch (copyErr) {
        rememberLog(`[updates] emergency state.db backup failed: ${errorMessage(copyErr)}`)
      }
    } else {
      rememberLog(`[updates] state.db too small (${stat.size} bytes) for a valid SQLite database`)
    }
  } catch (statErr) {
    rememberLog(`[updates] could not stat state.db before update: ${errorMessage(statErr)}`)
  }
}

// macOS/Linux update hand-off: spawn the repo-owned posix orchestrator
// (scripts/desktop-update/posix.sh) detached and QUIT. The script waits us
// out, runs `hermes update`, swaps/relaunches the app bundle, and writes
// .hermes-update-result.json for the relaunched Desktop to surface. It shows
// its own tiny shim window (or nothing, headless) — this process only needs
// to leave. Checkouts that predate the script get the manual card once.
/**
 * V3-RT M1: records the dependency environment the installer just made from nothing (critic r2 M1: only with the
 * capability `prepareDependencyInstall` gave before that install). Throws a plain-words error when it cannot: the
 * install is then a failure the user sees, never a record of bytes nobody checked, and never a loop back to Repair.
 */
export function sealInstalledDependencies(root: string, fresh: FreshDependencyInstall | null): void {
  try {
    const { files } = sealRuntimeDependencies(root, fresh)

    rememberLog(`[iclone-runtime] Python environment recorded after install: ${files} files`)
  } catch (error) {
    const reason = (error as Error).message

    rememberLog(`[iclone-runtime] the Python environment could not be recorded: ${reason}`)

    throw new Error(
      `The agent's Python environment was reinstalled but does not match what it was installed from (${reason}). ` +
        'Nothing from it was run. Something on this Mac may be changing the app folder; check it, then try again.'
    )
  }
}

export async function applyUpdatesPosixHandoff(opts: any) {
  const updateRoot = resolveUpdateRoot()

  // iclone-seam: p7-runtime-pin r1-policy — curated (IS_PACKAGED-derived): the bundled pin, never a fetched runtime.json
  if (updatePolicy() === 'curated') {
    const result = await runPinnedRuntimeUpdate({
      activeRoot: updateRoot,
      appUpdatePending: Boolean(quitState.icloneAppUpdate?.blocksRuntimeHandoff()),
      appVersion: app.getVersion(),
      emit: ev => ev?.line && rememberLog(ev.line),
      hermesHome: HERMES_HOME,
      pin: BUNDLED_RUNTIME_PIN,
      // V3-RT (ruling 36): Repair/Update of the app's own runtime keep its installer's outputs in its folder.
      privateDependencies: runtimePrivateDependencies()
    })

    // V3-RT critic r2 M1: this path never records the environment. The installer may find it "already in place", and
    // bytes that predate an install are never blessed: the record of the last install from nothing stays, and the
    // closed world before the next spawn holds the environment to it (a changed one refuses; Repair install starts
    // from nothing).
    return result
  }

  const handoff = resolvePosixScriptHandoff(updateRoot)

  if (!handoff) {
    emitUpdateProgress({ stage: 'manual', message: 'hermes update', percent: null })

    return { ok: true, manual: true, command: 'hermes update', hermesRoot: updateRoot }
  }

  const handoffConflict = updateHandoffConflict(HERMES_HOME)

  if (handoffConflict) {
    // Same hazard as the Windows path (#75778): a live foreign updater
    // already owns the marker — refuse rather than double-mutate the tree.
    rememberLog(`[updates] refusing posix hand-off: ${handoffConflict.message}`)
    emitUpdateProgress({ stage: 'error', message: handoffConflict.message, percent: null })

    return { ok: false, error: 'update-already-running', message: handoffConflict.message }
  }

  // ── Pre-flight state.db integrity guard (#68474) ──
  preflightStateDb(HERMES_HOME, rememberLog)

  // Branch-pin so a non-main checkout doesn't get switched to main (and
  // self-heal to main when the pinned branch no longer exists on origin).
  let branch = 'main'

  try {
    const head = await runResolvedGit(['rev-parse', '--abbrev-ref', 'HEAD'], boundedGit(updateRoot))
    const current = (head.stdout || '').trim()

    if (head.code === 0 && current && current !== 'HEAD') {
      branch = await resolveHealedBranch(updateRoot, current)
    }
  } catch {
    // best effort
  }

  const args = [...handoff.args, '--install-root', updateRoot, '--branch', branch, '--desktop-pid', String(process.pid)]
  const updateStartedAt = Math.floor(Date.now() / 1000)

  // Relaunch target: the running .app bundle on mac (script swaps the
  // rebuilt bundle over it), the running binary elsewhere. The script's gate
  // (an exact port of update-relaunch.ts's decideRelaunchOutcome) relaunches
  // only a binary the rebuild replaced with a launchable sandbox helper —
  // replaying the original launch context (filtered args, cwd, sandbox
  // opt-out) so a deep-link or --no-sandbox launch survives the update.
  // On mac the script treats this as permission to REPLACE the bundle: its
  // mac_swap() dittos <install root>/apps/desktop/release/**/Hermes.app over
  // the target and deletes the old copy. Upstream can pass the running app
  // freely because the running app IS what that repo builds. iclone os is a
  // white-label fork — the owner runs /Applications/iclone os.app while the
  // install root builds a stock Hermes.app — so passing it unguarded turns
  // "Update now" into "replace this app with a different product", with the
  // .old copy deleted on success. Only offer a bundle the updater actually
  // rebuilds; otherwise the update still runs and the owner reopens the app.
  const runningBundle = IS_MAC ? runningAppBundle() : null

  const targetApp = IS_MAC
    ? mayReplaceRunningBundle(runningBundle, updateRoot, path)
      ? runningBundle
      : null
    : process.execPath

  if (targetApp) {
    args.push('--relaunch-target', targetApp)
  } else if (IS_MAC && runningBundle) {
    rememberLog(
      `[update] not offering ${runningBundle} as the relaunch target: it is not the bundle ${updateRoot} rebuilds, ` +
        'so the updater must not swap it. The update proceeds; reopen the app afterwards.'
    )
  }

  const relaunchArgs = collectRelaunchArgs(process.argv.slice(1))

  if (!IS_MAC) {
    args.push('--relaunch-cwd', process.cwd())

    if (sandboxFallbackFromEnv(process.env, relaunchArgs)) {
      args.push('--sandbox-fallback')
    }

    if (relaunchArgs.length) {
      args.push('--', ...relaunchArgs)
    }
  }

  const child = spawnUpdaterProcess(handoff.command, args, {
    cwd: HERMES_HOME,
    env: {
      ...process.env,
      HERMES_HOME,
      HERMES_UPDATE_STARTED_AT: String(updateStartedAt),
      PATH: pathWithHermesManagedNode(path.join(updateRoot, 'venv', 'bin'))
    },
    detached: true,
    stdio: 'ignore'
  })

  // Bridge marker (same contract as the Windows hand-off): cover the gap
  // until the script claims the marker with its own pid as step 0. If the
  // script never starts, the dead pid reads as stale and self-deletes.
  if (Number.isInteger(child.pid)) {
    writeUpdateMarker(HERMES_HOME, child.pid, { startedAt: updateStartedAt })
  }

  rememberLog(`[updates] launched posix hand-off: ${handoff.scriptPath} (branch ${branch}); quitting to hand off`)
  // iclone-seam: p7-relaunch-copy
  rememberLog(`[iclone-runtime-pin] hand-off relaunch ${targetApp ? 'wired' : 'not wired; asking the owner to reopen'}`)
  emitUpdateProgress({ stage: 'restart', message: handoffRestartCopy(Boolean(targetApp)), percent: 100 })

  // Settle window (#66753): the reported macOS failure mode is exactly this
  // path — the app quits, bash/posix.sh dies early (or was never spawnable),
  // and the user is left with no app, no updater, and no relaunch. Watch the
  // child through the dwell; on spawn error or early death, stay alive and
  // surface the failure instead of quitting into nothing.
  const dwellStartedAt = Date.now()
  const handoffOutcome = await observeUpdaterHandoff(child, UPDATE_HANDOFF_DWELL_MS)

  if (!handoffOutcome.ok) {
    const message = `Update failed to start: ${handoffOutcome.message}. Hermes will keep running — try again, or run \`hermes update\` from a terminal.`

    rememberLog(`[updates] posix hand-off not viable, aborting quit: ${handoffOutcome.message}`)
    emitUpdateProgress({ stage: 'error', message, percent: null })

    return { ok: false, error: 'updater-spawn-failed', message }
  }

  quitState.isQuittingForHandoff = true
  setTimeout(
    () => {
      app.quit()
    },
    Math.max(0, UPDATE_HANDOFF_DWELL_MS - (Date.now() - dwellStartedAt))
  )

  return { ok: true, handedOff: true, updater: handoff.scriptPath }
}

// Bootstrap-complete marker helpers. The marker is written by whichever
// installer ran: install.ps1, install.sh, the Rust bootstrap installer, or the
// first-launch bootstrap runner. It is provenance ("a bootstrap finished
// here"), NOT the launch gate -- activeRuntimeState() decides that, because a
// healthy runtime can predate the marker or outlive a repair that cleared it.
//
// Marker schema (version 1):
//   {
//     schemaVersion: 1,
//     pinnedCommit: "<40-char SHA>",       // what install.ps1 was driven against
//     pinnedBranch: "<branch name>" | null,
//     completedAt:  "<ISO 8601>",
//     desktopVersion: "<app.getVersion()>"  // for forensics
//   }
function readBootstrapMarker() {
  return readJsonFileSync(BOOTSTRAP_COMPLETE_MARKER, { validate: isRecord })
}

// Marker-independent: is the canonical install at ACTIVE_HERMES_ROOT actually
// runnable right now? A complete CLI install (`install.sh --include-desktop`)
// or a DMG launch over a prior CLI install satisfies this WITHOUT the desktop
// ever having written the bootstrap marker -- so we must be able to recognise
// "already installed" off the filesystem alone, not just the marker.
function isActiveRuntimeUsable() {
  const venvPython = getVenvPython(activeVenvRoot())

  // From V3-RT-B r2 (ruling 42): no blocking Python probe on a packaged boot path. The app's own runtime is usable
  // when its install finished and was recorded (file reads); the integrity check before every spawn does the rest.
  if (IS_PACKAGED) {
    return isHermesSourceRoot(ACTIVE_HERMES_ROOT) && fileExists(venvPython) && isRecordedInstall(ACTIVE_HERMES_ROOT)
  }

  return (
    isHermesSourceRoot(ACTIVE_HERMES_ROOT) &&
    fileExists(venvPython) &&
    canImportHermesCli(venvPython, {
      env: {
        PYTHONPATH: [ACTIVE_HERMES_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
      }
    })
  )
}

function activeRuntimeState() {
  // We DELIBERATELY do NOT verify that the checkout is currently at the
  // pinned commit -- users update via the in-app update path or `hermes
  // update`, which moves HEAD legitimately. The marker only attests "a
  // desktop-managed bootstrap ran here at least once"; runtime usability is
  // what decides whether we can actually launch.
  return classifyActiveRuntime(readBootstrapMarker(), BOOTSTRAP_MARKER_SCHEMA_VERSION, isActiveRuntimeUsable())
}

export function resolveHermesBackend(backendArgs: string[]): HermesBackendSpec {
  // 1. Explicit override -- HERMES_DESKTOP_HERMES_ROOT points at a developer
  //    checkout. Honour it as-is (no bootstrap; the user is driving).
  const overrideEnv = codePathEnv('HERMES_DESKTOP_HERMES_ROOT') // iclone-seam: p7-env
  const overrideRoot = overrideEnv && path.resolve(overrideEnv)

  if (overrideRoot && isHermesSourceRoot(overrideRoot)) {
    const backend = createPythonBackend(overrideRoot, `Hermes source at ${overrideRoot}`, backendArgs)

    if (backend) {
      return backend
    }
  }

  // 2. Development source -- when running `npm run dev` from a checkout, the
  //    cloned repo at SOURCE_REPO_ROOT takes precedence over ACTIVE and any
  //    installed `hermes` on PATH so local Python edits are actually exercised.
  //    (In dev with no checkout, SOURCE_REPO_ROOT won't pass isHermesSourceRoot.)
  if (!IS_PACKAGED && isHermesSourceRoot(SOURCE_REPO_ROOT)) {
    const backend = createPythonBackend(SOURCE_REPO_ROOT, `Hermes source at ${SOURCE_REPO_ROOT}`, backendArgs)

    if (backend) {
      return backend
    }
  }

  // 3. ACTIVE_HERMES_ROOT — the canonical install at
  //    %LOCALAPPDATA%\\hermes\\hermes-agent (Windows) or ~/.hermes/hermes-agent.
  //    A valid bootstrap marker proves Desktop finished the first-run install
  //    flow, but marker provenance is NOT the same thing as runtime usability:
  //    the CLI can create the exact same repo+venv layout, and older desktop
  //    builds could leave a healthy install behind without the marker. If the
  //    active runtime is usable, launch it directly; only fall through to
  //    bootstrap when the runtime itself is unusable.
  const activeRuntime = activeRuntimeState()

  if (activeRuntime.shouldUseActiveRuntime && !bootState.bootstrapRepairRequested) {
    if (!activeRuntime.hasValidMarker) {
      rememberLog(
        `[bootstrap] Active Hermes runtime at ${ACTIVE_HERMES_ROOT} is usable but the bootstrap marker is missing or stale; skipping first-run bootstrap.`
      )
    }

    return createActiveBackend(backendArgs)
  }

  // V3-S r2 (m1): a pending Repair also skips steps 4–5. Those are runtimes icloneOS did not install, which its
  // permission gate refuses — returning one here would refuse the boot again and Repair would never reach the installer.
  const repairRequested = bootState.bootstrapRepairRequested

  if (repairRequested) {
    rememberLog(
      '[bootstrap] repair requested; bypassing the active runtime and any Hermes on PATH to re-run the installer'
    )
  }

  // 4. Existing `hermes` on PATH -- installed via install.ps1 / install.sh from
  //    a previous tool-only setup, or pip-installed system-wide. Use it but
  //    do NOT write a bootstrap marker; the user did this themselves and we
  //    don't want to take ownership of an install we didn't perform.
  //    HERMES_DESKTOP_IGNORE_EXISTING=1 forces the bootstrap path for testing.
  // V3-RT (ruling 36): a packaged app runs only its own runtime; a Hermes on PATH or a system Python is foreign (the
  // gate refuses it), so a packaged build goes straight from step 3 to installing its own copy.
  if (!repairRequested && !IS_PACKAGED && codePathEnv('HERMES_DESKTOP_IGNORE_EXISTING') !== '1') {
    // iclone-seam: p7-env
    let hermesCommand = null
    const hermesOverride = codePathEnv('HERMES_DESKTOP_HERMES') // iclone-seam: p7-env

    if (hermesOverride) {
      const resolvedOverride = findOnPath(hermesOverride)

      if (resolvedOverride) {
        hermesCommand = resolvedOverride
      } else if (!isWindowsBinaryPathInWsl(hermesOverride, { isWsl: IS_WSL })) {
        hermesCommand = hermesOverride
      } else {
        rememberLog(`Ignoring Windows Hermes override under WSL: ${hermesOverride}`)
      }
    } else {
      hermesCommand = findOnPath('hermes')
    }

    if (hermesCommand) {
      if (looksLikeDesktopAppBinary(hermesCommand)) {
        rememberLog(`Ignoring desktop app executable on PATH while resolving Hermes CLI: ${hermesCommand}`)
        hermesCommand = null
      }
    }

    if (hermesCommand) {
      const unwrapped = unwrapWindowsVenvHermesCommand(hermesCommand, backendArgs)

      if (unwrapped) {
        return unwrapped
      }

      // Smoke-test the candidate before trusting it. A `hermes` shim
      // left behind by a half-uninstalled pip install (or a venv
      // entry-point pointing at a deleted interpreter) still resolves
      // via findOnPath but explodes on spawn -- the user then sees a
      // dead backend instead of the first-launch installer. The cheap
      // `--version` probe (see backend-probes.ts) catches that case
      // and lets the resolver fall through to step 6 / bootstrap.
      const shellForProbe = isCommandScript(hermesCommand)

      // HERMES_DESKTOP_HERMES is an explicit deployment override (used by
      // the Nix wrapper), not a discovered PATH candidate. It must not fall
      // through to the install-script bootstrap if the optional probe times
      // out under load; the pinned backend is the only valid runtime there.
      if (shouldTrustHermesOverride(hermesOverride) || verifyHermesCli(hermesCommand, { shell: shellForProbe })) {
        // `unwrapped` above already answered "is this a Windows venv shim?" —
        // it was null (not a shim, or its import probe failed). Do NOT re-run
        // unwrapWindowsVenvHermesCommand here: the second call repeats the
        // same un-memoized import probe, costing up to another full probe
        // timeout on the boot path for an answer we already have.
        return {
          label: `existing Hermes CLI at ${hermesCommand}`,
          command: hermesCommand,
          args: backendArgs,
          bootstrap: false,
          env: {},
          kind: 'command',
          shell: shellForProbe
        }
      }

      rememberLog(
        `Ignoring existing Hermes CLI at ${hermesCommand}: --version probe failed; falling through to bootstrap.`
      )
    }
  }

  // 5. Last-ditch: pip-installed hermes_cli module via system Python.
  //    Same rationale as #4 -- the user installed this; we use it but don't
  //    take ownership.
  const python = repairRequested || IS_PACKAGED ? null : findSystemPython()

  if (python) {
    // Same smoke-test rationale as step 4: a system Python in the
    // SUPPORTED_VERSIONS range can be registered (PEP 514) without
    // having hermes_cli installed -- common on dev boxes that have
    // a python.org install from prior unrelated work. Returning that
    // backend hands the spawn step a guaranteed ModuleNotFoundError.
    // Verify the import works before trusting the candidate; on
    // failure, fall through to step 6 so the bootstrap runner pulls
    // a uv-managed 3.11 into %LOCALAPPDATA%\hermes\hermes-agent\venv.
    if (canImportHermesCli(python)) {
      return {
        kind: 'python',
        label: `installed hermes_cli module via ${python}`,
        command: python,
        args: ['-m', 'hermes_cli.main', ...backendArgs],
        bootstrap: false,
        env: {},
        shell: false
      }
    }

    rememberLog(`Ignoring system Python ${python}: hermes_cli is not importable; falling through to bootstrap.`)
  }

  // 6. Nothing usable yet -- signal the bootstrap runner that we need to
  //    clone+install. Phase 1D's bootstrap-runner consumes this sentinel
  //    and drives install.ps1 stages with a progress UI. Until 1D lands,
  //    callers see the sentinel and surface it as a user-facing error
  //    explaining what's missing.
  //
  //    We deliberately do NOT throw here -- throwing inside
  //    resolveHermesBackend was the old "no payload" path and forced the
  //    user into a dead end. With the bootstrap protocol, "no install yet"
  //    is a recoverable state the GUI can drive through.
  return {
    kind: 'bootstrap-needed',
    label: 'Hermes Agent not installed yet; bootstrap required',
    command: null,
    args: backendArgs,
    bootstrap: true,
    env: {},
    shell: false,
    // Hints for the bootstrap runner / UI layer:
    activeRoot: ACTIVE_HERMES_ROOT,
    installStamp: INSTALL_STAMP, // may be null in dev
    isPackaged: IS_PACKAGED,
    platform: process.platform
  }
}

// iclone-seam: r1-config — Hermes's own update check off once per HERMES_HOME a backend reads (root + each --profile
// home), before its spawn. U1: nothing aligns the runtime at boot any more; HEAD ≠ pin is passive copy in the pane.
export function ensureRuntimeUpdateCheckOff(profile: null | string = null): Promise<void> {
  const policy = updatePolicy()

  if (policy !== 'curated') {
    return Promise.resolve()
  }

  const userData = app.getPath('userData')
  const root = ACTIVE_HERMES_ROOT
  const key = profile || ''
  let config = curatedRuntimeConfig.get(key)

  if (!config) {
    config = (async () => {
      // V3-RT (critic m4): a packaged app runs nothing of its runtime before the integrity check has passed, and then
      // runs it sealed (the same env cut and isolation flags as a gated spawn).
      if (IS_PACKAGED) {
        try {
          await checkRuntimeIntegrity(root)
        } catch (error) {
          rememberLog(`[runtime-update-policy] update check left as is: ${(error as Error).message}`)

          return
        }
      }

      await ensureCuratedRuntimeConfig({
        // V3-RT K-RT7: the CLI of the environment the runtime runs on (PM's committed one from 1ac3f97 on).
        hermesBin: path.join(activeVenvRoot(), 'bin', 'hermes'),
        hermesHome: HERMES_HOME,
        log: rememberLog,
        markerFile: path.join(userData, CURATED_CONFIG_MARKER_FILE),
        policy,
        profile,
        run: spawnCapped,
        ...(IS_PACKAGED
          ? {
              sealed: {
                python: getVenvPython(activeVenvRoot()),
                sealEnv: (env: NodeJS.ProcessEnv) => isolatePythonEnv(env, root)
              }
            }
          : {}),
        runtimeSha: runtimeHead(root)
      }).catch(() => undefined)
    })()
    curatedRuntimeConfig.set(key, config)
  }

  return config
}

// iclone-seam: r1-health — amendment order step 4: after the first curated local spawn, /api/health.commit == HEAD.
let runtimeHealthCheck: HealthCommitCheck | null = null
let runtimeHealthCheckStarted = false

export function verifyCuratedHealthCommit(baseUrl: string) {
  if (runtimeHealthCheckStarted || updatePolicy() !== 'curated') {
    return
  }

  runtimeHealthCheckStarted = true
  void checkRuntimeHealthCommit({
    fetchCommit: async () => {
      const res = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(5_000) })
      const health = await res.json()

      return typeof health?.commit === 'string' ? health.commit : null
    },
    align: readJsonFile<RuntimeAlignRecord>(path.join(app.getPath('userData'), RUNTIME_ALIGN_FILE)),
    head: runtimeHead(),
    log: rememberLog,
    pinSha: BUNDLED_RUNTIME_PIN.sha
  }).then(result => {
    runtimeHealthCheck = result
  })
}
