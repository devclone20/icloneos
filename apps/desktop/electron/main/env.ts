// Process environment resolved at load: paths, platform flags, Hermes home, update policy and the pre-ready Chromium switches.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { pinChromiumUiLocale } from '../app-locale'
import { hermesManagedNodePathEntries, normalizeHermesHomeRoot } from '../backend-env'
import { detectRemoteDisplay, isWslEnvironment, resolveLinuxPasswordStore } from '../bootstrap-platform'
import { describeDevCdpDecision, resolveDevCdpPort } from '../dev-cdp'
import { managedRuntimeRoot } from '../iclone-runtime-location'
import { codePathEnv, sealPackagedProcessEnv } from '../packaged-env'
import { pmCommittedVenv } from '../pm-venv'
import { RUNTIME_PIN } from '../runtime-pin.generated'
import { glassSupportedOn, translucencySupportedOn } from '../translucency'
import { UPDATE_POLICY_OVERRIDE_FILE } from '../update-policy'
import {
  alreadyHasNoSandbox,
  buildNoSandboxRelaunchArgs,
  decideWindowsSandboxLaunch,
  fallbackMarker,
  grantAllApplicationPackagesAcl,
  readSandboxMarker,
  shouldAttemptAclRepair,
  shouldRelaunchForGpuSandboxCrash,
  writeSandboxMarker
} from '../windows-sandbox-fallback'
import { readWindowsUserEnvVar } from '../windows-user-env'

import { lateBound, sandboxState } from './state'

const USER_DATA_OVERRIDE = codePathEnv('HERMES_DESKTOP_USER_DATA_DIR') // iclone-seam: p7-env

if (USER_DATA_OVERRIDE) {
  const resolvedUserData = path.resolve(USER_DATA_OVERRIDE)
  fs.mkdirSync(resolvedUserData, { recursive: true })
  app.setPath('userData', resolvedUserData)
}

export const DEV_SERVER = codePathEnv('HERMES_DESKTOP_DEV_SERVER') // iclone-seam: p7-env
export const IS_PACKAGED = app.isPackaged || Boolean(codePathEnv('HERMES_DESKTOP_IS_PACKAGED')) // iclone-seam: p7-env

export function updatePolicyOverrideFile() {
  return path.join(app.getPath('userData'), UPDATE_POLICY_OVERRIDE_FILE)
}

export const IS_MAC = process.platform === 'darwin'
export const IS_WINDOWS = process.platform === 'win32'
export const IS_WSL = isWslEnvironment()
// Truthful macOS kernel major (Tahoe = 25). Product version lies (16 vs 26) per
// build SDK, so gate Tahoe workarounds on Darwin instead.
export const DARWIN_MAJOR = IS_MAC ? Number.parseInt(os.release(), 10) || 0 : 0
// Glass: macOS vibrancy, or Windows 11 22H2+ system backdrop. Computed once
// so the renderer, the persisted default, and every chat window agree.
export const GLASS_SUPPORTED = glassSupportedOn(process.platform, os.release())
// Clear rides setOpacity, a documented no-op on Linux, so neither mode works
// there and Settings drops the row entirely.
export const TRANSLUCENCY_SUPPORTED = translucencySupportedOn(process.platform)
export const APP_ROOT = app.getAppPath()

// Preload must be plain JS — Electron's sandbox can't run .ts, and tsx's
// ESM loader is broken on Electron 40's Node (ERR_INVALID_RETURN_PROPERTY_VALUE).
// Dev (`npm run dev`) and prod both load the esbuild output from dist/.
export const PRELOAD_PATH = path.join(APP_ROOT, 'dist', 'electron-preload.js')

// Remote displays (SSH X11 forwarding, VNC, RDP) make Chromium's GPU
// compositor flicker — accelerated layers can't be presented cleanly over the
// wire, so the window flashes during scroll/streaming/animation. Local
// Windows/macOS (and WSLg, which renders locally via vGPU) composite on the
// GPU and never see it. Fall back to software rendering when a remote display
// is detected; it's rock-steady over the wire and the CPU cost is negligible
// next to the connection's latency. Must run before app `ready` — these
// switches only apply pre-launch. Override with HERMES_DESKTOP_DISABLE_GPU
// (1/true → always disable, 0/false → keep GPU on).
export const REMOTE_DISPLAY_REASON = detectRemoteDisplay()

