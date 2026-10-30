// Small persisted desktop settings: update config, window geometry, zoom; plus git helpers for the update root.
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { detectBundleSkew, type RunGit } from '../bundle-skew'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { debounce, sanitizeWindowState } from '../window-state'

import { DEFAULT_UPDATE_BRANCH, INSTALL_STAMP, resolveUpdateRoot } from './env'
import { runResolvedGit } from './executables'
import { rememberLog } from './log'
import { DESKTOP_UPDATE_CONFIG_PATH, DESKTOP_WINDOW_STATE_PATH } from './paths'
import { windowsState } from './state'

// ─── Self-update (git-pull against the running backend's hermes root) ──────

export function readDesktopUpdateConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DESKTOP_UPDATE_CONFIG_PATH, 'utf8'))
    const branch = typeof parsed?.branch === 'string' ? parsed.branch.trim() : ''

    return { branch: branch || DEFAULT_UPDATE_BRANCH }
  } catch {
    return { branch: DEFAULT_UPDATE_BRANCH }
  }
}

// Atomic file write: temp + rename (atomic on all platforms). Prevents
// partial writes on crash/power loss that corrupt JSON config files.
export function writeDesktopUpdateConfig(config: { branch: string }) {
  fs.mkdirSync(path.dirname(DESKTOP_UPDATE_CONFIG_PATH), { recursive: true })
  writeFileAtomicSync(DESKTOP_UPDATE_CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ─── Main-window geometry persistence (window-state.json) ──────────────────

export function readWindowState(): ReturnType<typeof sanitizeWindowState> {
  try {
    return sanitizeWindowState(JSON.parse(fs.readFileSync(DESKTOP_WINDOW_STATE_PATH, 'utf8')))
  } catch {
    return null
  }
}

// Persist the window's restored (non-maximized) bounds plus its maximized flag.
// getNormalBounds() keeps the pre-maximize size, so un-maximizing next session
// lands back where the user actually sized the window.
function persistWindowState() {
  if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed() || windowsState.mainWindow.isMinimized()) {
    return
  }

  try {
    const { x, y, width, height } = windowsState.mainWindow.getNormalBounds()
    fs.mkdirSync(path.dirname(DESKTOP_WINDOW_STATE_PATH), { recursive: true })
    writeFileAtomicSync(
      DESKTOP_WINDOW_STATE_PATH,
      JSON.stringify({ x, y, width, height, isMaximized: windowsState.mainWindow.isMaximized() }, null, 2)
    )
  } catch (err) {
    rememberLog(`[window-state] persist failed: ${errorMessage(err) || err}`)
  }
}

// move/resize fire many times mid-drag; debounce to one write.
export const schedulePersistWindowState = debounce(persistWindowState, 250)

// Zoom's primary store is a main-process JSON file. The renderer localStorage
// mirror lives under Electron's cache/storage folders, which crash recovery
// can move or recreate — wiping the zoom setting exactly when the user just
// recovered from a crash (#56726). JSON survives; localStorage is kept as a
// secondary mirror so pre-JSON installs migrate transparently on first read.
const DESKTOP_ZOOM_STATE_PATH = path.join(app.getPath('userData'), 'zoom-state.json')

export function readZoomState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DESKTOP_ZOOM_STATE_PATH, 'utf8'))
    const level = Number(raw?.zoomLevel)

    return Number.isFinite(level) ? level : null
  } catch {
    return null
  }
}

export function writeZoomState(zoomLevel: number) {
  try {
    fs.mkdirSync(path.dirname(DESKTOP_ZOOM_STATE_PATH), { recursive: true })
    writeFileAtomicSync(DESKTOP_ZOOM_STATE_PATH, JSON.stringify({ zoomLevel }, null, 2))
  } catch (error) {
    rememberLog(`[zoom] json persist failed: ${errorMessage(error) || error}`)
  }
}

// Renderer-bundle skew: `hermes update` moves the SOURCE TREE, but the UI
// (including bundled plugins like Bot Mode) is compiled into this binary at
// build time. A terminal-side update — or an in-app update whose bundle-swap
// leg failed — leaves the new runtime running under an old renderer, so About
// shows the new version while the sidebar is missing that version's desktop
// features. Compare the build stamp's commit against the tree, scoped to
// apps/desktop/, and warn when the running renderer is provably behind.
// Fail-quiet: dev runs (no stamp), non-git builds, and shallow-clone gaps all
// report in-sync rather than risk a false "your install is torn" warning.
// bundle-skew's RunGit models a finished process (`code: number`); a signal-killed git (code null) is a failure like any
// non-zero exit, which is how detectBundleSkew already read it.
// V3-RT K-RT9: the update root is the app's own runtime folder, which has no `.git` and lives inside the owner's home —
// itself a git repository on this owner's Mac. Git must never walk up out of that folder into the home repository.
const runGitForSkew: RunGit = async (args, options) => {
  const result = await runResolvedGit(args, {
    ...options,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(options.cwd), GIT_OPTIONAL_LOCKS: '0' }
  })

  return { ...result, code: result.code ?? 1 }
}

export async function detectRendererSkew() {
  return detectBundleSkew(INSTALL_STAMP, runGitForSkew, resolveUpdateRoot())
}
