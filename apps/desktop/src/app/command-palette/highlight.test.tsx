import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PaletteHighlight } from './highlight'

afterEach(cleanup)

const marks = (search: string, text: string) =>
  [...render(<PaletteHighlight search={search} text={text} />).container.querySelectorAll('mark')].map(
    node => node.textContent
  )

describe('PaletteHighlight', () => {
  it('marks every occurrence of every typed term, case-insensitively', () => {
    expect(marks('new  SESSION', 'New session in a new window')).toEqual(['New', 'session', 'new'])
  })

  it('merges adjacent and overlapping terms into one mark', () => {
    expect(marks('the them', 'themes')).toEqual(['them'])
  })

  it('leaves the label alone when the row matched on something else', () => {
    const { container } = render(<PaletteHighlight search="zzz" text="Toggle sidebar" />)

    expect(container.querySelectorAll('mark')).toHaveLength(0)
    expect(container.textContent).toBe('Toggle sidebar')
  })

  it("paints in the sheet's own ink, not the shared component's default accent", () => {
    // tailwind-merge resolves the text-colour conflict in favour of the last
    // class, so the gold never depends on stylesheet order.
    const { container } = render(<PaletteHighlight search="a" text="a" />)
    const className = container.querySelector('mark')?.className ?? ''

    expect(className.split(/\s+/)).toContain('icp-mark')
    expect(className).toContain('text-(--ic-accent-strong)')
    expect(className).not.toContain('--ui-accent')
  })
})
