/**
 * v0.0.9 F6 (a11y lens r1): the drag-to-split chrome meets WCAG non-text contrast (3:1) and text contrast (4.5:1) in
 * every skin, computed from the tokens the skins declare (src/test/token-contrast.ts), and the stylesheet really uses
 * those tokens. Red before: the divider's focus was a 1px hairline at 1.2–1.4:1, the light-skin drop target 1.9:1.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors } from '@/test/token-contrast'
import { icloneDarkTheme, icloneLightTheme, icloneNaturalTheme } from '@/themes/presets'

const SKINS_WITH_ACCENT = [
  ['iclone-natural', icloneNaturalTheme.colors.foreground, 'dark', icloneNaturalTheme.colors.midground],
  ['iclone-dark', icloneDarkTheme.colors.foreground, 'dark', icloneDarkTheme.colors.midground],
  ['iclone-light', icloneLightTheme.colors.foreground, 'light', icloneLightTheme.colors.midground]
] as const

it('the plain light accent alone would fail (why the chrome uses the strong step)', () => {
  const [, foreground, skin, midground] = SKINS_WITH_ACCENT[2]
  const color = skinColors(foreground, skin, [['--ic-skin-accent', midground ?? '']])
  const surface = color('var(--ic-surface)')

  expect(ratio(over(color('var(--ic-accent)'), surface), surface)).toBeLessThan(3)
})

const CSS = read('app/home/window/ic-window.css')

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''
}

describe('the stylesheet reads the measured tokens', () => {
  it('divider focus: a 2px accent ring, distinct from hover', () => {
    expect(rule('.ic-pane-divider:focus-visible')).toContain('outline: 2px solid var(--ic-accent-strong);')
    expect(rule('.ic-pane-divider:focus-visible')).not.toContain('outline: none')
  })

  it('drop target: the incoming half is edged in the strong accent; the other half in --ic-border-strong', () => {
    expect(rule(".ic-split-preview__half[data-role='incoming']")).toContain('border-color: var(--ic-accent-strong);')
    expect(rule('.ic-split-preview__half')).toContain('border: 2px solid var(--ic-border-strong);')
    // No opacity on a half: the label inside stays opaque.
    expect(rule('.ic-split-preview__half')).not.toMatch(/(?:^|\s)opacity:/)
  })

  it('the labels are --ic-text-1 on --ic-surface', () => {
    expect(rule('.ic-split-preview__label')).toContain('color: var(--ic-text-1);')
    expect(rule('.ic-split-preview__label')).toContain('background: var(--ic-surface);')
  })

  it('hit targets: the 8px divider has a 32px band; the one opacity slider a 3px ring (26 → 32)', () => {
    const band = rule('.ic-pane-divider::after')

    expect(band).toContain('left: -12px;')
    expect(band).toContain('right: -12px;')
    expect(rule('.ic-win__controls .iop::before')).toContain('inset: -3px;')
  })
})

describe.each(SKINS_WITH_ACCENT)('contrast · %s', (_name, foreground, skin, midground) => {
  // --ic-accent is the skin's midground (ic-bridge.css → --ic-skin-accent): measured with the skin's own.
  const color = skinColors(foreground, skin, [['--ic-skin-accent', midground ?? '']])
  const surface = color('var(--ic-surface)')

  it('divider focus ring (strong accent) ≥ 3:1 on the pane surface', () => {
    expect(ratio(over(color('var(--ic-accent-strong)'), surface), surface)).toBeGreaterThanOrEqual(3)
  })

  it('drop target edge (strong accent) ≥ 3:1 on the pane under it and on its own fill', () => {
    const fill = over(color('var(--ic-accent-soft)'), surface)
    const edge = over(color('var(--ic-accent-strong)'), fill)

    expect(ratio(edge, surface)).toBeGreaterThanOrEqual(3)
    expect(ratio(edge, fill)).toBeGreaterThanOrEqual(3)
  })

  it('preview labels (--ic-text-1 on --ic-surface) ≥ 4.5:1', () => {
    expect(ratio(over(color('var(--ic-text-1)'), surface), surface)).toBeGreaterThanOrEqual(4.5)
  })
})

// r5 (design R5-5): red on b290e6d7f3 — the light pane ring was the strong accent at -2px, merging with the gilt frame.
describe('the light pane focus ring stands apart from the resting frame', () => {
  it('the light ring is the CTA gold, 1px inside the frame line, ≥ 3:1 against the surface and the frame line', () => {
    const LIGHT_RING = rule(":root[data-hermes-theme='iclone-light'] .ic-win:focus-visible")

    expect(LIGHT_RING).toContain('outline-color: var(--ic-cta-fill);')
    expect(LIGHT_RING).toContain('outline-offset: -3px;')

    const [, foreground, skin, midground] = SKINS_WITH_ACCENT[2]
    const color = skinColors(foreground, skin, [['--ic-skin-accent', midground ?? '']])
    const surface = color('var(--ic-surface)')
    const ring = over(color('var(--ic-cta-fill)'), surface)
    const frame = over(color('var(--ic-win-frame-line)'), surface)

    expect(ratio(ring, surface)).toBeGreaterThanOrEqual(3)
    expect(ratio(ring, frame)).toBeGreaterThanOrEqual(3)
  })
})
