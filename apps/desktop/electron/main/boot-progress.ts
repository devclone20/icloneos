// Boot progress and first-run setup state, broadcast to the renderer.

import { sleep } from '../../src/iclone-shared/async'
import type { BootstrapEvent, StageEvent, StageResultJson } from '../bootstrap-runner'
import { createFirstRunSetupGate } from '../first-run-setup-gate'

import { assertAgentInstallAllowed, recordBootstrapEventForStatus } from './agent-runtime-status'
import { progressState } from './backend-state'
import { BOOT_FAKE_MODE, BOOT_FAKE_STEP_MS } from './boot-fake'
import { ACTIVE_HERMES_ROOT, isRuntimeUpgradeFromLegacy } from './env'
import { rememberLog } from './log'
import type { HermesBackendSpec } from './runtime'
import { windowsState } from './state'

export function resetBootProgressForReconnect() {
  updateBootProgress(
    {
      error: null,
      message: 'Restarting desktop connection',
      phase: 'backend.resolve',
      progress: 4,
      running: true
    },
    { allowDecrease: true }
  )
}

function clampBootProgress(value: unknown) {
  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export function broadcastBootProgress() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:boot-progress', progressState.bootProgressState)
}

// Bootstrap-event broadcast channel + state. The bootstrap runner emits a
// stream of events (manifest, stage, log, complete, failed) that the renderer
// install overlay subscribes to. We also keep a running snapshot:
//   - manifest: the stage list (rendered as a checklist in the overlay)
//   - stages:   per-stage state ('pending' | 'running' | 'succeeded' |
//               'skipped' | 'failed') keyed by stage name
//   - active:   true while a bootstrap is in flight; false otherwise
//   - error:    last 'failed' event's error message
//   - log:      bounded ring buffer of the last 200 log lines for the
//               "Show details" affordance in the overlay
//
// The snapshot is queryable via the hermes:bootstrap:get IPC handler so a
// reloaded renderer (e.g. devtools reload during dev) recovers state.
// Bootstrap log ring: bounded buffer so a long install (npm + playwright
// downloads can emit thousands of lines) doesn't grow unbounded in memory
// AND so the renderer's getBootstrapState() reply stays a reasonable size.
// We keep enough to cover an entire failed stage's transcript so the
// 'Copy output' button gives the user actually-actionable context, not
// just the last few lines.
const BOOTSTRAP_LOG_RING_MAX = 500

/** Events the runner emits plus the ones main raises itself around it (platform gate, first-run choice, dismiss). */
type DesktopBootstrapEvent =
  | BootstrapEvent
  | { type: 'unsupported-platform'; platform: string; activeRoot: string; installCommand: string; docsUrl: string }
  | { type: 'setup-choice'; active: boolean; platform?: string; activeRoot?: string }
  | { type: 'dismissed' }

interface BootstrapSnapshotState {
  active: boolean
  manifest: Extract<BootstrapEvent, { type: 'manifest' }> | null
  stages: Record<
    string,
    {
      state: StageEvent['state'] | 'pending'
      json: StageResultJson | null
      durationMs: number | null
      error: string | null
    }
  >
  error: string | null
  log: { ts: number; stage: string | null; line: string; stream: 'stderr' | 'stdout' }[]
  startedAt: number | null
  completedAt: number | null
  setupChoice: { platform: string | undefined; activeRoot: string | undefined } | null
  unsupportedPlatform: { platform: string; activeRoot: string; installCommand: string; docsUrl: string } | null
}

let bootstrapState: BootstrapSnapshotState = {
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  setupChoice: null,
  unsupportedPlatform: null
}

let firstRunSetupGate: ReturnType<typeof createFirstRunSetupGate> | null = null

export function broadcastBootstrapEvent(ev: DesktopBootstrapEvent) {
  // RTB-6/7: the persisted install status (per-package lines, diagnosis) Settings and V3-ON read.
  try {
    recordBootstrapEventForStatus(ev)
  } catch {
    // The status record never stalls an install.
  }

  if (ev.type === 'manifest') {
    bootstrapState.manifest = ev
    bootstrapState.active = true
    bootstrapState.setupChoice = null
    bootstrapState.startedAt = bootstrapState.startedAt || Date.now()
    bootstrapState.stages = {}

    for (const stage of ev.stages || []) {
      bootstrapState.stages[stage.name] = { state: 'pending', json: null, durationMs: null, error: null }
    }
  } else if (ev.type === 'stage') {
    bootstrapState.stages[ev.name] = {
      state: ev.state,
      durationMs: ev.durationMs ?? null,
      json: ev.json ?? null,
      error: ev.error ?? null
    }
  } else if (ev.type === 'log') {
    bootstrapState.log.push({ ts: Date.now(), stage: ev.stage || null, line: ev.line, stream: ev.stream || 'stdout' })

    if (bootstrapState.log.length > BOOTSTRAP_LOG_RING_MAX) {
      bootstrapState.log.splice(0, bootstrapState.log.length - BOOTSTRAP_LOG_RING_MAX)
    }
  } else if (ev.type === 'complete') {
    bootstrapState.active = false
    bootstrapState.completedAt = Date.now()
    bootstrapState.error = null
    bootstrapState.unsupportedPlatform = null
  } else if (ev.type === 'failed') {
    bootstrapState.active = false
    bootstrapState.error = ev.error || 'unknown error'
    bootstrapState.setupChoice = null
  } else if (ev.type === 'unsupported-platform') {
    bootstrapState.active = false
    bootstrapState.setupChoice = null
    bootstrapState.unsupportedPlatform = {
      platform: ev.platform,
      activeRoot: ev.activeRoot,
      installCommand: ev.installCommand,
      docsUrl: ev.docsUrl
    }
  } else if (ev.type === 'setup-choice') {
    bootstrapState.active = false
    bootstrapState.error = null
    bootstrapState.manifest = null
    bootstrapState.stages = {}
    bootstrapState.setupChoice = ev.active
      ? {
          platform: ev.platform,
          activeRoot: ev.activeRoot
        }
      : null
    bootstrapState.unsupportedPlatform = null
  } else if (ev.type === 'dismissed') {
    resetBootstrapSnapshot()
  }

  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = windowsState.mainWindow

  if (!webContents || webContents.isDestroyed()) {
    return
  }

  webContents.send('hermes:bootstrap:event', ev)
}

