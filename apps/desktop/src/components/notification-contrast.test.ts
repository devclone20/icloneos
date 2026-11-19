/**
 * v0.0.9 F4 — gate N4: contrast of the notification surfaces, computed from the tokens the skins really declare
 * (ic-tokens.css, the skin foreground in themes/presets.ts and styles.css's ink), never from a number copied here.
 *
 * The toast, the status banner and the centre sit on an OPAQUE plate (--ic-note-plate), so the plate IS the worst
 * background: text ≥ 4.5:1, the severity icon and its side bar ≥ 3:1, in iclone-natural, iclone-dark and iclone-light.
 * On the old toast (--ic-text-2 on 40–54 % glass) the body measured 2.05:1 in light over a dark backdrop.
 */
import { describe, expect, it } from 'vitest'

import { over, ratio, read, skinColors, SKINS } from '@/test/token-contrast'

const SURFACES_CSS = read('components/notification-system.css')

const TEXT = ['--ic-note-ink', '--ic-note-ink-2'] as const
const MARKS = ['--ic-note-info', '--ic-note-success', '--ic-note-warning', '--ic-note-error'] as const
const PLATES = ['--ic-note-plate', '--ic-note-plate-sunken'] as const

describe.each(SKINS)('N4 · %s', (_name, foreground, skin) => {
  const color = skinColors(foreground, skin)

  it.each(PLATES)('%s is opaque (no translucent glass behind the words)', plate => {
    expect(color(`var(${plate})`)[3]).toBeCloseTo(1, 5)
  })

  it.each(PLATES.flatMap(plate => TEXT.map(text => [text, plate] as const)))('%s on %s ≥ 4.5:1', (text, plate) => {
    const under = color(`var(${plate})`)

    expect(ratio(over(color(`var(${text})`), under), under)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(MARKS)('%s (icon + side bar) ≥ 3:1 on the plate', mark => {
    const plate = color('var(--ic-note-plate)')

    expect(ratio(over(color(`var(${mark})`), plate), plate)).toBeGreaterThanOrEqual(3)
  })

  it('--ic-text-2-aa holds 4.5:1 on the skin surface too (setting-row detail, inline alert info)', () => {
    const surface = color('var(--ic-surface)')

    expect(ratio(over(color('var(--ic-text-2-aa)'), surface), surface)).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * v0.0.9 design 1 (critic r1): the F5/F6 surfaces (wallet panel, Collection cards and panel, the window menu and pane
 * chrome) set secondary words in --ic-text-2 (the dark hover plate uses its own --ic-inft-plate-ink-2). Each is measured on the real backgrounds it sits on in every skin —
 * translucent fills composited over the skin surface — and must hold AA (4.5:1). Red on the old light skin: 4.1:1
 * on paper.
 */
const SECONDARY_BACKGROUNDS = [
  '--ic-surface',
  '--ic-paper',
  '--ic-wallet-panel-fill',
  '--ic-inft-card-fill',
  '--ic-inft-panel-fill',
  '--ic-ctl-fill',
  '--ic-surface-raised',
  '--ic-fill-hover',
  '--ic-tab-fill'
] as const

describe.each(SKINS)('design 1 · --ic-text-2 on the F5/F6 surfaces · %s', (_name, foreground, skin) => {
  const color = skinColors(foreground, skin)

  it.each(SECONDARY_BACKGROUNDS.filter(token => skin === 'light' || token !== '--ic-paper'))(
    '--ic-text-2 on %s ≥ 4.5:1',
    background => {
      const surface = color('var(--ic-surface)')
      const under = over(color(`var(${background})`), surface)

      expect(ratio(over(color('var(--ic-text-2)'), under), under)).toBeGreaterThanOrEqual(4.5)
    }
  )
})

describe('N4 · the surfaces read only those tokens', () => {
  it('no translucent glass and no blur on a notification plate', () => {
    expect(SURFACES_CSS).not.toMatch(/--ic-surface-glass/)
    expect(SURFACES_CSS).not.toMatch(/backdrop-filter/)
  })

  it('text on a plate is --ic-note-ink / --ic-note-ink-2, never --ic-text-2 or --ic-text-3', () => {
    expect(SURFACES_CSS).not.toMatch(/var\(--ic-text-[23]\)/)
  })

  // v0.0.9 r3 (design N2): the quiet button's own ink is --ic-text-3 (40 %, under 3:1 on a plate). On a toast or a
  // banner, its actions must read the plate's measured inks: the leading action (tone="note") the full ink, the quiet
  // siblings --ic-note-ink-2. Red on fb85: no such rule, so Retry / Show details / Restart agent / More wore text-3.
  it('plate actions read the plate inks: tone="note" → --ic-note-ink, quiet siblings → --ic-note-ink-2', () => {
    const flat = SURFACES_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (selector: string) => {
      const at = flat.search(new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`))
      expect(at, selector).toBeGreaterThanOrEqual(0)
      const open = flat.indexOf('{', at)

      return flat.slice(open, flat.indexOf('}', open))
    }

    expect(rule('.icn-actions .icpg__btn--quiet')).toMatch(/color:\s*var\(--ic-note-ink-2\)/)
    expect(rule('.icn-banner__actions .icpg__btn--quiet')).toMatch(/color:\s*var\(--ic-note-ink-2\)/)
    expect(rule('.icpg__btn--note')).toMatch(/color:\s*var\(--ic-note-ink\);/)
  })

  it('no raw colour, radius, shadow or z-index literal (tokens only)', () => {
    expect(SURFACES_CSS).not.toMatch(/(?<![\w-])#[0-9a-fA-F]{3,8}(?![\w-])/)
    expect(SURFACES_CSS).not.toMatch(/(?<![\w-])(?:rgba?|hsla?)\(/)
    expect(SURFACES_CSS).not.toMatch(/border-radius:\s*\d/)
    expect(SURFACES_CSS).not.toMatch(/box-shadow:\s*\d/)
    expect(SURFACES_CSS).not.toMatch(/z-index:\s*\d/)
  })
})
