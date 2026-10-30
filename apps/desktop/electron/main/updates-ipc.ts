// IPC: updates, version, about panel, uninstall and VS Code themes.
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { app, ipcMain } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { RUNTIME_CHOICE_FILE } from '../agent-update'
import { bindRuntimeChoiceFile } from '../bootstrap-runner'
import {
  buildPosixCleanupScript,
  buildWindowsCleanupScript,
  modeRemovesAgent,
  modeRemovesUserData,
  resolveRemovableAppPath,
  shouldRemoveAppBundle,
  uninstallArgsForMode
} from '../desktop-uninstall'
import { createUninstallSummaryCache, isUninstallSummaryValue, readGitHeadSha } from '../uninstall-summary-cache'
import {
  BUNDLED_RUNTIME_PIN,
  compareWithUpstreamGuarded,
  readUpdatePolicyOverride,
  UPDATE_POLICY_LOG_TAG,
  writeUpdatePolicyOverride
} from '../update-policy'
import { CURATED_CONFIG_MARKER_FILE, readJsonFile, RUNTIME_ALIGN_FILE } from '../update-runtime-align'
import { fetchMarketplaceThemes, searchMarketplaceThemes } from '../vscode-marketplace'
import { hiddenWindowsChildOptions } from '../windows-child-options'

import {
  applyAgentUpdate,
  checkAgentLatestNow,
  mintAgentGesture,
  readAgentLastCheck,
  trackTrustedInput
} from './agent-update'
import { icloneRuntimeVersion, icloneVersionLine } from './app-identity'
import type { releaseBackendLock } from './backend-pool'
import { detectRendererSkew, readDesktopUpdateConfig, writeDesktopUpdateConfig } from './desktop-settings'
import {
  ACTIVE_HERMES_ROOT,
  activeVenvRoot,
  DEFAULT_UPDATE_BRANCH,
  fileExists,
  HERMES_HOME,
  IS_PACKAGED,
  IS_WINDOWS,
  isHermesSourceRoot,
  resolveUpdateRoot,
  updatePolicyOverrideFile
} from './env'
import { findSystemPython, getVenvPython } from './executables'
import { rememberLog, updatePolicy } from './log'
import type { quitState } from './state'
import { applyUpdates } from './update-apply'
import { checkUpdates, compareWithUpstream } from './updates'

interface UpdatesIpcDeps {
  quitState: typeof quitState
  releaseBackendLock: typeof releaseBackendLock
}

// ===========================================================================
// Uninstall — remove the Chat GUI (and optionally the agent / user data).
// ===========================================================================
//
// The renderer's About → Danger Zone surfaces three options that mirror the
// CLI exactly: GUI only, Lite (keep user data), Full. We ask the agent to do
// the actual removal via `hermes uninstall …` so the cross-platform PATH /
// registry / service / node-symlink cleanup all lives in one place
// (hermes_cli/uninstall.py + hermes_cli/gui_uninstall.py).
//
// probeUninstallSummary() shells out to `--gui-summary` (a fast, no-side-effect
// JSON probe) so the UI can gate options on what's actually installed — and
// detect a missing agent (a future "lite client" that ships without the
// bundled agent), hiding the agent/full options when there's nothing to remove.

function uninstallVenvPython() {
  return getVenvPython(activeVenvRoot())
}

type UninstallSummary = Record<string, unknown>

const isFallbackSummary = (summary: UninstallSummary) => summary.probe === 'fallback'

// The probe answer changes only with the app or the runtime: About shows the cached one at once (V3-0b).
const uninstallSummaryCache = createUninstallSummaryCache<UninstallSummary>({
  file: () => path.join(app.getPath('userData'), 'uninstall-summary.json'),
  isFallback: isFallbackSummary,
  isValue: isUninstallSummaryValue,
  key: () => `${app.getVersion()}|${readGitHeadSha(ACTIVE_HERMES_ROOT) ?? 'no-sha'}|${ACTIVE_HERMES_ROOT}`,
  log: rememberLog,
  probe: probeUninstallSummary
})

