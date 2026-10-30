import { displayModelName } from '@/lib/model-status-label'

import { chainListReader } from '../agent'
import { defineEconData } from '../app-data'
/**
 * EconomyOS — Wallet data layer.
 *
 * Shapes `wallet balance`, `compute status` and `chain list` into what the
 * Wallet app renders, and nothing else: every shaper is total (never throws)
 * and tolerant of missing/renamed fields, per the CLI's own tolerance
 * contract. `readBalances`/`readCompute`/`readChains` are the only entry
 * points the app should call — they own the argv and the cache TTLs — and
 * `prefetch` is the one read the dock warms before the window ever opens.
 */
import {
  type AcpErrorKind,
  acpJson,
  type AcpResult,
  asRecord,
  bool,
  isFiniteNumber,
  type Json,
  listAt,
  num,
  str
} from '../cli'
import { chainByNetwork, type ChainInfo, fromHexUnits, shortAddress, usd } from '../format'
import { cadenceTtlMs, liveCadenceSecs, parallelPrefetch } from '../live'
import { readSnapshot, type Snapshot } from '../snapshot'

export interface WalletToken {
  /** Stable React key: `<network>:<tokenAddress-or-native>`. */
  key: string
  network: string
  chainId: number
  chainLabel: string
  symbol: string
  name: string
  logo: string
  isNative: boolean
  amount: number
  /** USD price per unit; null when the feed carried no price — unknown is not $0. */
  price: null | number
  usd: number
}

export interface WalletStock {
  /** Stable React key: `<protocol>:<chain>:<symbol>`. */
  key: string
  symbol: string
  name: string
  /** Chain or protocol label — tokenized stocks are protocol-scoped, not chain-scoped. */
  chain: string
  protocol: string
  amount: number
  usd: number
}

interface WalletHyperliquidSummary {
  balanceUsd: number
  spotUsd: number
  longPositionsUsd: number
  asOf: string
  isCached: boolean
}

export interface WalletChainTotal {
  network: string
  chainId: number
  label: string
  assetCount: number
  usd: number
}

export interface WalletBalances {
  address: string
  solanaAddress: string
  /** All tokens the CLI reported, sorted by USD desc — zero balances included. */
  tokens: WalletToken[]
  stocks: WalletStock[]
  hyperliquid: WalletHyperliquidSummary
  /** One entry per network holding a non-zero token balance, richest first. */
  chainTotals: WalletChainTotal[]
  tokensUsd: number
  stocksUsd: number
  /** Σ tokens + Σ stocks + hyperliquid.balanceUsd — the wallet hero figure. */
  totalUsd: number
}

export interface ComputeStatus {
  limit: number
  limitRemaining: number
  usage: number
  preferredModel: string
  fallbackModel: string
  autoTopUpEnabled: boolean
  autoTopUpThreshold: number
  autoTopUpAmount: number
  hasComputeAutoBilling: boolean
}

export interface WalletChain {
  id: number
  name: string
  family: string
}

export interface ChainListResult {
  environment: string
  chains: WalletChain[]
}

/** The held tokens of one chain under that chain's total — the grouped view. */
export interface WalletChainGroup {
  total: WalletChainTotal
  tokens: WalletToken[]
}

/** What survives a relaunch (snapshot.ts). Bump the version with the shape. */
interface WalletSnapshot {
  balances: WalletBalances
  compute: ComputeStatus | null
  chains: ChainListResult | null
}

interface ReadOptions {
  force?: boolean
  /** The window just painted saved balances and the owner is looking at them: take the urgent slot (a fresh
   *  cache hit is still served; a queued warm-up of the same read is promoted, never doubled). */
  atPaint?: boolean
}

// The window's timer ticks every 60 s (Settings → iNFT, floor 15 s) without
// forcing. cli.ts stamps a cache entry when the read is REQUESTED, so a TTL
// equal to the tick has expired by the next tick whatever the CLI's latency:
// one spawn per tick for balances, one every second tick for compute, and a
// finished prefetch is still warm when the window opens.
// Five seconds under the default 60 s tick: a repeating timer may fire a hair
// early, and an entry exactly one period old must already read as stale.
const BALANCES_TTL_MS = 55_000
// Compute credit moves on inference and top-ups only.
const COMPUTE_TTL_MS = 115_000
// Identical argv — and so the same cache key — as the market app's chain read:
// one hourly answer serves both windows.

