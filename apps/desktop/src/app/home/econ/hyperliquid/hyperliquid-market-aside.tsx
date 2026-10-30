import { memo } from 'react'

import { chainByNetwork, timeAgo } from '../format'
import { Action, AddressChip, Money, Note, Pill, SectionTitle, Signed } from '../ui'

import { asOfMs, routeExplorerUrl } from './hyperliquid-data'
import type { HlMarket, HlRoute } from './hyperliquid-data'
import { signedPct } from './hyperliquid-markets'

function RouteCard({ route }: { route: HlRoute }) {
  const chain = route.network ? chainByNetwork(route.network) : null
  const explorer = routeExplorerUrl(route)

  return (
    <div className="hl-route">
      <div className="hl-route__head">
        <span className="hl-route__protocol">{route.protocol}</span>
        {chain ? <Pill tone="muted">{chain.label}</Pill> : route.chain ? <Pill tone="muted">{route.chain}</Pill> : null}
      </div>
      <dl className="hl-route__kv">
        {route.priceUsd != null ? (
          <>
            <dt>Price</dt>
            <dd>
              <Money value={route.priceUsd} />
            </dd>
          </>
        ) : null}
        {route.minBuyUsd != null ? (
          <>
            <dt>Min buy</dt>
            <dd>
              <Money value={route.minBuyUsd} />
            </dd>
          </>
        ) : null}
        {route.detail ? (
          <>
            <dt>Address</dt>
            <dd>
              <AddressChip address={route.detail} href={explorer || undefined} />
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}

export const MarketAside = memo(function MarketAside({
  agentName,
  market,
  onBuy,
  onOpenPerp,
  routes,
  routesLoading
}: {
  agentName: string
  market: HlMarket
  onBuy: (symbol: string) => void
  onOpenPerp: (symbol: string) => void
  routes: HlRoute[]
  routesLoading: boolean
}) {
  const asOf = asOfMs(market.asOf)

  return (
    <>
      <SectionTitle>Market</SectionTitle>
      <h3 className="hl-aside__symbol">{market.symbol}</h3>
      {market.name ? <p className="hl-aside__name">{market.name}</p> : null}

      <dl className="e-kv">
        <dt>Price</dt>
        <dd>
          <Money value={market.priceUsd} />
          {asOf ? <span className="hl-asof"> as of {timeAgo(asOf)}</span> : null}
        </dd>
        <dt>24h change</dt>
        <dd>
          {market.change24hPct == null ? (
            '—'
          ) : (
            <Signed text={signedPct(market.change24hPct)} value={market.change24hPct} />
          )}
        </dd>
        <dt>Min buy</dt>
        <dd>
          <Money value={market.minBuyUsd} />
        </dd>
      </dl>

      <SectionTitle end={routesLoading ? <span className="hl-asof">checking live routes…</span> : undefined}>
        Routes
      </SectionTitle>
      {routes.length === 0 ? (
        <Note>
          No routes reported for {market.symbol} yet — ask {agentName} for the live routes of {market.symbol}.
        </Note>
      ) : (
        <div>
          {routes.map((route, index) => (
            <RouteCard key={`${route.protocol}-${route.network}-${index}`} route={route} />
          ))}
        </div>
      )}

      <div className="hl-aside-actions">
        <Action kind="primary" onClick={() => onBuy(market.symbol)}>
          Buy via {agentName}
        </Action>
        <Action onClick={() => onOpenPerp(market.symbol)}>Open perp via {agentName}</Action>
      </div>
    </>
  )
})