if (REMOTE_DISPLAY_REASON) {
  app.disableHardwareAcceleration()
  // Belt-and-suspenders for X11/VNC, where the Viz compositor can still glitch
  // with only --disable-gpu: force compositing onto the CPU too.
  app.commandLine.appendSwitch('disable-gpu-compositing')
  console.log(
    `[hermes] remote display detected (${REMOTE_DISPLAY_REASON}); disabling GPU hardware acceleration to prevent flicker`
  )
}

// Renderer debugging port. On for dev-server runs (`hgui` / `npm run dev`) so
// the CDP tooling in scripts/ can attach; never for a packaged build — see
// electron/dev-cdp.ts. Must run before app `ready` like the switches above;
// Chromium binds it at launch.
const DEV_CDP = resolveDevCdpPort({ env: process.env, isPackaged: IS_PACKAGED, devServer: DEV_SERVER })

if (DEV_CDP.port) {
  app.commandLine.appendSwitch('remote-debugging-port', String(DEV_CDP.port))
  // Loopback only. Chromium already defaults to 127.0.0.1, but say it out loud
  // so a future edit can't widen it by omission.
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  console.log(
    `[hermes] renderer debugging on http://127.0.0.1:${DEV_CDP.port} — anything that can reach it ` +
      'can run code in the renderer. HERMES_DESKTOP_CDP_PORT=off to disable.'
  )
} else {
  const why = describeDevCdpDecision(DEV_CDP)

  if (why) {
    console.warn(`[hermes] ${why}`)
  }
}

// WSLg: Chromium blocklists the Mesa vGPU → software compositing → typing lag.
// /dev/dxg means a real GPU is available; un-blocklist it. Skipped when a remote
// display already forced software (SSH'd-into-WSL).
if (IS_WSL && !REMOTE_DISPLAY_REASON && fs.existsSync('/dev/dxg')) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  console.log('[hermes] WSL GPU passthrough (/dev/dxg) detected; enabling GPU acceleration')
}

// Linux: point Chromium at the session's keychain backend so safeStorage can
// encrypt remote gateway tokens (hardening.ts refuses to persist them without
// it). The value arrives via HERMES_DESKTOP_PASSWORD_STORE, bridged by the
// `hermes desktop` launcher from detection or `desktop.password_store` in
// config.yaml. Must run before app `ready` — the switch only applies pre-launch.
const PASSWORD_STORE = resolveLinuxPasswordStore()

if (PASSWORD_STORE.warning) {
  console.warn(`[hermes] ${PASSWORD_STORE.warning}`)
}

if (PASSWORD_STORE.store) {
  app.commandLine.appendSwitch('password-store', PASSWORD_STORE.store)
  console.log(`[hermes] using password-store backend: ${PASSWORD_STORE.store}`)
}

if (IS_WINDOWS) {
  const windowsUserData = app.getPath('userData')
  const priorMarker = readSandboxMarker(windowsUserData)

  // Best-effort ACL repair, only when the last boot aborted or the fallback is
  // engaged — icacls /T recurses the whole install tree, so healthy launches
  // skip it (the installer already granted the ACE at install time). Repair
  // targets the install dir only: granting AppContainer read on userData would
  // expose Hermes sessions/config to every packaged app on the machine.
  if (shouldAttemptAclRepair(priorMarker)) {
    const exeDir = path.dirname(process.execPath)
    const acl = grantAllApplicationPackagesAcl(exeDir, { execFileSync })

    if (acl.ok) {
      console.log(`[hermes] granted ALL APPLICATION PACKAGES RX on ${exeDir} (#38216)`)
    } else if (acl.error && acl.error !== 'missing-target-or-exec') {
      console.warn(`[hermes] AppContainer ACL grant failed on ${exeDir}: ${acl.error}`)
    }
  }

  const sandboxDecision = decideWindowsSandboxLaunch({
    argv: process.argv,
    env: process.env,
    marker: priorMarker,
    appVersion: app.getVersion()
  })

  sandboxState.windowsSandboxFallbackActive = sandboxDecision.enable
  sandboxState.windowsSandboxFallbackSticky = sandboxDecision.nextMarker.state === 'fallback'

  if (sandboxDecision.nextMarker.state === 'fallback' && sandboxDecision.nextMarker.reason) {
    sandboxState.windowsSandboxFallbackReason = sandboxDecision.nextMarker.reason
  }

  if (sandboxDecision.enable && sandboxDecision.reason !== 'already-enabled') {
    app.commandLine.appendSwitch('no-sandbox')
    process.env.ELECTRON_DISABLE_SANDBOX = '1'
    console.log(
      `[hermes] Windows sandbox fallback enabled (${sandboxDecision.reason}); launching with --no-sandbox (#38216)`
    )
  }

  writeSandboxMarker(windowsUserData, sandboxDecision.nextMarker)

  // Catch the first GPU breakpoint death and relaunch before Chromium's
  // "GPU process isn't usable" FATAL abort ends the process with no recovery.
  app.on('child-process-gone', (_event, details) => {
    if (
      !shouldRelaunchForGpuSandboxCrash({
        details,
        alreadyNoSandbox: sandboxState.windowsSandboxFallbackActive || alreadyHasNoSandbox(process.argv, process.env),
        relaunchAttempted: sandboxState.windowsNoSandboxRelaunchAttempted
      })
    ) {
      return
    }

    sandboxState.windowsNoSandboxRelaunchAttempted = true
    sandboxState.windowsSandboxFallbackActive = true
    sandboxState.windowsSandboxFallbackSticky = true
    sandboxState.windowsSandboxFallbackReason = 'gpu-breakpoint'

    try {
      writeSandboxMarker(app.getPath('userData'), fallbackMarker('gpu-breakpoint', app.getVersion()))
    } catch {
      void 0
    }

    console.warn(
      `[hermes] Windows GPU sandbox crashed (exit=${details?.exitCode}); relaunching once with --no-sandbox (#38216)`
    )

    try {
      app.relaunch({ args: buildNoSandboxRelaunchArgs(process.argv.slice(1)) })
      void lateBound.exitAfterBackendShutdown(0)
    } catch (error) {
      console.error(`[hermes] --no-sandbox relaunch failed: ${errorMessage(error) || error}`)
    }
  })
}

