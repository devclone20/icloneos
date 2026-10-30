/**
 * EconomyOS — Hyperliquid · the market list: favourites, search, and the
 * row that hands a buy or perp brief to the iNFT.
 */
import { Star } from 'lucide-react'
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { timeAgo } from '../format'
import { Action, Cell, Empty, Money, Note, Pill, Row, Rows, SearchBox, Signed, SkeletonRows, Toolbar } from '../ui'

import { asOfMs, capMarkets, filterMarkets, MARKETS_RENDER_CAP, splitFavourites } from './hyperliquid-data'
import type { HlMarket } from './hyperliquid-data'

/** A quote older than this shows its age beside the price (U3-p2-14). */
const QUOTE_STALE_MS = 60 * 60 * 1000

/** The oldest quote in the catalogue, epoch ms — what "quotes as of" reports. */
export function oldestQuoteMs(markets: readonly HlMarket[]): null | number {
  let oldest: null | number = null

  for (const market of markets) {
    const at = asOfMs(market.asOf)

    if (at !== null && (oldest === null || at < oldest)) {
      oldest = at
    }
  }

  return oldest
}

/** `12h ago` for a stale quote; null while it is fresh enough to say nothing. */
export function quoteAge(asOf: number | null, nowMs = Date.now()): null | string {
  const at = asOfMs(asOf)

  return at !== null && nowMs - at > QUOTE_STALE_MS ? timeAgo(at, nowMs) : null
}

export function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

// ── markets ──────────────────────────────────────────────────────────────────

const STAR_COL = 22

/** One catalogue row. Memoised on primitives + the market's identity (the CLI
 *  cache hands back the same object per load), so a keystroke, a selection
 *  or a pin touches only the rows whose props changed. The row is a grid row
 *  (not a button — ARIA forbids the star button inside one) and the single
 *  tab stop: Enter/Space opens it, `f` pins it, the star itself is mouse-only. */
const MarketRow = memo(function MarketRow({
  active,
  favourite,
  market,
  onSelect,
  onToggleFavourite
}: {
  active: boolean
  favourite: boolean
  market: HlMarket
  onSelect: (symbol: string) => void
  onToggleFavourite: (symbol: string) => void
}) {
  const age = quoteAge(market.asOf)

  return (
    <div
      aria-selected={active}
      className={active ? 'e-row e-row--click e-row--on hl-mrow' : 'e-row e-row--click hl-mrow'}
      onClick={() => onSelect(market.symbol)}
      onKeyDown={event => {
        if (event.key === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          onToggleFavourite(market.symbol)
        } else if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
          event.preventDefault()
          onSelect(market.symbol)
        }
      }}
      role="row"
      tabIndex={0}
    >
      <button
        aria-label={favourite ? `Unpin ${market.symbol}` : `Pin ${market.symbol}`}
        aria-pressed={favourite}
        className={favourite ? 'hl-star hl-star--on' : 'hl-star'}
        onClick={event => {
          event.stopPropagation()
          onToggleFavourite(market.symbol)
        }}
        tabIndex={-1}
        type="button"
      >
        <Star fill={favourite ? 'currentColor' : 'none'} size={13} strokeWidth={1.8} />
      </button>
      <Cell grow>
        <b>{market.symbol}</b>
        {market.name ? <span className="e-cell--muted"> {market.name}</span> : null}
      </Cell>
      <Cell align="end" mono width={90}>
        <Money value={market.priceUsd} />
        {age ? <span className="hl-asof hl-asof--row">{age}</span> : null}
      </Cell>
      <Cell align="end" width={80}>
        {market.change24hPct == null ? (
          '—'
        ) : (
          <Signed text={signedPct(market.change24hPct)} value={market.change24hPct} />
        )}
      </Cell>
      <Cell grow>
        <span className="hl-protocols">
          {market.protocols.map(protocol => (
            <Pill key={protocol}>{protocol}</Pill>
          ))}
        </span>
      </Cell>
      <Cell align="end" mono width={90}>
        <Money value={market.minBuyUsd} />
      </Cell>
    </div>
  )
})

