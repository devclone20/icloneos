/**
 * v0.0.9 r4 (design r3 N3, "the boot card has no visible primary"). Cascade layers are ordered by FIRST appearance.
 * The packaged index.html links ic-system.css before the Tailwind sheet, so a sheet whose first word is
 * `@layer components { … }` sorts `components` under Tailwind's `base`, and preflight's button reset
 * (transparent, padding 0, radius 0) beats every .ic-btn variant. Red on 5470b2b185: ic-system.css opened with a
 * bare `@layer components {` block.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../..')
const TAILWIND_ORDER = ['properties', 'theme', 'base', 'components', 'utilities']

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)

    return entry.isDirectory() ? cssFiles(full) : entry.name.endsWith('.css') ? [full] : []
  })
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('cascade layer order never depends on which sheet loads first', () => {
  const layered = cssFiles(SRC).filter(file => /@layer\s+[a-z-]+\s*\{/.test(strip(fs.readFileSync(file, 'utf8'))))

  it('finds the layered app sheets (the test is not vacuous)', () => {
    expect(layered.map(file => path.relative(SRC, file))).toContain(path.join('components', 'ic', 'ic-system.css'))
  })

  it.each(layered.filter(file => !file.endsWith(`${path.sep}styles.css`)).map(file => path.relative(SRC, file)))(
    '%s states the Tailwind layer order before its first layer block',
    file => {
      const css = strip(fs.readFileSync(path.join(SRC, file), 'utf8'))
      const firstBlock = css.search(/@layer\s+[a-z-]+\s*\{/)
      const statement = /@layer\s+([a-z-]+(?:\s*,\s*[a-z-]+)+)\s*;/.exec(css)

      expect(statement, 'an @layer order statement').not.toBeNull()
      expect(statement!.index).toBeLessThan(firstBlock)
      expect(statement![1].split(',').map(name => name.trim())).toEqual(TAILWIND_ORDER)
    }
  )

  it('Tailwind still declares theme → base → components → utilities (the statement must never reorder it)', () => {
    const tw = fs.readFileSync(createRequire(import.meta.url).resolve('tailwindcss/index.css'), 'utf8')
    const declared = /@layer\s+([a-z-]+(?:\s*,\s*[a-z-]+)+)\s*;/.exec(tw)

    expect(declared?.[1].split(',').map(name => name.trim())).toEqual(TAILWIND_ORDER.slice(1))
  })
})
