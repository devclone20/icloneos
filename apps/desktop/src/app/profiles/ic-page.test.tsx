import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The page chassis itself moved to src/components/ic/ (front IC); its component
// tests went with it. What stays here is the check that cannot move: every file
// of THIS page folder, read from disk, plus the chassis files it now imports.
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

// The point of this front: the pages are OURS. A re-skin would show up here as
// an import of the old design's components or one of its colour utilities.
describe('no old-design surface', () => {
  // Every source file of the page, read from disk: a new file is covered the
  // day it is written, which is how create/rename/delete slipped back onto the
  // upstream dialog after r1 (ticket E3d2-T1).
  const OURS = [
    ...readdirSync(dirname(fileURLToPath(import.meta.url)))
      .filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'))
      .sort(),
    // The chassis moved to the one home (front IC, 2026-10-19) and `ic-page.tsx`
    // here is its re-export shim, so the hygiene follows the real files.
    '../../components/ic/ic-page.tsx',
    '../../components/ic/state.tsx'
  ]

  const BANNED_IMPORT = /from '(@\/components\/(ui|chat|page-loader)|\.\.\/overlays\/panel|@\/components\/ui\/.*)'/

  const TAILWIND_CLASS =
    /className=(?:"|{`)[^"`]*\b(?:min-w-0|flex|grid|gap-\d|p[xytblr]?-\d|m[xytblr]?-\d|text-(?:xs|sm|base|lg|xl)|font-(?:mono|medium|semibold|bold)|rounded(?:-\w+)?|size-\d|w-\d|h-\d|items-\w+|justify-\w+|shrink-0|truncate|animate-\w+)\b/

  const BANNED_CLASS =
    /\b(?:text|bg|border|ring|fill|from|to)-(?:muted-foreground|foreground|background|card|popover|accent|primary|secondary|destructive|border|muted)\b/

  for (const file of OURS) {
    it(`${file} imports no old-design component`, () => {
      expect(read(file)).not.toMatch(BANNED_IMPORT)
    })

    it(`${file} paints with our tokens only`, () => {
      expect(read(file)).not.toMatch(BANNED_CLASS)
    })

    it(`${file} carries no utility classes and no other page's copy`, () => {
      const source = read(file)

      // Our look is one stylesheet of `icpg__*`/`icdlg__*` rules. A Tailwind
      // utility here is the upstream theme leaking back in (E3d2-T3).
      expect(source).not.toMatch(TAILWIND_CLASS)
      // Borrowing a Settings string put developer copy in front of the user.
      expect(source).not.toContain('t.settings.')
    })
  }

  it('the look is one stylesheet on the --ic-* table', () => {
    const css = read('../../components/ic/ic-page.css')

    expect(css).toContain("@import '../../app/home/ic-tokens.css'")
    expect(css).toMatch(/--ic-surface/)
    expect(css).not.toMatch(BANNED_CLASS)
  })
})
