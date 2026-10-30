import { beforeEach, describe, expect, it } from 'vitest'

import type { AcpErrorKind, AcpFailure } from '../cli'
import { failureNote } from '../failure-note'

import {
  asOfMs,
  capMarkets,
  FAVOURITES_KEY,
  FAVOURITES_MAX,
  filterMarkets,
  hyperliquidChain,
  isAddressLike,
  isHlSnapshot,
  leverageLabel,
  MARKETS_RENDER_CAP,
  ORDERS_STALE_MS,
  readFavourites,
  reviveSnapshot,
  routeExplorerUrl,
  routeNetwork,
  routesFromMarket,
  shapeAccount,
  shapeMarket,
  shapeOrder,
  shapePosition,
  shapeRoutes,
  shapeSpotBalance,
  shouldReadOrders,
  splitFavourites,
  SYMBOL_RE,
  toggleFavourite,
  toSnapshot,
  totalMarginUsed,
  totalUnrealizedPnl,
  writeFavourites
} from './hyperliquid-data'
import type { HlMarket } from './hyperliquid-data'

function market(symbol: string, name = ''): HlMarket {
  return shapeMarket({ name, symbol })!
}

describe('shapePosition', () => {
  it('derives long from a positive szi', () => {
    const position = shapePosition({
      coin: 'BTC',
      entryPx: '60000',
      leverage: { type: 'cross', value: 5 },
      liquidationPx: '50000',
      marginUsed: '120',
      positionValue: '600',
      returnOnEquity: '0.1',
      szi: '0.01',
      unrealizedPnl: '12.5'
    })

    expect(position).toMatchObject({ coin: 'BTC', leverageType: 'cross', leverageValue: 5, side: 'long', szi: 0.01 })
  })

  it('derives short from a negative szi', () => {
    const position = shapePosition({ coin: 'ETH', leverage: { type: 'isolated', value: 3 }, szi: -1.5 })

    expect(position).toMatchObject({ leverageType: 'isolated', leverageValue: 3, side: 'short', szi: -1.5 })
  })

  it('unwraps a nested { position, type } row', () => {
    const position = shapePosition({ position: { coin: 'SOL', szi: 2 }, type: 'oneWay' })

    expect(position).toMatchObject({ coin: 'SOL', side: 'long' })
  })

  it('drops a row with no coin', () => {
    expect(shapePosition({ szi: 1 })).toBeNull()
    expect(shapePosition(null)).toBeNull()
  })

  it('defaults leverage to 1x cross when the field is missing', () => {
    const position = shapePosition({ coin: 'BTC', szi: 1 })

    expect(position).toMatchObject({ leverageType: 'cross', leverageValue: 1 })
  })
})

describe('shapeOrder', () => {
  it('normalizes Hyperliquid B/A sides to buy/sell', () => {
    expect(shapeOrder({ coin: 'BTC', side: 'B' })?.side).toBe('buy')
    expect(shapeOrder({ coin: 'BTC', side: 'A' })?.side).toBe('sell')
    expect(shapeOrder({ coin: 'BTC', side: 'sell' })?.side).toBe('sell')
  })

  it('reads size/price from either field name', () => {
    expect(shapeOrder({ coin: 'BTC', side: 'B', sz: '0.02', limitPx: '61000' })).toMatchObject({
      price: 61000,
      size: 0.02
    })
    expect(shapeOrder({ coin: 'BTC', side: 'B', size: '0.02', price: '61000' })).toMatchObject({
      price: 61000,
      size: 0.02
    })
  })

  it('detects a trigger order from triggerPx when isTrigger is absent', () => {
    const order = shapeOrder({ coin: 'BTC', side: 'A', triggerPx: '58000' })

    expect(order).toMatchObject({ isTrigger: true, triggerPx: 58000 })
  })

  it('keeps a plain limit order untriggered', () => {
    const order = shapeOrder({ coin: 'BTC', side: 'B', limitPx: '61000' })

    expect(order).toMatchObject({ isTrigger: false, triggerPx: null })
  })

  it('reads reduceOnly and a numeric oid', () => {
    const order = shapeOrder({ coin: 'BTC', oid: 42, reduceOnly: true, side: 'A' })

    expect(order).toMatchObject({ oid: '42', reduceOnly: true })
  })

  it('drops a row with no coin', () => {
    expect(shapeOrder({ side: 'B' })).toBeNull()
  })

  it('keeps a real timestamp and reads null (never 0) when the CLI gave none', () => {
    expect(shapeOrder({ coin: 'BTC', side: 'B', timestamp: 1_700_000_000_000 })?.timestamp).toBe(1_700_000_000_000)
    expect(shapeOrder({ coin: 'BTC', side: 'B' })?.timestamp).toBeNull()
    expect(shapeOrder({ coin: 'BTC', side: 'B', timestamp: 0 })?.timestamp).toBeNull()
    expect(shapeOrder({ coin: 'BTC', side: 'B', timestamp: 'soon' })?.timestamp).toBeNull()
  })
})

