// X1b: what an app window does when its page content asks for a new window.
//
// Nothing. A window request reaches setWindowOpenHandler from ANY frame of the window — the app's own document, a
// model-generated artifact in `<iframe sandbox="allow-scripts">`, a third-party embed — and Electron 40.10.2 hands it
// over even when the frame lacks `allow-popups` and no gesture happened (GHSA-9f4c-93c8-jc8g: a synthetic ctrl/meta- or
// middle-click takes the OpenURL path). The handler cannot tell those frames apart (the details carry no frame), so it
// can never be the route to the system browser. That route is `hermes:openExternal`, reached only by the app's own
// document: the preload's link router (external-link-router.ts) for a real click on a link, and the renderer's
// `openExternalLink` for the app's buttons, behind the app sender guard (main/window-ipc.ts).

export interface WindowOpenRequestLike {
  url: string
  disposition?: string
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'invalid'
  }
}

/** The handler every app window installs (main/windows.ts wireCommonWindowHandlers). Logs only the scheme. */
export function createAppWindowOpenHandler(log: (line: string) => void) {
  return (details: WindowOpenRequestLike): { action: 'deny' } => {
    log(`[link] denied window request from page content: ${schemeOf(details.url)} ${details.disposition ?? 'default'}`)

    return { action: 'deny' }
  }
}
