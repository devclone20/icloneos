/** The market data module's `constants` section — its public names are re-exported by ../market-data.ts. */
import { ICLONE_STORAGE } from '../../../lib/storage-keys'

// ── constants ───────────────────────────────────────────────────────────────

/** A search asks for the first page, then "Show more" widens it — the
 *  bridge accepts `--top-k` up to 100. */
export const TOP_K_STEPS: readonly number[] = [24, 48, 100]
export const TOP_K = TOP_K_STEPS[0]
/** Per iNFT: each agent shops the marketplace with its own history. */
export const RECENT_KEY = ICLONE_STORAGE.marketRecent.key
export const RECENT_MAX = 8
/** Per iNFT: the last search and filters, so an open resumes where it left. */
export const PARAMS_KEY = ICLONE_STORAGE.marketParams.key
/** Per iNFT: the My jobs tab the owner picked. */
export const JOBS_TAB_KEY = ICLONE_STORAGE.marketJobsTab.key
/** Bump when `MarketSnapshot` changes shape. */
export const SNAPSHOT_VERSION = 1

// `acp browse` refuses an empty query (it prints a plain-text hint, not JSON),
// so the featured feed is a broad query every agent description matches.
export const FEATURED_QUERY = 'agent'

export const QUERY_MAX = 120
export const ONLINE_WINDOW_MS = 10 * 60 * 1000
export const ALWAYS_ON_YEAR = 2999
export const BASE_CHAIN_ID = 8453
export const SOLANA_CHAIN_ID = 501
export const USDC_DECIMALS = 6

// The featured feed is a broad ranking that barely moves minute to minute and
// the most expensive read (~2.5 s); a typed search is fresher by intent.
export const FEATURED_TTL_MS = 10 * 60_000
export const SEARCH_TTL_MS = 120_000
export const JOBS_TTL_MS = 60_000
export const HISTORY_TTL_MS = 30_000
export const OFFERINGS_TTL_MS = 5 * 60_000
// The chain list is compiled into the CLI — only an app update changes it.
// A cold CLI start plus a network search can outlast the bridge's 60 s default.
export const NETWORK_TIMEOUT_MS = 90_000
// The snapshot shares the storage quota with every other app.
export const SNAPSHOT_JOBS_MAX = 100
export const SNAPSHOT_OFFERINGS_MAX = 50
// The envelope, the keys and the stamps around the measured lists.
export const SNAPSHOT_SLACK_BYTES = 1024

// What the bridge admits as an id (electron/iclone-acp.ts `id`), and the two
// wallet shapes a provider can be hired on. Anything else never reaches a
// command the iNFT is asked to run.
export const ACP_ID = /^[A-Za-z0-9_.:-]{1,120}$/
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const JOBS_ARGV: readonly string[] = ['job', 'list', '--all', '--json']
export const OFFERINGS_ARGV: readonly string[] = ['offering', 'list', '--json']
export const RESOURCES_ARGV: readonly string[] = ['resource', 'list', '--json']
export const SUBSCRIPTIONS_ARGV: readonly string[] = ['subscription', 'list', '--json']