async function getUninstallSummary(): Promise<UninstallSummary> {
  const summary = await uninstallSummaryCache.get()

  // The bundle the renderer would remove on *this* machine, from the running exe (the Python probe only knows the
  // standard locations). Resolved on every read so a cached answer never names where the app used to live.
  return isFallbackSummary(summary)
    ? summary
    : { ...summary, running_app_path: resolveRemovableAppPath(process.execPath, process.platform, process.env) }
}

async function probeUninstallSummary(): Promise<UninstallSummary> {
  const py = uninstallVenvPython()
  const agentRoot = ACTIVE_HERMES_ROOT

  // Fast JS-side fallback used when the agent venv is gone (lite client) or the
  // probe fails — the renderer still needs *something* to render options from.
  const fallback = (): UninstallSummary => ({
    hermes_home: HERMES_HOME,
    agent_installed: isHermesSourceRoot(agentRoot) && fileExists(py),
    gui_installed: true,
    source_built_artifacts: [],
    packaged_app_paths: [],
    userdata_dir: app.getPath('userData'),
    userdata_exists: true,
    platform: process.platform,
    probe: 'fallback'
  })

  if (!fileExists(py)) {
    return fallback()
  }

  return new Promise<UninstallSummary>(resolve => {
    let stdout = ''
    let settled = false

    const done = (value: UninstallSummary) => {
      if (settled) {
        return
      }

      settled = true
      resolve(value)
    }

    try {
      const child = spawn(
        py,
        ['-m', 'hermes_cli.main', 'uninstall', '--gui-summary'],
        hiddenWindowsChildOptions({
          cwd: agentRoot,
          env: { ...process.env, HERMES_HOME, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'ignore']
        })
        // hiddenWindowsChildOptions erases the stdio tuple; the literal pins stdout as the only pipe.
      ) as ChildProcessByStdio<null, Readable, null>

      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
      })
      child.on('error', () => done(fallback()))
      child.on('exit', code => {
        if (code !== 0) {
          return done(fallback())
        }

        try {
          const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}'
          const parsed: unknown = JSON.parse(line)

          done(isUninstallSummaryValue(parsed) ? parsed : fallback())
        } catch {
          done(fallback())
        }
      })
      setTimeout(() => done(fallback()), 8000)
    } catch {
      done(fallback())
    }
  })
}

