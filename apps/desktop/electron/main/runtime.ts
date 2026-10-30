// Runtime resolution: bootstrap marker, renderer index, working directory, backend command and the curated runtime.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { buildDesktopBackendEnv } from '../backend-env'
import type { InstallStamp } from '../bootstrap-runner'
import { resolveRemovableAppPath } from '../desktop-uninstall'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { codePathEnv } from '../packaged-env'
import { missingRendererAssets } from '../renderer-bundle'
import { getVenvSitePackagesEntries } from '../windows-hermes-path'
import { isPackagedInstallPath as isPackagedInstallPathUnderRoots } from '../workspace-cwd'

import {
  ACTIVE_HERMES_ROOT,
  activeVenvRoot,
  APP_ROOT,
  directoryExists,
  fileExists,
  HERMES_HOME,
  IS_PACKAGED,
  IS_WINDOWS,
  SOURCE_REPO_ROOT,
  unpackedPathFor
} from './env'
import { findPythonForRoot, findSystemPython, getVenvPython, venvRootForPython } from './executables'
import { rememberLog } from './log'
import { BOOTSTRAP_COMPLETE_MARKER, BOOTSTRAP_MARKER_SCHEMA_VERSION } from './paths'

// Windows console-window flashes are governed by the *parent's* console, not by
// each child spawn. A GUI-subsystem parent (pythonw.exe) has no console, so every
// console-subsystem child it spawns (git, gh, cmd, ...) must allocate its own —
// which flashes a window. A console-subsystem parent (python.exe) instead owns a
// single console that all of its children inherit, so none of them flash.
//
// Note this change adds no new creationflag: the backend spawn is ALREADY wrapped
// in hiddenWindowsChildOptions() (windowsHide: true), but that setting is INERT
// against pythonw.exe — a GUI-subsystem process has no console for it to act on.
// Switching the backend to the venv's console python.exe is what makes the
// existing wrapper load-bearing: with windowsHide the process comes up owning a
// *windowless* console (verified at runtime — it has an attachable console whose
// window handle is NULL), and its children inherit that one windowless console
// instead of each allocating a visible one.
//
// This makes "no flashing windows" a property of the one backend launch rather
// than a flag that has to be remembered at every descendant spawn site. Restoring
// console python also restores stdout, so the backend announces its port on the
// normal HERMES_DASHBOARD_READY stdout line and no ready-file side channel is
// needed.

export function makeDashboardReadyFile() {
  const dir = path.join(app.getPath('userData'), 'backend-ready')
  fs.mkdirSync(dir, { recursive: true })

  return path.join(dir, `dashboard-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`)
}

export function writeBootstrapMarker(payload: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(BOOTSTRAP_COMPLETE_MARKER), { recursive: true })

  const merged = {
    schemaVersion: BOOTSTRAP_MARKER_SCHEMA_VERSION,
    pinnedCommit: payload.pinnedCommit || null,
    pinnedBranch: payload.pinnedBranch || null,
    completedAt: new Date().toISOString(),
    desktopVersion: app.getVersion()
  }

  writeFileAtomicSync(BOOTSTRAP_COMPLETE_MARKER, JSON.stringify(merged, null, 2) + '\n')

  return merged
}

let webDistPackagedLogged = false

export function resolveWebDist() {
  const override = codePathEnv('HERMES_DESKTOP_WEB_DIST') // iclone-seam: p7-env

  if (override && directoryExists(path.resolve(override))) {
    return path.resolve(override)
  }

  const unpackedDist = path.join(unpackedPathFor(APP_ROOT), 'dist')

  if (directoryExists(unpackedDist)) {
    return unpackedDist
  }

  // Final fallback: APP_ROOT/dist. When packaged with asar:true this lives
  // INSIDE app.asar — not a servable filesystem directory — so the embedded
  // dashboard backend 404s on static routes (see #41327, #39472). The durable
  // fix is unpacking dist/ (PR #41411 adds dist/** to asarUnpack so the tier-2
  // unpackedDist above resolves). If we still land here while packaged, log it
  // so the cause isn't silent.
  const fallback = path.join(APP_ROOT, 'dist')

  // iclone-seam: p7-web-dist — dist/ stays inside app.asar (P7 7b). The desktop backend runs headless `serve`,
  // which never mounts the dashboard SPA, so HERMES_WEB_DIST needs no real directory.
  if (IS_PACKAGED && !webDistPackagedLogged) {
    webDistPackagedLogged = true
    rememberLog(
      `[p7-web-dist] packaged: dashboard SPA not served (headless backend); web dist stays in app.asar: ${fallback}`
    )
  }

  return fallback
}

