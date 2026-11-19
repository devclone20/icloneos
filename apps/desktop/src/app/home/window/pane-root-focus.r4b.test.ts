/**
 * The pane root's focus ring.
 * r4b (critic-r4 04-light): after a Dock drag cancelled by Esc a gold outline stayed round the Email pane — the page's
 * :focus-visible ring on the pane root (tabindex -1), which a pointer had focused and the Esc key turned "visible".
 * r4d (eng r4-m3): the r4b fix removed every ring from the root, so a keyboard focus showed none (WCAG 2.4.7). Now:
 *   - a pointer focus draws nothing (`:focus:not(:focus-visible)`);
 *   - a keyboard focus draws an inset ring in the house keyboard-ring token;
 *   - the Esc that cancels a drag marks the root quiet for that key, never calling .focus(); the mark goes on the
 *     next key or on blur.
 * Red on 52cae17554: no inset ring, no quiet mark.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { read } from '@/test/token-contrast'

import { beginDockDrag, cancelDockDrag } from './dock-split'

const CSS = read('app/home/window/ic-window.css')

const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`)

  expect(at, selector).toBeGreaterThanOrEqual(0)

  return CSS.slice(at, CSS.indexOf('}', at))
}

function paneRoot(): HTMLElement {
  const root = document.createElement('aside')

  root.className = 'ic-win iecon'
  root.dataset.icWindow = 'email'
  root.tabIndex = -1
  document.body.append(root)

  return root
}

afterEach(() => {
  cancelDockDrag({ say: false })
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('the pane root ring', () => {
  it('a keyboard focus draws an inset ring in the strong accent; a pointer focus and a quiet root draw none', () => {
    expect(rule('.ic-win:focus-visible')).toMatch(/outline: 2px solid var\(--ic-accent-strong\);\s*outline-offset: -2px/)
    expect(CSS).toMatch(/\.ic-win:focus:not\(:focus-visible\),\s*\.ic-win\[data-ic-focus-quiet\]:focus-visible \{\s*outline: none/)
    // The quiet rule comes after the ring, so it wins at equal or higher specificity.
    expect(CSS.indexOf('.ic-win[data-ic-focus-quiet]:focus-visible')).toBeGreaterThan(CSS.indexOf('.ic-win:focus-visible {'))
    expect(CSS).not.toMatch(/\.ic-win:focus,\s*\.ic-win:focus-visible \{\s*outline: none/)
  })

  it('Esc during a drag marks the focused pane root quiet and never focuses anything', () => {
    vi.useFakeTimers()
    const root = paneRoot()

    root.focus()
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')

    beginDockDrag('wallet', 500, 300, { left: 0, top: 0, width: 1000, height: 700 })
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))

    expect(root.dataset.icFocusQuiet).toBe('')
    expect(document.activeElement).toBe(root)
    expect(focus).not.toHaveBeenCalled()

    // The next key is a real keyboard move: the ring may show again.
    vi.runAllTimers()
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }))
    expect(root.dataset.icFocusQuiet).toBeUndefined()
    focus.mockRestore()
  })

  it('the quiet mark also goes when the root loses focus', () => {
    vi.useFakeTimers()
    const root = paneRoot()
    const other = document.createElement('button')

    document.body.append(other)
    root.focus()
    beginDockDrag('wallet', 500, 300, { left: 0, top: 0, width: 1000, height: 700 })
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))
    expect(root.dataset.icFocusQuiet).toBe('')

    other.focus()
    expect(root.dataset.icFocusQuiet).toBeUndefined()
  })

  it('a keyboard hand-off (focusPane) leaves no quiet mark, so its ring shows', async () => {
    const { focusPane } = await import('./pane-focus')
    const root = paneRoot()

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)

      return 0
    })
    focusPane('email')
    vi.unstubAllGlobals()

    expect(document.activeElement).toBe(root)
    expect(root.dataset.icFocusQuiet).toBeUndefined()
  })
})

// r4d (design r4 F6-2): red on 52cae17554 — the whole-frame preview had no veil, so in light its label sat on live text.
describe('the whole-frame preview veils the pane under it', () => {
  it('both roles carry the house scrim; the drop target keeps its accent tint over it', () => {
    // r5 (design R5-1): the veil is the pane's surface at 88 % (the scrim was too thin in light). Red on b290e6d7f3.
    expect(rule('.ic-split-preview__half.ic-split-preview__whole')).toMatch(
      /background: color-mix\(in srgb, var\(--ic-surface\) var\(--ic-a88\), transparent\);/
    )
    expect(rule(".ic-split-preview__half.ic-split-preview__whole[data-role='incoming']").replace(/\s+/g, ' ')).toContain(
      'linear-gradient(var(--ic-accent-soft), var(--ic-accent-soft)), color-mix(in srgb, var(--ic-surface) var(--ic-a88), transparent);'
    )
    // Later than the half's own incoming rule, at the same or higher specificity, so it wins.
    expect(CSS.indexOf('.ic-split-preview__half.ic-split-preview__whole {')).toBeGreaterThan(
      CSS.indexOf(".ic-split-preview__half[data-role='incoming'] {")
    )
  })
})
