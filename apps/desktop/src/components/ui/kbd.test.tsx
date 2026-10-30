import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Kbd, KbdGroup } from './kbd'

afterEach(cleanup)

// U3-07: 10px shortcut hints measured 3.1:1 (ghost, 38% mix) and 2.5:1 (the
// sidebar ⌘N, dimmed with opacity-55). Hints read on a text token, never on a
// lower ad-hoc mix or an opacity utility.
describe('kbd hint legibility', () => {
  it('puts the ghost label on the tertiary text token, replacing the surface text', () => {
    render(
      <Kbd size="sm" variant="ghost">
        K
      </Kbd>
    )

    const classes = screen.getByText('K').className.split(/\s+/)
    const textColors = classes.filter(c => /^text-(\(--|\[color-mix)/.test(c))

    expect(textColors).toEqual(['text-(--ui-text-tertiary)'])
    expect(classes).toContain('text-[0.625rem]')
  })

  it('keeps the default label on its own surface text', () => {
    render(<Kbd>N</Kbd>)

    expect(screen.getByText('N').className).toContain('text-[color-mix(in_srgb,var(--dt-foreground)_58%,transparent)]')
  })

  it('passes the variant to every key of a group', () => {
    render(<KbdGroup keys={['⌘', 'N']} size="sm" variant="ghost" />)

    for (const key of ['⌘', 'N']) {
      expect(screen.getByText(key).className).toContain('text-(--ui-text-tertiary)')
    }
  })

  it('never dims the sidebar New-session hint with opacity', () => {
    const source = readFileSync(join(import.meta.dirname, '../../app/chat/sidebar/index.tsx'), 'utf8')
    const hint = source.match(/<KbdGroup\b[^>]*keys=\{newSessionKbd\}[^>]*\/>/s)?.[0] ?? ''
    // The tag reads its class from a const; check the definition too, up to the blank line that ends it.
    const hintClass = source.match(/const newSessionKbdClass\s*=\s*([\s\S]*?)\n\s*\n/)?.[1]

    expect(hint).toContain('variant="ghost"')
    expect(hint).toContain('className={newSessionKbdClass}')
    expect(hint).not.toMatch(/opacity-/)
    expect(hintClass).toBeDefined()
    expect(hintClass).not.toMatch(/opacity-/)
  })
})