/** v2: sanitised symbols, allow-listed logos, keyed stocks. */
export const WALLET_SNAPSHOT_VERSION = 2
/** Zero-balance spam tokens stay on screen by design; only this many are persisted. */
export const SNAPSHOT_EMPTY_TOKEN_CAP = 200

// ── what the CLI's token metadata may say ────────────────────────────────────

// ERC-20 metadata is written by whoever deployed the token: an airdropped spam
// token calls itself "USDC", or carries a sentence aimed at the agent. A ticker
// is short and plain; anything else shows as its contract address.
const TOKEN_SYMBOL = /^[A-Za-z0-9._$-]{1,16}$/

// A logo URL is fetched by the renderer: off this list it is a tracking pixel
// that hands the airdropper the owner's IP. https only.
const LOGO_HOSTS = new Set([
  'static.alchemyapi.io',
  'assets.coingecko.com',
  'logos.covalenthq.com',
  'raw.githubusercontent.com',
  'tokens.1inch.io'
])

/** The ticker when it looks like one, the token's short contract address otherwise. */
export function safeSymbol(symbol: string, tokenAddress: string): string {
  return TOKEN_SYMBOL.test(symbol) ? symbol : shortAddress(tokenAddress) || 'TOKEN'
}

/** The URL when it is https on an allow-listed host, '' otherwise (initials paint). */
export function safeLogoUrl(url: string): string {
  if (!url) {
    return ''
  }

  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && LOGO_HOSTS.has(parsed.hostname)
      ? url
      : ''
  } catch {
    return ''
  }
}

// ── token + stock + hyperliquid shaping ─────────────────────────────────────

function shapeToken(raw: Json): WalletToken | null {
  const network = str(raw, 'network')

  if (!network) {
    return null
  }

  const chain: ChainInfo = chainByNetwork(network)
  const tokenAddress = typeof raw.tokenAddress === 'string' ? raw.tokenAddress : null
  const metadata = asRecord(raw.tokenMetadata)
  const decimals = tokenAddress === null ? chain.nativeDecimals : num(metadata, 'decimals', 18)
  const symbol = tokenAddress === null ? chain.native || 'NATIVE' : safeSymbol(str(metadata, 'symbol'), tokenAddress)
  const name = str(metadata, 'name') || symbol
  const amount = fromHexUnits(str(raw, 'tokenBalance', '0x0'), decimals)
  const prices = listAt(raw, ['tokenPrices'])
  const price = prices.length > 0 ? num(prices[0], 'value') : null

  return {
    key: `${network}:${tokenAddress ?? 'native'}`,
    network,
    chainId: chain.chainId,
    chainLabel: chain.label,
    symbol,
    name,
    logo: safeLogoUrl(str(metadata, 'logo')),
    isNative: tokenAddress === null,
    amount,
    price,
    usd: price === null ? 0 : amount * price
  }
}

function shapeStock(raw: Json): WalletStock {
  const symbol = str(raw, 'symbol')
  const protocol = str(raw, 'protocol')
  const chain = str(raw, 'chain') || protocol

  return {
    key: `${protocol}:${chain}:${symbol}`,
    symbol,
    name: str(raw, 'name') || symbol,
    chain,
    protocol,
    amount: num(raw, 'shares', num(raw, 'amount')),
    usd: num(raw, 'usd', num(raw, 'valueUsd'))
  }
}

function shapeHyperliquidSummary(raw: Json | null): WalletHyperliquidSummary {
  return {
    balanceUsd: num(raw, 'balanceUsd'),
    spotUsd: num(raw, 'spotUsd'),
    longPositionsUsd: num(raw, 'longPositionsUsd'),
    asOf: str(raw, 'asOf'),
    isCached: bool(raw, 'isCached')
  }
}

function totalsByChain(tokens: WalletToken[]): WalletChainTotal[] {
  const byNetwork = new Map<string, WalletChainTotal>()

  for (const token of tokens) {
    if (token.amount <= 0) {
      continue
    }

    const existing = byNetwork.get(token.network)

    if (existing) {
      existing.usd += token.usd
      existing.assetCount += 1
    } else {
      byNetwork.set(token.network, {
        network: token.network,
        chainId: token.chainId,
        label: token.chainLabel,
        assetCount: 1,
        usd: token.usd
      })
    }
  }

  return [...byNetwork.values()].sort((a, b) => b.usd - a.usd)
}