describe('shapeMarket', () => {
  it('reads the nested price block', () => {
    const shaped = shapeMarket({
      minBuyUsd: 10,
      name: 'Tesla',
      price: { asOf: 1700000000, change24hPct: '1.53', sharePriceUsd: '341.07', usd: '341.07' },
      protocols: ['ondo', 'xstocks'],
      symbol: 'TSLA'
    })

    expect(shaped).toMatchObject({
      change24hPct: 1.53,
      minBuyUsd: 10,
      priceUsd: 341.07,
      protocols: ['ondo', 'xstocks'],
      symbol: 'TSLA'
    })
  })

  it('precomputes the lower-cased search index once', () => {
    expect(shapeMarket({ name: 'Tesla Inc', symbol: 'TSLA' })?.search).toBe('tsla tesla inc')
    expect(shapeMarket({ symbol: 'HYPE' })?.search).toBe('hype ')
  })

  it('tolerates a missing price block', () => {
    const shaped = shapeMarket({ symbol: 'HYPE' })

    expect(shaped).toMatchObject({ change24hPct: null, priceUsd: null, protocols: [] })
  })

  it('drops a row with no symbol', () => {
    expect(shapeMarket({ name: 'Nothing' })).toBeNull()
  })

  it('mirrors the bridge validator: a symbol it would refuse never becomes a row', () => {
    expect(SYMBOL_RE.source).toBe('^[A-Za-z0-9.-]{1,24}$')
    expect(shapeMarket({ symbol: 'TS LA' })).toBeNull()
    expect(shapeMarket({ symbol: '--json' })).toBeNull()
    expect(shapeMarket({ symbol: '-X' })).toBeNull()
    expect(shapeMarket({ symbol: 'A'.repeat(25) })).toBeNull()
    expect(shapeMarket({ symbol: 'TSLA;rm' })).toBeNull()
    expect(shapeMarket({ symbol: 'A'.repeat(24) })?.symbol).toBe('A'.repeat(24))
    expect(shapeMarket({ symbol: 'BRK.B' })?.symbol).toBe('BRK.B')
    expect(shapeMarket({ symbol: 'X-1' })?.symbol).toBe('X-1')
  })
})

describe('shapeSpotBalance', () => {
  it('shapes a spot row', () => {
    expect(shapeSpotBalance({ coin: 'USDC', hold: '5', total: '100' })).toMatchObject({
      coin: 'USDC',
      hold: 5,
      total: 100
    })
  })

  it('drops a row with no coin', () => {
    expect(shapeSpotBalance({ total: 1 })).toBeNull()
  })
})

describe('shapeAccount', () => {
  it('reads top-level fields and filters out flat (szi=0) positions', () => {
    const account = shapeAccount({
      accountValue: '1000',
      address: '0xabc',
      network: 'mainnet',
      positions: [
        { coin: 'BTC', szi: '0.01' },
        { coin: 'FLAT', szi: '0' }
      ],
      spotBalances: [{ coin: 'USDC', total: '50' }],
      withdrawable: '400'
    })

    expect(account.accountValue).toBe(1000)
    expect(account.positions).toHaveLength(1)
    expect(account.positions[0]?.coin).toBe('BTC')
    expect(account.spotBalances).toHaveLength(1)
  })

  it('tolerates a bare/empty payload', () => {
    const account = shapeAccount({})

    expect(account).toMatchObject({ accountValue: 0, positions: [], spotBalances: [], withdrawable: 0 })
  })
})

describe('totals', () => {
  it('sums unrealized pnl and margin used across positions', () => {
    const positions = [
      shapePosition({ coin: 'BTC', marginUsed: 100, szi: 1, unrealizedPnl: 10 }),
      shapePosition({ coin: 'ETH', marginUsed: 50, szi: -1, unrealizedPnl: -4 })
    ].filter((position): position is NonNullable<typeof position> => position !== null)

    expect(totalUnrealizedPnl(positions)).toBe(6)
    expect(totalMarginUsed(positions)).toBe(150)
  })

  it('sums to zero with no positions', () => {
    expect(totalUnrealizedPnl([])).toBe(0)
    expect(totalMarginUsed([])).toBe(0)
  })
})

