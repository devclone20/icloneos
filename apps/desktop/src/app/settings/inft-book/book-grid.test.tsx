import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { toInftCards } from '@/app/home/inft-scan'

import { fixtureId, fixtureItem } from './book-fixture'
import { BookGrid, columnsFor } from './book-grid'

// One render of the (memoised) card = one render of its checkbox.
const checkboxRenders = vi.hoisted(() => new Map<string, number>())

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, id, ...rest }: { checked: boolean; id: string; 'aria-label': string }) => {
    const label = rest['aria-label']

    checkboxRenders.set(label, (checkboxRenders.get(label) ?? 0) + 1)

    return <input aria-label={label} checked={checked} id={id} readOnly type="checkbox" />
  }
}))

const VIEWPORT = { width: 700, height: 800 }

const cards = toInftCards({
  ok: true,
  source: 'indexer',
  agents: Array.from({ length: 1_000 }, (_, i) => fixtureItem(i))
})

const showOnHome = (name: string) => `show ${name}`
// V3-BK: the status mark's inputs; a fresh (equal) set on every render must not re-render any card either.
const status = () => ({ configured: new Set([cards[2]!.id]), setUp: 'Set up', setupNeeded: 'Setup needed' })
const restore: Array<() => void> = []

function stub(property: 'clientWidth' | 'offsetHeight' | 'offsetWidth', value: number) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)

  Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => value })
  restore.push(() => original && Object.defineProperty(HTMLElement.prototype, property, original))
}

beforeAll(() => {
  stub('clientWidth', VIEWPORT.width)
  stub('offsetWidth', VIEWPORT.width)
  stub('offsetHeight', VIEWPORT.height)
})

afterAll(() => restore.forEach(undo => undo()))

afterEach(() => {
  cleanup()
  checkboxRenders.clear()
})

const domCards = (container: HTMLElement) => container.querySelectorAll('[data-book-card]').length

describe('the Book grid over 1 000 iNFTs (G1/G2/G3)', () => {
  it('virtualises: the first 12 cards paint, and the DOM never holds more than 60 cards while scrolling', () => {
    const started = performance.now()

    const { container } = render(
      <BookGrid
        cards={cards}
        checked={new Set()}
        label="Book"
        onToggle={() => undefined}
        showOnHome={showOnHome}
        {...status()}
      />
    )

    const firstPaintMs = performance.now() - started

    const ids = [...container.querySelectorAll('[data-book-card]')].map(el => el.getAttribute('data-book-card'))

    expect(ids.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => cards[i]?.id))
    expect(domCards(container)).toBeLessThanOrEqual(60)

    const scroller = container.querySelector<HTMLElement>('.inft-book__scroll')!
    let worst = 0

    for (let top = 0; top <= 250 * 188; top += 1_500) {
      act(() => {
        scroller.scrollTop = top
        scroller.dispatchEvent(new Event('scroll'))
      })
      worst = Math.max(worst, domCards(container))
    }

    expect(worst).toBeLessThanOrEqual(60)
    // The last card is reachable.
    expect(container.querySelector(`[data-book-card="${fixtureId(999)}"]`)).not.toBeNull()
    // Recorded by the gate script (V3H_gates.sh greps this line).
    console.info(`[V3H] grid 1000 first render ${firstPaintMs.toFixed(1)} ms · max DOM cards ${worst}`)
  })

  it('checking one card re-renders that card and no other', () => {
    const onToggle = vi.fn()

    const { rerender } = render(
      <BookGrid
        cards={cards}
        checked={new Set()}
        label="Book"
        onToggle={onToggle}
        showOnHome={showOnHome}
        {...status()}
      />
    )

    const before = new Map(checkboxRenders)

    rerender(
      <BookGrid
        cards={cards}
        checked={new Set([cards[5]!.id])}
        label="Book"
        onToggle={onToggle}
        showOnHome={showOnHome}
        {...status()}
      />
    )

    const rerendered = [...checkboxRenders]
      .filter(([label, count]) => count !== before.get(label))
      .map(([label]) => label)

    expect(rerendered).toEqual([showOnHome(cards[5]!.name)])
  })

  it('columns follow the pane width', () => {
    expect(columnsFor(0)).toBe(1)
    expect(columnsFor(700)).toBe(4)
    expect(columnsFor(1_200)).toBe(7)
  })
})
