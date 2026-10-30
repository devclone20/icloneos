// App identity and process-wide guards installed before ready: name, app icon, about panel, privileged schemes, crash forensics.
import fs from 'node:fs'
import path from 'node:path'

import { app, protocol, session } from 'electron'

import { appIconCandidates, resolveAppIcon } from '../app-icon'
import { installCrashForensics } from '../crash-forensics'
import { APP_COPYRIGHT, readRuntimeVersion, versionLine } from '../iclone-app-update'
import { gateWebSessionsByConsent } from '../iclone-consent'
import { MEDIA_PROTOCOL } from '../media-protocol'
import { installWebviewGuard, PREVIEW_PARTITION } from '../webview-guard'

import { APP_NAME, APP_ROOT, fileExists, IS_WINDOWS, resolveUpdateRoot, unpackedPathFor } from './env'
import { flushDesktopLogBufferSync, rememberLog } from './log'

export function getAppIconPath() {
  // Fail-soft: skip candidates that exist but don't decode (truncated PNG in a
  // packaged app.asar previously crashed createWindow mid-session). Missing
  // every candidate is fine — the window then uses the platform default icon.
  try {
    return resolveAppIcon(APP_ICON_PATHS)
  } catch {
    return undefined
  }
}

// Right-edge window-control reservation lives in titlebar-overlay-width.ts
// (pure + unit-testable); computeNativeOverlayWidth() applies it per platform.
// It's only the pre-layout fallback — the renderer measures the exact overlay
// width live via the Window Controls Overlay API.
// The apple-touch PNG bakes in the macOS-style ~10% margin, which is correct
// for the dock but renders visibly smaller than neighboring taskbar icons on
// Windows, where icons are full-bleed. Windows prefers the full-bleed
// assets/icon.ico (shipped to resources/ via extraResources) and only falls
// back to the padded PNG if the ico is missing.
// The ladder is BUILT once here but each window factory RE-RESOLVES through
// resolveAppIcon (decoding probe): existence alone is not proof the bytes
// decode, and an undecodable icon must never take the main process down.
const APP_ICON_PATHS = appIconCandidates({
  isWindows: IS_WINDOWS,
  appRoot: APP_ROOT,
  resourcesPath: process.resourcesPath,
  unpackedPathFor
})

app.setName(APP_NAME)

// Windows toast notifications silently no-op unless an AppUserModelID is set:
// `new Notification().show()` returns without error and nothing appears. The
// AUMID must match the installed Start Menu shortcut's AUMID, which
// electron-builder derives from the build `appId` (com.nousresearch.hermes) —
// keep this string in sync with package.json `build.appId`. macOS/Linux don't
// need this, so gate it on Windows. (Fixes: desktop approval/turn notifications
// never firing on Windows.)
if (IS_WINDOWS) {
  app.setAppUserModelId('io.cloneframe.icloneos')
}

// Seed the native About panel with the live Hermes version. This is refreshed
// on every open via the explicit "About" menu handler (refreshAboutPanel), so
// an in-place `hermes update` mid-session is reflected without an app restart;
// the seed here just covers the first open and any non-menu invocation path.
// iclone-seam: p7-version
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: icloneVersionLine(),
  copyright: APP_COPYRIGHT
})

// Custom scheme for streaming audio/video into the renderer. Local paths read
// from this machine; remote paths are proxied through the configured gateway
// with main-process authentication. This avoids whole-file data URLs and keeps
// playback seekable and Range-aware. Must be registered before app readiness.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true
    }
  }
])

installCrashForensics({ flush: flushDesktopLogBufferSync, log: rememberLog })
installWebviewGuard(app, rememberLog, () => session.fromPartition(PREVIEW_PARTITION)) // iclone-seam: p7-webview
// Every later session (preview <webview>, OAuth, embeds) declines mic/notifications the user switched off; owners that set
// their own handlers afterwards keep them (defaultSession in installMediaPermissions, Privy deny-all).
gateWebSessionsByConsent(app)

// iclone-seam: p7-version
export function icloneRuntimeVersion() {
  try {
    return readRuntimeVersion(resolveUpdateRoot())
  } catch {
    return null
  }
}

export function icloneVersionLine() {
  return versionLine(app.getVersion(), icloneRuntimeVersion())
}

// Resolve the canonical Hermes version (the one `release.py` bumps in
// hermes_cli/__init__.py + pyproject.toml) so the desktop About panel shows the
// real Hermes version instead of the Electron app's own package.json version,
// which historically drifted (stuck at 0.0.2). Falls back to app.getVersion()
// when the source tree can't be read (e.g. a packaged build without the repo).
function resolveHermesVersion() {
  try {
    const root = resolveUpdateRoot()
    const initPath = path.join(root, 'hermes_cli', '__init__.py')

    if (fileExists(initPath)) {
      const raw = fs.readFileSync(initPath, 'utf8')
      const match = raw.match(/__version__\s*=\s*["']([^"']+)["']/)

      if (match) {
        return match[1]
      }
    }
  } catch {
    // Fall through to the Electron app version below.
  }

  return app.getVersion()
}
