/** The market data module's `offerings` section — its public names are re-exported by ../market-data.ts. */
import { asArray, bool, isString, type Json, listAt, num, str } from '../../cli'
import { timeAgo, tokenAmount } from '../../format'

import { ACP_ID, ALWAYS_ON_YEAR, BASE_CHAIN_ID, ONLINE_WINDOW_MS, SOLANA_CHAIN_ID } from './constants'
import { finiteOrNull, records, round } from './primitives'
import { schemaModel } from './schemas'
import type {
  AcpChain,
  BrowsePage,
  MarketAgent,
  MarketOffering,
  MarketResource,
  MarketSubscription,
  OwnOffering
} from './types'

// ── agents + offerings ──────────────────────────────────────────────────────

function shapeOffering(raw: Json): MarketOffering {
  return {
    id: str(raw, 'id'),
    agentId: str(raw, 'agentId'),
    name: str(raw, 'name') || 'Untitled offering',
    description: str(raw, 'description'),
    deliverable: schemaModel(raw.deliverable),
    requirements: schemaModel(raw.requirements ?? raw.requirement),
    slaMinutes: finiteOrNull(raw.slaMinutes),
    priceType: (str(raw, 'priceType') || 'fixed').toLowerCase(),
    priceValue: finiteOrNull(raw.priceValue ?? raw.price),
    requiredFunds: bool(raw, 'requiredFunds'),
    isHidden: bool(raw, 'isHidden'),
    isPrivate: bool(raw, 'isPrivate')
  }
}

export function shapeOfferings(raw: unknown): MarketOffering[] {
  return listAt(raw, ['offerings', 'data']).map(shapeOffering)
}

/** A schema as the CLI takes it back: an object as compact JSON, text as is. */
function sourceText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }

  return ''
}

function subscriptionIdsOf(raw: Json): string[] {
  const attached = records(raw.subscriptions).map(item => str(item, 'id'))
  const listed = asArray(raw.subscriptionIds).filter(isString)

  return [...new Set([...attached, ...listed].filter(value => ACP_ID.test(value)))]
}

export function shapeOwnOffering(raw: Json): OwnOffering {
  return {
    ...shapeOffering(raw),
    source: {
      requirements: sourceText(raw.requirements ?? raw.requirement),
      deliverable: sourceText(raw.deliverable),
      subscriptionIds: subscriptionIdsOf(raw)
    }
  }
}

/** `acp offering list --json` — a bare array of the iNFT's own offerings. */
export function shapeOwnOfferings(raw: unknown): OwnOffering[] {
  return listAt(raw, ['offerings', 'data']).map(shapeOwnOffering)
}

/** A link a listing may carry: https, no credentials, nothing else. */
export function safeLink(value: string): string {
  const url = value.trim()

  if (!/^https:\/\/\S+$/.test(url) || url.length > 2000) {
    return ''
  }

  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password ? url : ''
  } catch {
    return ''
  }
}

function shapeResource(raw: Json): MarketResource {
  return {
    id: str(raw, 'id'),
    agentId: str(raw, 'agentId'),
    name: str(raw, 'name') || 'Untitled resource',
    description: str(raw, 'description'),
    url: safeLink(str(raw, 'url')),
    params: schemaModel(raw.params),
    isHidden: bool(raw, 'isHidden') || bool(raw, 'hidden')
  }
}

/** `acp resource list --json` — a bare array; hidden ones are the owner's too. */
export function shapeResources(raw: unknown): MarketResource[] {
  return listAt(raw, ['resources', 'data']).map(shapeResource)
}

const SECONDS_PER_DAY = 86_400

export function shapeSubscriptions(raw: unknown): MarketSubscription[] {
  return listAt(raw, ['subscriptions', 'data'])
    .map(item => {
      const seconds = finiteOrNull(item.duration)
      const days = finiteOrNull(item.durationDays)

      return {
        id: str(item, 'id'),
        packageId: str(item, 'packageId'),
        name: str(item, 'name') || 'Untitled package',
        priceUsdc: finiteOrNull(item.price),
        durationDays: days ?? (seconds == null ? null : Math.round(seconds / SECONDS_PER_DAY))
      }
    })
    .filter(item => ACP_ID.test(item.id))
}

