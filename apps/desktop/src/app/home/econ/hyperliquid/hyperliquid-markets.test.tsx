import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { HlMarket } from './hyperliquid-data'
import { MarketsSection, oldestQuoteMs, quoteAge } from './hyperliquid-markets'

// The markets list moved out of hyperliquid-app.tsx. These snapshots were recorded from the list as it was
// inside the app, so any change to the markup it renders fails here.

type MarketsCase = Pick<
  Parameters<typeof MarketsSection>[0],
  'error' | 'favourites' | 'loading' | 'markets' | 'onlyFavourites' | 'selectedSymbol'
>

function market(symbol: string, name: string, priceUsd: null | number, change24hPct: null | number): HlMarket {
  return {
    asOf: Date.now() - 60_000,
    change24hPct,
    minBuyUsd: 10,
    name,
    priceUsd,
    protocols: ['hyperliquid'],
    search: `${symbol} ${name}`.toLowerCase(),
    sharePriceUsd: null,
    symbol
  }
}

const markets = [
  market('BTC', 'Bitcoin', 67_250.5, 2.31),
  market('ETH', 'Ether', 3_120.04, -1.2),
  market('HYPE', 'Hyperliquid', null, null)
]

const idle = { error: null, favourites: [], loading: false, markets: [], onlyFavourites: false, selectedSymbol: null }

const cases: Array<[string, MarketsCase]> = [
  ['loading', { ...idle, loading: true }],
  ['failed with nothing to show', { ...idle, error: 'Hyperliquid did not answer.' }],
  ['a list with a favourite and a selection', { ...idle, favourites: ['ETH'], markets, selectedSymbol: 'BTC' }],
  ['favourites only', { ...idle, favourites: ['ETH'], markets, onlyFavourites: true }],
  ['a list behind an error', { ...idle, error: 'Hyperliquid did not answer.', markets }]
]

const noop = () => undefined

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-01T12:00:00Z'), toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

describe('MarketsSection markup', () => {
  it.each(cases)('%s', (_name, props) => {
    const { container, unmount } = render(
      <MarketsSection {...props} onBrowseAll={noop} onRetry={noop} onSelect={noop} onToggleFavourite={noop} />
    )

    expect(container.innerHTML.replaceAll('><', '>\n<')).toMatchSnapshot()
    unmount()
  })
})

describe('quote age (U3-p2-14)', () => {
  it('names the oldest quote in the catalogue and marks only stale rows', () => {
    const now = Date.now()
    const stale = { ...market('A', 'Agilent Technologies, Inc.', 169.89, -1.78), asOf: now - 12 * 3_600_000 }
    const fresh = { ...market('B', 'Fresh Co', 1, 0), asOf: now - 60_000 }

    expect(oldestQuoteMs([fresh, stale])).toBe(stale.asOf)
    expect(oldestQuoteMs([{ ...fresh, asOf: null }])).toBeNull()
    expect(quoteAge(fresh.asOf, now)).toBeNull()
    expect(quoteAge(stale.asOf, now)).toMatch(/12h/)
  })
})
