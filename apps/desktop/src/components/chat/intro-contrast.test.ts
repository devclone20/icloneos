/**
 * v0.0.9 r2 (d-r2-1): the Message window's empty-chat line ("Your Imagination is the Limit") holds AA (4.5:1) in the
 * light skin and stays white in the dark skins, computed from the declared tokens (src/test/token-contrast.ts).
 * Red before: intro.css painted it --ic-white in every skin, ~1.1:1 on the light plate.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

const INTRO_CSS = read('components/chat/intro.css')

it('the line is painted with the per-skin token, not a fixed white', () => {
  const rule = /\[data-slot='aui_intro'\] p\.ic-intro-line:last-child \{([^}]*)\}/.exec(INTRO_CSS)?.[1] ?? ''

  expect(rule).toContain('color: var(--ic-text-intro);')
  expect(rule).not.toContain('var(--ic-white)')
})

describe.each(SKINS)('contrast · %s', (_name, foreground, skin) => {
  const color = skinColors(foreground, skin)
  const surface = color('var(--ic-surface)')
  // The Message window's glass over the opaque pane surface (the plate the line sits on).
  const plate = over(color('var(--ic-surface-glass)'), surface)
  const line = color('var(--ic-text-intro)')

  it('≥ 4.5:1 on the pane surface and on its glass plate', () => {
    expect(ratio(over(line, surface), surface)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(over(line, plate), plate)).toBeGreaterThanOrEqual(4.5)
  })

  if (skin === 'dark') {
    it('unchanged in the dark skins: pure white', () => {
      expect(line).toEqual(color('var(--ic-white)'))
      expect(line).toEqual([1, 1, 1, 1])
    })
  }
})
