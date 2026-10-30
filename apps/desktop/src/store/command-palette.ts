import { atom } from 'nanostores'

import { releaseTypingFocus } from '@/components/ui/keyboard-first'

/** Whether the global command palette (Cmd/Ctrl+K) is currently open. */
export const $commandPaletteOpen = atom(false)

/** Optional nested page to open when the palette next opens (e.g. `theme`). */
export const $commandPalettePage = atom<string | null>(null)

/** Optional search text to prefill when the palette next opens (type-to-search
 *  from a surface: the keystroke that opened the palette must not be lost). */
export const $commandPaletteSeed = atom<string | null>(null)

// The element that had focus when the palette opened. Restored by
// `restoreCommandPaletteFocus` once the sheet has UNMOUNTED: restoring on
// close raced the exit animation (the search input was still mounted, so the
// composer release saw an editable target and skipped — focus fell to <body>).
let opener: Element | null = null

// Whether the close came from an item that ran (a route, a dialog, a toggle)
// rather than a dismissal (Esc, backdrop). Only a ran action may have claimed
// focus for a surface it opened; a dismissal always hands focus back.
let closedByAction = false

// One restore per close. The sheet's `animationend` AND its fallback timer
// both retire the body; the second pass found no opener, released typing
// focus and handed the composer what the first had just given back to the
// opener (lab 2 r2: Model pill → ⌘K → Esc → composer).
let restorePending = false

function captureOpener(): void {
  opener = typeof document === 'undefined' ? null : document.activeElement
  closedByAction = false
}

export function openCommandPalette(): void {
  captureOpener()
  $commandPaletteOpen.set(true)
}

/** Open the palette directly on a nested page (`theme`, `settings`, …). */
export function openCommandPalettePage(page: string, seed?: string): void {
  captureOpener()
  $commandPalettePage.set(page)

  if (seed) {
    $commandPaletteSeed.set(seed)
  }

  $commandPaletteOpen.set(true)
}

function setOpen(open: boolean): void {
  $commandPaletteOpen.set(open)

  if (!open) {
    $commandPalettePage.set(null)
    $commandPaletteSeed.set(null)
    restorePending = true
  }
}

/**
 * Hand focus back after the sheet unmounts: to the element that opened the
 * palette whenever it is still in the document — the iT textarea, a toolbar
 * button, a dock tile, the composer — never to <body> and never to the
 * composer by default. Only when the opener is gone does the typing-focus
 * release pick a home. Skipped when a palette ACTION moved focus (a route, a
 * dialog): that surface claimed focus already and must not lose it; a
 * dismissal (Esc) can have claimed nothing, so the opener always wins.
 */
export function restoreCommandPaletteFocus(): void {
  if (!restorePending) {
    return
  }

  const target = opener
  const claimed = closedByAction

  restorePending = false
  opener = null
  closedByAction = false

  if (typeof document === 'undefined') {
    return
  }

  const active = document.activeElement

  if (claimed && active && active !== document.body) {
    return
  }

  if (target instanceof HTMLElement && target.isConnected) {
    target.focus()

    return
  }

  releaseTypingFocus()
}

export function closeCommandPalette(): void {
  setOpen(false)
}

/** Close after an item ran: focus the item moved (a dialog, a route) is kept. */
export function closeCommandPaletteAfterAction(): void {
  closedByAction = true
  setOpen(false)
}

// ⌘K is a toggle, so the open half must capture the opener like every other
// door: without it the restore had nobody to return to and fell to the
// composer release (lab 2 r2: iT textarea → ⌘K → Esc → <body>).
export function toggleCommandPalette(): void {
  if ($commandPaletteOpen.get()) {
    setOpen(false)

    return
  }

  openCommandPalette()
}