describe('leverageLabel', () => {
  it('reads "5x cross"', () => {
    const position = shapePosition({ coin: 'BTC', leverage: { type: 'cross', value: 5 }, szi: 1 })

    expect(leverageLabel(position!)).toBe('5× cross')
  })
})

describe('asOfMs', () => {
  it('lifts a seconds timestamp to ms and leaves ms alone', () => {
    expect(asOfMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(asOfMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it('reads nothing from null, zero or garbage', () => {
    expect(asOfMs(null)).toBeNull()
    expect(asOfMs(0)).toBeNull()
    expect(asOfMs(Number.NaN)).toBeNull()
  })
})

describe('filterMarkets', () => {
  const markets = [market('BTC', 'Bitcoin'), market('ETH', 'Ethereum'), market('ENA', 'Ethena')]

  it('returns the same list for an empty query', () => {
    expect(filterMarkets(markets, '')).toBe(markets)
  })

  it('ranks a symbol-prefix match before a substring/name match', () => {
    const result = filterMarkets(markets, 'et')

    expect(result.map(entry => entry.symbol)).toEqual(['ETH', 'ENA'])
  })

  it('matches on name too, case-insensitively', () => {
    expect(filterMarkets(markets, 'BIT').map(entry => entry.symbol)).toEqual(['BTC'])
  })
})

describe('capMarkets', () => {
  it('caps to the default render limit', () => {
    const markets = Array.from({ length: MARKETS_RENDER_CAP + 20 }, (_, index) => market(`S${index}`))

    expect(capMarkets(markets)).toHaveLength(MARKETS_RENDER_CAP)
  })

  it('respects a custom cap and keeps identity when nothing is cut', () => {
    const markets = Array.from({ length: 10 }, (_, index) => market(`S${index}`))

    expect(capMarkets(markets, 3)).toHaveLength(3)
    expect(capMarkets(markets)).toBe(markets)
  })
})

describe('favourites', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips symbols through localStorage under the iNFT’s own key', () => {
    writeFavourites('i01-6', ['TSLA', 'NVDA'])

    expect(window.localStorage.getItem(FAVOURITES_KEY + 'i01-6')).toBe('["TSLA","NVDA"]')
    expect(readFavourites('i01-6')).toEqual(['TSLA', 'NVDA'])
    // Another iNFT has its own watchlist.
    expect(readFavourites('i01-7')).toEqual([])
  })

  it('survives corrupt or foreign storage', () => {
    window.localStorage.setItem(FAVOURITES_KEY + 'i01-6', '{not json')
    expect(readFavourites('i01-6')).toEqual([])

    window.localStorage.setItem(FAVOURITES_KEY + 'i01-6', '[1, "", "  ", "AAPL", "AAPL", null]')
    expect(readFavourites('i01-6')).toEqual(['AAPL'])
  })

  it('toggles a pin on and off without mutating the input', () => {
    const list = ['TSLA']
    const pinned = toggleFavourite(list, 'NVDA')

    expect(pinned).toEqual(['TSLA', 'NVDA'])
    expect(toggleFavourite(pinned, 'TSLA')).toEqual(['NVDA'])
    expect(list).toEqual(['TSLA'])
  })

  it('lets the oldest pin go past the cap', () => {
    const full = Array.from({ length: FAVOURITES_MAX }, (_, index) => `S${index}`)
    const next = toggleFavourite(full, 'NEW')

    expect(next).toHaveLength(FAVOURITES_MAX)
    expect(next[0]).toBe('S1')
    expect(next.at(-1)).toBe('NEW')
  })

  it('splits favourites to the front, keeping each side in list order', () => {
    const markets = [market('AAPL'), market('TSLA'), market('NVDA'), market('MSFT')]
    const { pinned, rest } = splitFavourites(markets, new Set(['NVDA', 'AAPL']))

    expect(pinned.map(entry => entry.symbol)).toEqual(['AAPL', 'NVDA'])
    expect(rest.map(entry => entry.symbol)).toEqual(['TSLA', 'MSFT'])
  })

  it('returns the list itself when nothing is pinned', () => {
    const markets = [market('AAPL')]

    expect(splitFavourites(markets, new Set()).rest).toBe(markets)
  })
})

describe('routes', () => {
  it('resolves short chain names, network ids and numeric chain ids', () => {
    expect(routeNetwork('base')).toBe('base-mainnet')
    expect(routeNetwork('Arbitrum')).toBe('arb-mainnet')
    expect(routeNetwork('solana-mainnet')).toBe('solana-mainnet')
    expect(routeNetwork('8453')).toBe('base-mainnet')
    expect(routeNetwork('hyperevm')).toBe('hyperliquid')
    expect(routeNetwork('')).toBe('')
    expect(routeNetwork('narnia')).toBe('')
  })

  it('does not let a -mainnet suffix fabricate a chain', () => {
    expect(routeNetwork('narnia-mainnet')).toBe('')
    expect(routeNetwork('base-mainnet')).toBe('base-mainnet')
  })

  it('links an explorer only for an address-shaped detail on a known network', () => {
    const evm = `0x${'ab'.repeat(20)}`
    const sol = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    const route = (network: string, detail: string) => ({
      chain: '',
      detail,
      minBuyUsd: null,
      network,
      priceUsd: null,
      protocol: 'ondo'
    })

    expect(isAddressLike(evm)).toBe(true)
    expect(isAddressLike(sol)).toBe(true)
    expect(isAddressLike('0xdeadbeef')).toBe(false)
    expect(isAddressLike('foo/../bar')).toBe(false)
    expect(isAddressLike(`${evm}?x=1`)).toBe(false)

    expect(routeExplorerUrl(route('base-mainnet', evm))).toBe(`https://basescan.org/address/${evm}`)
    expect(routeExplorerUrl(route('solana-mainnet', sol))).toBe(`https://solscan.io/account/${sol}`)
    expect(routeExplorerUrl(route('base-mainnet', 'foo/../bar'))).toBe('')
    expect(routeExplorerUrl(route('base-mainnet', `${evm}#frag`))).toBe('')
    expect(routeExplorerUrl(route('', evm))).toBe('')
    expect(routeExplorerUrl(route('monad-mainnet', evm))).toBe('')
  })

  it('shapes a direct route list with its network and address', () => {
    const routes = shapeRoutes({
      routes: [{ address: '0xdeadbeef', chain: 'base', minBuyUsd: 5, name: 'ondo', priceUsd: 341.07 }]
    })

    expect(routes).toEqual([
      {
        chain: 'base',
        detail: '0xdeadbeef',
        minBuyUsd: 5,
        network: 'base-mainnet',
        priceUsd: 341.07,
        protocol: 'ondo'
      }
    ])
  })

  it('synthesizes one route per protocol when the CLI answers with the stock record', () => {
    const routes = shapeRoutes({
      minBuyUsd: 5,
      price: { usd: '341.07' },
      protocols: ['ondo', 'xstocks'],
      symbol: 'TSLA'
    })

    expect(routes).toEqual([
      { chain: '', detail: '', minBuyUsd: 5, network: '', priceUsd: 341.07, protocol: 'ondo' },
      { chain: '', detail: '', minBuyUsd: 5, network: '', priceUsd: 341.07, protocol: 'xstocks' }
    ])
  })

  it('derives the same routes from an already-loaded market row', () => {
    const row = shapeMarket({ minBuyUsd: 5, price: { usd: '341.07' }, protocols: ['ondo'], symbol: 'TSLA' })!

    expect(routesFromMarket(row)).toEqual([
      { chain: '', detail: '', minBuyUsd: 5, network: '', priceUsd: 341.07, protocol: 'ondo' }
    ])
  })

  it('returns an empty list when nothing is shapeable', () => {
    expect(shapeRoutes({})).toEqual([])
    expect(shapeRoutes(null)).toEqual([])
  })
})

describe('snapshot shape', () => {
  const account = shapeAccount({ address: '0xabc' })
  const order = shapeOrder({ coin: 'BTC', oid: 1, side: 'B' })!

  it('caps markets so the blob cannot take account and orders down with it', () => {
    const markets = Array.from({ length: MARKETS_RENDER_CAP + 5 }, (_, index) => market(`S${index}`))
    const snapshot = toSnapshot(account, [order], markets)

    expect(snapshot.markets).toHaveLength(MARKETS_RENDER_CAP)
    expect(snapshot.account).toBe(account)
    expect(snapshot.orders).toEqual([order])
  })

  it('recognises its own shape and rejects anything else', () => {
    expect(isHlSnapshot(toSnapshot(account, [], []))).toBe(true)
    expect(isHlSnapshot({ account: { address: '0x' }, markets: [], orders: [] })).toBe(false)
    expect(isHlSnapshot({ orders: [], markets: [] })).toBe(false)
    expect(isHlSnapshot(null)).toBe(false)
    expect(isHlSnapshot('nope')).toBe(false)
  })

  it('revives its own output unchanged', () => {
    const position = shapePosition({ coin: 'BTC', leverage: { type: 'isolated', value: 3 }, szi: -1 })!

    const full = shapeAccount({
      accountValue: '10',
      address: '0xabc',
      positions: [],
      spotBalances: [],
      withdrawable: '4'
    })

    const row = market('TSLA', 'Tesla')
    const snapshot = toSnapshot({ ...full, positions: [position] }, [order], [row])

    expect(reviveSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('drops malformed elements instead of rendering them', () => {
    const revived = reviveSnapshot({
      account: {
        accountValue: 1,
        address: '0xabc',
        network: 'mainnet',
        positions: [null, { coin: 'BTC' }, shapePosition({ coin: 'ETH', szi: 1 })],
        spotBalances: [{ coin: 'USDC', hold: 0, total: 'lots' }, shapeSpotBalance({ coin: 'USDC', total: 5 })],
        withdrawable: 1
      },
      markets: [null, { symbol: 'TS LA' }, market('NVDA')],
      orders: [null, { coin: 'BTC' }, order]
    })

    expect(revived?.account.positions.map(entry => entry.coin)).toEqual(['ETH'])
    expect(revived?.account.spotBalances.map(entry => entry.coin)).toEqual(['USDC'])
    expect(revived?.markets.map(entry => entry.symbol)).toEqual(['NVDA'])
    expect(revived?.orders).toEqual([order])
  })

  it('keeps an older snapshot whose order timestamps were 0', () => {
    const revived = reviveSnapshot(toSnapshot(account, [{ ...order, timestamp: 0 }], []))

    expect(revived?.orders[0]?.timestamp).toBe(0)
  })

  it('revives nothing from a broken shell', () => {
    expect(reviveSnapshot(null)).toBeNull()
    expect(reviveSnapshot({ account: {}, markets: [], orders: [] })).toBeNull()
    expect(reviveSnapshot({ account: { address: '0x', positions: [], spotBalances: [] }, orders: [] })).toBeNull()
  })
})

describe('shouldReadOrders', () => {
  const fresh = { openOrders: 0, ordersAt: 1_000_000, ordersFresh: true }
  const soon = fresh.ordersAt + 1_000

  it('bounds staleness at five minutes', () => {
    expect(ORDERS_STALE_MS).toBe(300_000)
  })

  it('skips the read while orders are fresh, none are open and the section is elsewhere', () => {
    expect(shouldReadOrders(fresh, { force: false, now: soon, ordersOpen: false })).toBe(false)
  })

  it('reads on a manual refresh, before the first live answer, on Orders, or with orders open', () => {
    expect(shouldReadOrders(fresh, { force: true, now: soon, ordersOpen: false })).toBe(true)
    expect(shouldReadOrders({ ...fresh, ordersFresh: false }, { force: false, now: soon, ordersOpen: false })).toBe(
      true
    )
    expect(shouldReadOrders(fresh, { force: false, now: soon, ordersOpen: true })).toBe(true)
    expect(shouldReadOrders({ ...fresh, openOrders: 1 }, { force: false, now: soon, ordersOpen: false })).toBe(true)
  })

  it('reads again once the last live answer is older than ORDERS_STALE_MS, even at zero orders', () => {
    const edge = fresh.ordersAt + ORDERS_STALE_MS

    expect(shouldReadOrders(fresh, { force: false, now: edge, ordersOpen: false })).toBe(false)
    expect(shouldReadOrders(fresh, { force: false, now: edge + 1, ordersOpen: false })).toBe(true)
  })
})

describe('hyperliquidChain', () => {
  it('resolves the Hyperliquid explorer prefix', () => {
    expect(hyperliquidChain().explorer).toBe('https://app.hyperliquid.xyz/explorer/address/')
  })
})

describe('failureNote (Hyperliquid account)', () => {
  const failure = (kind: AcpErrorKind, error: string): AcpFailure => ({ error, kind, ok: false })

  it('R16.copy.hyperliquid_sign_in_again: an expired Virtuals session offers Sign in again (the Setup action)', () => {
    const notice = failureNote(failure('reauth-acp', 'Not authenticated.'))

    expect(notice).toEqual({
      action: 'Sign in again',
      message: 'The Virtuals session for this iNFT expired.',
      setup: true
    })
    expect(notice.message).not.toMatch(/setup needed|unprovisioned/i)
  })

  it('keeps Open Setup for an unprovisioned iNFT and Try again for a transient failure', () => {
    expect(failureNote(failure('not-provisioned', 'No active agent.'))).toMatchObject({
      action: 'Open Setup',
      setup: true
    })
    expect(failureNote(failure('busy', 'busy'))).toEqual({ action: 'Try again', message: 'busy', setup: false })
  })
})
