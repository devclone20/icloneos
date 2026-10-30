// U1 — main's side of Settings › Updates › Agent: the check, the gesture lock and the hand-off to the fork-owned
// script (scripts/desktop-update/iclone-agent-update.sh). The only callers are the `hermes:agent-update:*` handlers.
import fs from 'node:fs'
import path from 'node:path'

import { app, type WebContents } from 'electron'

import type {
  IcloneAgentGestureResult,
  IcloneAgentUpdateApplyResult,
  IcloneAgentUpdateCheck
} from '../../src/iclone-shared/update-status'
import {
  AGENT_CONTAINS_PROOF_FILE,
  AGENT_LAST_CHECK_FILE,
  AGENT_UPDATE_LOG_TAG,
  agentCompareUrl,
  agentUpdateDoorOpen,
  checkAgentLatest,
  createGestureStore,
  ensureFullPreUpdateBackup,
  gestureAllowed,
  lsRemoteArgv,
  lsRemoteCwd,
  parseCompare,
  parseContains,
  RUNTIME_CHOICE_FILE,
  validateAgentApply
} from '../agent-update'
import { compatGate, previewAgentTip, refreshInstallTarget } from '../iclone-compat'
import { appendLine as appendCompatLine, storeRoot as compatStoreRoot } from '../iclone-compat/store'
import { appRuntimeRoot } from '../iclone-runtime-location'
import { readRuntimeStatus } from '../iclone-updates'
import { readJsonFileSync, writeJsonAtomicSync } from '../lib/fs-json'
import { runGit } from '../lib/git'
import { updateHandoffConflict, writeUpdateMarker } from '../update-marker'
import { BUNDLED_RUNTIME_PIN } from '../update-policy'
import { isOfficialRemote, OFFICIAL_REPO_HTTPS_URL } from '../update-remote'
import { gateUpdateApply, spawnCapped } from '../update-runtime-align'
import { observeUpdaterHandoff, spawnUpdaterProcess } from '../updater-process'

import { ACTIVE_HERMES_ROOT, HERMES_HOME, IS_MAC, IS_PACKAGED, IS_WINDOWS, SOURCE_REPO_ROOT } from './env'
import { rememberLog, updatePolicy } from './log'
import { quitState } from './state'
import { getOriginUrl, preflightStateDb, runningAppBundle, UPDATE_HANDOFF_DWELL_MS } from './updates'

const SCRIPT_NAME = 'iclone-agent-update.sh'
/** A real pointer/keyboard event must reach the sender this recently before a gesture token is minted: short enough
 *  that no agent turn (message → model → `it` verb) fits between the user's last keystroke and the mint. */
const TRUSTED_INPUT_WINDOW_MS = 1500
const TRUSTED_INPUT_TYPES = new Set(['char', 'gestureTap', 'keyDown', 'keyUp', 'mouseDown', 'mouseUp', 'rawKeyDown'])

const lastTrustedInput = new WeakMap<WebContents, number>()
const gestures = createGestureStore()

const lastCheckFile = () => path.join(app.getPath('userData'), AGENT_LAST_CHECK_FILE)
const containsProofFile = () => path.join(app.getPath('userData'), AGENT_CONTAINS_PROOF_FILE)

// 'input-event' fires for input the browser process delivers (the OS, or sendInputEvent), never for a DOM
// `element.click()` — so the `it` CLI, which drives the page from inside, can never mint a token.
export function trackTrustedInput(contents: WebContents): void {
  contents.on('input-event', (_event, input) => {
    if (TRUSTED_INPUT_TYPES.has(input.type)) {
      lastTrustedInput.set(contents, Date.now())
    }
  })
}

/** When the browser process last delivered real input to `contents` (0 = never). V3-F's gesture lock reads it too. */
export function lastTrustedInputAt(contents: WebContents): number {
  return lastTrustedInput.get(contents) ?? 0
}

export function mintAgentGesture(sender: WebContents, payload: unknown): IcloneAgentGestureResult {
  const allowed = gestureAllowed({
    lastInputAt: lastTrustedInputAt(sender),
    now: Date.now(),
    payload,
    windowMs: TRUSTED_INPUT_WINDOW_MS
  })

  if (!allowed) {
    return { error: 'no-user-activation', ok: false }
  }

  return { gesture: gestures.mint(), ok: true }
}

