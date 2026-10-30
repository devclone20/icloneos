// X1c: an app window only ever shows the app.
//
// The app's windows load the renderer index (or the dev server) with the preload, which exposes the whole
// `hermesDesktop` bridge to whatever document the main frame holds. Before X1c, `will-navigate` let the main frame go
// to ANY `file:` URL in a packaged build — a link in model-written HTML (`<a target="_self" href="file:…">`) or a
// `location.href` would put a local page the model wrote into an app window, with the preload and the bridge. Now a
// main-frame navigation or redirect is allowed only to the app itself (ipc-sender-guard.ts isAppRendererUrl: the
// renderer index file, any query or hash, or the dev server origin); everything else is cancelled and opens nothing.
// A link the user really clicks reaches the OS through the preload's router (external-link-router.ts), never here.

import { isAppRendererUrl } from './ipc-sender-guard'

export interface AppNavigationGuardOptions {
  devServer?: string
  rendererIndexPath: () => string
  log: (line: string) => void
}

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'invalid'
  }
}

export interface NavigationEventLike {
  preventDefault(): void
  /** Where the frame is going (Electron 40 puts it on the event; the positional `url` argument is deprecated). */
  url: string
  isMainFrame: boolean
}

/** The `will-navigate` / `will-redirect` listener every app window installs (main/windows.ts). Sub-frames (an embed,
 *  an artifact iframe) are not the app window and hold no preload: their navigations and redirects are theirs. */
export function createAppNavigationGuard({ devServer, rendererIndexPath, log }: AppNavigationGuardOptions) {
  return (event: NavigationEventLike): void => {
    if (!event.isMainFrame || isAppRendererUrl(event.url, devServer, devServer ? '' : rendererIndexPath())) {
      return
    }

    event.preventDefault()
    log(`[link] blocked app window navigation: ${schemeOf(event.url)}`)
  }
}
