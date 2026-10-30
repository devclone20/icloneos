/**
 * K102 (design freeze S24 / C1): the three files V3-F created speak icloneOS tokens only. No Tailwind utility over the
 * old Hermes colour aliases (the `--color-*: var(--dt-*)` names declared in styles.css, read from there), no Hermes
 * radius scale (`rounded-sm|md|lg|xl`) and no `--stroke-nous`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../..')

const V3F_FILES = [
  'components/consent/permission-ask.tsx',
  'components/permissions/permissions-pane.tsx',
  'components/permissions/mode-picker.tsx'
]

const ALIASES = [
  ...readFileSync(path.join(SRC, 'styles.css'), 'utf8').matchAll(/--color-([a-z-]+):\s*var\(--dt-/g)
].map(match => match[1])

const UTILITY =
  /(?:^|[\s'"`(:])(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|divide|outline|from|to|via|placeholder|decoration)-([a-z-]+)(?:\/\d+)?(?=[\s'"`)]|$)/g

function offenders(text: string): string[] {
  const found: string[] = []

  for (const match of text.matchAll(UTILITY)) {
    if (ALIASES.includes(match[1])) {
      found.push(match[0].replace(/^[\s'"`(:]/, ''))
    }
  }

  for (const match of text.matchAll(/\brounded-(?:sm|md|lg|xl|2xl)\b|--stroke-nous/g)) {
    found.push(match[0])
  }

  return found
}

describe('K102: V3-F files use the icloneOS tokens', () => {
  it('the alias list is read from styles.css (control)', () => {
    expect(ALIASES).toEqual(expect.arrayContaining(['foreground', 'muted-foreground', 'destructive', 'border', 'card']))
  })

  it('the detector bites on each old spelling (control)', () => {
    expect(offenders('className="text-foreground"')).toEqual(['text-foreground'])
    expect(offenders("'mt-1 text-muted-foreground'")).toEqual(['text-muted-foreground'])
    expect(offenders('"hover:text-destructive/80"')).toEqual(['hover:text-destructive/80'])
    expect(offenders('"rounded-md border border-(--stroke-nous)"')).toEqual(['rounded-md', '--stroke-nous'])
    expect(offenders('"text-(--ic-text-1) rounded-(--ic-radius-sm) border-(--ic-border-subtle)"')).toEqual([])
  })

  it.each(V3F_FILES)('%s has no Hermes alias utility, radius or stroke', file => {
    expect(offenders(readFileSync(path.join(SRC, file), 'utf8'))).toEqual([])
  })
})