/** Non-zero balances first (what the table shows), zero balances collapsed
 *  behind the "Show N empty balances" toggle — split, never dropped. */
export function splitByBalance(tokens: WalletToken[]): { held: WalletToken[]; empty: WalletToken[] } {
  const held: WalletToken[] = []
  const empty: WalletToken[] = []

  for (const token of tokens) {
    if (token.amount > 0) {
      held.push(token)
    } else {
      empty.push(token)
    }
  }

  return { held, empty }
}

/** Held tokens under their chain, richest chain first (the order of `totals`);
 *  a chain with nothing held never yields a group. */
export function groupHeldByChain(held: WalletToken[], totals: WalletChainTotal[]): WalletChainGroup[] {
  const byNetwork = new Map(totals.map(total => [total.network, { total, tokens: [] as WalletToken[] }]))

  for (const token of held) {
    byNetwork.get(token.network)?.tokens.push(token)
  }

  return [...byNetwork.values()].filter(group => group.tokens.length > 0)
}

export function shapeBalances(raw: unknown): WalletBalances {
  const root = asRecord(raw)

  const tokens = listAt(raw, ['tokens'])
    .map(shapeToken)
    .filter((token): token is WalletToken => token !== null)
    .sort((a, b) => b.usd - a.usd)

  const stocks = listAt(raw, ['stocks']).map(shapeStock)
  const hyperliquid = shapeHyperliquidSummary(asRecord(root?.hyperliquid))
  const tokensUsd = tokens.reduce((sum, token) => sum + token.usd, 0)
  const stocksUsd = stocks.reduce((sum, stock) => sum + stock.usd, 0)

  return {
    address: str(root, 'address'),
    solanaAddress: str(root, 'solanaAddress'),
    tokens,
    stocks,
    hyperliquid,
    chainTotals: totalsByChain(tokens),
    tokensUsd,
    stocksUsd,
    totalUsd: tokensUsd + stocksUsd + hyperliquid.balanceUsd
  }
}

export function shapeCompute(raw: unknown): ComputeStatus {
  const root = asRecord(raw)

  return {
    limit: num(root, 'limit'),
    limitRemaining: num(root, 'limitRemaining'),
    usage: num(root, 'usage'),
    preferredModel: str(root, 'preferredModel'),
    fallbackModel: str(root, 'fallbackModel'),
    autoTopUpEnabled: bool(root, 'autoTopUpEnabled'),
    autoTopUpThreshold: num(root, 'autoTopUpThreshold'),
    autoTopUpAmount: num(root, 'autoTopUpAmount'),
    hasComputeAutoBilling: bool(root, 'hasComputeAutoBilling')
  }
}

/** The compute API names a model `<provider>-<model>` with its dots flattened
 *  (`deepseek-deepseek-v4-1-flash`); the owner reads the model's own name
 *  ("Deepseek V4.1 Flash"). Blank stays blank so callers keep their dash. */
export function computeModelLabel(slug: string): string {
  const id = slug.trim()

  if (!id) {
    return ''
  }

  const model = id
    .replace(/^([a-z0-9]+)-(?=\1-)/i, '')
    // `v4-1` → `v4.1`; a size (`3-70b`) or a date's later fields are not a version.
    .replace(/(?<!\d-?)(\d{1,2})-(\d{1,2})(?=-|$)/g, '$1.$2')
    // What is left between digits is a size or a date: a space, so the
    // display name's own version dotting leaves it alone (`3.1 8b`).
    .replace(/(\d)-(?=\d)/g, '$1 ')

  return displayModelName(model)
}

export function shapeChainList(raw: unknown): ChainListResult {
  const root = asRecord(raw)

  const chains = listAt(raw, ['chains']).map(entry => ({
    id: num(entry, 'id'),
    name: str(entry, 'name'),
    family: str(entry, 'family')
  }))

  return { environment: str(root, 'environment'), chains }
}

// ── snapshot ─────────────────────────────────────────────────────────────────

/** The persisted state: every held token, the empties capped, totals intact
 *  (empties carry no value, so the hero figure and chain totals still add up). */
