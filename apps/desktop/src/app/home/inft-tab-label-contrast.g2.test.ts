/**
 * v0.0.9 G-2 (design G verdict): the vertical "INFT" island label is a primary control — the Email empty state sends the
 * owner to it — and it is 11px/600 text, so it needs ≥ 4.5:1. Red on 0d197361ab: in the light skin it was --ic-accent
 * (the pale gold) at opacity 0.9 on its 5 % chip over paper. The faint-ink gate only knows --ic-text-3, so this is its row.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

const COLLECTIONS = read('app/home/collections.css')
const LIGHT = ":root[data-hermes-theme='iclone-light']"

const body = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)

  return css.slice(at, css.indexOf('}', at))
}

/** The label's resting opacity in a skin: the light override when there is one, else the base rule. */
function restingOpacity(skin: 'dark' | 'light'): number {
  const base = parseFloat(/opacity: ([\d.]+);/.exec(body(COLLECTIONS, '.inft-tab__label'))![1])

  if (skin === 'dark' || !COLLECTIONS.includes(`${LIGHT} .inft-tab__label {`)) {
    return base
  }

  return parseFloat(/opacity: ([\d.]+);/.exec(body(COLLECTIONS, `${LIGHT} .inft-tab__label`))![1])
}

describe('the iNFT island label holds AA', () => {
  it('light skin: --ic-tab-label-ink at its resting opacity, on its chip over paper, ≥ 4.5:1', () => {
    const light = SKINS.find(([name]) => name === 'iclone-light')!
    const color = skinColors(light[1], light[2])
    const chip = over(color('var(--ic-tab-fill)'), color('var(--ic-surface)'))
    const [r, g, b, a] = color('var(--ic-tab-label-ink)')
    const ink = over([r, g, b, a * restingOpacity('light')], chip)

    expect(ratio(ink, chip)).toBeGreaterThanOrEqual(4.5)
  })

  it('light skin: the label rests at full opacity', () => {
    expect(restingOpacity('light')).toBe(1)
  })
})