async function runDesktopUninstall(
  { quitState, releaseBackendLock }: Pick<UpdatesIpcDeps, 'quitState' | 'releaseBackendLock'>,
  mode: string
) {
  let uninstallArgs

  try {
    uninstallArgs = uninstallArgsForMode(mode)
  } catch (error) {
    return { ok: false, error: 'invalid-mode', message: errorMessage(error) }
  }

  const venvPy = uninstallVenvPython()

  if (!fileExists(venvPy)) {
    return {
      ok: false,
      error: 'agent-missing',
      message: `Can't run the uninstaller: no Hermes agent venv at ${activeVenvRoot()}.`
    }
  }

  // Interpreter choice (Finding 3): lite/full rmtree the venv that holds the
  // running python.exe. On Windows a running .exe is mandatory-locked, so the
  // rmtree must NOT be driven by the venv's own interpreter — use a system
  // Python with PYTHONPATH=<agentRoot> so `import hermes_cli` resolves from
  // source while the venv is torn down. gui-only doesn't touch the venv, so the
  // venv python is fine there. If no system Python exists (the Windows edge
  // case), fall back to the venv python — gui-only is unaffected; lite/full may
  // leave venv remnants the user can delete, which we log.
  let py = venvPy
  let pythonPath = null

  if (modeRemovesAgent(mode)) {
    const sysPy = findSystemPython()

    if (sysPy) {
      py = sysPy
      pythonPath = ACTIVE_HERMES_ROOT
    } else if (IS_WINDOWS) {
      rememberLog(
        '[uninstall] no system Python found for lite/full on Windows; falling back ' +
          'to the venv python — venv files locked by the running interpreter may ' +
          'remain and need manual deletion.'
      )
    }
  }

  const appPath = resolveRemovableAppPath(process.execPath, process.platform, process.env)
  const removeBundle = shouldRemoveAppBundle(IS_PACKAGED, appPath) ? appPath : null

  // CRITICAL (Windows): tear down every backend the desktop owns and wait for
  // the venv shim to unlock BEFORE the cleanup script runs. lite/full delete
  // the venv, and even gui-only removes the install tree's GUI artifacts — a
  // live backend grandchild (gateway / pty / REPL) holding a mandatory file
  // lock would make the script's rmdir half-fail (#37532 for the update path).
  // Reuses the incident-hardened update teardown; no-op on macOS/Linux.
  try {
    await releaseBackendLock(ACTIVE_HERMES_ROOT, 'uninstall')
  } catch (error) {
    rememberLog(`[uninstall] backend teardown errored (continuing): ${errorMessage(error)}`)
  }

  const scriptArgs = {
    desktopPid: process.pid,
    pythonExe: py,
    pythonPath,
    agentRoot: ACTIVE_HERMES_ROOT,
    uninstallArgs,
    appPath: removeBundle,
    hermesHome: HERMES_HOME
  }

  let scriptPath
  let runner
  let runnerArgs

  try {
    if (IS_WINDOWS) {
      scriptPath = path.join(app.getPath('temp'), `hermes-uninstall-${Date.now()}.cmd`)
      fs.writeFileSync(scriptPath, buildWindowsCleanupScript(scriptArgs))
      runner = process.env.ComSpec || 'cmd.exe'
      runnerArgs = ['/c', scriptPath]
    } else {
      scriptPath = path.join(app.getPath('temp'), `hermes-uninstall-${Date.now()}.sh`)
      fs.writeFileSync(scriptPath, buildPosixCleanupScript(scriptArgs), { mode: 0o755 })
      runner = '/bin/bash'
      runnerArgs = [scriptPath]
    }
  } catch (error) {
    return { ok: false, error: 'script-write-failed', message: errorMessage(error) }
  }

  try {
    const child = spawn(runner, runnerArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })

    child.unref()
  } catch (error) {
    return { ok: false, error: 'spawn-failed', message: errorMessage(error) }
  }

  rememberLog(
    `[uninstall] launched detached cleanup (${mode}): ${scriptPath} ` +
      `(removesAgent=${modeRemovesAgent(mode)} removesUserData=${modeRemovesUserData(mode)} bundle=${removeBundle || 'none'})`
  )

  // Give the renderer a beat to show its "uninstalling…" state, then quit so
  // the venv python shim + app bundle unlock and the cleanup script can run.
  quitState.isQuittingForHandoff = true
  setTimeout(() => app.quit(), 800)

  return { ok: true, mode, willRemoveAppBundle: Boolean(removeBundle), scriptPath }
}