export function toWalletSnapshot(
  balances: WalletBalances,
  compute: ComputeStatus | null,
  chains: ChainListResult | null
): WalletSnapshot {
  const { held, empty } = splitByBalance(balances.tokens)

  if (empty.length <= SNAPSHOT_EMPTY_TOKEN_CAP) {
    return { balances, compute, chains }
  }

  const tokens = [...held, ...empty.slice(0, SNAPSHOT_EMPTY_TOKEN_CAP)].sort((a, b) => b.usd - a.usd)

  return { balances: { ...balances, tokens }, compute, chains }
}

function isToken(value: unknown): boolean {
  const token = asRecord(value)

  return Boolean(
    token &&
    typeof token.key === 'string' &&
    typeof token.network === 'string' &&
    typeof token.chainLabel === 'string' &&
    typeof token.symbol === 'string' &&
    typeof token.name === 'string' &&
    typeof token.logo === 'string' &&
    typeof token.isNative === 'boolean' &&
    isFiniteNumber(token.chainId) &&
    isFiniteNumber(token.amount) &&
    (token.price === null || isFiniteNumber(token.price)) &&
    isFiniteNumber(token.usd)
  )
}

function isStock(value: unknown): boolean {
  const stock = asRecord(value)

  return Boolean(
    stock &&
    typeof stock.key === 'string' &&
    typeof stock.symbol === 'string' &&
    typeof stock.name === 'string' &&
    typeof stock.chain === 'string' &&
    typeof stock.protocol === 'string' &&
    isFiniteNumber(stock.amount) &&
    isFiniteNumber(stock.usd)
  )
}

function isChainTotal(value: unknown): boolean {
  const total = asRecord(value)

  return Boolean(
    total &&
    typeof total.network === 'string' &&
    typeof total.label === 'string' &&
    isFiniteNumber(total.chainId) &&
    isFiniteNumber(total.assetCount) &&
    isFiniteNumber(total.usd)
  )
}

function isBalances(value: unknown): value is WalletBalances {
  const balances = asRecord(value)
  const hyperliquid = asRecord(balances?.hyperliquid)

  return Boolean(
    balances &&
    hyperliquid &&
    typeof balances.address === 'string' &&
    typeof balances.solanaAddress === 'string' &&
    Array.isArray(balances.tokens) &&
    balances.tokens.every(isToken) &&
    Array.isArray(balances.stocks) &&
    balances.stocks.every(isStock) &&
    Array.isArray(balances.chainTotals) &&
    balances.chainTotals.every(isChainTotal) &&
    isFiniteNumber(hyperliquid.balanceUsd) &&
    isFiniteNumber(hyperliquid.spotUsd) &&
    isFiniteNumber(hyperliquid.longPositionsUsd) &&
    typeof hyperliquid.asOf === 'string' &&
    typeof hyperliquid.isCached === 'boolean' &&
    isFiniteNumber(balances.tokensUsd) &&
    isFiniteNumber(balances.stocksUsd) &&
    isFiniteNumber(balances.totalUsd)
  )
}

function isCompute(value: unknown): value is ComputeStatus {
  const compute = asRecord(value)

  return Boolean(
    compute &&
    isFiniteNumber(compute.limit) &&
    isFiniteNumber(compute.limitRemaining) &&
    isFiniteNumber(compute.usage) &&
    typeof compute.preferredModel === 'string' &&
    typeof compute.fallbackModel === 'string' &&
    typeof compute.autoTopUpEnabled === 'boolean' &&
    isFiniteNumber(compute.autoTopUpThreshold) &&
    isFiniteNumber(compute.autoTopUpAmount) &&
    typeof compute.hasComputeAutoBilling === 'boolean'
  )
}

function isChainList(value: unknown): value is ChainListResult {
  const list = asRecord(value)

  return Boolean(
    list &&
    typeof list.environment === 'string' &&
    Array.isArray(list.chains) &&
    list.chains.every(entry => {
      const chain = asRecord(entry)

      return chain && isFiniteNumber(chain.id) && typeof chain.name === 'string' && typeof chain.family === 'string'
    })
  )
}

/** A snapshot is only as sound as the disk it came from: every field the
 *  wallet dereferences in render is checked here, so a corrupted or foreign
 *  entry is ignored instead of taking the window down on every launch. */
