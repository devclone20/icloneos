import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../../lib/storage-keys'
import { defineEconData } from '../app-data'
/**
 * EconomyOS — Hyperliquid data layer: shapers for `trade hl-status`,
 * `trade hl-orders`, `trade stock-list` and `trade stock-list <SYMBOL>`, the
 * small aggregates the app renders (totals, side derivation, search, pinned
 * favourites), the snapshot shape it persists, the dock badge it publishes
 * and the prefetch the home surface fires when an iNFT takes the stage.
 *
 * Every shaper is total (never throws, drops what it cannot read) because the
 * CLI's JSON is real API pass-through and fields come and go.
 */
import { setEconBadge } from '../badges'
import type { AcpResult } from '../cli'
import { acpJson, asArray, asRecord, bool, isFiniteNumber, listAt, num, str } from '../cli'
import type { ChainInfo } from '../format'
import { chainById, chainByNetwork, explorerAddressUrl } from '../format'
import { cadenceTtlMs, liveCadenceSecs, parallelPrefetch } from '../live'
import { readSnapshot } from '../snapshot'

interface HlPosition {
  coin: string
  /** Signed size (Hyperliquid's `szi`) — negative is short. */
  szi: number
  side: 'long' | 'short'
  entryPx: number
  positionValue: number
  unrealizedPnl: number
  returnOnEquity: number
  leverageType: 'cross' | 'isolated'
  leverageValue: number
  liquidationPx: number
  marginUsed: number
}

interface HlSpotBalance {
  coin: string
  total: number
  hold: number
  entryNtl: number
}

export interface HlOrder {
  coin: string
  side: 'buy' | 'sell'
  size: number
  price: number
  oid: string
  orderType: string
  isTrigger: boolean
  triggerPx: number | null
  reduceOnly: boolean
  /** Placement time in epoch ms; null when the CLI gave none (never 0). */
  timestamp: number | null
}

export interface HlMarket {
  symbol: string
  name: string
  protocols: string[]
  priceUsd: number | null
  change24hPct: number | null
  sharePriceUsd: number | null
  /** The price's timestamp as the CLI gave it — seconds or ms; see `asOfMs`. */
  asOf: number | null
  minBuyUsd: number | null
  /** `symbol name`, lower-cased once here so a keystroke never lower-cases the list. */
  search: string
}

export interface HlRoute {
  protocol: string
  /** The chain as the CLI names it. */
  chain: string
  /** `chain` resolved to a CLI network id (`base-mainnet`); '' when unknown. */
  network: string
  priceUsd: number | null
  minBuyUsd: number | null
  /** The contract / pool address on `network`, when the route names one. */
  detail: string
}

export interface HlAccount {
  address: string
  network: string
  accountValue: number
  withdrawable: number
  positions: HlPosition[]
  spotBalances: HlSpotBalance[]
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}

/**
 * Mirror of the bridge's `symbol` validator (electron/iclone-acp.ts): a
 * catalogue symbol that fails it is refused as an argv positional, so it is
 * dropped here at the shaper — it never reaches a brief, an argv or a row.
 */
export const SYMBOL_RE = /^[A-Za-z0-9.-]{1,24}$/

