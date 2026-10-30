import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { onReleaseTypingFocus } from '@/components/ui/keyboard-first'
import {
  closeCommandPalette,
  closeCommandPaletteAfterAction,
  openCommandPalette,
  openCommandPalettePage,
  restoreCommandPaletteFocus,
  toggleCommandPalette
} from '@/store/command-palette'

import { PRODUCT_PALETTE_HIDDEN } from './contrib'
import { PaletteSheet } from './sheet'

const here = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

afterEach(() => {
  cleanup()
  globalThis.document.body.innerHTML = ''
})

const sheet = (open: boolean, onExited: () => void) => (
  <PaletteSheet
    bindings={{}}
    groups={[]}
    modHeld={false}
    noResultsLabel="Nothing"
    onClose={() => {}}
    onExited={onExited}
    onSearchChange={() => {}}
    onSelect={() => {}}
    open={open}
    placeholder="Search"
    search=""
    title="Commands"
  />
)

describe('palette focus restore (U2-p2-03, U4-p2-07)', () => {
  it('returns focus to the button that opened the palette once the sheet is gone', () => {
    const button = globalThis.document.createElement('button')

    button.textContent = 'iNFT collection'
    globalThis.document.body.append(button)
    button.focus()
    openCommandPalette()

    const input = globalThis.document.createElement('input')

    globalThis.document.body.append(input)
    input.focus()
    closeCommandPalette()
    input.remove()
    expect(globalThis.document.activeElement).toBe(globalThis.document.body)
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(button)
  })

  it('leaves focus alone when the palette action claimed it (a dialog, a route)', () => {
    const button = globalThis.document.createElement('button')
    const dialogInput = globalThis.document.createElement('input')

    globalThis.document.body.append(button, dialogInput)
    button.focus()
    openCommandPalettePage('theme')
    closeCommandPaletteAfterAction()
    dialogInput.focus()
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(dialogInput)
  })

  it('the ⌘K toggle captures the opener too (lab 2 r2: the shortcut path returned to <body>)', () => {
    const textarea = globalThis.document.createElement('textarea')
    const release = vi.fn()
    const off = onReleaseTypingFocus(release)

    textarea.setAttribute('aria-label', 'Terminal input')
    globalThis.document.body.append(textarea)
    textarea.focus()
    toggleCommandPalette()
    textarea.blur()
    expect(globalThis.document.activeElement).toBe(globalThis.document.body)
    toggleCommandPalette()
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(textarea)
    expect(release).not.toHaveBeenCalled()
    off()
  })

  it('restores once per close: the fallback timer re-running it must not release to the composer', () => {
    const button = globalThis.document.createElement('button')
    const release = vi.fn()
    const off = onReleaseTypingFocus(release)

    globalThis.document.body.append(button)
    button.focus()
    openCommandPalette()
    closeCommandPalette()
    button.blur()
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(button)
    // The second retire (EXIT_FALLBACK_MS after close) finds nothing pending.
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(button)
    expect(release).not.toHaveBeenCalled()
    // And a restore with no close behind it is a no-op too.
    button.blur()
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(globalThis.document.body)
    expect(release).not.toHaveBeenCalled()
    off()
  })

  it('a dismissal hands focus to the opener even when a composer claim slipped in', () => {
    const button = globalThis.document.createElement('button')
    const composer = globalThis.document.createElement('div')

    composer.contentEditable = 'true'
    composer.tabIndex = 0
    globalThis.document.body.append(button, composer)
    button.focus()
    openCommandPalette()
    closeCommandPalette()
    // Nothing legitimate claims focus on Esc: whatever did (the composer's
    // release bus) loses to the element the user was on.
    composer.focus()
    restoreCommandPaletteFocus()
    expect(globalThis.document.activeElement).toBe(button)
  })

  // The real unmount flow: the sheet closes, its card's exit animation ends,
  // the body retires and restores. Pinned for an editable opener (the iT
  // 'Terminal input' textarea, U2-p2-03) and a plain button (the Model pill,
  // U4-p2-07): the opener itself is focused, the composer release never runs.
  it.each([
    [
      'a textarea opener (iT)',
      () => Object.assign(globalThis.document.createElement('textarea'), { ariaLabel: 'Terminal input' })
    ],
    [
      'a button opener (Model pill)',
      () => Object.assign(globalThis.document.createElement('button'), { ariaLabel: 'Model' })
    ]
  ])('Esc returns focus to %s through the sheet unmount, not the composer release', (_name, make) => {
    const opener = make()
    const release = vi.fn()
    const off = onReleaseTypingFocus(release)

    globalThis.document.body.append(opener)
    opener.focus()
    expect(globalThis.document.activeElement).toBe(opener)
    openCommandPalette()

    const view = render(sheet(true, () => undefined))
    const input = screen.getByPlaceholderText('Search')

    input.focus()
    expect(globalThis.document.activeElement).toBe(input)

    // Esc: the sheet asks to close; the store closes; the exit plays.
    fireEvent.keyDown(input, { key: 'Escape' })
    closeCommandPalette()
    view.rerender(
      sheet(false, () => {
        view.unmount()
        restoreCommandPaletteFocus()
      })
    )
    fireEvent.animationEnd(screen.getByRole('dialog'))

    expect(globalThis.document.activeElement).toBe(opener)
    expect(globalThis.document.activeElement).not.toBe(globalThis.document.body)
    expect(release).not.toHaveBeenCalled()
    off()
  })

  it('runs from the sheet unmount, not from close (the input was still mounted at close)', () => {
    const onExited = vi.fn()
    const { rerender } = render(sheet(true, onExited))
    const card = screen.getByRole('dialog')

    // Closing only starts the exit animation: the subtree (and its focused
    // input) is still mounted, so restoring focus now would be undone.
    rerender(sheet(false, onExited))
    expect(onExited).not.toHaveBeenCalled()
    expect(globalThis.document.contains(card)).toBe(true)

    // A descendant's animation ending is not the card's exit.
    fireEvent.animationEnd(screen.getByPlaceholderText('Search'))
    expect(onExited).not.toHaveBeenCalled()

    fireEvent.animationEnd(card)
    expect(onExited).toHaveBeenCalledTimes(1)
  })
})

describe('product palette (U2-p2-05)', () => {
  it('hides the upstream developer doors', () => {
    for (const id of ['plugins.reload', 'cc-restart-gateway', 'cc-update-hermes', 'nav-agents']) {
      expect(PRODUCT_PALETTE_HIDDEN.has(id)).toBe(true)
    }

    // V3-F: the yolo toggle is gone; its door opens the permission mode picker and is shown.
    expect(PRODUCT_PALETTE_HIDDEN.has('session.permissionMode')).toBe(false)

    const index = here('./index.tsx')

    expect(index).not.toContain("id: 'cc-restart-gateway'")
    expect(index).not.toContain("id: 'cc-update-hermes'")
    expect(here('./contrib.ts')).toContain('!PRODUCT_PALETTE_HIDDEN.has(item.id)')
  })
})