export function isWalletSnapshot(value: unknown): value is WalletSnapshot {
  const root = asRecord(value)

  return Boolean(
    root &&
    isBalances(root.balances) &&
    (root.compute === null || isCompute(root.compute)) &&
    (root.chains === null || isChainList(root.chains))
  )
}

/** The last snapshot, only when every field the render dereferences checks
 *  out — what is on disk is unknown until it is looked at. */
export function readWalletSnapshot(slug: string): Snapshot<WalletSnapshot> | null {
  const snapshot = readSnapshot<unknown>('wallet', slug, WALLET_SNAPSHOT_VERSION)

  return snapshot && isWalletSnapshot(snapshot.data) ? { at: snapshot.at, data: snapshot.data } : null
}

// ── labels ───────────────────────────────────────────────────────────────────

const COMPACT_UNITS: Array<[number, string]> = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
]

/** "$5.1K" for a rail count; the full figure below a thousand. Thresholds sit
 *  just under each unit so rounding never prints "$1000K". */
export function compactUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }

  const abs = Math.abs(value)

  for (const [size, suffix] of COMPACT_UNITS) {
    if (abs >= size * 0.9995) {
      const scaled = abs / size
      const digits = scaled >= 9.995 ? 0 : 1

      return `${value < 0 ? '−' : ''}$${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`
    }
  }

  return usd(value)
}

/** The short state the window header shows when the balance read fails; the
 *  body carries the full message. */
export function failureLabel(kind: AcpErrorKind): string {
  switch (kind) {
    case 'reauth':
      return 'sign-in required'

    case 'reauth-acp':
      return 'sign-in required'

    case 'not-provisioned':
      return 'setup needed'

    case 'busy':
      return 'agent busy'

    case 'timeout':
      return 'timed out'

    case 'unavailable':
      return 'bridge unavailable'

    default:
      return 'balances unavailable'
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

export function readBalances(
  inftId: string,
  slug: string,
  options: ReadOptions = {}
): Promise<AcpResult<WalletBalances>> {
  return acpJson(inftId, slug, ['wallet', 'balance', '--json'], shapeBalances, {
    // A focused window ticks every 20 s: its read must have expired by then.
    ttlMs: cadenceTtlMs(liveCadenceSecs('wallet', slug), BALANCES_TTL_MS),
    force: options.force,
    // A forced read is the owner's Refresh, and the first read of an open window is the one he waits on
    // (doc 07 #10): the urgent slot, never the background queue behind the other dock apps' warm-ups (U3-p2b-01).
    urgent: options.force || options.atPaint
  })
}

export function readCompute(
  inftId: string,
  slug: string,
  options: ReadOptions = {}
): Promise<AcpResult<ComputeStatus>> {
  return acpJson(inftId, slug, ['compute', 'status', '--json'], shapeCompute, {
    ttlMs: COMPUTE_TTL_MS,
    force: options.force
  })
}

export const readChains = chainListReader(shapeChainList)

/** The first-paint reads only (prefetch.ts): the same argv and TTLs as the
 *  window's own reads, so its mount is a cache hit — the balances, then the
 *  compute credit tile beside them. No dock badge — a wallet has no count
 *  worth wearing. */
const econData = defineEconData({
  kind: 'wallet',
  async warm(inftId, slug) {
    await readBalances(inftId, slug)
    await readCompute(inftId, slug)
  }
})

/** Returns at once: the reads queue behind nobody's awaits (live.ts). */
export const prefetch = parallelPrefetch('wallet', econData.prefetch)

// ── cells ───────────────────────────────────────────────────────────────────

/** The PRICE cell: a feed without a price says so, never `$0.00`. */
export function priceText(token: Pick<WalletToken, 'price'>): string {
  return token.price === null ? '—' : usd(token.price)
}

/** The VALUE cell is a figure only when the price is known or there is nothing to value. */
export function valueKnown(token: Pick<WalletToken, 'amount' | 'price'>): boolean {
  return token.price !== null || token.amount === 0
}

/** The asset's name under its symbol — none when the feed only repeats the symbol. */
export function assetName(token: Pick<WalletToken, 'name' | 'symbol'>): null | string {
  return token.name === token.symbol ? null : token.name
}

/** Distinct chains among the rows on screen — what "across N chains" counts when empty balances are shown. */
export function countChains(tokens: readonly Pick<WalletToken, 'network'>[]): number {
  return new Set(tokens.map(token => token.network)).size
}