export function readAgentLastCheck(): IcloneAgentUpdateCheck | null {
  const value = readJsonFileSync<IcloneAgentUpdateCheck>(lastCheckFile())

  return value && typeof value.checkedAt === 'string' && value.installed ? value : null
}

async function readCompare(base: string, head: string, signal: AbortSignal, onePage: boolean): Promise<unknown> {
  const url = agentCompareUrl(base, head, { onePage })

  if (!url) {
    return null
  }

  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'iclone-os-agent-update' },
    signal
  })

  return res.ok ? res.json() : null
}

const DOOR_CLOSED_MESSAGE = 'Agent updates come with app updates in this version.'

/** The user's "Check for updates". Target root is ALWAYS the active runtime, never the updater root (a dev run resolves that to the fork). */
export async function checkAgentLatestNow(): Promise<IcloneAgentUpdateCheck> {
  if (!agentUpdateDoorOpen()) {
    rememberLog(`${AGENT_UPDATE_LOG_TAG} check refused: door-closed (agent updates come with app updates)`)

    // Nothing is asked of the network and nothing is persisted.
    return {
      checkedAt: new Date().toISOString(),
      compat: null,
      error: 'door-closed',
      installed: { branch: null, date: null, dirty: null, sha: null, version: null, verifiedWithRelease: false },
      latest: null,
      updateAvailable: false,
      verified: { sha: BUNDLED_RUNTIME_PIN.sha, version: null }
    }
  }

  const check = await checkAgentLatest({
    fetchCompare: async (base, head, signal) => parseCompare(await readCompare(base, head, signal, false)),
    fetchContains: async (tagSha, tipSha, signal) => parseContains(await readCompare(tagSha, tipSha, signal, true)),
    lsRemote: timeoutMs => {
      const { cwd, env } = lsRemoteCwd()
      rememberLog(`${AGENT_UPDATE_LOG_TAG} ls-remote ${OFFICIAL_REPO_HTTPS_URL} (user click)`)

      return runGit(lsRemoteArgv(), { cwd, env, maxBuffer: 1 << 20, timeoutMs })
    },
    pin: { sha: BUNDLED_RUNTIME_PIN.sha },
    previewCompat: previewAgentTip,
    readContainsProof: () => {
      const proof = readJsonFileSync<{ tagSha: string; tipSha: string }>(containsProofFile())

      return proof?.tagSha && proof.tipSha ? proof : null
    },
    readInstalled: async () => {
      const status = await readRuntimeStatus({
        home: HERMES_HOME,
        ...(IS_PACKAGED ? { managedRoot: appRuntimeRoot(app.getPath('userData')) } : {}),
        packaged: IS_PACKAGED,
        sourceRoot: SOURCE_REPO_ROOT
      })

      return status.available && status.head
        ? {
            branch: status.branch,
            date: status.head.date,
            dirty: status.dirty,
            sha: status.head.sha,
            version: status.version
          }
        : null
    },
    writeContainsProof: proof => writeJsonAtomicSync(containsProofFile(), proof),
    writeLastCheck: check => writeJsonAtomicSync(lastCheckFile(), check)
  })

  return check
}

/** Packaged: Resources/desktop-update/; a dev run: the fork's own scripts/ (never the runtime checkout's). */
function agentUpdateScriptPath(): string {
  return IS_PACKAGED
    ? path.join(process.resourcesPath, 'desktop-update', SCRIPT_NAME)
    : path.join(SOURCE_REPO_ROOT, 'scripts', 'desktop-update', SCRIPT_NAME)
}

function relaunchArgs(): string[] {
  if (!IS_PACKAGED) {
    return []
  }

  const bundle = IS_MAC ? runningAppBundle() : null

  return bundle ? ['--relaunch-app', bundle] : IS_MAC ? [] : ['--relaunch-app', process.execPath]
}

