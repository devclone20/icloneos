import './hyperliquid.css'

/**
 * EconomyOS — Hyperliquid. A trading terminal's clarity, read-only: the
 * iNFT's perp positions, open orders, spot balances, and a searchable market
 * list that hands off a buy/perp brief to the iNFT — it never trades itself.
 *
 * Paint order: the last snapshot at once, `hl-status` as soon as it answers
 * (the hero and every table need only that), `hl-orders` behind it, and the
 * stock catalogue only when Markets or Favourites is opened.
 */
import { ArrowDownToLine, ArrowUpFromLine, Coins, ListOrdered, Search, Star, Waves } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useEconPanelEscape } from '@/app/home/home-escape'

import { humanizeAcpError } from '../cli'
import { type FailureNote, failureNote } from '../failure-note'
import { explorerAddressUrl, signedUsd, timeAgo, tokenAmount } from '../format'
import { useAskInft, useOpenSetup } from '../handoff'
import { reportEconStatus, useAutoRefresh } from '../live'
import { readSnapshot, useSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'
import {
  Action,
  AddressChip,
  AppFrame,
  Cell,
  Empty,
  Money,
  Note,
  Pill,
  RailItem,
  RailSection,
  Row,
  Rows,
  SectionTitle,
  Signed,
  SkeletonRows,
  SkeletonStats,
  Stat,
  StatRow,
  Toolbar
} from '../ui'

import {
  HL_SNAPSHOT_VERSION,
  hyperliquidChain,
  isAddressLike,
  isValidSymbol,
  leverageLabel,
  loadOrders,
  publishOrdersBadge,
  readAccount,
  readFavourites,
  readMarkets,
  readRoutes,
  reviveSnapshot,
  routesFromMarket,
  shouldReadOrders,
  toggleFavourite,
  toSnapshot,
  totalMarginUsed,
  totalUnrealizedPnl,
  writeFavourites
} from './hyperliquid-data'
import type { HlAccount, HlMarket, HlOrder, HlRoute, HlSnapshot } from './hyperliquid-data'
import { BuyForm, FundForm, type FundKind, PerpForm, type TradeKind } from './hyperliquid-forms'
import { MarketAside } from './hyperliquid-market-aside'
import { MarketsSection, oldestQuoteMs } from './hyperliquid-markets'

type Section = 'favourites' | 'markets' | 'orders' | 'positions' | 'spot'

interface Latest {
  account: HlAccount | null
  /** The hl-status read `at` the account came from — what the snapshot carries. */
  at: number
  markets: HlMarket[]
  orders: HlOrder[] | null
  /** The `at` of the last LIVE hl-orders answer in this mount; 0 before one. */
  ordersAt: number
  /** True once a LIVE hl-orders answered in this mount (a snapshot does not count). */
  ordersFresh: boolean
  /** True once a LIVE hl-status answered OK in this mount — only then do the
   *  other reads run beside the account instead of behind it. */
  accountLive: boolean
}

function emptyLatest(): Latest {
  return { account: null, at: 0, markets: [], orders: null, ordersAt: 0, ordersFresh: false, accountLive: false }
}

function latestFrom(snapshot: { at: number; data: HlSnapshot } | null): Latest {
  if (!snapshot) {
    return emptyLatest()
  }

  return {
    ...emptyLatest(),
    account: snapshot.data.account,
    at: snapshot.at,
    markets: snapshot.data.markets,
    orders: snapshot.data.orders
  }
}

/** The last snapshot, revived element by element, or null. */
function readInitialSnapshot(slug: string): { at: number; data: HlSnapshot } | null {
  const stored = readSnapshot<unknown>('hyperliquid', slug, HL_SNAPSHOT_VERSION)
  const data = stored ? reviveSnapshot(stored.data) : null

  return stored && data ? { at: stored.at, data } : null
}

function SideBadge({ side }: { side: 'long' | 'short' | 'buy' | 'sell' }) {
  const up = side === 'long' || side === 'buy'
  const label = side === 'long' ? 'LONG' : side === 'short' ? 'SHORT' : side.toUpperCase()

  return (
    <span className="hl-side">
      <Pill tone={up ? 'up' : 'down'}>{label}</Pill>
    </span>
  )
}

const PositionsTable = memo(function PositionsTable({
  agentName,
  positions
}: {
  agentName: string
  positions: HlAccount['positions']
}) {
  if (positions.length === 0) {
    return (
      <Empty
        hint={`Deposit USDC and ask ${agentName} to trade — every order goes through a dry-run first.`}
        title="No open positions"
      />
    )
  }

  return (
    <div className="e-scroll">
      <div className="hl-thead">
        <Row>
          <Cell grow>Coin</Cell>
          <Cell width={54}>Side</Cell>
          <Cell align="end" mono width={90}>
            Size
          </Cell>
          <Cell align="end" mono width={90}>
            Entry
          </Cell>
          <Cell align="end" mono width={90}>
            Value
          </Cell>
          <Cell align="end" mono width={110}>
            uPnL / ROE
          </Cell>
          <Cell align="end" width={90}>
            Leverage
          </Cell>
          <Cell align="end" mono width={90}>
            Liq. price
          </Cell>
        </Row>
      </div>
      <Rows>
        {positions.map(position => (
          <Row key={position.coin}>
            <Cell grow>{position.coin}</Cell>
            <Cell width={54}>
              <SideBadge side={position.side} />
            </Cell>
            <Cell align="end" mono width={90}>
              {tokenAmount(Math.abs(position.szi))}
            </Cell>
            <Cell align="end" mono width={90}>
              <Money value={position.entryPx} />
            </Cell>
            <Cell align="end" mono width={90}>
              <Money value={position.positionValue} />
            </Cell>
            <Cell align="end" mono width={110}>
              <Signed
                text={`${position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)} (${(position.returnOnEquity * 100).toFixed(1)}%)`}
                value={position.unrealizedPnl}
              />
            </Cell>
            <Cell align="end" width={90}>
              {leverageLabel(position)}
            </Cell>
            <Cell align="end" mono width={90}>
              <Money value={position.liquidationPx} />
            </Cell>
          </Row>
        ))}
      </Rows>
    </div>
  )
})

const OrdersTable = memo(function OrdersTable({ orders }: { orders: HlOrder[] }) {
  if (orders.length === 0) {
    return (
      <Empty
        hint="Orders placed through your iNFT appear here as soon as Hyperliquid accepts them."
        title="No open orders"
      />
    )
  }

  return (
    <div className="e-scroll">
      <div className="hl-thead">
        <Row>
          <Cell grow>Coin</Cell>
          <Cell width={54}>Side</Cell>
          <Cell grow>Type</Cell>
          <Cell align="end" mono width={90}>
            Size
          </Cell>
          <Cell align="end" mono width={90}>
            Price
          </Cell>
          <Cell align="end" width={72}>
            Age
          </Cell>
        </Row>
      </div>
      <Rows>
        {orders.map(order => (
          <Row key={order.oid}>
            <Cell grow>{order.coin}</Cell>
            <Cell width={54}>
              <SideBadge side={order.side} />
            </Cell>
            <Cell grow muted>
              {order.isTrigger ? `${order.orderType} @ ${order.triggerPx ?? '—'}` : order.orderType}
              {order.reduceOnly ? (
                <>
                  {' '}
                  <Pill tone="muted">reduce-only</Pill>
                </>
              ) : null}
            </Cell>
            <Cell align="end" mono width={90}>
              {tokenAmount(order.size)}
            </Cell>
            <Cell align="end" mono width={90}>
              <Money value={order.price} />
            </Cell>
            <Cell align="end" muted width={72}>
              {order.timestamp ? timeAgo(order.timestamp) : '—'}
            </Cell>
          </Row>
        ))}
      </Rows>
    </div>
  )
})

const SpotTable = memo(function SpotTable({ spotBalances }: { spotBalances: HlAccount['spotBalances'] }) {
  if (spotBalances.length === 0) {
    return <Empty hint="USDC and any spot fills on Hyperliquid show up here." title="No spot balances" />
  }

  return (
    <div className="e-scroll">
      <div className="hl-thead">
        <Row>
          <Cell grow>Coin</Cell>
          <Cell align="end" mono width={110}>
            Total
          </Cell>
          <Cell align="end" mono width={110}>
            Held (in orders)
          </Cell>
        </Row>
      </div>
      <Rows>
        {spotBalances.map(balance => (
          <Row key={balance.coin}>
            <Cell grow>{balance.coin}</Cell>
            <Cell align="end" mono width={110}>
              {tokenAmount(balance.total)}
            </Cell>
            <Cell align="end" mono width={110}>
              {tokenAmount(balance.hold)}
            </Cell>
          </Row>
        ))}
      </Rows>
    </div>
  )
})

// ── the app ──────────────────────────────────────────────────────────────────

export default function HyperliquidApp({ expanded: _expanded, identity, inftId, refreshKey, slug }: EconAppProps) {
  const [section, setSection] = useState<Section>('positions')
  // The last snapshot is read in the first render, not in an effect: effects
  // run after paint, and a one-frame skeleton before the figures is a flash.
  const [initial] = useState(() => readInitialSnapshot(slug))
  const [account, setAccount] = useState<HlAccount | null>(initial?.data.account ?? null)
  const [orders, setOrders] = useState<HlOrder[] | null>(initial?.data.orders ?? null)
  const [markets, setMarkets] = useState<HlMarket[]>(initial?.data.markets ?? [])
  const [marketsLoading, setMarketsLoading] = useState(false)
  const [favourites, setFavourites] = useState<string[]>(() => readFavourites(slug))
  const [selectedSymbol, setSelectedSymbol] = useState<null | string>(null)
  const [routes, setRoutes] = useState<HlRoute[]>([])
  const [routesLoading, setRoutesLoading] = useState(false)
  const [notice, setNotice] = useState<FailureNote | null>(null)
  const [ordersError, setOrdersError] = useState<null | string>(null)
  const [marketsError, setMarketsError] = useState<null | string>(null)
  const [fund, setFund] = useState<FundKind | null>(null)
  const [trade, setTrade] = useState<{ kind: TradeKind; symbol: string } | null>(null)
  const ask = useAskInft()
  const openSetup = useOpenSetup()

  // What the snapshot persists — written beside each setter (never mirrored
  // from state in an effect), so a persist reads what is on screen right now.
  const latest = useRef<Latest>(latestFrom(initial))

  const agentName = identity?.name || 'your agent'
  const marketsSection = section === 'markets' || section === 'favourites'

  const snap = useSnapshot<HlSnapshot>('hyperliquid', slug, HL_SNAPSHOT_VERSION, ({ at, data: raw }) => {
    const data = reviveSnapshot(raw)

    if (!data) {
      return
    }

    // The first render already seeded this very snapshot; only the side
    // effects (header age, dock badge) belong here.
    if (at !== initial?.at) {
      Object.assign(latest.current, { account: data.account, at, markets: data.markets, orders: data.orders })
      setAccount(data.account)
      setOrders(data.orders)
      setMarkets(data.markets)
    }

    reportEconStatus('hyperliquid', slug, { updatedAt: at })
    publishOrdersBadge(slug, data.orders)
  })

  const persistLatest = useCallback(() => {
    const { account: current, at, markets: list, orders: open, ordersFresh } = latest.current

    // Never persisted until orders are KNOWN LIVE in this mount: a snapshot
    // without them would hydrate as a false "0 open orders", and one carrying
    // the previous snapshot's orders would claim a freshness they lack.
    if (!current || !open || !ordersFresh || at <= 0) {
      return
    }

    snap.persist(toSnapshot(current, open, list), at)
  }, [snap])

  const applyAccount = useCallback(
    (data: HlAccount, at: number) => {
      if (latest.current.account === data && latest.current.at === at) {
        return
      }

      latest.current.account = data
      latest.current.at = at
      latest.current.accountLive = true
      setAccount(data)
      persistLatest()
    },
    [persistLatest]
  )

  const applyOrders = useCallback(
    (data: HlOrder[], at: number) => {
      latest.current.ordersFresh = true
      latest.current.ordersAt = at

      if (latest.current.orders === data) {
        return
      }

      latest.current.orders = data
      setOrders(data)
      persistLatest()
    },
    [persistLatest]
  )

  const applyMarkets = useCallback(
    (data: HlMarket[]) => {
      if (latest.current.markets === data) {
        return
      }

      latest.current.markets = data
      setMarkets(data)
      persistLatest()
    },
    [persistLatest]
  )

  /** A de-provisioned iNFT must not keep painting yesterday's positions. */
  const resetAll = useCallback(() => {
    latest.current = emptyLatest()
    setAccount(null)
    setOrders(null)
    setMarkets([])
    snap.clear()
    publishOrdersBadge(slug, [])
  }, [slug, snap])

  // Throws when hl-status failed — AFTER the state is set, so the Note still
  // renders and the header shows the error instead of a fresh "updated".
  const load = useCallback(
    async ({ force }: { force: boolean }) => {
      const current = latest.current

      const wantOrders = shouldReadOrders(
        { openOrders: current.orders?.length ?? 0, ordersAt: current.ordersAt, ordersFresh: current.ordersFresh },
        { force, ordersOpen: section === 'orders' }
      )

      // The catalogue is the heaviest read: only a manual refresh re-reads it,
      // and only while the owner is looking at it.
      const wantMarkets = force && marketsSection

      // Once this mount has a LIVE account the three CLI spawns run at once; in
      // sequence a refresh took 8–10 s (U3-p2-07). Until then — a cold window,
      // or one painted from the snapshot — the account answers first: a
      // de-provisioned or signed-out iNFT would only answer the same way thrice.
      const accountPending = readAccount(inftId, slug, force)
      const accountFirst = current.accountLive ? null : await accountPending
      const others = accountFirst === null || accountFirst.ok
      const ordersPending = wantOrders && others ? loadOrders(inftId, slug, force) : null
      const marketsPending = wantMarkets && others ? readMarkets(inftId, slug, true) : null

      if (marketsPending) {
        reportEconStatus('hyperliquid', slug, { stage: 'refreshing markets…' })
      }

      const accountResult = accountFirst ?? (await accountPending)
      let failure: null | string = null

      if (accountResult.ok) {
        applyAccount(accountResult.data, accountResult.at)
        setNotice(null)
      } else {
        const next = failureNote(accountResult)

        if (accountResult.kind === 'not-provisioned') {
          resetAll()
        }

        failure = next.message
        setNotice(next)

        // Orders and markets would only answer the same way.
        if (next.setup) {
          throw new Error(failure)
        }
      }

      if (ordersPending) {
        const ordersResult = await ordersPending

        if (ordersResult.ok) {
          applyOrders(ordersResult.data, ordersResult.at)
          setOrdersError(null)
        } else {
          setOrdersError(humanizeAcpError(ordersResult.error))
        }
      }

      if (marketsPending) {
        const marketsResult = await marketsPending

        if (marketsResult.ok) {
          applyMarkets(marketsResult.data)
          setMarketsError(null)
        } else {
          setMarketsError(humanizeAcpError(marketsResult.error))
        }
      }

      if (failure) {
        throw new Error(failure)
      }
    },
    [applyAccount, applyMarkets, applyOrders, inftId, marketsSection, resetAll, section, slug]
  )

  // The head's status is about the load; a fresh read of a stale catalogue
  // must not read "updated just now" over 12-hour-old prices (U3-p2-14).
  useEffect(() => {
    reportEconStatus('hyperliquid', slug, { dataAt: marketsSection ? (oldestQuoteMs(markets) ?? 0) : 0 })
  }, [markets, marketsSection, slug])

  const { reload } = useAutoRefresh('hyperliquid', slug, load, [inftId], refreshKey)

  // The catalogue loads when Markets/Favourites opens — through the TTL cache,
  // so re-entering within ten minutes costs nothing.
  useEffect(() => {
    if (!marketsSection) {
      return
    }

    let cancelled = false

    setMarketsLoading(true)
    void readMarkets(inftId, slug).then(result => {
      if (cancelled) {
        return
      }

      setMarketsLoading(false)

      if (result.ok) {
        applyMarkets(result.data)
        setMarketsError(null)
      } else {
        setMarketsError(humanizeAcpError(result.error))
      }
    })

    return () => {
      cancelled = true
    }
  }, [applyMarkets, inftId, marketsSection, slug])

  useEffect(() => {
    writeFavourites(slug, favourites)
  }, [favourites, slug])

  const selectedMarket = useMemo(
    () => markets.find(market => market.symbol === selectedSymbol) ?? null,
    [markets, selectedSymbol]
  )

  // Read at fire time by the routes effect, which is keyed on the SYMBOL: a
  // catalogue refresh hands back a new row object for the same market, and
  // that must not reset the aside to synthesized routes.
  const selectedMarketRef = useRef(selectedMarket)
  const selectedKey = selectedMarket?.symbol ?? null

  selectedMarketRef.current = selectedMarket

  // Routes paint at once from the row itself and refine when the CLI answers.
  useEffect(() => {
    const market = selectedMarketRef.current

    if (!market || market.symbol !== selectedKey) {
      setRoutes([])
      setRoutesLoading(false)

      return
    }

    let cancelled = false

    setRoutes(routesFromMarket(market))
    setRoutesLoading(true)
    void readRoutes(inftId, slug, market.symbol).then(result => {
      if (cancelled) {
        return
      }

      setRoutesLoading(false)

      if (result.ok && result.data.length > 0) {
        setRoutes(result.data)
      }
    })

    return () => {
      cancelled = true
    }
  }, [inftId, selectedKey, slug])

  const onToggleFavourite = useCallback((symbol: string) => {
    setFavourites(list => toggleFavourite(list, symbol))
  }, [])

  const browseAll = useCallback(() => setSection('markets'), [])
  const retry = useCallback(() => void reload(), [reload])

  // Buy/Open perp open a form in the aside (U3-p2-01): a symbol reaches it
  // only through the shaper's validator — the same one the bridge applies to
  // argv — and the brief leaves with the real figures when the owner asks.
  const openTrade = useCallback((kind: TradeKind, symbol: string) => {
    if (isValidSymbol(symbol)) {
      setFund(null)
      setTrade({ kind, symbol })
    }
  }, [])

  const askBuy = useCallback((symbol: string) => openTrade('buy', symbol), [openTrade])
  const askPerp = useCallback((symbol: string) => openTrade('perp', symbol), [openTrade])
  const closeTrade = useCallback(() => setTrade(null), [])

  // A hand-off marks orders stale so the next tick re-reads them whatever the section.
  const askTrade = useCallback(
    (brief: string) => {
      latest.current.ordersFresh = false
      setTrade(null)
      ask(brief)
    },
    [ask]
  )

  // Deposit/Withdraw open a form in the aside; only its "Ask <agent>" hands
  // the brief over (U3-p2-01) — with the real amount and no CLI flags.
  const askFund = useCallback(
    (brief: string) => {
      setFund(null)
      ask(brief)
    },
    [ask]
  )

  const closeFund = useCallback(() => setFund(null), [])

  useEconPanelEscape(fund !== null, closeFund)

  const chain = hyperliquidChain()
  const openOrders = orders?.length ?? 0
  const uPnl = account ? totalUnrealizedPnl(account.positions) : 0
  const marginUsed = account ? totalMarginUsed(account.positions) : 0

  const rail = (
    <RailSection>
      <RailItem
        active={section === 'positions'}
        icon={<Waves size={15} strokeWidth={1.7} />}
        label="Positions"
        onClick={() => setSection('positions')}
      />
      <RailItem
        active={section === 'orders'}
        count={openOrders || undefined}
        icon={<ListOrdered size={15} strokeWidth={1.7} />}
        label="Orders"
        onClick={() => setSection('orders')}
      />
      <RailItem
        active={section === 'spot'}
        icon={<Coins size={15} strokeWidth={1.7} />}
        label="Spot"
        onClick={() => setSection('spot')}
      />
      <RailItem
        active={section === 'markets'}
        icon={<Search size={15} strokeWidth={1.7} />}
        label="Markets"
        onClick={() => setSection('markets')}
      />
      <RailItem
        active={section === 'favourites'}
        count={favourites.length || undefined}
        icon={<Star size={15} strokeWidth={1.7} />}
        label="Favourites"
        onClick={() => setSection('favourites')}
      />
    </RailSection>
  )

  const aside = fund ? (
    <FundForm
      agentName={agentName}
      kind={fund}
      max={fund === 'withdraw' ? (account?.withdrawable ?? null) : null}
      onCancel={closeFund}
      onSubmit={askFund}
    />
  ) : trade?.kind === 'buy' ? (
    <BuyForm agentName={agentName} onCancel={closeTrade} onSubmit={askTrade} symbol={trade.symbol} />
  ) : trade?.kind === 'perp' ? (
    <PerpForm agentName={agentName} onCancel={closeTrade} onSubmit={askTrade} symbol={trade.symbol} />
  ) : marketsSection && selectedMarket ? (
    <MarketAside
      agentName={agentName}
      market={selectedMarket}
      onBuy={askBuy}
      onOpenPerp={askPerp}
      routes={routes}
      routesLoading={routesLoading}
    />
  ) : undefined

  let body: React.ReactNode

  if (marketsSection) {
    body = (
      <MarketsSection
        error={marketsError}
        favourites={favourites}
        loading={marketsLoading}
        markets={markets}
        onBrowseAll={browseAll}
        onlyFavourites={section === 'favourites'}
        onRetry={retry}
        onSelect={setSelectedSymbol}
        onToggleFavourite={onToggleFavourite}
        selectedSymbol={selectedSymbol}
      />
    )
  } else if (!account) {
    body = notice ? (
      <Empty
        hint="Fix the issue above and refresh — positions, orders and spot balances appear here."
        title="Account unavailable"
      />
    ) : (
      <SkeletonRows rows={6} />
    )
  } else if (section === 'positions') {
    body = <PositionsTable agentName={agentName} positions={account.positions} />
  } else if (section === 'orders') {
    body = (
      <>
        {ordersError ? <Note kind="warn">Could not refresh orders — showing the last list. {ordersError}</Note> : null}
        {orders === null ? <SkeletonRows rows={4} /> : <OrdersTable orders={orders} />}
      </>
    )
  } else {
    body = <SpotTable spotBalances={account.spotBalances} />
  }

  return (
    <div className="hl-root">
      <AppFrame aside={aside} className="hl-frame" rail={rail}>
        {!account ? (
          <SkeletonStats count={5} />
        ) : (
          <StatRow>
            <Stat
              hero
              label="Account value"
              sub={
                <span className="hl-hero-sub">
                  {chain.label} ·{' '}
                  <AddressChip
                    address={account.address}
                    href={
                      isAddressLike(account.address) ? explorerAddressUrl('hyperliquid', account.address) : undefined
                    }
                  />
                </span>
              }
              value={<Money value={account.accountValue} />}
            />
            <Stat label="Withdrawable" value={<Money value={account.withdrawable} />} />
            <Stat
              label="Unrealized PnL"
              tone={uPnl > 0 ? 'up' : uPnl < 0 ? 'down' : undefined}
              value={<Signed text={signedUsd(uPnl)} value={uPnl} />}
            />
            <Stat label="Margin used" value={<Money value={marginUsed} />} />
            <Stat label="Open orders" value={orders === null ? '—' : openOrders} />
          </StatRow>
        )}

        {notice ? (
          <Note kind={notice.setup ? 'warn' : 'error'}>
            {notice.message}
            <Action kind="quiet" onClick={notice.setup ? openSetup : retry}>
              {notice.action}
            </Action>
          </Note>
        ) : null}

        <Toolbar
          end={
            <>
              <Action
                kind={fund === 'deposit' ? 'primary' : 'default'}
                onClick={() => setFund(fund === 'deposit' ? null : 'deposit')}
              >
                <ArrowDownToLine size={13} strokeWidth={1.8} /> Deposit
              </Action>
              <Action
                kind={fund === 'withdraw' ? 'primary' : 'default'}
                onClick={() => setFund(fund === 'withdraw' ? null : 'withdraw')}
              >
                <ArrowUpFromLine size={13} strokeWidth={1.8} /> Withdraw
              </Action>
            </>
          }
        >
          <SectionTitle>{section}</SectionTitle>
        </Toolbar>

        {body}
      </AppFrame>
    </div>
  )
}
