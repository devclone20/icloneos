/**
 * v0.0.9 r3 design pass on the pane chrome. Each case is red on fb85ac6be6:
 * - N4: the opacity slider in a control column kept the lone slider's fixed offsets (home.css top 52px / right 30px);
 *   `position: relative` then shifted it 30px off the ×/menu axis into the content.
 * - N8: the folded tabs were the same pill, told apart only by ink weight.
 * - N1: the Dock split menu had no placement of its own (it opened to the left of a left-edge Dock).
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

const CSS = read('app/home/window/ic-window.css')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''
}

describe('the opacity slider sits on the control column axis (N4)', () => {
  it.each(['.ic-win > .ic-win__controls .iop', '.ic-win__controls:not(.ic-win > *) .iop'])('%s clears its offsets', sel => {
    expect(rule(sel)).toContain('position: relative;')
    expect(rule(sel)).toContain('inset: auto;')
  })
})

describe('the folded tabs say which is shown (N8)', () => {
  it('the resting tab has no edge and no shadow; the shown tab is the plate, edged in the strong accent, 500', () => {
    const rest = rule('.ihome .ic-pane-tab')
    const shown = rule(".ihome .ic-pane-tab[aria-selected='true']")

    expect(rest).toContain('border: 1px solid transparent;')
    expect(rest).not.toContain('box-shadow')
    expect(shown).toContain('border-color: var(--ic-accent-strong);')
    expect(shown).toContain('background: var(--ic-ctl-fill);')
    expect(shown).toContain('font-weight: 500;')
  })

  it.each(SKINS)('the shown tab edge reads ≥ 3:1 against its plate · %s', (_n, foreground, skin) => {
    const color = skinColors(foreground, skin)
    const plate = over(color('var(--ic-ctl-fill)'), color('var(--ic-surface)'))

    expect(ratio(over(color('var(--ic-accent-strong)'), plate), plate)).toBeGreaterThanOrEqual(3)
  })
})

describe('the Dock split menu has its own placement (N1)', () => {
  it('opens inward from a left-edge Dock, and from the right edge in RTL', () => {
    expect(rule('.ic-wmenu__panel.dock-split-menu')).toContain('left: calc(100% + 10px);')
    expect(rule('.ic-wmenu__panel.dock-split-menu')).toContain('right: auto;')
    expect(rule(":root[dir='rtl'] .ic-wmenu__panel.dock-split-menu")).toContain('right: calc(100% + 10px);')
  })
})