export function isValidSymbol(symbol: string): boolean {
  // The bridge admits a leading dash, but the CLI's argv parser would read
  // `--json` (or any `-x`) as a flag and answer with the whole catalogue.
  return SYMBOL_RE.test(symbol) && !symbol.startsWith('-')
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** An EVM (0x + 40 hex) or Solana (base58, 32–44) address — the only strings
 *  that may be appended to an explorer prefix. */
export function isAddressLike(value: string): boolean {
  return EVM_ADDRESS_RE.test(value) || BASE58_ADDRESS_RE.test(value)
}

// ── shapers ──────────────────────────────────────────────────────────────────

/** Hyperliquid's raw clearinghouse rows sometimes nest the fields one level
 *  deeper as `{ position: {...}, type }` — try the nested shape first. */
function unwrapPosition(raw: unknown) {
  const root = asRecord(raw)

  return asRecord(root?.position) ?? root
}

export function shapePosition(raw: unknown): HlPosition | null {
  const root = unwrapPosition(raw)
  const coin = str(root, 'coin')

  if (!root || !coin) {
    return null
  }

  const leverage = asRecord(root.leverage)
  const szi = num(root, 'szi', num(root, 'size'))

  return {
    coin,
    entryPx: num(root, 'entryPx'),
    leverageType: str(leverage, 'type', 'cross') === 'isolated' ? 'isolated' : 'cross',
    leverageValue: num(leverage, 'value', 1),
    liquidationPx: num(root, 'liquidationPx'),
    marginUsed: num(root, 'marginUsed'),
    positionValue: num(root, 'positionValue'),
    returnOnEquity: num(root, 'returnOnEquity'),
    side: szi < 0 ? 'short' : 'long',
    szi,
    unrealizedPnl: num(root, 'unrealizedPnl')
  }
}

export function shapeSpotBalance(raw: unknown): HlSpotBalance | null {
  const root = asRecord(raw)
  const coin = str(root, 'coin')

  if (!root || !coin) {
    return null
  }

  return { coin, entryNtl: num(root, 'entryNtl'), hold: num(root, 'hold'), total: num(root, 'total') }
}

function normalizeOrderSide(raw: string): 'buy' | 'sell' {
  const lower = raw.trim().toLowerCase()

  return lower === 'b' || lower === 'buy' ? 'buy' : 'sell'
}

export function shapeOrder(raw: unknown): HlOrder | null {
  const root = asRecord(raw)
  const coin = str(root, 'coin')

  if (!root || !coin) {
    return null
  }

  const triggerPx = root.triggerPx
  const hasTriggerPx = typeof triggerPx === 'number' || (typeof triggerPx === 'string' && triggerPx.trim() !== '')
  const oid = root.oid
  const timestamp = root.timestamp != null ? num(root, 'timestamp') : 0

  return {
    coin,
    isTrigger: bool(root, 'isTrigger', hasTriggerPx),
    oid: typeof oid === 'number' ? String(oid) : str(root, 'oid'),
    orderType: str(root, 'orderType', 'limit'),
    price: num(root, 'limitPx', num(root, 'price')),
    reduceOnly: bool(root, 'reduceOnly'),
    side: normalizeOrderSide(str(root, 'side')),
    size: num(root, 'sz', num(root, 'size')),
    timestamp: timestamp > 0 ? timestamp : null,
    triggerPx: hasTriggerPx ? num(root, 'triggerPx') : null
  }
}

export function shapeMarket(raw: unknown): HlMarket | null {
  const root = asRecord(raw)
  const symbol = str(root, 'symbol')

  if (!root || !isValidSymbol(symbol)) {
    return null
  }

  const price = asRecord(root.price)
  const name = str(root, 'name')

  return {
    asOf: price && price.asOf != null ? num(price, 'asOf') : null,
    change24hPct: price && price.change24hPct != null ? num(price, 'change24hPct') : null,
    minBuyUsd: root.minBuyUsd != null ? num(root, 'minBuyUsd') : null,
    name,
    priceUsd: price && price.usd != null ? num(price, 'usd') : null,
    protocols: asArray(root.protocols).filter((entry): entry is string => typeof entry === 'string'),
    search: `${symbol} ${name}`.toLowerCase(),
    sharePriceUsd: price && price.sharePriceUsd != null ? num(price, 'sharePriceUsd') : null,
    symbol
  }
}

/** Short chain names the trade routes use, mapped to the CLI network ids
 *  `format.ts` knows explorers for. */
const NETWORK_ALIASES: Record<string, string> = {
  arb: 'arb-mainnet',
  arbitrum: 'arb-mainnet',
  arc: 'arc-mainnet',
  base: 'base-mainnet',
  bnb: 'bnb-mainnet',
  bsc: 'bnb-mainnet',
  eth: 'eth-mainnet',
  ethereum: 'eth-mainnet',
  hl: 'hyperliquid',
  hyperevm: 'hyperliquid',
  hyperliquid: 'hyperliquid',
  mainnet: 'eth-mainnet',
  matic: 'polygon-mainnet',
  monad: 'monad-mainnet',
  op: 'opt-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  robinhood: 'robinhood-mainnet',
  sol: 'solana-mainnet',
  solana: 'solana-mainnet'
}

/** A route's `chain` — a short name, a network id or a numeric chain id — as
 *  a CLI network id, or '' when it names nothing we know an explorer for. */
export function routeNetwork(chain: string): string {
  const key = chain.trim().toLowerCase()

  if (!key) {
    return ''
  }

  if (/^\d+$/.test(key)) {
    return chainById(Number(key))?.network ?? ''
  }

  if (key.endsWith('-mainnet')) {
    return chainByNetwork(key).chainId !== 0 ? key : ''
  }

  return NETWORK_ALIASES[key] ?? ''
}

function shapeRoute(raw: unknown): HlRoute | null {
  const root = asRecord(raw)
  const protocol = str(root, 'protocol') || str(root, 'name') || str(root, 'source')

  if (!root || !protocol) {
    return null
  }

  const price = asRecord(root.price)
  const chain = str(root, 'chain') || str(root, 'network') || str(root, 'chainId')

  return {
    chain,
    detail: str(root, 'address') || str(root, 'pool') || str(root, 'contract') || str(root, 'tokenAddress'),
    minBuyUsd: root.minBuyUsd != null ? num(root, 'minBuyUsd') : null,
    network: routeNetwork(chain),
    priceUsd: price ? num(price, 'usd') : root.priceUsd != null ? num(root, 'priceUsd') : null,
    protocol
  }
}

function synthesizeRoutes(protocols: string[], priceUsd: number | null, minBuyUsd: number | null): HlRoute[] {
  return protocols.map(protocol => ({ chain: '', detail: '', minBuyUsd, network: '', priceUsd, protocol }))
}

/**
 * `trade stock-list <SYMBOL>` is documented only as "every route, tolerant
 * shape". When the CLI answers with a route list, shape it directly; when it
 * answers with the single stock record instead (the same shape `stock-list`
 * returns per row), synthesize one route per supported protocol so the aside
 * still has something to show.
 */
export function shapeRoutes(raw: unknown): HlRoute[] {
  const direct = listAt(raw, ['routes', 'options', 'markets']).map(shapeRoute).filter(nonNull)

  if (direct.length > 0) {
    return direct
  }

  const root = asRecord(raw)
  const protocols = asArray(root?.protocols).filter((entry): entry is string => typeof entry === 'string')
  const price = asRecord(root?.price)
  const priceUsd = price && price.usd != null ? num(price, 'usd') : null
  const minBuyUsd = root?.minBuyUsd != null ? num(root, 'minBuyUsd') : null

  return synthesizeRoutes(protocols, priceUsd, minBuyUsd)
}

/** The routes a market row already implies — painted the instant a row is
 *  selected, refined when `trade stock-list <SYMBOL>` answers. */
export function routesFromMarket(market: HlMarket): HlRoute[] {
  return synthesizeRoutes(market.protocols, market.priceUsd, market.minBuyUsd)
}

/** The explorer link for a route's address — '' unless the network has an
 *  explorer AND `detail` is address-shaped (CLI text never reaches a URL raw). */
export function routeExplorerUrl(route: HlRoute): string {
  if (!route.network || !isAddressLike(route.detail)) {
    return ''
  }

  return explorerAddressUrl(route.network, route.detail)
}

export function shapeAccount(raw: unknown): HlAccount {
  const root = asRecord(raw)

  return {
    accountValue: num(root, 'accountValue'),
    address: str(root, 'address'),
    network: str(root, 'network', 'mainnet'),
    positions: listAt(raw, ['positions'])
      .map(shapePosition)
      .filter(nonNull)
      .filter(position => position.szi !== 0),
    spotBalances: listAt(raw, ['spotBalances']).map(shapeSpotBalance).filter(nonNull),
    withdrawable: num(root, 'withdrawable')
  }
}

function shapeOrders(raw: unknown): HlOrder[] {
  return listAt(raw, ['orders']).map(shapeOrder).filter(nonNull)
}

function shapeMarkets(raw: unknown): HlMarket[] {
  return listAt(raw, ['stocks']).map(shapeMarket).filter(nonNull)
}

// ── aggregates ───────────────────────────────────────────────────────────────

export function totalUnrealizedPnl(positions: HlPosition[]): number {
  return positions.reduce((total, position) => total + position.unrealizedPnl, 0)
}

export function totalMarginUsed(positions: HlPosition[]): number {
  return positions.reduce((total, position) => total + position.marginUsed, 0)
}

export function leverageLabel(position: HlPosition): string {
  return `${position.leverageValue}× ${position.leverageType}`
}

export function hyperliquidChain(): ChainInfo {
  return chainByNetwork('hyperliquid')
}

/** A price timestamp in ms — the feed gives seconds for some venues and ms
 *  for others; anything under 1e12 can only be seconds. */
export function asOfMs(asOf: number | null): number | null {
  if (asOf == null || !Number.isFinite(asOf) || asOf <= 0) {
    return null
  }

  return asOf < 1e12 ? asOf * 1000 : asOf
}

/** Symbol/name search over the precomputed index, ranked so an exact-prefix
 *  match always leads — the list is hundreds of rows, so the ranking is what
 *  makes typing feel fast. */
export function filterMarkets(markets: HlMarket[], query: string): HlMarket[] {
  const q = query.trim().toLowerCase()

  if (!q) {
    return markets
  }

  const prefix: HlMarket[] = []
  const rest: HlMarket[] = []

  for (const market of markets) {
    if (market.search.startsWith(q)) {
      prefix.push(market)
    } else if (market.search.includes(q)) {
      rest.push(market)
    }
  }

  return [...prefix, ...rest]
}

export const MARKETS_RENDER_CAP = 150

/** Caps rendering to keep hundreds of filtered rows fast — the caller shows
 *  a note when the true match count exceeds what is rendered. */
export function capMarkets(markets: HlMarket[], cap = MARKETS_RENDER_CAP): HlMarket[] {
  return markets.length > cap ? markets.slice(0, cap) : markets
}

// ── favourites ───────────────────────────────────────────────────────────────

/** Per iNFT: each agent has its own account and its own watchlist. */
export const FAVOURITES_KEY = ICLONE_STORAGE.hyperliquidFavourites.key
export const FAVOURITES_MAX = 50

function normalizeFavourites(list: unknown[]): string[] {
  const seen = new Set<string>()

  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim()) {
      seen.add(entry.trim())
    }
  }

  return [...seen].slice(-FAVOURITES_MAX)
}

