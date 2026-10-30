import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { TEXT_SCALE } from '../src/lib/text-size'

import {
  auditDecls,
  classifySize,
  contextFor,
  type CssRoot,
  findCarriers,
  scaleFontShorthand,
  scanCss,
  splitTop,
  textScale
} from './postcss-text-scale'

// postcss ships with Vite (not a direct dependency): resolve it the way Vite does.
const fromHere = createRequire(import.meta.url)

const postcss = createRequire(fromHere.resolve('vite/package.json'))('postcss') as {
  (plugins: unknown[]): { process(css: string, opts: { from?: string }): { css: string } }
  parse(css: string): CssRoot
}

const run = (css: string): string => postcss([textScale({ sourceDirs: [] })]).process(css, { from: undefined }).css

describe('classifySize', () => {
  const defs = new Map([
    ['--text-xs', ['0.75rem']],
    ['--text-xs--line-height', ['calc(1 / 0.75)']],
    ['--spacing', ['0.25rem']],
    ['--leading', ['calc(var(--spacing) * 6)', '1.25', 'initial']],
    ['--loop', ['var(--loop)']]
  ])

  it.each([
    ['0.8125rem', 'abs'],
    ['13px', 'abs'],
    ['10pt', 'abs'],
    ['var(--text-xs)', 'abs'],
    ['calc(var(--spacing) * 6)', 'abs'],
    ['clamp(0.75rem, 1rem, 2rem)', 'abs'],
    ['var(--missing, 0.875rem)', 'abs'],
    ['0.875em', 'rel'],
    ['120%', 'rel'],
    ['1.5', 'rel'],
    ['var(--text-xs--line-height)', 'rel'],
    ['inherit', 'rel'],
    ['smaller', 'rel'],
    ['2vw', 'rel'],
    ['calc(1rem - 2px)', 'abs'],
    ['calc(1em + 2px)', 'mixed'],
    ['var(--leading, var(--text-xs--line-height))', 'mixed'],
    ['var(--missing)', 'unknown'],
    ['var(--loop)', 'unknown'],
    ['attr(data-size)', 'unknown']
  ])('%s → %s', (value, kind) => {
    expect(classifySize(value, defs)).toBe(kind)
  })

  it('treats math constants as factors, not keywords', () => {
    expect(classifySize('min(1rem, infinity * 1px)')).toBe('abs')
  })
})

describe('splitTop', () => {
  it('ignores separators inside parentheses', () => {
    expect(splitTop('a calc(1px + 2px) b')).toEqual(['a', 'calc(1px + 2px)', 'b'])
    expect(splitTop('var(--a, 1px), 2px', ',')).toEqual(['var(--a, 1px)', '2px'])
  })
})

describe('scaleFontShorthand', () => {
  it('scales an absolute size and line-height, leaves weight and family', () => {
    expect(scaleFontShorthand('600 13px/16px Inter, sans-serif')).toBe(
      '600 max(min(13px, 10px), calc(13px * var(--ic-text-scale, 1)))/max(min(16px, 12px), calc(16px * var(--ic-text-scale, 1))) Inter, sans-serif'
    )
  })

  it('keeps a unitless line-height and relative sizes', () => {
    expect(scaleFontShorthand('normal normal normal 16px/1 codicon')).toBe(
      'normal normal normal max(min(16px, 10px), calc(16px * var(--ic-text-scale, 1)))/1 codicon'
    )
    expect(scaleFontShorthand('normal 1.21em KaTeX_Main, serif')).toBe('normal 1.21em KaTeX_Main, serif')
    expect(scaleFontShorthand('inherit')).toBe('inherit')
  })
})

describe('findCarriers', () => {
  it('finds a property read whole by a mixed line-height', () => {
    const defs = new Map([['--tw-leading', ['1.25rem', '1.5']]])

    expect([...findCarriers(['var(--tw-leading, 1.5)', '1rem'], defs)]).toEqual(['--tw-leading'])
  })
})

/** The px a floored declaration resolves to at a given scale. */
function resolvedPx(emitted: string, scale: number): number {
  const match = /^max\(min\((\d+(?:\.\d+)?)px, (\d+)px\), calc\(\1px \* var\(--ic-text-scale, 1\)\)\)$/.exec(emitted)

  if (!match) {
    throw new Error(`not a floored px size: ${emitted}`)
  }

  const [, px, floor] = match

  return Math.max(Math.min(Number(px), Number(floor)), Number(px) * scale)
}

