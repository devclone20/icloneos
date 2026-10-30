// K73: a thumbnail whose request hangs gives its slot back after THUMB_TIMEOUT_MS, so eight hung IPFS gateways
// never stall the rest of the grid. V3-BK: the face shows only the art, the checkbox and the status mark.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toInftCards } from '@/app/home/inft-scan'

import { BookCard, THUMB_TIMEOUT_MS } from './book-card'
import { fixtureItem } from './book-fixture'
import { clearThumbs, MAX_IN_FLIGHT, readThumb, thumbKey, thumbsInFlight } from './thumb-cache'

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    id,
    onCheckedChange,
    ...rest
  }: {
    'aria-label': string
    checked: boolean
    id: string
    onCheckedChange: (next: boolean) => void
  }) => (
    <input
      aria-label={rest['aria-label']}
      checked={checked}
      id={id}
      onChange={() => onCheckedChange(!checked)}
      type="checkbox"
    />
  )
}))

// fixtureItem(i) has an image for i % 5 >= 2 (and a broken scheme for i % 20 === 2): take 12 plain http ones.
const cards = toInftCards({
  ok: true,
  source: 'indexer',
  agents: Array.from({ length: 40 }, (_, i) => fixtureItem(i)).filter((_, i) => i % 5 >= 2 && i % 20 !== 2)
}).slice(0, 12)

const showOnHome = (name: string) => `show ${name}`
const labels = { setUp: 'Set up', setupNeeded: 'Setup needed', showOnHome }

beforeEach(() => {
  vi.useFakeTimers()
  clearThumbs()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Book thumbnails (K73)', () => {
  it('eight hung images free their slots after the timeout; the waiting ones then load', () => {
    const { container } = render(
      <div>
        {cards.map(card => (
          <BookCard
            card={card}
            checked={false}
            configured={false}
            key={card.id}
            onToggle={() => undefined}
            {...labels}
          />
        ))}
      </div>
    )

    expect(cards).toHaveLength(12)
    expect(thumbsInFlight()).toBe(MAX_IN_FLIGHT)
    expect(container.querySelectorAll('img')).toHaveLength(MAX_IN_FLIGHT)

    act(() => void vi.advanceTimersByTime(THUMB_TIMEOUT_MS - 1))
    expect(container.querySelectorAll('img')).toHaveLength(MAX_IN_FLIGHT)

    act(() => void vi.advanceTimersByTime(1))
    // The first eight are broken (monogram) and remembered; the last four got slots and are now requesting.
    expect(readThumb(thumbKey(cards[0]!))).toBe('broken')
    expect(container.querySelectorAll('img')).toHaveLength(4)
    expect(thumbsInFlight()).toBe(4)
  })

  it('an image that loads in time is never timed out', () => {
    const card = cards[0]!

    const { container } = render(
      <BookCard card={card} checked={false} configured={false} onToggle={() => undefined} {...labels} />
    )

    act(() => void fireEvent.load(container.querySelector('img')!))
    act(() => void vi.advanceTimersByTime(THUMB_TIMEOUT_MS * 2))

    expect(readThumb(thumbKey(card))).toBe('ok')
    expect(container.querySelector('img')).not.toBeNull()
    expect(thumbsInFlight()).toBe(0)
  })
})

describe('the Book card face (V3-BK, ruling 46)', () => {
  const card = cards[0]!

  it('shows no chain, name or collection text', () => {
    const { container } = render(<BookCard card={card} checked configured onToggle={() => undefined} {...labels} />)

    expect(
      container.querySelector('.inft-card__meta, .inft-card__chain, .inft-card__name, .inft-card__collection')
    ).toBeNull()
    expect(screen.queryByText(card.chain)).toBeNull()
    expect(screen.queryByText(card.name)).toBeNull()
    expect(screen.queryByText(card.collection)).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('a set-up iNFT carries the green check mark, named "Set up"', () => {
    const { container } = render(
      <BookCard card={card} checked={false} configured onToggle={() => undefined} {...labels} />
    )

    const mark = screen.getByRole('img', { name: 'Set up' })

    expect(mark.getAttribute('data-state')).toBe('set')
    expect(mark.querySelector('path')).not.toBeNull()
    expect(container.querySelector('[data-book-card]')!.getAttribute('title')).toBe(
      `${card.name} · ${card.collection}\nSet up`
    )
  })

  it('an iNFT that needs setup carries the neutral ring, named "Setup needed"', () => {
    const { container } = render(
      <BookCard card={card} checked={false} configured={false} onToggle={() => undefined} {...labels} />
    )

    const mark = screen.getByRole('img', { name: 'Setup needed' })

    expect(mark.getAttribute('data-state')).toBe('needed')
    expect(mark.querySelector('circle')).not.toBeNull()
    expect(container.querySelector('[data-book-card]')!.getAttribute('title')).toBe(
      `${card.name} · ${card.collection}\nSetup needed`
    )
  })

  it('the checkbox keeps the full name for screen readers and still toggles its card', () => {
    const onToggle = vi.fn()

    render(<BookCard card={card} checked={false} configured={false} onToggle={onToggle} {...labels} />)
    fireEvent.click(screen.getByRole('checkbox', { name: showOnHome(card.name) }))

    expect(onToggle).toHaveBeenCalledExactlyOnceWith(card.id)
  })
})
