import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The stylesheet rules three tickets hang on, pinned at the source: the live
 * widths are the critic's to measure on the lab, these keep the mechanism from
 * being edited away. U3-p2-03 (asset column at 0 px with an aside open),
 * U3-p2-09 (WITHDRAWABLE wider than its card at 2×), U3-p2-04 (card price
 * clipped, category chips with no scroll affordance at 2×).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const econ = fs.readFileSync(path.join(here, 'econ.css'), 'utf8')
const market = fs.readFileSync(path.join(here, 'market', 'market.css'), 'utf8')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)

  if (start < 0) {
    throw new Error(`no rule ${selector}`)
  }

  return css.slice(start, css.indexOf('}', start))
}

describe('econ.css table cells and stat cards', () => {
  it('U3-p2-03: the asset cell has a basis and a floor, numeric cells shrink to theirs', () => {
    expect(rule(econ, '.e-cell--grow')).toContain('flex: 1 1 160px')
    expect(rule(econ, '.e-cell--grow')).toContain('min-width: 120px')
    expect(rule(econ, '.e-cell--end')).toContain('flex-shrink: 1')
    expect(rule(econ, '.e-cell--end')).toContain('min-width: max(72px, 7ch)')
  })

  it('U3-p2-09: a stat card may shrink and its label may break inside a word; Large widens the columns', () => {
    expect(rule(econ, '.e-stat')).toContain('min-width: 0')
    expect(rule(econ, '.e-stat__label')).toContain('overflow-wrap: anywhere')
    expect(rule(econ, '.e-stats')).toContain('minmax(140px, 1fr)')
    expect(rule(econ, "html[data-text-size='large'] .e-stats")).toContain('minmax(min(100%, 190px), 1fr)')
  })
})

describe('market.css cards and category chips', () => {
  it('U3-p2-04: the footer wraps so the price is never the item that clips', () => {
    expect(rule(market, '.mk-card__foot')).toContain('flex-wrap: wrap')
    expect(rule(market, '.mk-card__offers')).toContain('flex-wrap: wrap')
    expect(rule(market, '.mk-card__offers')).not.toContain('overflow: hidden')
  })

  it('U3-p2-04: category chips keep a visible scrollbar at Default and wrap at Large', () => {
    expect(rule(market, '.mk-cats')).not.toContain('scrollbar-width: none')
    expect(rule(market, '.mk-cats')).toContain('scrollbar-width: thin')
    expect(market).not.toContain('.mk-cats::-webkit-scrollbar')
    expect(rule(market, "html[data-text-size='large'] .mk-cats")).toContain('flex-wrap: wrap')
  })
})
