/**
 * v0.0.9 pass 4 (critic-G 11-light): the pane root's keyboard ring meets WCAG 1.4.11 (non-text contrast ≥ 3:1) in
 * every skin, against the two colours it touches: the pane surface it sits on and the frame line just outside it.
 * Computed from the tokens the skins declare (src/test/token-contrast.ts). And it is drawn where it can be seen: a
 * layer ABOVE the plate. Red before: the only ring was an inset outline, painted under the opaque .ic-win__plate.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors } from '@/test/token-contrast'
import { icloneDarkTheme, icloneLightTheme, icloneNaturalTheme } from '@/themes/presets'

const SKINS = [
  ['iclone-natural', icloneNaturalTheme.colors.foreground, 'dark', icloneNaturalTheme.colors.midground],
  ['iclone-dark', icloneDarkTheme.colors.foreground, 'dark', icloneDarkTheme.colors.midground],
  ['iclone-light', icloneLightTheme.colors.foreground, 'light', icloneLightTheme.colors.midground]
] as const

const CSS = read('app/home/window/ic-window.css')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''
}

describe('the pane ring is drawn above the plate', () => {
  const ring = rule('.ic-win:focus-visible:not([data-ic-focus-quiet])::after')

  it('a 2px inset band in the ring token, over the content rung, in the frame radius, hit-transparent', () => {
    expect(ring).toContain('outline: 2px solid var(--ic-pane-focus-ring);')
    expect(ring).toContain('outline-offset: -2px;')
    expect(ring).toContain('z-index: var(--ic-z-local-overlay);')
    expect(ring).toContain('position: absolute;')
    expect(ring).toContain('inset: 0;')
    expect(ring).toContain('border-radius: inherit;')
    expect(ring).toContain('pointer-events: none;')
  })

  it('the plate it must clear is opaque and covers the root (why an outline alone is not seen)', () => {
    expect(rule('.ic-win__plate')).toContain('inset: 0;')
    expect(rule('.ic-win__plate')).toContain('background: var(--ic-surface);')
  })
})

describe.each(SKINS)('contrast · %s', (_name, foreground, skin, midground) => {
  const color = skinColors(foreground, skin, [['--ic-skin-accent', midground ?? '']])
  const surface = color('var(--ic-surface)')
  const ring = over(color('var(--ic-pane-focus-ring)'), surface)

  it('ring ≥ 3:1 on the pane surface', () => {
    expect(ratio(ring, surface)).toBeGreaterThanOrEqual(3)
  })

  it('ring ≥ 3:1 against the frame line outside it', () => {
    expect(ratio(ring, over(color('var(--ic-econ-frame-line)'), surface))).toBeGreaterThanOrEqual(3)
  })
})
