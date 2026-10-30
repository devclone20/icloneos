import { type AppView, isOverlayView } from '@/app/routes'

import { TITLEBAR_HEIGHT } from './titlebar'

/** Height of the window-drag band at the top of the main window: the old
 *  titlebar row's height, so every surface below keeps its geometry. */
export const WINDOW_DRAG_BAND_PX = TITLEBAR_HEIGHT

/** How much of the upstream pane layout a user may reach, in one window:
 *  - `covered` — OUR home stage covers it (home and every overlay view over
 *    home, main window only): the whole layout is inert and hidden from
 *    assistive tech.
 *  - `chat` — the chat route in the main window: OUR Message window shows the
 *    chat surface, so only that surface stays live; every other pane and tab
 *    strip is sealed.
 *  - `live` — plugin pages (they own the workspace outright) and auxiliary
 *    windows (HUD, popped-out browser, secondary), where the layout is the
 *    visible surface. */
type LegacyShellMode = 'chat' | 'covered' | 'live'

export function legacyShellMode(view: AppView, auxiliary: boolean): LegacyShellMode {
  if (auxiliary) {
    return 'live'
  }

  if (view === 'home' || isOverlayView(view)) {
    return 'covered'
  }

  return view === 'chat' ? 'chat' : 'live'
}

const NON_RENDERING = new Set(['SCRIPT', 'STYLE', 'TEMPLATE'])

/**
 * Seals every subtree of `root` that does not hold `keep`: walking up from
 * `keep`, each sibling off that path becomes inert and aria-hidden, so Tab and
 * screen readers reach only `keep`. With `keep` null (or outside `root`) every
 * child of `root` is sealed. Elements already inert are left alone. Returns
 * the undo, which restores exactly the attributes it changed.
 */
export function sealAllBut(root: Element, keep: Element | null): () => void {
  const sealed: { el: Element; ariaHidden: string | null }[] = []

  const seal = (el: Element) => {
    if (NON_RENDERING.has(el.tagName) || el.hasAttribute('inert')) {
      return
    }

    sealed.push({ el, ariaHidden: el.getAttribute('aria-hidden') })
    el.setAttribute('inert', '')
    el.setAttribute('aria-hidden', 'true')
  }

  if (!keep || keep === root || !root.contains(keep)) {
    Array.from(root.children).forEach(seal)
  } else {
    for (let node = keep; node !== root && node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node) {
          seal(sibling)
        }
      }
    }
  }

  return () => {
    for (const { el, ariaHidden } of sealed) {
      el.removeAttribute('inert')

      if (ariaHidden === null) {
        el.removeAttribute('aria-hidden')
      } else {
        el.setAttribute('aria-hidden', ariaHidden)
      }
    }
  }
}