// Keep the renderer's PROCESS priority normal while its windows are hidden —
// a deprioritized renderer streams a live answer visibly slower once the
// window is minimized. This switch only affects scheduling priority; it does
// not exempt timers from throttling and costs nothing at idle.
//
// The timer/rAF throttling story is deliberately NOT handled here anymore.
// The old process-wide `disable-background-timer-throttling` /
// `disable-backgrounding-occluded-windows` switches (plus a static
// `backgroundThrottling: false` on every chat window) pinned every renderer's
// `document.visibilityState` to 'visible' forever — which silently turned all
// the renderer's visibility-gated backstop polls and clock ticks into
// always-on timers. A completely idle, minimized Hermes burned ~20% CPU
// around the clock. Throttling is now a runtime dial scoped to streaming:
// see createStreamThrottle() — chat windows are unthrottled while any turn is
// in flight (so a live answer keeps painting while blurred, occluded, or
// minimized, exactly as before) and return to Chromium's default throttling
// once the work settles.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// Ruling 69: English only — the renderer's dates, numbers and money never follow the operating system's locale.
pinChromiumUiLocale(app.commandLine)

export const SOURCE_REPO_ROOT = path.resolve(APP_ROOT, '../..')

// Build-time install stamp -- the git ref this .exe was built against.
//
// Written by apps/desktop/scripts/write-build-stamp.mjs during `npm run build`
// and bundled into packaged apps via electron-builder's extraResources entry,
// so the runtime stamp ends up at process.resourcesPath/install-stamp.json
// after install. The bootstrap runner (Phase 1D) reads it to know which
// commit to clone when running install.ps1 stages at first launch.
//
// Returns null when the file is missing (dev runs from a checkout where
// build hasn't been invoked, or schema mismatch). Callers must handle null.
//
// Schema:
//   { schemaVersion: 1, commit, branch, builtAt, dirty, source }
const INSTALL_STAMP_SCHEMA_VERSION = 1

function loadInstallStamp() {
  // Try packaged location first (resources/install-stamp.json), then the
  // dev/local build output (apps/desktop/build/install-stamp.json) so
  // someone running `npm run start` after a local `npm run build` also
  // sees a stamp without needing a packaged build.
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'install-stamp.json') : null,
    path.join(APP_ROOT, 'build', 'install-stamp.json')
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw)

      if (parsed && typeof parsed === 'object' && typeof parsed.commit === 'string' && parsed.commit.length >= 7) {
        if (parsed.schemaVersion !== INSTALL_STAMP_SCHEMA_VERSION) {
          console.warn(
            `[hermes] install-stamp.json schemaVersion ${parsed.schemaVersion} != expected ${INSTALL_STAMP_SCHEMA_VERSION}; ignoring`
          )

          continue
        }

        return Object.freeze({
          schemaVersion: parsed.schemaVersion,
          commit: parsed.commit,
          branch: parsed.branch || null,
          builtAt: parsed.builtAt || null,
          dirty: Boolean(parsed.dirty),
          source: parsed.source || null,
          path: p
        })
      }
    } catch (e) {
      console.warn(`[hermes] install-stamp.json found at ${p} , but parsing failed with ${e}`)
      // Either ENOENT or malformed JSON; try the next candidate
    }
  }

  return null
}

