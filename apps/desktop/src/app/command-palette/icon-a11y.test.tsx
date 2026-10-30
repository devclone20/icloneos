import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Check } from '@/lib/icons'

import { PaletteSheet } from './sheet'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

afterEach(cleanup)

describe('icons are decoration, never a nameless control (U4-p2-11)', () => {
  it('palette rows hide their icon', () => {
    render(
      <PaletteSheet
        bindings={{}}
        groups={[{ items: [{ icon: Check, id: 'x', label: 'Open the thing' }] }]}
        modHeld={false}
        noResultsLabel="Nothing"
        onClose={() => {}}
        onExited={() => {}}
        onSearchChange={() => {}}
        onSelect={() => {}}
        open
        placeholder="Search"
        search=""
        title="Commands"
      />
    )

    const icon = screen.getByRole('option', { name: 'Open the thing' }).querySelector('svg')

    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.getAttribute('focusable')).toBe('false')
  })

  it('trailing icons and the submenu chevron are hidden too (lab 2 r2: Change theme, Change color mode)', () => {
    render(
      <PaletteSheet
        bindings={{}}
        groups={[
          {
            items: [
              {
                icon: Check,
                id: 'theme',
                label: 'Change theme',
                to: 'theme',
                trailing: { icon: Check, label: 'Dark' }
              },
              {
                icon: Check,
                id: 'mode',
                label: 'Change color mode',
                trailing: { icon: Check, label: 'Auto', spin: true }
              }
            ]
          }
        ]}
        modHeld={false}
        noResultsLabel="Nothing"
        onClose={() => {}}
        onExited={() => {}}
        onSearchChange={() => {}}
        onSelect={() => {}}
        open
        placeholder="Search"
        search=""
        title="Commands"
      />
    )

    const options = screen.getAllByRole('option')

    expect(options).toHaveLength(2)
    expect(options.flatMap(option => [...option.querySelectorAll('svg')]).length).toBeGreaterThan(2)
    expect(options.filter(option => option.querySelector('svg:not([aria-hidden="true"])'))).toEqual([])
  })

  it("an active row's check and a nested page's back chevron are hidden too (lab 2 r3: theme page)", () => {
    render(
      <PaletteSheet
        bindings={{}}
        groups={[{ items: [{ active: true, icon: Check, id: 'dark', label: 'Dark' }] }]}
        modHeld={false}
        noResultsLabel="Nothing"
        onBack={() => {}}
        onClose={() => {}}
        onExited={() => {}}
        onSearchChange={() => {}}
        onSelect={() => {}}
        open
        pageTitle="Change theme"
        placeholder="Search"
        search=""
        title="Commands"
      />
    )

    const options = screen.getAllByRole('option')

    expect(options).toHaveLength(1)
    expect(options[0]?.querySelector('svg.icp-row__check')).not.toBeNull()
    expect(options.filter(option => option.querySelector('svg:not([aria-hidden="true"])'))).toEqual([])
    expect(window.document.querySelectorAll('.icp-back svg:not([aria-hidden="true"])')).toHaveLength(0)
    expect(window.document.querySelectorAll('.icp-back svg')).toHaveLength(1)
  })

  it('composer controls hide every @/lib/icons glyph', () => {
    const dir = resolve(__dirname, '../chat/composer')
    const offenders: string[] = []

    for (const file of readdirSync(dir).filter(f => f.endsWith('.tsx') && !f.includes('.test.'))) {
      const source = readFileSync(resolve(dir, file), 'utf8')
      const match = /import \{([^}]*)\} from '@\/lib\/icons'/.exec(source)

      if (!match) {
        continue
      }

      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(' as ').at(-1)

        if (!name) {
          continue
        }

        for (const tag of source.match(new RegExp(`<${name}(\\s[^<>]*?)?\\s*/>`, 'g')) ?? []) {
          if (!tag.includes('aria-hidden')) {
            offenders.push(`${file}: ${tag}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