export function resolveRendererIndex() {
  const asarIndex = path.join(APP_ROOT, 'dist', 'index.html')
  const webDistIndex = path.join(resolveWebDist(), 'index.html')

  // A packaged build ships dist/ twice: inside app.asar AND — because
  // asarUnpack lists dist/** — beside it in app.asar.unpacked. Prefer the
  // unpacked tree, matching the resolveWebDist()/unpackedPathFor precedent:
  // it is the copy the embedded dashboard serves and the copy a repair
  // rewrites, while pointing the window at the asar-internal index.html is
  // exactly how lazy chunks end up fetched from a path that cannot serve
  // them (#93479). Every window loader shares this resolver (main, overlay,
  // quick), so the ordering fix covers all of them. Dev is unchanged:
  // unpackedPathFor is a no-op outside an asar, so both candidates collapse
  // to APP_ROOT/dist and the original order is preserved.
  const candidates = IS_PACKAGED ? [webDistIndex, asarIndex] : [asarIndex, webDistIndex]
  const present = [...new Set(candidates)].filter(fileExists)

  // index.html and the hashed chunks it names are one generation. An update
  // that replaces only one of the two shipped copies (app.asar vs
  // app.asar.unpacked) leaves a TORN copy: the window loads, then dies on the
  // first lazy import with "Failed to fetch dynamically imported module" and
  // every restart reloads the same torn copy. Prefer a copy whose modules are
  // all present, so the intact generation heals the boot by itself.
  for (const candidate of present) {
    const missing = missingRendererAssets(candidate)

    if (missing.length === 0) {
      return candidate
    }

    rememberLog(
      `[renderer] skipping torn renderer bundle at ${candidate}: ` +
        `${missing.length} module file(s) named by index.html are missing ` +
        `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`
    )
  }

  if (present.length > 0) {
    // Every copy is torn. Load the first one anyway — the boundary's error is
    // still better than a blank window — but say what is wrong and how to fix
    // it, because no amount of restarting repairs a torn bundle.
    rememberLog(
      `[renderer] every renderer bundle is incomplete (${present.join(', ')}). ` +
        `The last update replaced the app while its files were locked. ` +
        `Repair with: hermes desktop --force-build`
    )

    return present[0]
  }

  // Nothing on disk. A packaged build with no renderer bundle blank-pages with
  // a bare ERR_FILE_NOT_FOUND and no clue why (see #39484). Surface the cause
  // and the fix before Electron loads the missing file.
  rememberLog(
    `[renderer] index.html not found — the desktop app was packaged without a ` +
      `renderer bundle. Tried: ${candidates.join(', ')}. ` +
      `Rebuild with: hermes desktop --force-build`
  )

  return candidates[0]
}

// True when `dir` lives inside the packaged app bundle / install tree.
// Packaged Electron's process.cwd() (and npm's INIT_CWD when dev tooling
// leaked into a release build) often resolve here — e.g. win-unpacked on
// Windows — which is exactly where PR #37536 item 16 said we must NOT run.
function isPackagedInstallPath(dir: string) {
  return isPackagedInstallPathUnderRoots(dir, {
    isPackaged: IS_PACKAGED,
    installRoots: [
      APP_ROOT,
      path.dirname(process.execPath),
      resolveRemovableAppPath(process.execPath, process.platform, process.env)
    ].filter((root): root is string => Boolean(root))
  })
}

export function resolveHermesCwd() {
  // In a packaged build, `process.cwd()` resolves to the install root (e.g.
  // `…/win-unpacked` on Windows or `/Applications/Hermes.app/Contents/...`
  // on macOS). Sessions spawned there leave files inside the app bundle
  // and bewilder users when "where did my files go?" is the install dir.
  // The user-configurable default project directory wins over everything,
  // followed by env hints (only honored when packaged if they point at a
  // real directory), then the home dir.
  const candidates = [
    readDefaultProjectDir(),
    process.env.HERMES_DESKTOP_CWD,
    IS_PACKAGED ? null : process.env.INIT_CWD,
    IS_PACKAGED ? null : process.cwd(),
    !IS_PACKAGED ? SOURCE_REPO_ROOT : null,
    app.getPath('home')
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const resolved = path.resolve(String(candidate))

    if (isPackagedInstallPath(resolved)) {
      continue
    }

    if (directoryExists(resolved)) {
      return resolved
    }
  }

  return app.getPath('home')
}

export function sanitizeWorkspaceCwd(cwd: string) {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : ''

  if (!trimmed || isPackagedInstallPath(trimmed)) {
    return { cwd: resolveHermesCwd(), sanitized: Boolean(trimmed) }
  }

  try {
    const resolved = path.resolve(trimmed)

    if (directoryExists(resolved)) {
      return { cwd: resolved, sanitized: false }
    }
  } catch {
    // Fall through to the resolved default.
  }

  return { cwd: resolveHermesCwd(), sanitized: Boolean(trimmed) }
}

// Persisted "Default project directory" — surfaced as a setting in the
// renderer (see app/settings/sessions-settings.tsx). Stored as JSON in
// userData so it survives self-updates without bleeding into the new
// install. `null` means "no preference, fall back to the usual chain".
const DEFAULT_PROJECT_DIR_CONFIG_FILENAME = 'project-dir.json'

function defaultProjectDirConfigPath() {
  return path.join(app.getPath('userData'), DEFAULT_PROJECT_DIR_CONFIG_FILENAME)
}

