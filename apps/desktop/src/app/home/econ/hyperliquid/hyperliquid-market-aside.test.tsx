import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { HlMarket, HlRoute } from './hyperliquid-data'
import { MarketAside } from './hyperliquid-market-aside'

const market: HlMarket = {
  asOf: Date.now() - 60_000,
  change24hPct: 2.31,
  minBuyUsd: 10,
  name: 'Tesla',
  priceUsd: 251.4,
  protocols: ['hyperliquid'],
  search: 'tsla tesla',
  sharePriceUsd: null,
  symbol: 'TSLA'
}

const route: HlRoute = {
  chain: 'Base',
  detail: '0x1111111111111111111111111111111111111111',
  minBuyUsd: 5,
  network: 'base-mainnet',
  priceUsd: 251.2,
  protocol: 'aerodrome'
}

/** UF2B1-c2-03: the aside lives in its own module (hyperliquid-app.tsx <= 900 lines) and still renders the market, its routes and both actions. */
describe('MarketAside', () => {
  it('renders the market, each route and the two agent actions', () => {
    const onBuy = vi.fn()
    const onOpenPerp = vi.fn()

    const { container, getByText } = render(
      <MarketAside
        agentName="Pat"
        market={market}
        onBuy={onBuy}
        onOpenPerp={onOpenPerp}
        routes={[route]}
        routesLoading={false}
      />
    )

    expect(container.querySelector('.hl-aside__symbol')?.textContent).toBe('TSLA')
    expect(container.querySelectorAll('.hl-route')).toHaveLength(1)
    expect(container.querySelector('.hl-route__protocol')?.textContent).toBe('aerodrome')

    fireEvent.click(getByText('Buy via Pat'))
    fireEvent.click(getByText('Open perp via Pat'))
    expect(onBuy).toHaveBeenCalledWith('TSLA')
    expect(onOpenPerp).toHaveBeenCalledWith('TSLA')
  })

  it('names the agent when no route is known yet', () => {
    const { container } = render(
      <MarketAside
        agentName="Pat"
        market={market}
        onBuy={() => undefined}
        onOpenPerp={() => undefined}
        routes={[]}
        routesLoading
      />
    )

    expect(container.querySelectorAll('.hl-route')).toHaveLength(0)
    expect(container.textContent).toContain('ask Pat for the live routes of TSLA')
    expect(container.textContent).toContain('checking live routes')
  })
})