export const INSTALL_STAMP = loadInstallStamp()

if (INSTALL_STAMP) {
  console.log(
    `[hermes] install stamp: ${INSTALL_STAMP.commit.slice(0, 12)}${INSTALL_STAMP.branch ? ` (${INSTALL_STAMP.branch})` : ''}${INSTALL_STAMP.dirty ? ' [DIRTY]' : ''} from ${INSTALL_STAMP.source || 'unknown'}`
  )
} else if (IS_PACKAGED) {
  // Dev builds without a stamp are normal; packaged builds without one
  // mean the bootstrap won't know what to clone. Surface clearly.
  console.error(
    '[hermes] WARNING: no install-stamp.json found in packaged build. First-launch bootstrap will not have a pinned ref to install.'
  )
}

// HERMES_HOME — the user-facing root for everything Hermes-related. Mirrors
// scripts/install.ps1's $HermesHome and scripts/install.sh's $HERMES_HOME.
//
// Defaults:
//   Windows: %LOCALAPPDATA%\hermes (matches install.ps1)
//   macOS / Linux: ~/.hermes (matches install.sh)
//
// Special case for Windows: if the user has a legacy ~/.hermes directory
// (e.g., from a prior pip install or a manual setup) AND no
// %LOCALAPPDATA%\hermes yet, prefer the legacy path so we don't orphan their
// existing config / sessions / .env. New installs go to %LOCALAPPDATA%.
//
// HERMES_DESKTOP_USER_DATA_DIR (used by test:desktop:fresh) puts the sandbox
// HERMES_HOME beneath the throwaway userData dir so a fresh-install run never
// touches the user's real ~/.hermes / %LOCALAPPDATA%\hermes.
function resolveHermesHome() {
  const homeOverride = codePathEnv('HERMES_HOME') // iclone-seam: p7-env

  if (homeOverride) {
    return normalizeHermesHomeRoot(homeOverride)
  }

  if (USER_DATA_OVERRIDE) {
    return path.join(path.resolve(USER_DATA_OVERRIDE), 'hermes-home')
  }

  if (IS_WINDOWS) {
    // A GUI app launched from Explorer inherits the environment block captured
    // at login, so a HERMES_HOME set via `setx` AFTER login is invisible in
    // process.env even though the CLI (a fresh shell) sees it. Without this the
    // backend silently falls back to %LOCALAPPDATA%\hermes and reports "No
    // inference provider configured" despite a valid configured home (#45471).
    // Consult the live User-scoped registry value before the default below.
    const fromRegistry = readWindowsUserEnvVar('HERMES_HOME')

    if (fromRegistry) {
      return normalizeHermesHomeRoot(fromRegistry)
    }
  }

  if (IS_WINDOWS && process.env.LOCALAPPDATA) {
    const localappdata = path.join(process.env.LOCALAPPDATA, 'hermes')
    const legacy = path.join(app.getPath('home'), '.hermes')

    // Migrate transparently to LOCALAPPDATA, but honour an existing legacy
    // ~/.hermes setup (no LOCALAPPDATA install yet) so users don't lose state.
    if (!directoryExists(localappdata) && directoryExists(legacy)) {
      return legacy
    }

    return localappdata
  }

  return path.join(app.getPath('home'), '.hermes')
}

export const HERMES_HOME = resolveHermesHome()
sealPackagedProcessEnv({ HERMES_HOME }) // iclone-seam: p7-env

export function pathWithHermesManagedNode(...entries: string[]) {
  const managed = hermesManagedNodePathEntries(HERMES_HOME).filter(directoryExists)

  return [...managed, ...entries, process.env.PATH].filter(Boolean).join(path.delimiter)
}