function MarketGroup({
  active,
  favourites,
  label,
  markets,
  onSelect,
  onToggleFavourite
}: {
  active: null | string
  favourites: ReadonlySet<string>
  label: null | string
  markets: HlMarket[]
  onSelect: (symbol: string) => void
  onToggleFavourite: (symbol: string) => void
}) {
  if (markets.length === 0) {
    return null
  }

  return (
    <>
      {label ? <p className="hl-group">{label}</p> : null}
      {markets.map(market => (
        <MarketRow
          active={market.symbol === active}
          favourite={favourites.has(market.symbol)}
          key={market.symbol}
          market={market}
          onSelect={onSelect}
          onToggleFavourite={onToggleFavourite}
        />
      ))}
    </>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/** The catalogue. Owns its search text so a keystroke re-renders this
 *  section only; filters on the deferred value so the input never waits for
 *  the list. `/` focuses search, Enter opens the first visible match. */
export const MarketsSection = memo(function MarketsSection({
  error,
  favourites,
  loading,
  markets,
  onBrowseAll,
  onlyFavourites,
  onRetry,
  onSelect,
  onToggleFavourite,
  selectedSymbol
}: {
  error: null | string
  favourites: string[]
  loading: boolean
  markets: HlMarket[]
  onBrowseAll: () => void
  onlyFavourites: boolean
  onRetry: () => void
  onSelect: (symbol: string) => void
  onToggleFavourite: (symbol: string) => void
  selectedSymbol: null | string
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const stale = query !== deferredQuery
  const searchRef = useRef<HTMLDivElement>(null)

  const favouriteSet = useMemo(() => new Set(favourites), [favourites])

  const scoped = useMemo(
    () => (onlyFavourites ? markets.filter(market => favouriteSet.has(market.symbol)) : markets),
    [favouriteSet, markets, onlyFavourites]
  )

  const filtered = useMemo(() => filterMarkets(scoped, deferredQuery), [deferredQuery, scoped])

  const groups = useMemo(() => {
    if (onlyFavourites) {
      return { pinned: [] as HlMarket[], rest: capMarkets(filtered) }
    }

    const { pinned, rest } = splitFavourites(filtered, favouriteSet)

    return { pinned, rest: capMarkets(rest, Math.max(0, MARKETS_RENDER_CAP - pinned.length)) }
  }, [favouriteSet, filtered, onlyFavourites])

  const shown = groups.pinned.length + groups.rest.length

  // From the LIVE query, not the deferred one: a fast type-then-Enter must
  // open what the owner sees typed, not the previous keystroke's first row.
  const openFirst = useCallback(() => {
    const live = filterMarkets(scoped, query)
    const { pinned, rest } = onlyFavourites ? { pinned: [], rest: live } : splitFavourites(live, favouriteSet)
    const hit = pinned[0] ?? rest[0]

    if (hit) {
      onSelect(hit.symbol)
    }
  }, [favouriteSet, onlyFavourites, onSelect, query, scoped])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return
      }

      const input = searchRef.current?.querySelector('input')

      if (!input) {
        return
      }

      event.preventDefault()
      input.focus()
      input.select()
    }

    document.addEventListener('keydown', onKey)

    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const placeholder = onlyFavourites ? 'Search your favourites…  ( / )' : 'Search symbol or name…  ( / )'

  let body: React.ReactNode

  // The head's "updated just now" is about the load; the quotes can be hours older.
  const oldestAge = quoteAge(oldestQuoteMs(markets))

  const quoteNote = oldestAge ? (
    <Note>Quotes as of {oldestAge} — Refresh in the head re-reads the catalogue.</Note>
  ) : null

  if (loading && markets.length === 0) {
    body = <SkeletonRows rows={8} />
  } else if (error && markets.length === 0) {
    body = (
      <Empty action={<Action onClick={onRetry}>Try again</Action>} hint={error} title="Markets could not be loaded" />
    )
  } else if (onlyFavourites && scoped.length === 0) {
    const none = favourites.length === 0

    body = (
      <Empty
        action={
          <Action kind="primary" onClick={onBrowseAll}>
            Browse markets
          </Action>
        }
        hint={
          none
            ? 'Star a market to pin it here — pinned markets also lead the Markets list.'
            : `${favourites.length} pinned, none listed today — delisted or renamed symbols drop out of the catalogue.`
        }
        icon={<Star size={22} strokeWidth={1.6} />}
        title={none ? 'No favourites yet' : 'No pinned markets in today’s catalogue'}
      />
    )
  } else if (filtered.length === 0) {
    body = (
      <Empty
        hint={onlyFavourites ? 'None of your pinned markets match.' : 'Try a different symbol or company name.'}
        title={onlyFavourites ? 'No favourites match' : 'No markets match'}
      />
    )
  } else {
    body = (
      <div className="e-scroll">
        {quoteNote}
        <div className="hl-thead">
          <Row>
            <Cell width={STAR_COL}>{' '}</Cell>
            <Cell grow>Symbol / name</Cell>
            <Cell align="end" mono width={90}>
              Price
            </Cell>
            <Cell align="end" width={80}>
              24h
            </Cell>
            <Cell grow>Protocols</Cell>
            <Cell align="end" mono width={90}>
              Min buy
            </Cell>
          </Row>
        </div>
        <Rows>
          <div aria-label="Markets" className={stale ? 'hl-list hl-list--stale' : 'hl-list'} role="grid">
            <MarketGroup
              active={selectedSymbol}
              favourites={favouriteSet}
              label={groups.pinned.length > 0 ? 'Pinned' : null}
              markets={groups.pinned}
              onSelect={onSelect}
              onToggleFavourite={onToggleFavourite}
            />
            <MarketGroup
              active={selectedSymbol}
              favourites={favouriteSet}
              label={groups.pinned.length > 0 ? 'All markets' : null}
              markets={groups.rest}
              onSelect={onSelect}
              onToggleFavourite={onToggleFavourite}
            />
          </div>
        </Rows>
        {filtered.length > shown ? (
          <Note>
            Showing {shown} of {filtered.length} matches (capped at {MARKETS_RENDER_CAP}) — refine your search to narrow
            it down.
          </Note>
        ) : null}
        {error ? <Note kind="warn">Could not refresh the catalogue — showing the last list. {error}</Note> : null}
      </div>
    )
  }

  return (
    <>
      <Toolbar>
        <div className="hl-search" ref={searchRef}>
          <SearchBox onChange={setQuery} onSubmit={openFirst} placeholder={placeholder} value={query} />
        </div>
      </Toolbar>
      {body}
    </>
  )
})