/** The iNFT's pinned symbols — a per-viewer convenience, so local storage. */
export function readFavourites(slug: string): string[] {
  const parsed = readJson<unknown>(FAVOURITES_KEY + slug)

  return normalizeFavourites(Array.isArray(parsed) ? parsed : [])
}

/** Best-effort: when the write fails the session list still applies. */
export function writeFavourites(slug: string, symbols: readonly string[]): void {
  writeJson(FAVOURITES_KEY + slug, normalizeFavourites([...symbols]))
}

/** Pin or unpin one symbol; past the cap the oldest pin makes room. */
export function toggleFavourite(symbols: readonly string[], symbol: string): string[] {
  if (symbols.includes(symbol)) {
    return symbols.filter(entry => entry !== symbol)
  }

  return normalizeFavourites([...symbols, symbol])
}

/** Favourites first, in the order the (already ranked) list has them. */
export function splitFavourites(
  markets: HlMarket[],
  favourites: ReadonlySet<string>
): { pinned: HlMarket[]; rest: HlMarket[] } {
  if (favourites.size === 0) {
    return { pinned: [], rest: markets }
  }

  const pinned: HlMarket[] = []
  const rest: HlMarket[] = []

  for (const market of markets) {
    if (favourites.has(market.symbol)) {
      pinned.push(market)
    } else {
      rest.push(market)
    }
  }

  return { pinned, rest }
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export const HL_SNAPSHOT_VERSION = 1

/** What the window paints before its first CLI answer. `at` is the hl-status
 *  read the account came from; markets are capped so the blob never nears
 *  SNAPSHOT_MAX_BYTES and takes account and orders down with it. */
export interface HlSnapshot {
  account: HlAccount
  orders: HlOrder[]
  markets: HlMarket[]
}

export function toSnapshot(account: HlAccount, orders: HlOrder[], markets: HlMarket[]): HlSnapshot {
  return { account, markets: capMarkets(markets, MARKETS_RENDER_CAP), orders }
}

export function isHlSnapshot(value: unknown): value is HlSnapshot {
  const root = asRecord(value)
  const account = asRecord(root?.account)

  return Boolean(
    root &&
    account &&
    typeof account.address === 'string' &&
    Array.isArray(account.positions) &&
    Array.isArray(account.spotBalances) &&
    Array.isArray(root.orders) &&
    Array.isArray(root.markets)
  )
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isHlPosition(value: unknown): value is HlPosition {
  const root = asRecord(value)

  return Boolean(
    root &&
    typeof root.coin === 'string' &&
    root.coin &&
    (root.side === 'long' || root.side === 'short') &&
    (root.leverageType === 'cross' || root.leverageType === 'isolated') &&
    isFiniteNumber(root.szi) &&
    isFiniteNumber(root.entryPx) &&
    isFiniteNumber(root.positionValue) &&
    isFiniteNumber(root.unrealizedPnl) &&
    isFiniteNumber(root.returnOnEquity) &&
    isFiniteNumber(root.leverageValue) &&
    isFiniteNumber(root.liquidationPx) &&
    isFiniteNumber(root.marginUsed)
  )
}

function isHlSpotBalance(value: unknown): value is HlSpotBalance {
  const root = asRecord(value)

  return Boolean(
    root &&
    typeof root.coin === 'string' &&
    root.coin &&
    isFiniteNumber(root.total) &&
    isFiniteNumber(root.hold) &&
    isFiniteNumber(root.entryNtl)
  )
}

function isHlOrder(value: unknown): value is HlOrder {
  const root = asRecord(value)

  return Boolean(
    root &&
    typeof root.coin === 'string' &&
    root.coin &&
    (root.side === 'buy' || root.side === 'sell') &&
    isFiniteNumber(root.size) &&
    isFiniteNumber(root.price) &&
    typeof root.oid === 'string' &&
    typeof root.orderType === 'string' &&
    typeof root.isTrigger === 'boolean' &&
    isNullableNumber(root.triggerPx) &&
    typeof root.reduceOnly === 'boolean' &&
    isNullableNumber(root.timestamp)
  )
}

function isHlMarket(value: unknown): value is HlMarket {
  const root = asRecord(value)

  return Boolean(
    root &&
    typeof root.symbol === 'string' &&
    isValidSymbol(root.symbol) &&
    typeof root.name === 'string' &&
    isStringList(root.protocols) &&
    isNullableNumber(root.priceUsd) &&
    isNullableNumber(root.change24hPct) &&
    isNullableNumber(root.sharePriceUsd) &&
    isNullableNumber(root.asOf) &&
    isNullableNumber(root.minBuyUsd) &&
    typeof root.search === 'string'
  )
}

/**
 * A stored snapshot, element by element: the only input the renderer takes
 * that did not pass through a shaper, so it is checked as strictly as one —
 * a malformed row is dropped, never rendered. Null when the shell is wrong.
 */
export function reviveSnapshot(value: unknown): HlSnapshot | null {
  if (!isHlSnapshot(value)) {
    return null
  }

  const account = value.account as unknown as Record<string, unknown>

  return {
    account: {
      accountValue: num(account, 'accountValue'),
      address: str(account, 'address'),
      network: str(account, 'network', 'mainnet'),
      positions: asArray(account.positions).filter(isHlPosition),
      spotBalances: asArray(account.spotBalances).filter(isHlSpotBalance),
      withdrawable: num(account, 'withdrawable')
    },
    markets: asArray(value.markets).filter(isHlMarket),
    orders: asArray(value.orders).filter(isHlOrder)
  }
}

// ── badge ────────────────────────────────────────────────────────────────────

/** The dock tile's number: open orders (0 hides it). */
export function publishOrdersBadge(slug: string, orders: readonly HlOrder[]): void {
  setEconBadge(slug, 'hyperliquid', orders.length)
}

// ── refresh policy ───────────────────────────────────────────────────────────

/** Open orders are re-read on a tick only while some are open or the Orders
 *  section is on screen — but never left unread longer than this, so a new
 *  order (0 → 1) reaches the badge without a manual refresh. */
export const ORDERS_STALE_MS = 5 * 60_000

interface OrdersFreshness {
  /** True once a LIVE hl-orders answered in this mount (a snapshot does not count). */
  ordersFresh: boolean
  /** The `at` of that live answer; 0 before one. */
  ordersAt: number
  openOrders: number
}

/** Whether this load should spend an `hl-orders` spawn. */
export function shouldReadOrders(
  state: OrdersFreshness,
  { force, now = Date.now(), ordersOpen }: { force: boolean; now?: number; ordersOpen: boolean }
): boolean {
  return force || !state.ordersFresh || ordersOpen || state.openOrders > 0 || now - state.ordersAt > ORDERS_STALE_MS
}

// ── loaders ──────────────────────────────────────────────────────────────────

const STATUS_ARGV = ['trade', 'hl-status', '--json']
const ORDERS_ARGV = ['trade', 'hl-orders', '--json']
const MARKETS_ARGV = ['trade', 'stock-list', '--json']

export const STATUS_TTL_MS = 30_000
export const ORDERS_TTL_MS = 30_000
/** The catalogue (symbol, name, protocols, min buy) barely moves; its price
 *  is a 2-dp reference, and the timer never touches it. */
export const MARKETS_TTL_MS = 10 * 60_000
/** Routes per symbol are static; the live price is on the list row. */
export const ROUTES_TTL_MS = 5 * 60_000

/** Status and orders are what the timer is for: their life follows the live period. */
function liveTtl(slug: string, maxMs: number): number {
  return cadenceTtlMs(liveCadenceSecs('hyperliquid', slug), maxMs)
}

/** A manual refresh is the read the owner waits on: it takes the urgent slot,
 *  so hl-orders runs beside it in the background one instead of behind it. */
export function readAccount(inftId: string, slug: string, force = false): Promise<AcpResult<HlAccount>> {
  return acpJson(inftId, slug, STATUS_ARGV, shapeAccount, {
    force,
    ttlMs: liveTtl(slug, STATUS_TTL_MS),
    urgent: force
  })
}

export function readOrders(inftId: string, slug: string, force = false): Promise<AcpResult<HlOrder[]>> {
  return acpJson(inftId, slug, ORDERS_ARGV, shapeOrders, { force, ttlMs: liveTtl(slug, ORDERS_TTL_MS) })
}

/** `readOrders` plus the dock badge — the one door the app loads orders by. */
export async function loadOrders(inftId: string, slug: string, force = false): Promise<AcpResult<HlOrder[]>> {
  const result = await readOrders(inftId, slug, force)

  if (result.ok) {
    publishOrdersBadge(slug, result.data)
  }

  return result
}

export function readMarkets(inftId: string, slug: string, force = false): Promise<AcpResult<HlMarket[]>> {
  return acpJson(inftId, slug, MARKETS_ARGV, shapeMarkets, { force, ttlMs: MARKETS_TTL_MS })
}

export function readRoutes(inftId: string, slug: string, symbol: string): Promise<AcpResult<HlRoute[]>> {
  // The bridge would refuse it anyway; refusing here spends no queue slot.
  if (!isValidSymbol(symbol)) {
    return Promise.resolve({ ok: false, kind: 'cli', error: `invalid symbol: ${JSON.stringify(symbol)}` })
  }

  return acpJson(inftId, slug, ['trade', 'stock-list', symbol, '--json'], shapeRoutes, { ttlMs: ROUTES_TTL_MS })
}

/**
 * The first-paint read only — `trade hl-status`, byte-identical argv and TTL
 * to the window's own read, so the mount hits the cache. Orders are not
 * warmed (the window reads them right after it paints), but the badge is
 * published from the last snapshot BEFORE the CLI is asked, so the dock wears
 * its count at once rather than behind the per-iNFT queue. An iNFT that turns
 * out de-provisioned loses both the snapshot and the badge.
 */
const econData = defineEconData({
  kind: 'hyperliquid',
  last: slug => {
    const snapshot = readSnapshot<unknown>('hyperliquid', slug, HL_SNAPSHOT_VERSION)

    return snapshot ? reviveSnapshot(snapshot.data) : null
  },
  badge: (slug, revived) => publishOrdersBadge(slug, revived.orders),
  async warm(inftId, slug) {
    const result = await readAccount(inftId, slug)

    return !result.ok && result.kind === 'not-provisioned' ? 'unprovisioned' : undefined
  }
})

/** Returns at once: the reads queue behind nobody's awaits (live.ts). */
export const prefetch = parallelPrefetch('hyperliquid', econData.prefetch)
