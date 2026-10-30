// Hidden BrowserWindow used by tier-2 link-title resolution: when curl can't
// read a page <title> (bot walls, JS-rendered pages), we briefly load the URL
// in an offscreen window and read its title. That window loads arbitrary
// user-linked pages, so it must never emit sound or trigger real downloads.

export function linkTitleWindowOptions<S>(partitionSession: S) {
  return {
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // Deliberately throttled: this hidden window loads arbitrary user-linked
      // pages, and an unthrottled heavy page burns full CPU for the window's
      // whole lifetime. Title resolution rides load events
      // (page-title-updated / did-finish-load) plus main-process timers, none
      // of which the renderer clamp touches — hidden-page throttling only
      // slows the page's own timer-driven JS, and the grace window already
      // absorbs that.
      contextIsolation: true,
      javascript: true,
      nodeIntegration: false,
      sandbox: true,
      session: partitionSession,
      webSecurity: true
    }
  }
}

// Create the offscreen title-fetch window, deny it every popup and immediately
// mute it. Without the mute, autoplaying media on the loaded page (e.g. a
// YouTube link) leaks ~2s of audio every time a session containing such links
// is re-rendered. See #49505.
/** The slice of a title-fetch window this module touches; the constructor is injected so tests pass fakes. */
interface TitleFetchWindow {
  webContents: {
    setAudioMuted(muted: boolean): void
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  }
}

/** A session that can veto downloads (Electron's Session; tests pass fakes). */
interface DownloadGuardSession {
  on(event: 'will-download', listener: (event: unknown, item: { cancel(): void }) => void): unknown
}

export function createLinkTitleWindow<W extends TitleFetchWindow, S>(
  BrowserWindow: new (options: ReturnType<typeof linkTitleWindowOptions<S>>) => W,
  partitionSession: S
): W {
  const window = new BrowserWindow(linkTitleWindowOptions(partitionSession))

  // X1: the page is arbitrary. Without a handler Electron 40 lets it open visible
  // BrowserWindows: by window.open in this partition, and by a synthetic
  // ctrl/meta-click in the DEFAULT session (the app's own microphone policy).
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  } catch {
    // webContents unavailable (degraded/headless): loadURL fails too and the
    // caller finishes with an empty title.
  }

  try {
    window.webContents.setAudioMuted(true)
  } catch {
    // webContents may be unavailable in degraded/headless environments; muting
    // is best-effort and the window is destroyed within a few seconds anyway.
  }

  return window
}

// Cancel any download the title-fetch window triggers. Without this, a link
// artifact URL served with Content-Disposition: attachment auto-downloads every
// time the Artifacts page renders and fetchLinkTitle loads it.
export function guardLinkTitleSession(partitionSession: DownloadGuardSession) {
  try {
    partitionSession.on('will-download', (_event, item) => item.cancel())
  } catch {
    // best-effort; worst case is a spurious download
  }
}

// Read the page title from a title-fetch window. Callers schedule this from
// timers that can fire after finish() destroys the window, so every access must
// guard isDestroyed and swallow Electron's "Object has been destroyed" throws.
interface TitledWindow {
  isDestroyed(): boolean
  webContents?: { isDestroyed(): boolean; getTitle(): string } | null
}

export function readLinkTitleWindowTitle(window: TitledWindow | null | undefined) {
  try {
    if (!window || window.isDestroyed()) {
      return ''
    }

    const contents = window.webContents

    if (!contents || contents.isDestroyed()) {
      return ''
    }

    return contents.getTitle() || ''
  } catch {
    return ''
  }
}
