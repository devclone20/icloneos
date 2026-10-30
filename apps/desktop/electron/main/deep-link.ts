// Deep links (iclone:// and hermes://) and their IPC.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { deepLinkSchemes } from '../iclone-app-update'

import { DEV_SERVER } from './env'
import { rememberLog } from './log'
import type { deepLinkState, windowsState } from './state'

interface DeepLinkIpcDeps {
  deepLinkState: typeof deepLinkState
  windowsState: typeof windowsState
}

// ---------------------------------------------------------------------------
// hermes:// deep links (e.g. hermes://blueprint/morning-brief?time=08:00,
// hermes://mcp/install?name=NAME&config=B64 — the vendor "Add to Hermes"
// button, or hermes://plugin/install?repo=owner/repo). Dev
// (`HERMES_DESKTOP_DEV_SERVER`) registers hermes-dev:// instead — bare
// Electron or a stale OS handler often owns hermes:// on dev machines.
// Parsing is generic ({kind, name, params}); the renderer routes per kind
// and anything install-shaped requires explicit user confirmation there.
// A docs/dashboard "Send to App" button opens this URL; we route it into the
// running app. Three delivery paths: macOS 'open-url',
// Win/Linux running-app 'second-instance' (argv), Win/Linux cold-start argv.
// ---------------------------------------------------------------------------
// iclone-seam: p7-url-scheme
const ICLONE_DEEPLINK = deepLinkSchemes(app.isPackaged, Boolean(DEV_SERVER))
const HERMES_PROTOCOL = ICLONE_DEEPLINK.register
/** Schemes accepted when parsing inbound URLs (dev accepts both). */
const DEEPLINK_SCHEMES = ICLONE_DEEPLINK.accept
let _pendingDeepLink: { kind: string; name: string; params: Record<string, string> } | null = null

export function _extractDeepLink(argv: unknown) {
  if (!Array.isArray(argv)) {
    return null
  }

  return argv.find(a => typeof a === 'string' && DEEPLINK_SCHEMES.some(s => a.startsWith(`${s}://`))) || null
}