// ACTIVE_HERMES_ROOT — the canonical mutable Hermes install. Same path
// install.ps1 / install.sh use, so a desktop-only user and a CLI-only user end
// up with identical layouts and can share one install.
// V3-RT (lead ruling 36): a packaged app runs its OWN runtime from an app-owned folder,
// `<userData>/hermes-runtime/<artifact-sha256>` (iclone-runtime-location.ts, the resolver V3-S r4 exposes), never
// `~/.hermes/hermes-agent`: whatever sits there (a 0.0.2 install, the owner's own git checkout) is left untouched.
// HERMES_HOME stays `~/.hermes` (state, config, profiles); only the code moves. Dev keeps the shared layout.
export const LEGACY_HERMES_ROOT = path.join(HERMES_HOME, 'hermes-agent')
export const ACTIVE_HERMES_ROOT = IS_PACKAGED
  ? managedRuntimeRoot(app.getPath('userData'), RUNTIME_PIN.tarballSha256)
  : LEGACY_HERMES_ROOT
/**
 * V3-RT (ruling 36): everything the installer creates for the app's runtime stays inside its folder — uv, the pinned
 * Python, PM's store and the dependency environment live under this private home, given to the install stages that
 * create them (bootstrap-runner `privateDependencies`). Null in dev (the shared `~/.hermes` layout).
 */
export const RUNTIME_DEPS_HOME = IS_PACKAGED ? path.join(ACTIVE_HERMES_ROOT, '.iclone-deps') : null

/** The installer's private HOME and HERMES_HOME for the app's runtime (bootstrap-runner `privateDependencies`). */
export function runtimePrivateDependencies(): null | { hermesHome: string; home: string } {
  return RUNTIME_DEPS_HOME
    ? { hermesHome: path.join(RUNTIME_DEPS_HOME, 'hermes'), home: path.join(RUNTIME_DEPS_HOME, 'home') }
    : null
}

/**
 * K-RT2 (ruling 36): this packaged app is installing its own runtime for someone who already had one at
 * `~/.hermes/hermes-agent` (a previous release's, or their own checkout). That folder is left untouched; the install
 * runs without the first-run choice and says so once.
 */
export function isRuntimeUpgradeFromLegacy(): boolean {
  return IS_PACKAGED && directoryExists(LEGACY_HERMES_ROOT)
}

// VENV_ROOT — venv lives inside the repo, exactly like install.ps1 does it.
export const VENV_ROOT = path.join(ACTIVE_HERMES_ROOT, 'venv')

/** The venv the canonical install runs on: PM's committed environment, else the in-tree `venv` (VENV_ROOT). */
export function activeVenvRoot(): string {
  return (
    pmCommittedVenv(ACTIVE_HERMES_ROOT, RUNTIME_DEPS_HOME ? path.join(RUNTIME_DEPS_HOME, 'hermes') : HERMES_HOME) ??
    VENV_ROOT
  )
}

// Mirrors hermes_cli.profiles._PROFILE_ID_RE so we never hand the backend a
// value its profile resolver would reject and exit on.
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Branch we track for self-update. The GUI work has merged to main, so this
// tracks main. User can also override at runtime via
// hermesDesktop.updates.setBranch().
export const DEFAULT_UPDATE_BRANCH = 'main'
// Automated teardown (Playwright's app.close(), harness scripts) quits with
// nobody to answer a modal, so the active-work confirmation would hang the
// caller instead of letting the process exit. Force quits set this.
export const SKIP_QUIT_CONFIRM = process.env.HERMES_DESKTOP_SKIP_QUIT_CONFIRM === '1'

export const APP_NAME = process.env.HERMES_DESKTOP_APP_NAME || 'iclone os'

export function fileExists(filePath: string) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function directoryExists(filePath: string) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

export function unpackedPathFor(filePath: string) {
  return filePath.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked')
}

export function isHermesSourceRoot(root: string) {
  return directoryExists(root) && fileExists(path.join(root, 'hermes_cli', 'main.py'))
}

// Match the backend's source resolution but bias toward a real git checkout.
// Dev → SOURCE_REPO_ROOT. Packaged/CLI install → ACTIVE_HERMES_ROOT.
// HERMES_DESKTOP_HERMES_ROOT always wins so devs can pin a worktree.
export function resolveUpdateRoot() {
  const overrideRoot = codePathEnv('HERMES_DESKTOP_HERMES_ROOT') // iclone-seam: p7-env

  const candidates = [
    overrideRoot && path.resolve(overrideRoot),
    !IS_PACKAGED && isHermesSourceRoot(SOURCE_REPO_ROOT) ? SOURCE_REPO_ROOT : null,
    isHermesSourceRoot(ACTIVE_HERMES_ROOT) ? ACTIVE_HERMES_ROOT : null
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find(c => directoryExists(path.join(c, '.git'))) || candidates[0] || ACTIVE_HERMES_ROOT
}
