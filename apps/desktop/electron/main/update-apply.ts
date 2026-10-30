// Applying an in-app update to the running install.
import path from 'node:path'

import { app } from 'electron'

import { compatGate, refreshInstallTarget } from '../iclone-compat'
import { appendLine as appendCompatLine, storeRoot as compatStoreRoot } from '../iclone-compat/store'
import { updateHandoffConflict, writeUpdateMarker } from '../update-marker'
import { BUNDLED_RUNTIME_PIN } from '../update-policy'
import { gateUpdateApply } from '../update-runtime-align'
import {
  observeUpdaterHandoff,
  resolveUpdateScriptHandoff,
  spawnUpdaterProcess,
  stagedUpdaterSupportsPrewrittenMarker,
  wrapHandoffForDetachedConsole
} from '../updater-process'
import {
  formatBlockerMessage,
  formatProbeFailedMessage,
  scanVenvBlockers,
  stopSafeVenvBlockers
} from '../venv-blocker-scan'

import { releaseBackendLockForUpdate } from './backend-pool'
import { readDesktopUpdateConfig } from './desktop-settings'
import {
  DEFAULT_UPDATE_BRANCH,
  HERMES_HOME,
  IS_MAC,
  IS_WINDOWS,
  pathWithHermesManagedNode,
  resolveUpdateRoot
} from './env'
import { runResolvedGit } from './executables'
import { rememberLog, updatePolicy } from './log'
import { startHermes } from './start-hermes'
import { quitState } from './state'
import {
  applyUpdatesPosixHandoff,
  emitUpdateProgress,
  preflightStateDb,
  repairMacUpdaterHelper,
  resolveHealedBranch,
  resolveUpdaterBinary,
  runningAppBundle,
  UPDATE_HANDOFF_DWELL_MS
} from './updates'

