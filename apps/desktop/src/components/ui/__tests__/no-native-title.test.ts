import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Static-analysis guard: no <button> or <Button> element in the desktop renderer
// may use the native HTML `title=` attribute. Native tooltips are unstyled,
// delayed (~500ms OS default), and visually inconsistent with the themed `Tip`.
// When a tip is warranted (see DESIGN.md — not every icon, never menu triggers),
// use `<Tip label={...}>` instead of `title=`.
//
// This is a source scan, not a behavior test — it's the same category as an
// ESLint rule, expressed as a vitest so it runs with the rest of the suite. It
// reads the TypeScript AST, not the text: a regex over the opening tag stops at
// the first `>` it meets, which is the `>` of any arrow prop (`onClick={() => …}`)
// written before `title=`, and so missed most of the sites it existed to find.

// Recursively walk a directory and collect all .tsx file paths.
function collectTsxFiles(dir: string): string[] {
  const results: string[] = []

  for (const entry of readdirSync(dir)) {
    // Skip node_modules, dist, and __tests__ (this file itself)
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') {
      continue
    }

    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      results.push(...collectTsxFiles(fullPath))
    } else if (entry.endsWith('.tsx')) {
      results.push(fullPath)
    }
  }

  return results
}

/** Every <button> / <Button> element in `source` carrying a `title` attribute, as `name:line <tag>`. */
function nativeTitleSitesIn(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const sites: string[] = []

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file)

      const hasTitle = node.attributes.properties.some(
        attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'title'
      )

      if ((tag === 'button' || tag === 'Button') && hasTitle) {
        sites.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} <${tag}>`)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(file)

  return sites
}

function nativeTitleSites(srcDir: string): string[] {
  return collectTsxFiles(srcDir).flatMap(filePath =>
    nativeTitleSitesIn(relative(srcDir, filePath), readFileSync(filePath, 'utf-8'))
  )
}

interface Exemption {
  count: number
  owner: string
  since: string
  until: string
}

// LEAD 2026-10-20 15:20: front I's phase-2 foundation (r7/r8) cleared every native title= on the Settings
// surface (critic probe L.I.r7crit.native_title_settings 0), so the dated FRONT_I_SETTINGS exemption rows
// are gone. Empty on purpose: the next exemption needs an owner, a date, an until and an exact count.
const EXEMPT: Record<string, Exemption> = {}

describe('no native title= on button elements', () => {
  const srcDir = resolve(__dirname, '../../..')
  const sites = nativeTitleSites(srcDir)

  it('scans the whole renderer tree, not one folder of it', () => {
    expect(basename(srcDir)).toBe('src')
  })

  it('sees a title= written after an arrow prop, across lines, on both tag spellings', () => {
    const source = [
      'export const A = () => (',
      '  <>',
      '    <button onClick={() => go()} title="after an arrow" type="button" />',
      '    <Button',
      '      disabled={count > limit}',
      '      title="after a comparison"',
      '    >',
      '      x',
      '    </Button>',
      '    <button aria-label="no title" onClick={() => go()} type="button" />',
      '  </>',
      ')'
    ].join('\n')

    expect(nativeTitleSitesIn('fixture.tsx', source)).toEqual(['fixture.tsx:3 <button>', 'fixture.tsx:4 <Button>'])
  })

  it('uses <Tip> instead of native title= on all button elements', () => {
    const violations = sites
      .filter(site => !(site.slice(0, site.indexOf(':')) in EXEMPT))
      .map(site => `${site} has title= — use <Tip>`)

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps every exemption live: each listed file exists and still has exactly its count', () => {
    const stale = Object.entries(EXEMPT).flatMap(([file, { count }]) => {
      if (!existsSync(join(srcDir, file))) {
        return [`${file}: listed but does not exist — remove the entry`]
      }

      const found = sites.filter(site => site.startsWith(`${file}:`)).length

      return found === count ? [] : [`${file}: exempted ${count}, found ${found} — update or remove the exemption`]
    })

    expect(stale, stale.join('\n')).toEqual([])
  })
})
