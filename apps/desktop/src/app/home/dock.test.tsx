import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Dock, type DockItem, focusDockTile } from '@/app/home/dock'

function renderDock() {
  const onSelect = vi.fn()

  const items: DockItem[] = ['email', 'wallet'].map(id => ({
    icon: id[0],
    id,
    label: id === 'email' ? 'Email' : 'Wallet',
    onSelect: () => onSelect(id)
  }))

  render(
    <>
      <input aria-label="Composer" />
      <Dock items={items} />
    </>
  )

  return {
    composer: screen.getByRole('textbox', { name: 'Composer' }),
    email: screen.getByRole('button', { name: 'Email' }),
    onSelect,
    wallet: screen.getByRole('button', { name: 'Wallet' })
  }
}

// U5-T9: the press calls `preventDefault`, which also cancels the browser's focus move.
describe('dock focus on pointer press', () => {
  it('moves a stale keyboard focus on another tile to the pressed tile', () => {
    const { email, onSelect, wallet } = renderDock()
    const focused = () => wallet.ownerDocument.activeElement

    email.focus()
    fireEvent.pointerDown(wallet, { button: 0, pointerId: 1 })

    expect(focused()).toBe(wallet)

    // Space on the focused tile is a detail-0 click: it acts on Wallet.
    fireEvent.click(focused() as HTMLElement, { detail: 0 })
    expect(onSelect).toHaveBeenCalledWith('wallet')
    expect(onSelect).not.toHaveBeenCalledWith('email')
  })

  it('leaves focus held outside the dock where it is', () => {
    const { composer, wallet } = renderDock()

    composer.focus()
    fireEvent.pointerDown(wallet, { button: 0, pointerId: 1 })

    expect(wallet.ownerDocument.activeElement).toBe(composer)
  })

  it('keeps focus on the pressed tile when it already has it and selects once on release', () => {
    const { onSelect, wallet } = renderDock()

    wallet.focus()
    fireEvent.pointerDown(wallet, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(wallet, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })

    expect(wallet.ownerDocument.activeElement).toBe(wallet)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('wallet')
  })

  it('ignores a non-primary press', () => {
    const { email, wallet } = renderDock()

    email.focus()
    fireEvent.pointerDown(wallet, { button: 2, pointerId: 1 })

    expect(wallet.ownerDocument.activeElement).toBe(email)
  })
})

describe('focusDockTile (U2-p2-02)', () => {
  it('hands focus back to the tile after the window — and its focused Close — left the DOM', async () => {
    renderDock()

    const close = window.document.createElement('button')

    window.document.body.append(close)
    close.focus()
    close.remove()
    expect(window.document.activeElement).toBe(window.document.body)

    focusDockTile('wallet')
    await new Promise(resolve => requestAnimationFrame(resolve))

    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'Wallet' }))
  })
})

describe('dock auto-hide pins open on keyboard focus only (Dock windows open maximized)', () => {
  const css = readFileSync(resolve(__dirname, 'dock.css'), 'utf8')

  const hiddenRules = [
    ...css.matchAll(/^(?::root\[dir='rtl'\] )?\.dock\[data-autohide\]:not\(\[data-revealed\]\)[^{]*\{/gm)
  ].map(match => match[0])

  it('hides unless revealed or a tile holds keyboard focus, in both directions', () => {
    expect(hiddenRules).toEqual([
      '.dock[data-autohide]:not([data-revealed]):not(:has(:focus-visible)) {',
      ":root[dir='rtl'] .dock[data-autohide]:not([data-revealed]):not(:has(:focus-visible)) {"
    ])
  })

  it('never lets a mouse or programmatic focus pin it: no :focus-within in the auto-hide rules', () => {
    expect(hiddenRules.some(rule => rule.includes(':focus-within'))).toBe(false)
  })
})

describe('dock glyph ink (U3-03-p2, rulings §24)', () => {
  const css = readFileSync(resolve(__dirname, 'dock.css'), 'utf8')

  it('untoned tiles redefine the one glyph-ink token to the skin text ink; the tile fill rules are untouched', () => {
    expect(css).toMatch(/\.dock__icon:not\(\.ic-tone\)\s*\{\s*--ic-dock-glyph-ink:\s*var\(--ic-text-1\);\s*\}/)
    // Every glyph still reads the same token — one recipe, no per-tile colour.
    expect(css).toMatch(/\.dock__glyph\s*\{[^}]*color:\s*var\(--ic-dock-glyph-ink\);/)
    // The owner's tile fills keep their shipped tokens.
    expect(css).toContain('background: var(--ic-dock-tile-press)')
    expect(css).toContain('var(--ic-dock-tone-fill)')
  })

  it('only the glyphs carry brand colour: Email in vivid mail red, Hyperliquid in its mint (owner 2026-10-20)', () => {
    expect(css).toMatch(/\.dock__icon\[data-dock='email'\] \.dock__glyph\s*\{\s*color:\s*var\(--ic-brand-email\);/)
    expect(css).toMatch(
      /\.dock__icon\[data-dock='hyperliquid'\] \.dock__glyph\s*\{\s*color:\s*var\(--ic-brand-hyperliquid\);/
    )
  })
})