// applyUpdates — hand off to the installer's --update flow, then exit.
//
// The desktop is a pure consumer: it does NOT git pull / pip install / rebuild
// itself (the old open-coded git dance lived here and drifted from
// `hermes update`). Instead we spawn the staged Hermes-Setup binary with
// --update and quit, so it can run `hermes update` (which refuses while we
// hold the venv shim) and rebuild the desktop with our exe already gone.
//
// Detection (checkUpdates / commit changelog / "N behind") stays in the UI;
// only this apply action changed.
export async function applyUpdates(opts: { stopSafeBlockers?: boolean } = {}) {
  // iclone-seam: p4a-gate r1-policy — curated never re-resolves the moving ref; the bundled pin's verdict holds.
  const gate = await gateUpdateApply({
    audit: entry => {
      try {
        appendCompatLine(compatStoreRoot(app.getPath('userData')), 'audit.jsonl', entry)
      } catch {
        void 0
      }
    },
    compatGate: () => compatGate(app.getPath('userData')),
    isWindows: IS_WINDOWS,
    pin: BUNDLED_RUNTIME_PIN,
    policy: updatePolicy(),
    refreshTarget: () => refreshInstallTarget()
  })

  if (gate.refusal) {
    return gate.refusal // iclone-seam: p4a-gate
  }

  if (quitState.updateInFlight) {
    throw new Error('An update is already in progress.')
  }

  quitState.updateInFlight = true

  try {
    // iclone-seam: r1-policy — curated: the only move is the pinned one (no `hermes update` card, no updater binary).
    if (gate.door === 'pinned') {
      return await applyUpdatesPosixHandoff(opts)
    }

    const updater = resolveUpdaterBinary()

    if (!updater && !IS_WINDOWS) {
      // macOS/Linux: hand off to the repo-owned posix script — same shape as
      // Windows (quit → detached orchestrator → `hermes update` → relaunch),
      // minus the venv-lock gauntlet POSIX doesn't need. The old in-app
      // updater (applyUpdatesPosixInApp) is gone with everything it dragged
      // in: the HERMES_DESKTOP_CHILD_PID reaper-exclusion dance (#37532),
      // the in-window rebuild retry, and the relaunch-outcome matrix — the
      // script owns swap/relaunch, and the app is DEAD during the update so
      // there is nothing to reap around. Checkouts that predate the script
      // get the manual `hermes update` card once; their next update pulls it.
      return await applyUpdatesPosixHandoff(opts)
    }

    if (!updater) {
      // No staged updater binary — this is a CLI-installed user (they ran
      // `hermes desktop`, never the Tauri installer that self-copies
      // hermes-setup.exe into HERMES_HOME). On Windows the repo hand-off
      // script serves them just as well as installer users — it only needs
      // PowerShell and the checkout — so fall through to the normal hand-off
      // when the script exists. Only when the checkout predates the script do
      // we surface the manual one-liner.
      const updateRoot = resolveUpdateRoot()

      if (!resolveUpdateScriptHandoff(updateRoot)) {
        // They DO have a working `hermes` on PATH / in the venv, so the
        // correct path is the one-liner in their native medium. We show the
        // EXACT command, branch-pinned to the checkout they're on — bare
        // `hermes update` defaults to main and would silently switch a
        // bb/gui (or any non-main) install off-branch. Mirror the GUI
        // button's contract: append --branch <current> for non-main
        // checkouts, keep it bare for main so the card stays clean.
        let command = 'hermes update'

        try {
          const head = await runResolvedGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: updateRoot })
          const current = (head.stdout || '').trim()

          if (head.code === 0 && current && current !== 'HEAD') {
            const branch = await resolveHealedBranch(updateRoot, current)

            if (branch !== 'main') {
              command = `hermes update --branch ${branch}`
            }
          }
        } catch {
          // Best-effort: fall back to bare `hermes update` if branch detection fails.
        }

        rememberLog(`[updates] no staged updater; surfacing manual \`${command}\` for CLI install at ${updateRoot}`)
        emitUpdateProgress({ stage: 'manual', message: command, percent: null })

        return { ok: true, manual: true, command, hermesRoot: updateRoot }
      }

      rememberLog('[updates] no staged updater; using repo hand-off script for CLI install')
    }

    const handoffConflict = updateHandoffConflict(HERMES_HOME)

    if (handoffConflict) {
      // A different updater already owns the marker — most often a previous
      // "Update" click whose updater is still alive and parked mid-run.
      // Spawning another here would overwrite its claim and let two updaters
      // mutate the checkout at once (#75778); refuse instead.
      rememberLog(`[updates] refusing hand-off: ${handoffConflict.message}`)
      emitUpdateProgress({ stage: 'error', message: handoffConflict.message, percent: null })

      return { ok: false, error: 'update-already-running', message: handoffConflict.message }
    }

    emitUpdateProgress({
      stage: 'restart',
      message:
        'Updating iclone os — this window will close and the updater will open. Don’t reopen iclone os yourself; it restarts automatically when the update finishes.',
      percent: 100
    })
    repairMacUpdaterHelper(updater)

    const updateRoot = resolveUpdateRoot()
    const { branch: configuredBranch } = readDesktopUpdateConfig()
    const branch = await resolveHealedBranch(updateRoot, configuredBranch || DEFAULT_UPDATE_BRANCH)
    const updaterArgs = ['--update', '--branch', branch]
    const targetApp = IS_MAC ? runningAppBundle() : null

    if (targetApp) {
      updaterArgs.push('--target-app', targetApp)
    }

    const venvBin = path.join(updateRoot, 'venv', IS_WINDOWS ? 'Scripts' : 'bin')

    // ── Pre-flight state.db integrity guard (#68474) ─────────────────
    // Emergency backup and header verification before the update touches
    // anything.  Runs while the backend is still alive.
    preflightStateDb(HERMES_HOME, rememberLog)

    // Stop our own backend(s) and wait for the venv shim to unlock BEFORE we
    // spawn the updater. Without this the updater races a still-locked
    // hermes.exe (held by the backend child / its grandchildren) and the update
    // bricks. See releaseBackendLockForUpdate for the full failure analysis.
    const lock = await releaseBackendLockForUpdate(updateRoot)

    if (!lock.unlocked) {
      // Something OUTSIDE this app holds the venv (a second window, a user
      // terminal running hermes, an unkillable child). Handing off anyway
      // guarantees a half-updated venv — abort loudly instead and let the
      // user close the holder and retry. Restart our own backend so the app
      // keeps working after the failed attempt.
      const message =
        'Update aborted: another process is holding the Hermes install open ' +
        '(a second iclone os window or a terminal running hermes?). Close it and retry.'

      emitUpdateProgress({ stage: 'error', message, percent: null })
      startHermes().catch(() => {})

      return { ok: false, error: message }
    }

    // Preflight: after releasing our own backends, check for remaining
    // Hermes processes running from this venv.  The updater normally refuses
    // when it detects a holder, but because the updater is spawned detached
    // with stdio:ignore, the user never sees that refusal and the update
    // silently fails.  This preflight detects holders early and gives the
    // user an actionable error.  Windows-only; the .pyd lock hazard is a
    // Windows phenomenon.  ALL failures (blocked, missing python, timeout,
    // malformed output, missing psutil) abort the handoff — never proceed
    // to the detached updater when the venv state is unknown.
    if (IS_WINDOWS) {
      let scanOutcome = await scanVenvBlockers(updateRoot)

      if (scanOutcome.kind === 'blocked' && opts.stopSafeBlockers) {
        const stopResult = await stopSafeVenvBlockers(updateRoot, scanOutcome.result)
        rememberLog(
          `[updates] user-approved blocker cleanup: stopped=${stopResult.stopped.join(',') || 'none'} failed=${stopResult.failed.join(',') || 'none'}`
        )
        // Let verified process-tree termination finish unwinding wrapper shells,
        // then make the scanner — not the stale renderer payload — authoritative.
        await new Promise(resolve => setTimeout(resolve, 300))
        scanOutcome = await scanVenvBlockers(updateRoot)
      }

      // Re-scan before aborting on 'blocked' (#74805). Process-table teardown
      // is asynchronous on Windows: even after releaseBackendLock's PID-exit
      // wait, a grandchild the desktop never tracked (or a process an AV /
      // NTFS filter driver is holding in teardown) can stay enumerable for a
      // few more seconds and read as a holder. Each scan already costs
      // seconds (spawns a venv python + psutil sweep), so two retries with a
      // short dwell give the table time to settle without meaningfully
      // delaying the abort path when a REAL holder (a user terminal, second
      // window) is present — that holder is still there on the third scan.
      for (let attempt = 0; scanOutcome.kind === 'blocked' && attempt < 2; attempt++) {
        rememberLog(
          `[updates] venv-blocker scan reported ${scanOutcome.result.processes.length} holder(s); re-scanning after settle (attempt ${attempt + 2}/3)`
        )
        await new Promise(resolve => setTimeout(resolve, 1500))
        scanOutcome = await scanVenvBlockers(updateRoot)
      }

      if (scanOutcome.kind === 'blocked') {
        const message = formatBlockerMessage(scanOutcome.result)

        rememberLog(`[updates] venv-blocked: ${scanOutcome.result.processes.length} process(es) hold the install`)
        emitUpdateProgress({ stage: 'error', message, percent: null })
        startHermes().catch(() => {})

        return { ok: false, error: 'venv-blocked', message, blockers: scanOutcome.result.processes }
      }

      if (scanOutcome.kind === 'probe-failure') {
        const message = formatProbeFailedMessage()

        rememberLog(`[updates] venv-blocker probe failed: ${scanOutcome.error}`)
        emitUpdateProgress({ stage: 'error', message, percent: null })
        startHermes().catch(() => {})

        return { ok: false, error: 'venv-probe-failed', message }
      }
    }

    // Detached so the updater outlives this process — it needs us GONE before
    // `hermes update` will run (the venv shim is locked while we live).
    //
    // Prefer the repo-owned hand-off script over the staged Tauri binary.
    // The staged binary is frozen (no self-update path) and historically runs
    // months-stale updater logic — pre-#67369 cache resolver, pre-#74782
    // marker adoption — producing failures that were fixed on main long ago
    // (2026-08-09 incident). scripts/desktop-update/windows.ps1 ships WITH the
    // checkout, so each `hermes update` refreshes the code that drives the
    // next one. Checkouts that predate the script fall back to the binary
    // path unchanged.
    const scriptHandoff = resolveUpdateScriptHandoff(updateRoot)
    let child

    if (scriptHandoff) {
      const updateStartedAt = Math.floor(Date.now() / 1000)

      // A bare detached+hidden powershell spawn silently dies before -File
      // processing (console-subsystem init failure — see
      // wrapHandoffForDetachedConsole). Route through `cmd start` so the
      // script gets its own minimized console and survives our exit. The
      // wrapper cmd.exe exits immediately, so child.pid is NOT the script's
      // pid — the script claims the update marker itself with its own $PID
      // as its first action, and a relaunched Desktop parks on that.
      const wrapped = wrapHandoffForDetachedConsole(scriptHandoff, [
        '-InstallRoot',
        updateRoot,
        '-Branch',
        branch,
        '-DesktopPid',
        String(process.pid),
        '-RelaunchExe',
        process.execPath
      ])

      child = spawnUpdaterProcess(wrapped.command, wrapped.args, {
        cwd: HERMES_HOME,
        env: {
          ...process.env,
          HERMES_HOME,
          HERMES_UPDATE_STARTED_AT: String(updateStartedAt),
          PATH: pathWithHermesManagedNode(venvBin)
        },
        detached: true,
        stdio: 'ignore'
      })

      // Bridge marker: child.pid is the short-lived cmd.exe WRAPPER, not the
      // script (see wrapHandoffForDetachedConsole). Write it anyway to cover
      // the first moments of the hand-off — the script's step 0 overwrites it
      // with its own live $PID, and if the script never starts the wrapper's
      // dead pid makes the marker read as stale and self-delete (no wedge).
      // The `hermes update` child adopts the SCRIPT's claim via
      // update_lock.py's process-ancestry rule; no mtime heuristics needed.
      if (Number.isInteger(child.pid)) {
        writeUpdateMarker(HERMES_HOME, child.pid, { startedAt: updateStartedAt })
      }

      rememberLog(
        `[updates] launched repo hand-off script: ${scriptHandoff.scriptPath} (branch ${branch}); exiting desktop to release venv shim`
      )
    } else {
      if (!updater) {
        throw new Error('No staged updater binary and no repo hand-off script to apply the update with.')
      }

      child = spawnUpdaterProcess(updater, updaterArgs, {
        cwd: HERMES_HOME,
        env: {
          ...process.env,
          HERMES_HOME,
          PATH: pathWithHermesManagedNode(venvBin)
        },
        detached: true,
        stdio: 'ignore'
      })

      // Write the update-in-progress marker IMMEDIATELY — before the 2.5s
      // quit dwell. The Tauri updater won't write its own marker for several
      // seconds (window init + manifest), and during that gap our renderer
      // can reconnect and spawn a fresh backend that re-locks .pyd files in
      // the venv. By writing the marker ourselves the renderer's
      // waitForUpdateToFinish() gate sees a live update and parks instead.
      // The updater overwrites this with its own PID later; same format.
      //
      // SKIPPED for pre-#74782 staged updaters: those have no self-PID
      // exclusion, so they read this very marker as a foreign live owner and
      // abort with "Another Hermes update is already running (PID <itself>)" —
      // an unbreakable loop, because the update that would replace the stale
      // binary is the one being refused. Losing the anti-respawn hardening is
      // strictly better than never updating again, and the updater still writes
      // its own marker moments later.
      if (Number.isInteger(child.pid) && stagedUpdaterSupportsPrewrittenMarker(updater)) {
        writeUpdateMarker(HERMES_HOME, child.pid)
      } else if (Number.isInteger(child.pid)) {
        rememberLog(
          `[updates] skipping marker pre-write: staged updater predates self-adopt (${updater}); it would refuse its own claim`
        )
      }

      rememberLog(
        `[updates] launched updater: ${updater} ${updaterArgs.join(' ')}; exiting desktop to release venv shim`
      )
    }

    // Linger on the "updating — don't reopen" overlay long enough for the user
    // to actually read it (and to bridge the gap until the updater's own window
    // appears), THEN quit to release the venv shim. The updater rebuilds and
    // relaunches us when it's done. (#50419 — a 600ms quit looked like a crash
    // and lured users into the #50238 relaunch loop.)
    //
    // The dwell doubles as the hand-off settle window (#66753): watch the
    // detached child for an async spawn `error` (ENOENT/EACCES) or an early
    // non-zero/signal exit. On failure, DON'T quit — the user would be left
    // with no app, no updater, and no evidence. Restart our backend and
    // surface the error instead. The pre-written marker names the dead child
    // pid, so readLiveUpdateMarker self-heals it; no cleanup needed.
    const dwellStartedAt = Date.now()
    const handoffOutcome = await observeUpdaterHandoff(child, UPDATE_HANDOFF_DWELL_MS)

    if (!handoffOutcome.ok) {
      const message = `Update failed to start: ${handoffOutcome.message}. Hermes will keep running — try again, or run \`hermes update\` from a terminal.`

      rememberLog(`[updates] hand-off not viable, aborting quit: ${handoffOutcome.message}`)
      emitUpdateProgress({ stage: 'error', message, percent: null })
      startHermes().catch(() => {})

      return { ok: false, error: 'updater-spawn-failed', message }
    }

    quitState.isQuittingForHandoff = true
    setTimeout(
      () => {
        app.quit()
      },
      Math.max(0, UPDATE_HANDOFF_DWELL_MS - (Date.now() - dwellStartedAt))
    )

    return { ok: true, handedOff: true, updater }
  } finally {
    quitState.updateInFlight = false
  }
}
