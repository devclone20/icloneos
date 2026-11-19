/**
 * v0.0.9 G-3 (design G verdict, 04-light): the banner hangs from the folded Message/Email tab group, so its centre is the
 * tabs' centre (±1px here; the shot's target is ±8 device px). Red on 0d197361ab: the banner kept the window's 16px
 * insets while the tabs centre on the frame (96px left, 72px right), 12px apart.
 */
import { describe, expect, it } from 'vitest'

import { read } from '@/test/token-contrast'

const BANNER = read('components/notification-system.css')
const WINDOW = read('app/home/window/ic-window.css')
const HOME = read('app/home/home.css')

const px = (css: string, name: string) => parseFloat(new RegExp(`${name}: (\\d+)px;`).exec(css)![1])
const FRAME = { left: px(HOME, '--ic-frame-left'), right: px(HOME, '--ic-frame-right') }

/** The declarations of `selector`'s LAST rule at the top level, or inside `@media (min-width: <media>px)`. */
function rule(css: string, selector: string, media?: number): Map<string, string> {
  let scope = css

  if (media) {
    const at = css.indexOf(`@media (min-width: ${media}px) {`)
    scope = css.slice(at, css.indexOf('\n}', at))
  } else {
    scope = css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
  }

  const at = scope.lastIndexOf(`${selector} {`)
  const found = new Map<string, string>()

  if (at < 0) {
    return found
  }

  const start = at + selector.length + 2
  const body = scope.slice(start, scope.indexOf('}', start))

  for (const match of body.matchAll(/(?:^|[;{\s])(left|right):\s*([^;]+);/g)) {
    found.set(match[1], match[2].replace(/\s+/g, ' ').trim())
  }

  return found
}

/** Evaluates a length expression made of px, rem, 100vw, var(--x, fallback), calc(), max(), min(), + and −. */
function evaluate(expression: string, vars: Record<string, number>, viewport = NaN): number {
  const js = expression
    .replace(/var\((--[\w-]+)(?:,\s*([\d.]+)px)?\)/g, (_m, name: string, fallback?: string) =>
      String(vars[name] ?? (fallback !== undefined ? Number(fallback) : NaN))
    )
    .replace(/100vw/g, String(viewport))
    .replace(/([\d.]+)rem/g, (_m, n: string) => String(Number(n) * 16))
    .replace(/([\d.]+)px/g, '$1')
    .replace(/calc\(/g, '(')
    .replace(/max\(/g, 'Math.max(')
    .replace(/min\(/g, 'Math.min(')

  return Function(`return (${js})`)() as number
}

// G re-shoot: the banner's minimum width beside an island (declared on .icn-banner-wrap).
const MIN_W = evaluate(/--icn-banner-min-w: ([^;]+);/.exec(BANNER)![1], {})

const VARS = {
  '--ic-frame-left': FRAME.left,
  '--ic-frame-right': FRAME.right,
  '--titlebar-controls-left': 78,
  '--iclone-island-w': 400,
  '--icn-banner-min-w': MIN_W
}

function centre(insets: Map<string, string>, width: number): number {
  const left = evaluate(insets.get('left')!, VARS, width)
  const right = evaluate(insets.get('right')!, VARS, width)

  return (left + width - right) / 2
}

describe('G-3: the banner centres on the folded pane tabs', () => {
  const tabs = rule(WINDOW, '.ihome .ic-pane-tabs')

  it('the tabs centre on the frame insets (the axis the banner must share)', () => {
    expect(tabs.get('left')).toBe('var(--ic-frame-left)')
    expect(tabs.get('right')).toBe('var(--ic-frame-right)')
    expect(FRAME.left).not.toBe(FRAME.right)
  })

  it.each([900, 1352, 1728])('no island, %ipx wide: banner centre = tab centre', width => {
    const banner = rule(BANNER, ":root[data-ic-panes='folded'] .icn-banner-wrap")

    expect(banner.size, 'a folded rule exists').toBe(2)
    expect(Math.abs(centre(banner, width) - centre(tabs, width))).toBeLessThanOrEqual(1)
    // The clamp: never nearer the edge than the base 16px.
    expect(evaluate(banner.get('left')!, VARS)).toBeGreaterThanOrEqual(16)
    expect(evaluate(banner.get('right')!, VARS)).toBeGreaterThanOrEqual(16)
  })

  it('the folded rule comes before the island rule, which still clears an open island', () => {
    const folded = BANNER.indexOf(":root[data-ic-panes='folded'] .icn-banner-wrap {")

    expect(folded).toBeGreaterThanOrEqual(0)
    expect(folded).toBeLessThan(BANNER.indexOf(':root[data-iclone-island] .icn-banner-wrap {'))
  })

  // Reviewed (v0.0.9 G re-shoot): centring now yields to the banner's minimum width. Where the minimum fits between
  // equal insets the banner is centred on the tabs as before; where it does not (1100, 1352 with a 400px island) the
  // banner is exactly the minimum, as near centred as that allows, and its right edge still clears the island.
  it.each([1100, 1352, 1728])('an island open, %ipx wide: centred on the tabs where the minimum fits, never under it', width => {
    const island = rule(BANNER, ':root[data-iclone-island] .icn-banner-wrap')
    const wide = rule(BANNER, ":root[data-ic-panes='folded'][data-iclone-island] .icn-banner-wrap", 1100)
    const insets = new Map([...island, ...wide])
    const left = evaluate(insets.get('left')!, VARS, width)
    const right = evaluate(insets.get('right')!, VARS, width)
    const symmetric = VARS['--iclone-island-w'] + 24 + VARS['--ic-frame-left'] - VARS['--ic-frame-right']

    expect(wide.has('left')).toBe(true)
    expect(width - left - right).toBeGreaterThanOrEqual(MIN_W - 0.5)
    expect(right).toBeGreaterThanOrEqual(VARS['--iclone-island-w'] + 24)

    if (width - symmetric - right >= MIN_W) {
      expect(Math.abs(centre(insets, width) - centre(tabs, width))).toBeLessThanOrEqual(1)
    } else {
      expect(Math.abs(width - left - right - MIN_W)).toBeLessThanOrEqual(0.5)
    }
  })
})