export function readDefaultProjectDir() {
  try {
    const raw = fs.readFileSync(defaultProjectDirConfigPath(), 'utf8')
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed.dir === 'string' && parsed.dir.trim()) {
      const resolved = path.resolve(parsed.dir)

      if (directoryExists(resolved)) {
        return resolved
      }
    }
  } catch {
    // Missing / unreadable / malformed → fall through to the rest of the
    // candidate chain.
  }

  return null
}

export function writeDefaultProjectDir(dir: string | null) {
  const target = defaultProjectDirConfigPath()
  const payload = dir ? JSON.stringify({ dir: path.resolve(dir) }, null, 2) : JSON.stringify({}, null, 2)

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, payload, 'utf8')
  } catch (error) {
    rememberLog(`[settings] write default project dir failed: ${errorMessage(error)}`)
  }
}

interface BackendSpecBase {
  label: string
  args: string[]
  env: NodeJS.ProcessEnv
  // Opt-in readiness handshake: the child writes its port to a file instead of announcing it on stdout.
  readyFile?: boolean
}

/** A runtime that can be spawned as-is (a source checkout, an existing CLI, a system python). */
interface ResolvedBackendSpec extends BackendSpecBase {
  kind: 'python' | 'command'
  command: string
  root?: string
  bootstrap: false
  shell: boolean
}

/** The canonical install: its venv may not exist yet, so ensureRuntime() refreshes it and fills `command`. */
interface ActiveBackendSpec extends BackendSpecBase {
  kind: 'python'
  command: string | null
  root: string
  bootstrap: true
  shell: false
}

interface BootstrapNeededBackendSpec extends BackendSpecBase {
  kind: 'bootstrap-needed'
  command: null
  bootstrap: true
  shell: false
  activeRoot: string
  installStamp: InstallStamp | null
  isPackaged: boolean
  platform: NodeJS.Platform
}

/** How to launch the Hermes backend, or (kind 'bootstrap-needed') the marker that the runtime must be installed first. */
export type HermesBackendSpec = ResolvedBackendSpec | ActiveBackendSpec | BootstrapNeededBackendSpec

/** What ensureRuntime() hands to spawn: never the bootstrap marker, always a command. */
export type RunnableBackendSpec = (ResolvedBackendSpec | ActiveBackendSpec) & { command: string }

export function createPythonBackend(
  root: string,
  label: string,
  backendArgs: readonly string[],
  options: { bootstrap?: boolean } = {}
): ResolvedBackendSpec | ActiveBackendSpec | null {
  const python = findPythonForRoot(root)

  if (!python) {
    return null
  }

  // The venv whose interpreter we selected is the venv whose site-packages
  // belong on PYTHONPATH — findPythonForRoot may have picked `.venv` over
  // `venv`, and mixing the two crashes the backend on its first native
  // import (see venvRootForPython). Fall back to root/venv only for a
  // system python, where the historical layout is the best guess.
  const venvRoot = venvRootForPython(python, root) ?? path.join(root, 'venv')
  const venvPython = getVenvPython(venvRoot)
  const command = IS_WINDOWS && fileExists(venvPython) ? venvPython : python

  return {
    kind: 'python',
    label,
    command,
    args: ['-m', 'hermes_cli.main', ...backendArgs],
    env: buildDesktopBackendEnv({
      hermesHome: HERMES_HOME,
      pythonPathEntries: [root, ...getVenvSitePackagesEntries(venvRoot)],
      venvRoot
    }),
    root,
    bootstrap: Boolean(options.bootstrap),
    shell: false
  }
}

// createActiveBackend — build a backend pointing at ACTIVE_HERMES_ROOT, the
// canonical install location shared with the CLI installer. The venv at
// VENV_ROOT may not exist yet on first run; bootstrap=true tells
// ensureRuntime() to create / refresh it before launch.
export function createActiveBackend(backendArgs: readonly string[]): ActiveBackendSpec {
  const venvRoot = activeVenvRoot()
  const venvPython = getVenvPython(venvRoot)
  const command = fileExists(venvPython) ? venvPython : findSystemPython()

  return {
    kind: 'python',
    label: `Hermes at ${ACTIVE_HERMES_ROOT}`,
    command,
    args: ['-m', 'hermes_cli.main', ...backendArgs],
    env: buildDesktopBackendEnv({
      hermesHome: HERMES_HOME,
      // V3-RT M1: a packaged app's environment names its verified tree in one .pth (pm/workspace.py), placed after the
      // standard library and before site-packages; nothing on PYTHONPATH may go ahead of the standard library.
      pythonPathEntries: IS_PACKAGED ? [] : [ACTIVE_HERMES_ROOT, ...getVenvSitePackagesEntries(venvRoot)],
      venvRoot
    }),
    root: ACTIVE_HERMES_ROOT,
    bootstrap: true,
    shell: false
  }
}

export const curatedRuntimeConfig = new Map<string, Promise<void>>()