/** `lastActiveAt: "2999-12-31…"` is the service's "always online" sentinel. */
export function isAlwaysOn(lastActiveAt: string): boolean {
  const year = Number(/^\s*(\d{4})-/.exec(lastActiveAt)?.[1])

  return Number.isFinite(year) && year >= ALWAYS_ON_YEAR
}

export function isOnline(lastActiveAt: string, now: number): boolean {
  if (!lastActiveAt) {
    return false
  }

  if (isAlwaysOn(lastActiveAt)) {
    return true
  }

  const at = Date.parse(lastActiveAt)

  return Number.isFinite(at) && now - at <= ONLINE_WINDOW_MS
}

export function safeImage(url: string): string {
  return /^https:\/\//i.test(url) ? url : ''
}

export function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function chainIdsOf(raw: Json): number[] {
  const ids = records(raw.chains)
    .filter(chain => chain.active !== false)
    .map(chain => num(chain, 'chainId'))
    .filter(isChainId)

  const single = num(raw, 'chainId')

  return [...new Set(ids.length > 0 ? ids : isChainId(single) ? [single] : [])]
}

/** One card per agent: the grid keys and selects by id. */
export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()

  return items.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)))
}

/** An agent with neither an id nor a wallet can be neither opened nor
 *  hired, and would collide with every other such card: it is dropped. */
function shapeAgent(raw: Json, now: number): MarketAgent | null {
  const walletAddress = str(raw, 'walletAddress')
  const solWalletAddress = str(raw, 'solWalletAddress')
  const id = str(raw, 'id') || walletAddress || solWalletAddress
  const name = str(raw, 'name')

  if (!id) {
    return null
  }

  const lastActiveAt = str(raw, 'lastActiveAt')

  const offerings = records(raw.offerings ?? raw.jobOfferings)
    .map(shapeOffering)
    .filter(offering => !offering.isHidden)

  const resources = records(raw.resources)
    .map(shapeResource)
    .filter(resource => !resource.isHidden)

  const cheapest = cheapestOffering(offerings)

  return {
    id,
    name: name || walletAddress || solWalletAddress || 'Unnamed agent',
    description: str(raw, 'description'),
    imageUrl: safeImage(str(raw, 'imageUrl')),
    walletAddress,
    solWalletAddress,
    role: str(raw, 'role'),
    cluster: str(raw, 'cluster'),
    tag: str(raw, 'tag'),
    lastActiveAt,
    online: isOnline(lastActiveAt, now),
    alwaysOn: isAlwaysOn(lastActiveAt),
    rating: finiteOrNull(raw.rating),
    isNew: bool(raw, 'isNew'),
    chainIds: chainIdsOf(raw),
    offerings,
    resources,
    priceFrom: cheapest ? priceLabel(cheapest) : ''
  }
}

export function shapeAgents(raw: unknown, now = Date.now()): MarketAgent[] {
  return uniqueById(
    listAt(raw, ['data', 'agents'])
      .map(item => shapeAgent(item, now))
      .filter((agent): agent is MarketAgent => agent !== null)
  )
}

export function filterByChain(agents: MarketAgent[], chainId: null | number): MarketAgent[] {
  return chainId ? agents.filter(agent => agent.chainIds.includes(chainId)) : agents
}

const browseShapers = new Map<null | number, (raw: unknown) => BrowsePage>()

/** One shaper per chain filter, created once — the CLI cache memoizes by the
 *  function, so one cached answer serves every chain filter without a spawn,
 *  and a fresh arrow per call would re-shape every cache hit. */
