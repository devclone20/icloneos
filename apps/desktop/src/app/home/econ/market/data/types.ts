/** The market data module's `types` section — its public names are re-exported by ../market-data.ts. */
import { TOP_K } from './constants'

// ── types ───────────────────────────────────────────────────────────────────

export type OnlineFilter = 'all' | 'offline' | 'online'
export type BrowseMode = 'mixed' | 'recency' | 'relevance'
export type SortField = '' | 'minsFromLastOnlineTime' | 'successfulJobCount' | 'successRate' | 'uniqueBuyerCount'

export const ONLINE_FILTERS: readonly OnlineFilter[] = ['all', 'online', 'offline']
export const BROWSE_MODES: readonly BrowseMode[] = ['mixed', 'relevance', 'recency']

export const SORT_FIELDS: readonly SortField[] = [
  '',
  'successfulJobCount',
  'successRate',
  'uniqueBuyerCount',
  'minsFromLastOnlineTime'
]

export interface BrowseParams {
  query: string
  online: OnlineFilter
  mode: BrowseMode
  sortBy: SortField
  /** Applied to the answer on the client, never sent: acp-cli parses
   *  `--chain-ids` but never forwards it, so a chain change is a cache hit. */
  chainId: null | number
  /** One of TOP_K_STEPS. */
  topK: number
}

export const DEFAULT_PARAMS: BrowseParams = {
  query: '',
  online: 'all',
  mode: 'mixed',
  sortBy: '',
  chainId: null,
  topK: TOP_K
}

export interface SchemaField {
  name: string
  /** The JSON-schema type as written: `string`, `array<string>`, `string | null`. */
  type: string
  /** The same type in the owner's words: `text`, `list of text`, `URL`. */
  label: string
  required: boolean
  description: string
  enumValues: string[]
  example: string
  hasDefault: boolean
  defaultValue: unknown
  constraints: string[]
}

export type SchemaModel = { fields: SchemaField[]; kind: 'fields' } | { kind: 'none' } | { kind: 'text'; text: string }

export interface MarketOffering {
  id: string
  agentId: string
  name: string
  description: string
  deliverable: SchemaModel
  requirements: SchemaModel
  slaMinutes: null | number
  /** Lower-case: `fixed`, `percentage`, or whatever the service sends. */
  priceType: string
  priceValue: null | number
  requiredFunds: boolean
  isHidden: boolean
  isPrivate: boolean
}

/** An external endpoint an agent exposes (URL + params schema) — read, not hired. */
export interface MarketResource {
  id: string
  agentId: string
  name: string
  description: string
  /** https only: anything else is '' and never becomes a link. */
  url: string
  params: SchemaModel
  isHidden: boolean
}

/** One of the iNFT's own offerings exactly as saved, so an editor opens it
 *  as it is: the schemas in the form the CLI takes back, and its packages. */
interface OfferingSource {
  /** The JSON schema (compact JSON) or the plain text; '' when unknown. */
  requirements: string
  deliverable: string
  subscriptionIds: string[]
}

export interface OwnOffering extends MarketOffering {
  source: OfferingSource
}

/** A subscription package the iNFT sells (`acp subscription list`). */
export interface MarketSubscription {
  id: string
  packageId: string
  name: string
  priceUsdc: null | number
  durationDays: null | number
}

export interface MarketAgent {
  id: string
  name: string
  description: string
  imageUrl: string
  walletAddress: string
  solWalletAddress: string
  role: string
  cluster: string
  tag: string
  lastActiveAt: string
  online: boolean
  alwaysOn: boolean
  rating: null | number
  isNew: boolean
  chainIds: number[]
  offerings: MarketOffering[]
  resources: MarketResource[]
  /** The cheapest offering's price, computed once per answer ('' when none). */
  priceFrom: string
}

/** One `acp browse` answer: the agents on screen (after the client-side
 *  chain filter) and how many the CLI returned — fewer than asked means the
 *  marketplace has nothing more for this search. */
export interface BrowsePage {
  agents: MarketAgent[]
  returned: number
}

export interface MarketJob {
  key: string
  id: string
  chainId: number
  legacy: boolean
  status: string
  clientAddress: string
  providerAddress: string
  evaluatorAddress: string
  providerName: string
  title: string
  budgetUsdc: null | number
  createdAt: string
  expiredAt: string
}

export type EntryTone = 'down' | 'muted' | 'tone' | 'up' | 'warn'

export interface JobEntry {
  /** Stable within one history — the service's id, else when/what. */
  id: string
  kind: 'message' | 'system'
  /** `Funded`, `Deliverable submitted` — or the message's content type. */
  title: string
  /** Short facts: an amount, a reason. */
  detail: string
  /** The long text: a message, a deliverable. Pretty-printed when it is JSON. */
  body: string
  bodyIsJson: boolean
  from: string
  tone: EntryTone
  at: null | number
}

export interface JobHistory {
  jobId: string
  chainId: number
  status: string
  budgetUsdc: null | number
  deliverable: string
  entries: JobEntry[]
}

export interface AcpChain {
  id: number
  name: string
  family: string
}

export type JobRole = '' | 'client' | 'evaluator' | 'provider'
