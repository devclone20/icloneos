/**
 * v0.0.9 r4d (design r4 F6-3): a filled Message pane's rail sat under the revealed Dock (02-dark), and the Dock's hover
 * tip stayed up over the split preview during a drag. Red on 52cae17554: no rule for either.
 */
import { describe, expect, it } from 'vitest'

import { read } from '@/test/token-contrast'

describe('the Dock never covers a filled pane, and no tip floats over a drag', () => {
  it('while the auto-hidden Dock is back, the Message rail starts right of it and its gutter', () => {
    const css = read('app/home/msg-sidebar.css')
    const tokens = read('app/home/home.css')

    expect(css).toMatch(
      /:root:has\(\.dock\[data-autohide\]:is\(\[data-revealed\], :focus-within\)\) \.imsg-side \{\s*left: max\(var\(--iwin-outer-left, var\(--ic-frame-left\)\), var\(--ic-frame-left\)\);/
    )
    // No nested :has() (invalid CSS, the whole rule would be dropped).
    expect(css).not.toMatch(/:has\([^)]*:has\(/)
    // --ic-frame-left is the Dock's right edge plus its gutter (the split's own inset).
    expect(tokens).toMatch(/--ic-frame-left: 96px;/)
  })

  // r5: red on b290e6d7f3 — the rule named only Radix tips; the Dock's own label tip is `.dock__tooltip`.
  it('the Dock\'s own label tip is hidden during a drag, from the dragged tile on', () => {
    const css = read('app/home/dock.css')

    expect(css).toMatch(/body:has\(\[data-ic-split-preview\]\) \.dock__tooltip,/)
    expect(css).toMatch(/\.dock__icon\[data-dragging\] ~ \.dock__tooltip \{[^}]*display: none;/)
    expect(read('app/home/dock.tsx')).toContain('className="dock__tooltip"')
    expect(read('app/home/dock.tsx')).toContain("event.currentTarget.dataset.dragging = ''")
  })

  it('a Dock drag hides every hover tip while the preview is up', () => {
    expect(read('app/home/dock.css')).toMatch(
      /body:has\(\[data-ic-split-preview\]\) \[data-slot='tooltip-content'\],/
    )
    expect(read('app/home/window/dock-split-preview.tsx')).toContain('data-ic-split-preview=""')
  })
})