export function getBootstrapState() {
  return bootstrapState
}

export function resetBootstrapSnapshot() {
  bootstrapState = {
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: null,
    setupChoice: null,
    unsupportedPlatform: null
  }
}

function promptFirstRunSetupChoice(backend: { platform?: string; activeRoot?: string }) {
  broadcastBootstrapEvent({
    type: 'setup-choice',
    active: true,
    platform: backend.platform || process.platform,
    activeRoot: backend.activeRoot || ACTIVE_HERMES_ROOT
  })
}

function hideFirstRunSetupChoice() {
  if (bootstrapState.setupChoice) {
    broadcastBootstrapEvent({ type: 'setup-choice', active: false })
  }
}

export function getFirstRunSetupGate(): ReturnType<typeof createFirstRunSetupGate> {
  if (!firstRunSetupGate) {
    firstRunSetupGate = createFirstRunSetupGate({
      hideChoice: hideFirstRunSetupChoice,
      log: rememberLog,
      onStuck: (_backend, stuckAfterMs) => {
        updateBootProgress(
          {
            error: null,
            message: `Still waiting for first-run setup choice after ${Math.round(stuckAfterMs / 1000)} seconds`,
            phase: 'bootstrap.choice',
            progress: 12,
            running: true
          },
          { allowDecrease: true }
        )
      },
      promptChoice: promptFirstRunSetupChoice
    })
  }

  return firstRunSetupGate
}

export async function waitForFirstRunSetupChoice(backend: HermesBackendSpec) {
  const gate = getFirstRunSetupGate()

  if (!gate.shouldGate(backend)) {
    return 'continue-local'
  }

  // RTB-6: the user skipped the install (twice, or in this run): no first-run choice either — nothing nags; Settings
  // > Machine > Updates > Agent runtime (Install again) or Gateway settings take it from there.
  assertAgentInstallAllowed()

  // K-RT2 (ruling 36): someone who already had a runtime (a previous release's, or their own) is not asked how to set
  // up: the app installs its own copy beside it, leaves their folder untouched, and the install overlay says so once.
  if (isRuntimeUpgradeFromLegacy()) {
    gate.continueLocal()

    return 'continue-local'
  }

  updateBootProgress(
    {
      error: null,
      message: 'Waiting for first-run setup choice',
      phase: 'bootstrap.choice',
      progress: 12,
      running: true
    },
    { allowDecrease: true }
  )

  return gate.wait(backend)
}

export function continueFirstRunLocalBootstrap() {
  getFirstRunSetupGate().continueLocal()
}

export function abandonFirstRunSetupChoiceForRemoteApply() {
  const gate = getFirstRunSetupGate()

  if (!gate.hasWaiter()) {
    return false
  }

  const resumedGatedConnection = gate.abandonForRemoteApply()

  if (resumedGatedConnection) {
    broadcastBootstrapEvent({ type: 'dismissed' })
  }

  return resumedGatedConnection
}

export function updateBootProgress(
  update: Partial<typeof progressState.bootProgressState>,
  options: { allowDecrease?: boolean } = {}
) {
  const nextProgressRaw =
    typeof update.progress === 'number' ? clampBootProgress(update.progress) : progressState.bootProgressState.progress

  const nextProgress = options.allowDecrease
    ? nextProgressRaw
    : Math.max(progressState.bootProgressState.progress, nextProgressRaw)

  progressState.bootProgressState = {
    ...progressState.bootProgressState,
    ...update,
    error: update.error === undefined ? progressState.bootProgressState.error : update.error,
    fakeMode: BOOT_FAKE_MODE || Boolean(update.fakeMode),
    progress: nextProgress,
    // `retryable` rides with `error`: it survives updates that preserve the
    // error and resets alongside a new/cleared error unless explicitly set.
    retryable:
      update.retryable === undefined
        ? update.error === undefined && Boolean(progressState.bootProgressState.retryable)
        : Boolean(update.retryable),
    timestamp: Date.now()
  }

  if (update.message) {
    rememberLog(`[boot] ${update.message}`)
  }

  broadcastBootProgress()
}

export async function advanceBootProgress(phase: string, message: string, progress: number) {
  updateBootProgress({
    phase,
    message,
    progress,
    running: true,
    error: null
  })

  if (BOOT_FAKE_MODE) {
    await sleep(BOOT_FAKE_STEP_MS)
  }
}
