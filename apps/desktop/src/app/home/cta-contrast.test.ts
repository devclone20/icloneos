/**
 * v0.0.9 r3 (design N5): the light skin's primary "Connect wallet" (econ gate, home hero) is a solid plate whose ink
 * holds AA — red on fb85ac6be6: no such rule; the light econ primary was --ic-accent text on a ~14 % accent wash.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

const ECON = read('app/home/econ/econ.css')
const HOME = read('app/home/home.css')
const LIGHT = ":root[data-hermes-theme='iclone-light']"

const body = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)

  return css.slice(at, css.indexOf('}', at))
}

describe('light primary CTA', () => {
  const light = SKINS.find(([name]) => name === 'iclone-light')!

  it.each(['--ic-cta-fill', '--ic-cta-fill-hover'])('--ic-cta-ink on %s ≥ 4.5:1 in the light skin', fill => {
    const color = skinColors(light[1], light[2])
    const plate = over(color(`var(${fill})`), color('var(--ic-surface)'))

    expect(ratio(over(color('var(--ic-cta-ink)'), plate), plate)).toBeGreaterThanOrEqual(4.5)
  })

  it('the econ primary and the hero CTA wear it in the light skin', () => {
    for (const [css, selector] of [
      [ECON, `${LIGHT} .e-btn--primary`],
      [HOME, `${LIGHT} .ihome__connect`]
    ] as const) {
      const rule = body(css, selector)

      expect(rule).toMatch(/background: var\(--ic-cta-fill\)/)
      expect(rule).toMatch(/color: var\(--ic-cta-ink\)/)
    }
  })

  // r4d (design r4 F3-1): red on 52cae17554 — the system primary (boot card Repair) was white on the light accent.
  it('the system primary (.ic-btn default) wears the CTA plate in the light skin, ≥ 4.5:1', () => {
    const SYSTEM = read('components/ic/ic-system.css')
    const rule = body(SYSTEM, `${LIGHT} .ic-btn[data-variant='default']`)

    expect(rule).toMatch(/background: var\(--ic-cta-fill\)/)
    expect(rule).toMatch(/color: var\(--ic-cta-ink\)/)
    expect(body(SYSTEM, `${LIGHT} .ic-btn[data-variant='default']:hover`)).toMatch(/background: var\(--ic-cta-fill-hover\)/)

    const light = SKINS.find(([name]) => name === 'iclone-light')!
    const color = skinColors(light[1], light[2])
    const plate = over(color('var(--ic-cta-fill)'), color('var(--ic-surface)'))

    expect(ratio(over(color('var(--ic-cta-ink)'), plate), plate)).toBeGreaterThanOrEqual(4.5)
  })

  it('the Collection display lines balance (design N9: no "…see your / iNFTs" widow)', () => {
    const css = read('app/home/collections.css')

    expect(body(css, '.inft-panel__line')).toMatch(/text-wrap: balance/)
    expect(body(css, '.inft-panel__title')).toMatch(/text-wrap: balance/)
  })

  it('the econ gate centres its icon and pads symmetrically (design N3)', () => {
    expect(body(ECON, '.e-empty__icon')).toMatch(/display: flex;\s*justify-content: center/)
    const pad = /padding: ([^;]+);/.exec(body(ECON, '.iecon__gate'))![1].split(/\s+/)

    expect(pad.length === 1 || pad.length === 2 || pad[1] === pad[3]).toBe(true)
  })
})
