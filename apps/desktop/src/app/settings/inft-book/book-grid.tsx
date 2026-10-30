/**
 * The iNFT Book grid, virtualised by ROW (`useVirtualizer`, overscan 3): only
 * the rows in or near the viewport are in the DOM, so 1 000 iNFTs cost the
 * same to paint as 30. Columns follow the pane's width; every row has the
 * same height, so no measurement pass is needed.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { type JSX, useLayoutEffect, useRef, useState } from 'react'

import type { INftCardData } from '@/app/home/collections'

import { BookCard } from './book-card'

const MIN_CARD_PX = 148
const GAP_PX = 12
const CARD_PX = 176
const ROW_PX = CARD_PX + GAP_PX
const OVERSCAN_ROWS = 3
// The first frame's guess, before the pane reports its size: 4 columns × ~4 rows,
// so the first 12 cards paint in the very first commit.
const INITIAL_RECT = { width: 4 * MIN_CARD_PX + 3 * GAP_PX, height: 4 * ROW_PX }

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GAP_PX) / (MIN_CARD_PX + GAP_PX)))
}

interface BookGridProps {
  cards: readonly INftCardData[]
  checked: ReadonlySet<string>
  /** Ids of the set-up iNFTs (Virtuals CLI configured) — each card gets a boolean, so the memo holds. */
  configured: ReadonlySet<string>
  label: string
  onToggle: (id: string) => void
  setUp: string
  setupNeeded: string
  showOnHome: (name: string) => string
}

export function BookGrid({
  cards,
  checked,
  configured,
  label,
  onToggle,
  setUp,
  setupNeeded,
  showOnHome
}: BookGridProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(INITIAL_RECT.width)
  const columns = columnsFor(width)

  useLayoutEffect(() => {
    const element = scrollRef.current

    if (!element) {
      return
    }

    if (element.clientWidth > 0) {
      setWidth(element.clientWidth)
    }

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setWidth(entry.contentRect.width)
      }
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const virtualizer = useVirtualizer({
    count: Math.ceil(cards.length / columns),
    estimateSize: () => ROW_PX,
    getScrollElement: () => scrollRef.current,
    initialRect: INITIAL_RECT,
    overscan: OVERSCAN_ROWS
  })

  return (
    <div aria-label={label} className="inft-book__scroll" ref={scrollRef} role="group">
      <div className="inft-book__spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(row => (
          <div
            className="inft-book__row"
            data-index={row.index}
            key={row.key}
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              transform: `translateY(${row.start}px)`
            }}
          >
            {cards.slice(row.index * columns, row.index * columns + columns).map(card => (
              <BookCard
                card={card}
                checked={checked.has(card.id)}
                configured={configured.has(card.id)}
                key={card.id}
                onToggle={onToggle}
                setUp={setUp}
                setupNeeded={setupNeeded}
                showOnHome={showOnHome}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
