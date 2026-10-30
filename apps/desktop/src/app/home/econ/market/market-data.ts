/**
 * EconomyOS — Market data: the live Virtuals ACP marketplace (`acp browse`),
 * the iNFT's own jobs, offerings, resources and subscription packages, and
 * the briefs that hand work over to the iNFT. Every shaper is total — it
 * never throws and returns empty shapes.
 *
 * Shapers handed to `acpJson` are module-level functions: the CLI cache
 * memoizes their output per function, so a cache hit returns the very same
 * arrays and every memo downstream holds.
 */

export { CHAINS_ARGV } from '../agent'
export { needsSetup } from '../cli'
export { oneLine } from '../format'
export {
  codeSpan,
  deliverableLine,
  hireBrief,
  hireChainId,
  hireCommand,
  OFFERING_BRIEF,
  providerWallet,
  resourceBrief,
  type ResourceChange,
  shellQuote
} from './data/briefs'
export { readChains, shapeChains } from './data/chains'
export {
  FEATURED_QUERY,
  JOBS_ARGV,
  JOBS_TAB_KEY,
  OFFERINGS_ARGV,
  RECENT_KEY,
  RECENT_MAX,
  SNAPSHOT_VERSION,
  TOP_K,
  TOP_K_STEPS
} from './data/constants'
export { shapeJobHistory, timestampOf } from './data/history'
export {
  baseUnitsToUsdc,
  counterpartOf,
  countNeedsAction,
  inJobsTab,
  isoOf,
  jobRole,
  type JobRowModel,
  jobRows,
  type JobsTab,
  jobStatusTone,
  jobWhen,
  matchesJob,
  needsMyAction,
  parseJobsTab,
  publishJobsBadge,
  sameAddress,
  shapeJobs,
  speakerOf,
  statusLabel,
  usdcLabel
} from './data/jobs'
export {
  browse,
  invalidateMarket,
  jobHistoryArgv,
  prefetch,
  readJobHistory,
  readJobs,
  readOfferings,
  readResources,
  readSubscriptions,
  settled
} from './data/loaders'
export {
  browseShaper,
  chainName,
  type ChainNames,
  chainNames,
  cheapestOffering,
  filterByChain,
  isAlwaysOn,
  isOnline,
  presenceOf,
  priceLabel,
  ratingLabel,
  shapeAgents,
  shapeOfferings,
  shapeOwnOffering,
  shapeOwnOfferings,
  slaLabel
} from './data/offerings'
export {
  browseArgv,
  browseKey,
  cleanQuery,
  filtersDirty,
  isFeatured,
  nextTopK,
  normalizeTopK,
  paramsDirty,
  parseParams,
  readParams,
  sameSearch,
  writeParams
} from './data/params'
export { parseRecent, pushRecent, readRecent, writeRecent } from './data/recent'
export { fieldPlaceholder, schemaModel } from './data/schemas'
export { type BrowseSlot, emptySlot, failureText, settle, settleBrowse, type Slot } from './data/slots'
export { buildSnapshot, type MarketSnapshot, readMarketSnapshot, restoreSnapshot, type Stamped } from './data/snapshot'
export {
  type AcpChain,
  BROWSE_MODES,
  type BrowseMode,
  type BrowsePage,
  type BrowseParams,
  DEFAULT_PARAMS,
  type JobEntry,
  type JobHistory,
  type MarketAgent,
  type MarketJob,
  type MarketOffering,
  type MarketResource,
  type MarketSubscription,
  ONLINE_FILTERS,
  type OnlineFilter,
  type OwnOffering,
  type SchemaField,
  type SchemaModel,
  SORT_FIELDS,
  type SortField
} from './data/types'
