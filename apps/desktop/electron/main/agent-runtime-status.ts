// Main's owner of the agent runtime install status (RTB-6/7, V3-ON status/repair API): fed by every bootstrap event,
// persisted to <userData>/agent-runtime-status.json (0600, atomic), broadcast to the renderer on change.

import fs from 'node:fs'
import path from 'node:path'

import { app, shell } from 'electron'

import {
  AGENT_INSTALL_SKIPPED_TAG,
  type AgentRuntimeStatus,
  type AgentRuntimeTracker,
  mayAutoInstall,
  parseAgentRuntimeStatus,
  recordInstallAgain,
  recordSkip,
  type StatusBootstrapEvent,
  trackBootstrapEvent
} from '../../src/iclone-shared/agent-runtime-status'
import { writeFileAtomicSync } from '../lib/atomic-write'

import { rememberLog } from './log'
import { windowsState } from './state'

export const AGENT_RUNTIME_STATUS_FILE = 'agent-runtime-status.json'
export const AGENT_RUNTIME_STATUS_CHANNEL = 'hermes:agent-runtime:changed'

let tracker: AgentRuntimeTracker | null = null
let skippedThisRun = false

function statusPath() {
  return path.join(app.getPath('userData'), AGENT_RUNTIME_STATUS_FILE)
}

function load(): AgentRuntimeTracker {
  if (!tracker) {
    let raw: unknown = null

    try {
      raw = JSON.parse(fs.readFileSync(statusPath(), 'utf8'))
    } catch {
      // Missing or unreadable: an empty record; the next event rewrites it.
    }

    tracker = { run: null, status: parseAgentRuntimeStatus(raw, Date.now()) }
  }

  return tracker
}

function publish(next: AgentRuntimeTracker, persist: boolean) {
  const changed = next.status !== load().status
  tracker = next

  if (!changed) {
    return
  }

  if (persist) {
    try {
      writeFileAtomicSync(statusPath(), `${JSON.stringify(next.status, null, 1)}\n`, { mode: 0o600 })
    } catch (error) {
      // A read-only userData loses the record, never the boot.
      rememberLog(`[agent-runtime] status not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const window = windowsState.mainWindow

  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(AGENT_RUNTIME_STATUS_CHANNEL, next.status)
  }
}

/** Fold one bootstrap event (boot-progress.ts calls this for every event it broadcasts). Persists on run boundaries. */
export function recordBootstrapEventForStatus(ev: StatusBootstrapEvent) {
  const next = trackBootstrapEvent(load(), ev, Date.now())
  const boundary = ev.type === 'complete' || ev.type === 'failed' || ev.type === 'stage'

  publish(next, boundary)
}

export function getAgentRuntimeStatus(): AgentRuntimeStatus & { skippedThisRun: boolean } {
  return { ...load().status, skippedThisRun }
}

/** The backend came up: an install that predates this record (an upgrade) is installed. */
export function markAgentRuntimeRunning() {
  const current = load()

  if (current.status.state === 'not-installed') {
    publish({ ...current, status: { ...current.status, state: 'installed', updatedAt: Date.now() } }, true)
  }
}

/** "Skip for now": the app opens without the agent; this run never starts the install again by itself. */
export function skipAgentInstall() {
  skippedThisRun = true
  const current = load()
  publish({ ...current, status: recordSkip(current.status, Date.now()) }, true)
  rememberLog(`[agent-runtime] install skipped by the user (skip ${current.status.skipCount + 1})`)
}

/** "Install again" (Settings > Machine > Agent runtime, V3-ON): the skip record is cleared for the next boot. */
export function clearAgentInstallSkip() {
  skippedThisRun = false
  const current = load()
  publish({ ...current, status: recordInstallAgain(current.status, Date.now()) }, true)
}

/** Called where the first-launch install would start: refuses (tagged) when the user declined it. */
export function assertAgentInstallAllowed() {
  if (!mayAutoInstall(load().status, skippedThisRun)) {
    const error = new Error(
      `${AGENT_INSTALL_SKIPPED_TAG} The agent runtime install was skipped; Settings > Machine > Agent runtime installs it.`
    ) as Error & { agentInstallSkipped?: boolean }

    error.agentInstallSkipped = true
    throw error
  }
}

/** Test seam. */
export function _resetAgentRuntimeStatusForTests() {
  tracker = null
  skippedThisRun = false
}

/** The fixes that open something outside the app (RTB-6), as a closed set: the renderer names one, never a URL. */
export type AgentRuntimeOpenFix = 'open-network-settings' | 'open-storage-settings' | 'reveal-folder'

const SYSTEM_SETTINGS_PANES: Record<'open-network-settings' | 'open-storage-settings', string> = {
  'open-network-settings': 'x-apple.systempreferences:com.apple.Network-Settings.extension',
  'open-storage-settings': 'x-apple.systempreferences:com.apple.settings.Storage'
}

/** Open the macOS Settings pane a fix needs, or reveal the app's own data folder (a permission fix). */
export async function openAgentRuntimeFix(fix: unknown): Promise<{ ok: boolean }> {
  if (fix === 'reveal-folder') {
    shell.showItemInFolder(statusPath())

    return { ok: true }
  }

  if (process.platform !== 'darwin' || (fix !== 'open-network-settings' && fix !== 'open-storage-settings')) {
    return { ok: false }
  }

  await shell.openExternal(SYSTEM_SETTINGS_PANES[fix])

  return { ok: true }
}