export function registerUpdatesIpc({ quitState, releaseBackendLock }: UpdatesIpcDeps): void {
  ipcMain.handle('hermes:updates:check', async () =>
    checkUpdates().catch(error => ({
      supported: true,
      branch: readDesktopUpdateConfig().branch,
      error: 'check-failed',
      message: error?.message || String(error),
      fetchedAt: Date.now()
    }))
  )

  ipcMain.handle('hermes:updates:apply', async (_event, payload) =>
    // iclone-seam: p4a-gate: compatGate refuses RED/UNKNOWN without the owner's ack at the top of applyUpdates (all doors)
    applyUpdates(payload || {}).catch(error => ({
      ok: false,
      error: 'apply-failed',
      message: error?.message || String(error)
    }))
  )

  ipcMain.handle('hermes:updates:branch:get', async () => readDesktopUpdateConfig())

  // U1 — Settings › Updates › Agent. The check runs only here (one click = one query to Nous Research); the apply needs
  // the last check's sha and a single-use token minted by a real input event on the confirm button.
  app.on('web-contents-created', (_event, contents) => trackTrustedInput(contents))
  bindRuntimeChoiceFile(() => path.join(app.getPath('userData'), RUNTIME_CHOICE_FILE))
  ipcMain.handle('hermes:agent-update:check', async () => checkAgentLatestNow())
  ipcMain.handle('hermes:agent-update:last-check', async () => readAgentLastCheck())
  ipcMain.handle('hermes:agent-update:gesture', async (event, payload) => mintAgentGesture(event.sender, payload))
  ipcMain.handle('hermes:agent-update:apply', async (_event, payload) =>
    applyAgentUpdate(payload).catch(error => ({
      ok: false as const,
      error: 'handoff-failed' as const,
      message: errorMessage(error)
    }))
  )

  // iclone-seam: r1-policy — explicit click only; curated never reaches git or api.github.com.
  ipcMain.handle('hermes:updates:compare-upstream', async () =>
    compareWithUpstreamGuarded(updatePolicy(), () => compareWithUpstream()).catch(error => ({
      supported: true,
      error: 'check-failed',
      message: error?.message || String(error),
      fetchedAt: Date.now()
    }))
  )

  // iclone-seam: r1-app-check — About's "Check for updates" asks the app updater (devclone20 feed), never Nous upstream.
  ipcMain.handle('iclone:app-update:check', async () => {
    if (!quitState.icloneAppUpdate) {
      return { outcome: 'inactive', version: null }
    }

    try {
      return await quitState.icloneAppUpdate.checkNow()
    } catch (error) {
      return { outcome: 'error', version: null, error: errorMessage(error) || String(error) }
    }
  })

  ipcMain.handle('iclone:update-policy', async () => {
    const userData = app.getPath('userData')
    const marker = readJsonFile<Record<string, unknown>>(path.join(userData, CURATED_CONFIG_MARKER_FILE)) ?? {}

    return {
      policy: updatePolicy(),
      packaged: IS_PACKAGED,
      override: IS_PACKAGED ? readUpdatePolicyOverride(updatePolicyOverrideFile()) : null,
      pin: { sha: BUNDLED_RUNTIME_PIN.sha, date: BUNDLED_RUNTIME_PIN.date, verified: BUNDLED_RUNTIME_PIN.verified },
      runtimeCheckOff: Boolean(marker[HERMES_HOME]),
      align: readJsonFile(path.join(userData, RUNTIME_ALIGN_FILE))
    }
  })

  // The packaged build on the developer's own Mac: a typed ack writes the override; it applies at the next launch.
  ipcMain.handle('iclone:update-policy:set-developer', async (_event, payload) => {
    if (!IS_PACKAGED) {
      return { ok: false, error: 'not-packaged' }
    }

    const result = writeUpdatePolicyOverride(updatePolicyOverrideFile(), { ack: payload?.ack, by: payload?.by })

    if (result.ok) {
      rememberLog(
        `${UPDATE_POLICY_LOG_TAG} developer override written by ${result.override?.by}; applies at next launch`
      )
    }

    return { ...result, restartRequired: result.ok }
  })

  ipcMain.handle('hermes:updates:branch:set', async (_event, name) => {
    if (updatePolicy() === 'curated') {
      return { ...readDesktopUpdateConfig(), refused: 'curated-only' }
    }

    const branch = typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_UPDATE_BRANCH
    writeDesktopUpdateConfig({ branch })

    return { branch }
  })

  ipcMain.handle('hermes:version', async () => {
    const skew = await detectRendererSkew()

    return {
      // iclone-seam: p7-version
      appVersion: app.getVersion(),
      runtimeVersion: icloneRuntimeVersion(),
      versionLine: icloneVersionLine(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      hermesRoot: resolveUpdateRoot(),
      bundleOutOfSync: skew.outOfSync,
      bundleCommitsBehind: skew.desktopCommitsBehind
    }
  })

  ipcMain.handle('hermes:uninstall:summary', async () => getUninstallSummary())
  ipcMain.handle('hermes:uninstall:run', async (_event, payload) => {
    const mode = payload && typeof payload === 'object' ? payload.mode : payload

    return runDesktopUninstall({ quitState, releaseBackendLock }, String(mode || ''))
  })

  // Download a VS Code Marketplace extension and return the raw color-theme JSON
  // it contributes. No theme code is executed — we only read JSON from the .vsix.
  ipcMain.handle('hermes:vscode-theme:fetch', async (_event, id) => fetchMarketplaceThemes(String(id || '')))

  // Search the Marketplace for color-theme extensions (empty query = top installs).
  ipcMain.handle('hermes:vscode-theme:search', async (_event, query) =>
    searchMarketplaceThemes(String(query || ''), 20)
  )
}