/** The user's confirmed "Update". Every refusal is a value; on success the app quits and the script reopens it. */
export async function applyAgentUpdate(request: unknown): Promise<IcloneAgentUpdateApplyResult> {
  if (!agentUpdateDoorOpen()) {
    rememberLog(`${AGENT_UPDATE_LOG_TAG} apply refused: door-closed`)

    return { error: 'door-closed', message: DOOR_CLOSED_MESSAGE, ok: false }
  }

  const token =
    request && typeof request === 'object' ? (request as { gestureToken?: unknown }).gestureToken : undefined

  const lastCheck = readAgentLastCheck()

  const verdict = validateAgentApply({
    appUpdatePending: Boolean(quitState.icloneAppUpdate?.blocksRuntimeHandoff()),
    gestureOk: gestures.consume(token),
    lastCheck,
    platform: process.platform,
    request,
    updaterRunning: quitState.updateInFlight || Boolean(updateHandoffConflict(HERMES_HOME))
  })

  if ('error' in verdict) {
    rememberLog(`${AGENT_UPDATE_LOG_TAG} apply refused: ${verdict.error}`)

    return verdict
  }

  const script = agentUpdateScriptPath()
  const hermesBin = path.join(ACTIVE_HERMES_ROOT, 'venv', 'bin', 'hermes')

  if (!fs.existsSync(path.join(ACTIVE_HERMES_ROOT, '.git')) || !fs.existsSync(hermesBin) || !fs.existsSync(script)) {
    return {
      error: 'no-runtime',
      message: 'The agent runtime or its update script is missing. Repair the agent first.',
      ok: false
    }
  }

  // The check reads NousResearch's tip, but `hermes update` pulls from the runtime's own origin: they must be the same.
  const originUrl = await getOriginUrl(ACTIVE_HERMES_ROOT)

  if (!isOfficialRemote(originUrl)) {
    rememberLog(`${AGENT_UPDATE_LOG_TAG} apply refused: origin-mismatch (${originUrl || 'none'})`)

    return {
      error: 'origin-mismatch',
      message: `Nothing was changed: this agent's git origin is not ${OFFICIAL_REPO_HTTPS_URL}, so the update would not install the version you checked.`,
      ok: false
    }
  }

  const userData = app.getPath('userData')
  let installTip: null | string = null

  const gate = await gateUpdateApply({
    audit: entry => {
      try {
        appendCompatLine(compatStoreRoot(userData), 'audit.jsonl', { ...entry, to: verdict.targetSha })
      } catch {
        void 0
      }
    },
    compatGate: () => compatGate(userData),
    door: 'agent-latest',
    isWindows: IS_WINDOWS,
    pin: BUNDLED_RUNTIME_PIN,
    policy: updatePolicy(),
    refreshTarget: async () => {
      installTip = await refreshInstallTarget()
    }
  })

  if (installTip && installTip !== verdict.targetSha) {
    return {
      error: 'stale-check',
      message: 'Nous Research published a newer version. Check for updates again.',
      ok: false
    }
  }

  if (gate.refusal) {
    return { compat: lastCheck?.compat ?? null, error: 'compat-hold', message: gate.refusal.message, ok: false }
  }

  quitState.updateInFlight = true

  try {
    preflightStateDb(HERMES_HOME, rememberLog)
    await ensureFullPreUpdateBackup({
      hermesBin,
      hermesHome: HERMES_HOME,
      log: rememberLog,
      readConfig: file => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return null
        }
      },
      run: spawnCapped
    })

    const args = [
      script,
      '--install-root',
      ACTIVE_HERMES_ROOT,
      '--desktop-pid',
      String(process.pid),
      '--target-sha',
      verdict.targetSha,
      '--choice-file',
      path.join(userData, RUNTIME_CHOICE_FILE),
      ...relaunchArgs()
    ]

    const child = spawnUpdaterProcess('/bin/bash', args, {
      cwd: HERMES_HOME,
      detached: true,
      env: { ...process.env, HERMES_HOME },
      stdio: 'ignore'
    })

    if (Number.isInteger(child.pid)) {
      writeUpdateMarker(HERMES_HOME, child.pid, { startedAt: Math.floor(Date.now() / 1000) })
    }

    const started = await observeUpdaterHandoff(child, UPDATE_HANDOFF_DWELL_MS)

    if (!started.ok) {
      quitState.updateInFlight = false

      return { error: 'handoff-failed', message: `The update could not start: ${started.message}`, ok: false }
    }

    rememberLog(`${AGENT_UPDATE_LOG_TAG} hand-off to ${SCRIPT_NAME} → ${verdict.targetSha.slice(0, 10)}; quitting`)
    quitState.isQuittingForHandoff = true
    setTimeout(() => app.quit(), 0)

    return { compat: lastCheck?.compat ?? null, ok: true }
  } catch (error) {
    quitState.updateInFlight = false

    return { error: 'preflight-failed', message: error instanceof Error ? error.message : String(error), ok: false }
  }
}