export function handleDeepLink(
  { deepLinkState, windowsState }: Pick<DeepLinkIpcDeps, 'deepLinkState' | 'windowsState'>,
  url: string
) {
  if (!url || typeof url !== 'string') {
    return
  }

  let parsed

  try {
    parsed = new URL(url)
  } catch {
    rememberLog(`[deeplink] ignoring malformed url: ${url}`)

    return
  }

  const scheme = parsed.protocol.replace(/:$/, '')

  if (!DEEPLINK_SCHEMES.includes(scheme)) {
    rememberLog(`[deeplink] ignoring scheme ${scheme} (expected ${DEEPLINK_SCHEMES.join(' or ')})`)

    return
  }

  // hermes://blueprint/<key>?slot=val  -> host="blueprint", path="/<key>"
  const kind = parsed.hostname || ''
  const name = decodeURIComponent((parsed.pathname || '').replace(/^\//, ''))
  const params: Record<string, string> = {}
  parsed.searchParams.forEach((v, k) => {
    params[k] = v
  })
  const payload = { kind, name, params }

  if (!deepLinkState._rendererReadyForDeepLink || !windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
    _pendingDeepLink = payload

    return
  }

  try {
    if (windowsState.mainWindow.isMinimized()) {
      windowsState.mainWindow.restore()
    }

    windowsState.mainWindow.focus()
    windowsState.mainWindow.webContents.send('hermes:deep-link', payload)
    rememberLog(`[deeplink] delivered ${kind}/${name}`)
  } catch (err) {
    rememberLog(`[deeplink] delivery failed: ${errorMessage(err)}`)
  }
}

/**
 * K144 — which copy may claim the `iclone://` scheme. LaunchServices keeps ONE handler per scheme; every packaged copy
 * that registered on launch (a lab pack, a trial build, a DMG still mounted) re-pointed it, so deep links could open a
 * stale copy. On macOS only the INSTALLED RELEASE app claims it: a bundle whose folder is /Applications or
 * ~/Applications AND whose own Info.plist declares the scheme. The first layer is the build itself (K144 r2,
 * scripts/build-identity.mjs): only the release pipeline packs `io.cloneframe.icloneos` with `iclone` in
 * CFBundleURLTypes; every other pack has its own bundle id and no scheme, so a dev pack installed with `install:mac`
 * never claims it either. Dev builds register their own scheme (hermes / hermes-dev) and are unaffected; other
 * platforms keep registering (their installers own the association).
 */
export function protocolClaimDecision({
  execPath,
  home,
  platform,
  scheme,
  bundleSchemes
}: {
  execPath: string
  home: string
  platform: string
  scheme: string
  /** The URL schemes the bundle's own Info.plist declares (null when it cannot be read). */
  bundleSchemes: (bundle: string) => readonly string[] | null
}): { register: boolean; why: string } {
  if (platform !== 'darwin' || scheme !== 'iclone') {
    return { register: true, why: 'not the packaged macOS scheme' }
  }

  // …/<Name>.app/Contents/MacOS/<exe> → the folder that holds the bundle.
  const bundle = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/)?.[1]

  if (!bundle) {
    return { register: false, why: 'not running from an .app bundle' }
  }

  const folder = path.posix.dirname(bundle)
  const installed = ['/Applications', path.posix.join(home.replace(/\/+$/, '') || '/', 'Applications')]

  if (!installed.includes(folder)) {
    return { register: false, why: 'this copy is not the installed app (/Applications or ~/Applications)' }
  }

  if (!bundleSchemes(bundle)?.includes(scheme)) {
    return { register: false, why: `this build does not declare ${scheme}:// (a non-release pack)` }
  }

  return { register: true, why: 'installed release copy' }
}

/** CFBundleURLSchemes of `<bundle>/Contents/Info.plist` (XML, as electron-builder writes it); null if unreadable. */
export function readBundleUrlSchemes(bundle: string): string[] | null {
  let plist: string

  try {
    plist = readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return null
  }

  if (!plist.includes('<plist')) {
    return null
  }

  const schemes: string[] = []

  for (const [, array] of plist.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g)) {
    for (const [, value] of array.matchAll(/<string>([^<]*)<\/string>/g)) {
      schemes.push(value.trim())
    }
  }

  return schemes
}

export function registerDeepLinkProtocol() {
  const claim = protocolClaimDecision({
    execPath: process.execPath,
    home: app.getPath('home'),
    platform: process.platform,
    scheme: HERMES_PROTOCOL,
    bundleSchemes: readBundleUrlSchemes
  })

  if (!claim.register) {
    // Inbound links still work in this copy when the OS hands them over; it only stops claiming the scheme.
    rememberLog(`[deeplink] not registering ${HERMES_PROTOCOL}:// handler: ${claim.why}`)

    return
  }

  try {
    if (process.defaultApp && process.argv.length >= 2) {
      // Dev: register with the electron exec path + entry script so the OS can
      // relaunch us with the URL. argv[1] is usually "." when launched via
      // `electron .` from apps/desktop — resolve against cwd.
      const entry = path.resolve(process.argv[1])
      app.setAsDefaultProtocolClient(HERMES_PROTOCOL, process.execPath, [entry])
    } else {
      app.setAsDefaultProtocolClient(HERMES_PROTOCOL)
    }

    rememberLog(`[deeplink] registered ${HERMES_PROTOCOL}:// handler`)
  } catch (err) {
    rememberLog(`[deeplink] protocol registration failed: ${errorMessage(err)}`)
  }
}

export function registerDeepLinkIpc({ deepLinkState, windowsState }: DeepLinkIpcDeps): void {
  // Renderer calls this (via IPC) once it has mounted its deep-link listener, so
  // a link that arrived during boot/install is flushed exactly once.
  ipcMain.handle('hermes:deep-link-ready', () => {
    deepLinkState._rendererReadyForDeepLink = true

    if (_pendingDeepLink) {
      const queued = _pendingDeepLink
      _pendingDeepLink = null
      handleDeepLink(
        { deepLinkState, windowsState },
        `${HERMES_PROTOCOL}://${queued.kind}/${encodeURIComponent(queued.name)}` +
          (Object.keys(queued.params).length ? '?' + new URLSearchParams(queued.params).toString() : '')
      )
    }

    return { ok: true }
  })
}
