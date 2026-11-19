/**
 * v0.0.9 r4 (design r3 N8): the split-docked banner's insets are derived from the measured titlebar, not `200px`, and
 * below 900px (where one line of title no longer fits between them) the banner stays the centred plate under the band.
 * Red on 5470b2b185: `left: 200px; right: 200px` at every width.
 */
import { describe, expect, it } from 'vitest'

import { read } from '@/test/token-contrast'

const CSS = read('components/notification-system.css').replace(/\/\*[\s\S]*?\*\//g, '')
const SPLIT = ":root[data-ic-panes='split']"

describe('split-docked banner geometry (design r3 N8)', () => {
  it('no split rule outside the ≥ 900px block; no magic inset anywhere', () => {
    const media = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(CSS)

    expect(media).not.toBeNull()
    expect(CSS.replace(media![0], '')).not.toContain(SPLIT)
    expect(CSS).not.toMatch(/(?:left|right):\s*200px/)
  })

  it('the inset is the larger of the window-button and frame-tool clearances, plus air, on both sides', () => {
    const block = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(CSS)![1]
    const wrap = block.slice(block.indexOf(`${SPLIT} .icn-banner-wrap {`))
    const body = wrap.slice(0, wrap.indexOf('}'))

    expect(body.replace(/\s+/g, ' ')).toContain(
      '--icn-dock-inset: max( calc(var(--titlebar-controls-left, 78px) + 12px), calc(var(--titlebar-tools-span, 188px) + 12px) );'
    )
    expect(body).toMatch(/left: var\(--icn-dock-inset\)/)
    expect(body).toMatch(/right: var\(--icn-dock-inset\)/)
  })

  it('both measured variables are published by the shell', () => {
    expect(read('app/shell/frame-tools.tsx')).toContain("root.style.setProperty('--titlebar-tools-span'")
    expect(read('app/contrib/wiring.tsx')).toContain("'--titlebar-controls-left'")
  })
})

describe('the centre count line (design r3 F4 b)', () => {
  it('says "No notifications" when empty, and counts otherwise', async () => {
    const { f4Centre } = await import('@/i18n/en/v009-f4')

    expect(f4Centre.count(0)).toBe('No notifications · last 200 kept')
    expect(f4Centre.count(1)).toBe('1 notification · last 200 kept')
    expect(f4Centre.count(7)).toBe('7 notifications · last 200 kept')
  })
})

// v0.0.9 r4b (critic-r4 04x): red on 4ba1f24493, where the centred banner covered the open centre's title.
describe('the banner and an open right-edge island never overlap', () => {
  it('while an island owns the right edge, the banner keeps clear of its width plus its edge gap', () => {
    const at = CSS.indexOf(':root[data-iclone-island] .icn-banner-wrap {')

    expect(at).toBeGreaterThanOrEqual(0)
    expect(CSS.slice(at, CSS.indexOf('}', at))).toMatch(/right: calc\(var\(--iclone-island-w, 400px\) \+ 24px\)/)

    // The centre sits 12px from the edge, so width + 24px leaves 12px of air between them.
    const centre = CSS.slice(CSS.indexOf('.icn-centre {'))

    expect(centre.slice(0, centre.indexOf('}'))).toMatch(/right: 12px/)
    // The split rule (the titlebar band, above the island's top) still wins in a split: it comes later.
    expect(at).toBeLessThan(CSS.indexOf('@media (min-width: 900px)'))
  })

  it('the centre publishes its width on the root while open', async () => {
    const edge = await import('@/app/home/right-edge')
    const release = edge.claimRightEdge('notifications', 'min(400px, calc(100vw - 24px))')

    expect(document.documentElement.dataset.icloneIsland).toBe('notifications')
    expect(document.documentElement.style.getPropertyValue('--iclone-island-w')).toBe('min(400px, calc(100vw - 24px))')
    release()
    expect(document.documentElement.dataset.icloneIsland).toBeUndefined()
  })
})

// r4d (design r4 F2-2), r5 (design R5-6), G re-shoot and the v0.0.9 UI lens: beside an open island the banner keeps
// clear of the window buttons where that costs it nothing, centres on the window from 1100px where its minimum fits,
// and never goes under --icn-banner-min-w where the window can hold it (from 952px beside a 400px island; the lens
// found 386px at 900-1026px). Reviewed: the rule text is evaluated as geometry, not matched as a string.
describe('the banner beside an open island', () => {
  const island = 400
  const controls = 78
  const min = 32 * 16

  /** The last `left:`/`right:` of `selector` at the top level, or inside `@media (min-width: <media>px)`. */
  const inset = (selector: string, side: 'left' | 'right', media?: number) => {
    const scope = media
      ? CSS.slice(CSS.indexOf(`@media (min-width: ${media}px) {`), CSS.indexOf('\n}', CSS.indexOf(`@media (min-width: ${media}px) {`)))
      : CSS.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')

    const at = scope.lastIndexOf(`${selector} {`)
    const body = at < 0 ? '' : scope.slice(at, scope.indexOf('}', at))

    return new RegExp(`(?:^|[;{\\s])${side}:\\s*([^;]+);`).exec(body)?.[1].replace(/\s+/g, ' ').trim()
  }

  const evaluate = (expression: string, width: number) =>
    Function(
      `return (${expression
        .replace(/var\(--iclone-island-w, 400px\)/g, String(island))
        .replace(/var\(--titlebar-controls-left, 78px\)/g, String(controls))
        .replace(/var\(--icn-banner-min-w\)/g, String(min))
        .replace(/100vw/g, String(width))
        .replace(/([\d.]+)px/g, '$1')
        .replace(/calc\(/g, '(')
        .replace(/max\(/g, 'Math.max(')
        .replace(/min\(/g, 'Math.min(')})`
    )() as number

  it.each([960, 1100, 1352, 1728])('%ipx wide: its minimum, the 16px floor, the window-button clearance when free', width => {
    const selector = ':root[data-iclone-island] .icn-banner-wrap'
    const left = evaluate(inset(selector, 'left', width >= 1100 ? 1100 : undefined) ?? inset(selector, 'left')!, width)
    const right = evaluate(inset(selector, 'right')!, width)

    expect(right).toBe(island + 24)
    expect(left).toBeGreaterThanOrEqual(16)
    expect(width - left - right).toBeGreaterThanOrEqual(min - 0.5)

    if (width - right - min >= controls + 12) {
      expect(left).toBeGreaterThanOrEqual(controls + 12)
    }

    if (width >= 1100 && width - 2 * (island + 24) >= min) {
      expect(left).toBe(island + 24)
    }
  })

  it('the wide rule comes before the split rule, which still wins in a split', () => {
    expect(CSS.indexOf('@media (min-width: 1100px)')).toBeLessThan(CSS.indexOf('@media (min-width: 900px)'))
  })
})