export function browseShaper(chainId: null | number): (raw: unknown) => BrowsePage {
  let shaper = browseShapers.get(chainId)

  if (!shaper) {
    shaper = (raw: unknown) => ({
      agents: filterByChain(shapeAgents(raw), chainId),
      returned: listAt(raw, ['data', 'agents']).length
    })
    browseShapers.set(chainId, shaper)
  }

  return shaper
}

/**
 * "Show more" re-asks the same search with a bigger `--top-k` — there is no
 * cursor. The cards already on screen keep their places (the owner is reading
 * them, and the service may reorder a wider page), refreshed from the wider
 * answer; the agents it adds follow, in its order, each id once.
 */
export function mergePages(shown: readonly MarketAgent[], wider: readonly MarketAgent[]): MarketAgent[] {
  const fresh = new Map(wider.map(agent => [agent.id, agent]))
  const kept = shown.map(agent => fresh.get(agent.id) ?? agent)
  const seen = new Set(kept.map(agent => agent.id))

  return uniqueById([...kept, ...wider.filter(agent => !seen.has(agent.id))])
}

export function priceLabel(offering: Pick<MarketOffering, 'priceType' | 'priceValue'>): string {
  const { priceType, priceValue } = offering

  if (priceValue == null) {
    return 'price on request'
  }

  // The service stores a share as WHOLE percent (a live listing: `20` = 20 %
  // of the job value), not as a fraction.
  if (priceType === 'percentage') {
    return `${round(priceValue, 2)}%`
  }

  if (priceValue === 0) {
    return 'free'
  }

  return priceType === 'fixed' ? `${tokenAmount(priceValue)} USDC` : `${tokenAmount(priceValue)} (${priceType})`
}

/** The fixed-price offering an owner would pay least for, else any priced one. */
export function cheapestOffering(offerings: MarketOffering[]): MarketOffering | null {
  const priced = offerings.filter(offering => offering.priceValue != null)
  const fixed = priced.filter(offering => offering.priceType === 'fixed')
  const pool = fixed.length > 0 ? fixed : priced

  return pool.reduce<MarketOffering | null>(
    (best, offering) => (!best || offering.priceValue! < best.priceValue! ? offering : best),
    null
  )
}

export function ratingLabel(rating: null | number): string {
  return rating == null ? 'new' : `★ ${rating.toFixed(1)}`
}

interface Presence {
  online: boolean
  label: string
}

/** Where an agent is, as of `now` — derived from `lastActiveAt` every time. */
export function presenceOf(agent: Pick<MarketAgent, 'lastActiveAt'>, now: number): Presence {
  const { lastActiveAt } = agent

  if (isAlwaysOn(lastActiveAt)) {
    return { online: true, label: 'always online' }
  }

  if (isOnline(lastActiveAt, now)) {
    return { online: true, label: 'online now' }
  }

  return {
    online: false,
    label: lastActiveAt && Number.isFinite(Date.parse(lastActiveAt)) ? `active ${timeAgo(lastActiveAt)}` : 'offline'
  }
}

export function slaLabel(minutes: null | number): string {
  if (minutes == null || minutes <= 0) {
    return ''
  }

  if (minutes < 60) {
    return `${Math.round(minutes)} min`
  }

  if (minutes < 1440) {
    return `${round(minutes / 60, 1)} h`
  }

  return `${round(minutes / 1440, 1)} d`
}

const KNOWN_CHAINS = new Map([
  [BASE_CHAIN_ID, 'Base'],
  [4663, 'Robinhood Chain'],
  [5042, 'Arc'],
  [SOLANA_CHAIN_ID, 'Solana']
])

export type ChainNames = ReadonlyMap<number, string>

/** Build once per chain list; every pill then reads a map, not a scan. */
export function chainNames(chains: AcpChain[]): ChainNames {
  return new Map(chains.map(chain => [chain.id, chain.name]))
}

export function chainName(chainId: number, names: ChainNames): string {
  return names.get(chainId) || KNOWN_CHAINS.get(chainId) || `chain ${chainId}`
}
