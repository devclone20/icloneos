// X1b: the one way a link the user clicks in an app window reaches the system browser.
//
// The window-open handler of every app window denies (app-window-open-policy.ts), so a link that asks for a new
// window — `target="_blank"`, a ⌘/Ctrl/⇧-click, a middle-click — would do nothing. This router, installed by the
// preload in the app's own document (the preload never runs in sub-frames), turns a REAL click on such a link into
// `hermes:openExternal`. `isTrusted` is false for every click a script dispatches, and a click inside an `<iframe>` is
// dispatched in the iframe's document, never this one — so an artifact, an embed or a page script cannot use it.
// A component that opens its own links (lib/external-link.tsx ExternalLink, the terminal) calls preventDefault, and
// the router stands aside: it decides after the whole dispatch. X1c: a plain click on a same-window link is routed
// too — main cancels every main-frame navigation that leaves the app (app-navigation-policy.ts), so this real click
// is the link's only way out. A link to the app's own document (a `#/route`, the same index) is the app's and is
// never routed.

const ROUTED_PROTOCOLS = new Set(['file:', 'http:', 'https:', 'mailto:'])

export interface RoutedClickLike {
  type: string
  button: number
  isTrusted: boolean
  defaultPrevented: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  target: unknown
}

interface AnchorLike {
  href: string
  target: string
}

interface ClosestCapable {
  closest(selector: string): unknown
}

function anchorOf(target: unknown): AnchorLike | null {
  if (!target || typeof (target as ClosestCapable).closest !== 'function') {
    return null
  }

  const anchor = (target as ClosestCapable).closest('a[href]') as AnchorLike | null

  return anchor && typeof anchor.href === 'string' ? anchor : null
}

/** Same scheme, host and path as the document the click happened in: an in-app link (any query or hash). */
function isAppDocument(url: URL, documentUrl: string): boolean {
  try {
    const current = new URL(documentUrl)

    return url.protocol === current.protocol && url.host === current.host && url.pathname === current.pathname
  } catch {
    return false
  }
}

/** Targets that keep the click in this window's main frame (or ask for a new one): the router owns those clicks. */
const ROUTED_TARGETS = new Set(['', '_blank', '_parent', '_self', '_top'])

/** The URL a real click asks to open outside the app, or null when the click is not that. */
export function externalLinkTarget(event: RoutedClickLike, documentUrl: string): null | string {
  if (!event.isTrusted) {
    return null
  }

  const primary = event.type === 'click' && event.button === 0
  const middle = event.type === 'auxclick' && event.button === 1

  if (!primary && !middle) {
    return null
  }

  const anchor = anchorOf(event.target)

  if (!anchor) {
    return null
  }

  const elsewhere = middle || event.metaKey || event.ctrlKey || event.shiftKey

  // A named target (an iframe's name) navigates that frame, not this window.
  if (!elsewhere && !ROUTED_TARGETS.has(anchor.target.toLowerCase())) {
    return null
  }

  let url: URL

  try {
    url = new URL(anchor.href)
  } catch {
    return null
  }

  if (!ROUTED_PROTOCOLS.has(url.protocol) || isAppDocument(url, documentUrl)) {
    return null
  }

  return url.toString()
}

export interface RouterTarget {
  addEventListener(type: 'auxclick' | 'click', listener: (event: RoutedClickLike) => void, capture: boolean): void
}

export function installExternalLinkRouter(
  target: RouterTarget,
  open: (url: string) => void,
  documentUrl: () => string,
  later: (run: () => void) => void = run => void setTimeout(run, 0)
): void {
  const onActivate = (event: RoutedClickLike) => {
    const url = externalLinkTarget(event, documentUrl())

    if (!url) {
      return
    }

    later(() => {
      if (!event.defaultPrevented) {
        open(url)
      }
    })
  }

  target.addEventListener('click', onActivate, true)
  target.addEventListener('auxclick', onActivate, true)
}
