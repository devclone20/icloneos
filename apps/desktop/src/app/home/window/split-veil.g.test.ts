/**
 * v0.0.9 F6 path to 9 (design G verdict): the whole-frame split preview ("Email replaces Settings") veils the pane under
 * it in the light skin too — a veil-to-surface luminance drop of at least 8 %, still opaque enough to ghost the rows,
 * and the paper label pill stays apart from it. Red on 0d197361ab: the light veil was paper at 88 % on a paper pane
 * (a 0 % drop), so 02-light showed no veil at all.
 */
import { describe, expect, it } from 'vitest'

import { luminance, over, read, skinColors, SKINS } from '@/test/token-contrast'

const CSS = read('app/home/window/ic-window.css')
const LIGHT = ":root[data-hermes-theme='iclone-light']"

/** The background the light skin's whole-frame veil really paints: its light rule when there is one, else the base. */
function lightVeilBackground(): string {
  for (const selector of [
    `${LIGHT} .ic-split-preview__half.ic-split-preview__whole`,
    '.ic-split-preview__half.ic-split-preview__whole'
  ]) {
    const at = CSS.indexOf(`${selector} {`)

    if (at >= 0) {
      return /background: ([^;]+);/
        .exec(CSS.slice(at, CSS.indexOf('}', at)))![1]
        .replace(/\s+/g, ' ')
        .trim()
    }
  }

  throw new Error('no whole-frame veil rule')
}

describe('the light whole-frame veil reads as a veil', () => {
  const light = SKINS.find(([name]) => name === 'iclone-light')!
  const color = skinColors(light[1], light[2])
  const surface = over(color('var(--ic-surface)'), [1, 1, 1, 1])

  it('veil over the pane surface: luminance drops ≥ 8 %, and it stays ≥ 85 % opaque (the rows ghost)', () => {
    const veilColor = color(lightVeilBackground())
    const veiled = over(veilColor, surface)

    expect(1 - luminance(veiled) / luminance(surface)).toBeGreaterThanOrEqual(0.08)
    expect(veilColor[3]).toBeGreaterThanOrEqual(0.85)
  })

  it('the drop target keeps its accent tint over the light veil', () => {
    const at = CSS.indexOf(`${LIGHT} .ic-split-preview__half.ic-split-preview__whole[data-role='incoming'] {`)

    expect(at).toBeGreaterThanOrEqual(0)
    expect(CSS.slice(at, CSS.indexOf('}', at)).replace(/\s+/g, ' ')).toContain(
      'linear-gradient(var(--ic-accent-soft), var(--ic-accent-soft)), var(--ic-split-veil);'
    )
  })
})