describe('textScale plugin', () => {
  it('U3-p2-08: at Small no font-size lands under 10px (line-height 12px), and Default is untouched', () => {
    const sizes = [5, 8, 10, 11, 14, 22]
    const out = run(sizes.map(px => `.s${px}{font-size:${px}px;line-height:${px + 4}px}`).join(''))

    for (const px of sizes) {
      const [, fontSize, lineHeight] =
        /font-size:([^;]+);line-height:([^}]+)}/.exec(out.split(`.s${px}{`)[1] ?? '') ?? []

      expect(resolvedPx(fontSize ?? '', 1)).toBe(px)
      expect(resolvedPx(lineHeight ?? '', 1)).toBe(px + 4)
      expect(resolvedPx(fontSize ?? '', TEXT_SCALE.small)).toBeGreaterThanOrEqual(Math.min(px, 10))
      expect(resolvedPx(lineHeight ?? '', TEXT_SCALE.small)).toBeGreaterThanOrEqual(Math.min(px + 4, 12))
    }

    expect(resolvedPx(/font-size:([^;]+);/.exec(out.split('.s14{')[1] ?? '')?.[1] ?? '', TEXT_SCALE.small)).toBe(11.9)
  })

  it('wraps absolute font-size and line-height, never twice', () => {
    const once = run('.a{font-size:0.75rem;line-height:1rem}')

    expect(once).toBe(
      '.a{font-size:max(min(0.75rem, 10px), calc(0.75rem * var(--ic-text-scale, 1)));line-height:max(min(1rem, 12px), calc(1rem * var(--ic-text-scale, 1)))}'
    )
    expect(run(once)).toBe(once)
  })

  it('leaves relative values and token definitions alone', () => {
    const css = ':root{--text-xs:0.75rem}.a{font-size:0.875em;line-height:1.5}.b{font-size:var(--text-xs)}'

    expect(run(css)).toBe(
      ':root{--text-xs:0.75rem}.a{font-size:0.875em;line-height:1.5}.b{font-size:max(min(var(--text-xs), 10px), calc(var(--text-xs) * var(--ic-text-scale, 1)))}'
    )
  })

  it('keeps the root font-size (it sets the rem) and icon glyph sizes', () => {
    const css = 'html{font-size:1rem}:root.dark{font-size:15px}.codicon[class*=codicon-]{font:normal 16px/1 codicon}'

    expect(run(css)).toBe(css)
    expect(run('html body{font-size:1rem}')).toBe(
      'html body{font-size:max(min(1rem, 10px), calc(1rem * var(--ic-text-scale, 1)))}'
    )
  })

  it('scales the absolute definitions of a carrier, not its mixed reader', () => {
    const css = [
      '.leading-6{--tw-leading:calc(var(--spacing) * 6);line-height:calc(var(--spacing) * 6)}',
      '.leading-tight{--tw-leading:1.25;line-height:1.25}',
      '.text-xs{font-size:var(--text-xs);line-height:var(--tw-leading, var(--text-xs--line-height))}',
      ':root{--spacing:0.25rem;--text-xs:0.75rem;--text-xs--line-height:calc(1 / 0.75)}'
    ].join('')

    const out = run(css)

    expect(out).toContain(
      '--tw-leading:max(min(calc(var(--spacing) * 6), 10px), calc(calc(var(--spacing) * 6) * var(--ic-text-scale, 1)))'
    )
    expect(out).toContain('--tw-leading:1.25;')
    expect(out).toContain('line-height:var(--tw-leading, var(--text-xs--line-height))')
    expect(out).toContain('font-size:max(min(var(--text-xs), 10px), calc(var(--text-xs) * var(--ic-text-scale, 1)))')
  })

  it('resolves tokens defined in another stylesheet through scanned sources', () => {
    const global = scanCss(':root{--ic-type-sm:0.6875rem;--lh:1.4}/* --x: 1px */')
    const root = postcss.parse('.a{font-size:var(--ic-type-sm)}.b{line-height:var(--lh)}.c{font-size:var(--nowhere)}')
    const ctx = contextFor(root, global)

    expect(global.defs.has('--x')).toBe(false)
    expect(classifySize('var(--ic-type-sm)', ctx.defs)).toBe('abs')
    expect(auditDecls(root, ctx).map(entry => [entry.selector, entry.kind])).toEqual([
      ['.a', 'abs'],
      ['.c', 'unknown']
    ])
  })
})
