// Every chat window enables `webviewTag` (session-windows.ts) for the preview
// pane. A renderer compromise could otherwise attach a <webview> with its own
// preload, Node integration, or the app's own session. This guard runs on every
// attach, whoever the embedder is, and pins the guest to what the preview pane
// actually needs.

import type { App, Session } from 'electron'

export const PREVIEW_PARTITION = 'persist:hermes-preview'

const LOG_TAG = '[iclone-webview-guard]'

const HTML_FILE_RE = /\.x?html?$/i

// Same loopback set as the preview pane's LOOPBACK_HOST_RE (preview-pane.tsx).
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i

type WebviewAttachDecision = { allow: true } | { allow: false; reason: string }

interface WebviewWebPreferences {
  [key: string]: unknown
}

interface WebviewParams {
  [key: string]: string | undefined
}

// https is the general case. Plain http is accepted only for loopback (the
// preview of a local dev server) and file: only for HTML documents (local HTML
// previews), never for an arbitrary local file; all stay inside the sandboxed
// preview partition.
export function isAllowedWebviewSrc(src: string | undefined): boolean {
  if (!src || src === 'about:blank') {
    return true
  }

  let url: URL

  try {
    url = new URL(src)
  } catch {
    return false
  }

  if (url.protocol === 'https:') {
    return true
  }

  if (url.protocol === 'http:') {
    return LOOPBACK_HOST_RE.test(url.hostname) || url.hostname.endsWith('.localhost')
  }

  return url.protocol === 'file:' && HTML_FILE_RE.test(url.pathname)
}

export function hardenWebviewAttach(
  webPreferences: WebviewWebPreferences,
  params: WebviewParams
): WebviewAttachDecision {
  const requestedPartition = params.partition || (webPreferences.partition as string | undefined)

  if (requestedPartition && requestedPartition !== PREVIEW_PARTITION) {
    return { allow: false, reason: `partition ${JSON.stringify(String(requestedPartition).slice(0, 64))}` }
  }

  if (!isAllowedWebviewSrc(params.src)) {
    return { allow: false, reason: `src scheme ${schemeOf(params.src)}` }
  }

  delete webPreferences.preload
  delete webPreferences.preloadURL
  webPreferences.partition = PREVIEW_PARTITION
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.experimentalFeatures = false
  delete webPreferences.enableBlinkFeatures

  return { allow: true }
}

function schemeOf(src: string | undefined): string {
  try {
    return new URL(String(src)).protocol
  } catch {
    return 'invalid'
  }
}

type PreviewSessionLike = Pick<Session, 'webRequest'>

// will-attach-webview only sees the first src. The guest can later be sent
// anywhere (embedder loadURL, redirects, link clicks), so every top-level
// document load in the preview partition passes the same allowlist.
export function guardPreviewNavigation(previewSession: PreviewSessionLike, log: (line: string) => void): void {
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    const cancel = details.resourceType === 'mainFrame' && !isAllowedWebviewSrc(details.url)

    if (cancel) {
      log(`${LOG_TAG} blocked preview navigation: ${schemeOf(details.url)}`)
    }

    callback({ cancel })
  })
}

export function installWebviewGuard(
  app: App,
  log: (line: string) => void,
  previewSession?: () => PreviewSessionLike
): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const decision = hardenWebviewAttach(webPreferences as WebviewWebPreferences, params)

      if ('reason' in decision) {
        event.preventDefault()
        log(`${LOG_TAG} denied <webview> attach: ${decision.reason}`)
      }
    })

    // X1/X1b: no web content opens a window by default. Electron's own default for a webContents with no handler is
    // to build a visible, unguarded BrowserWindow (the guest's land in the DEFAULT session, whose microphone policy is
    // the app's own), and Electron 40 skips the missing-`allowpopups` check on the OpenURL path (a synthetic
    // ctrl/meta- or middle-click). So EVERY webContents gets a deny here, at creation: a <webview> guest, the hidden
    // link-title page, the gateway/portal sign-in windows (main/oauth.ts, main/portal.ts) and any window added later.
    // 'web-contents-created' fires inside the BrowserWindow constructor, before the caller can call
    // setWindowOpenHandler, so an app surface that installs its own handler afterwards (windows.ts
    // wireCommonWindowHandlers, iclone-privy.ts confinePrivyWindow) replaces this default; one that installs none keeps
    // it. A plain click keeps navigating the page in place.
    const kind = contents.getType()

    contents.setWindowOpenHandler(details => {
      log(`${LOG_TAG} denied window from <${kind}>: ${schemeOf(details.url)}`)

      return { action: 'deny' }
    })
  })

  if (previewSession) {
    void app.whenReady().then(() => guardPreviewNavigation(previewSession(), log))
  }

  log(`${LOG_TAG} installed`)
}
