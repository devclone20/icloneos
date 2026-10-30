/** The market data module's `loaders` section — its public names are re-exported by ../market-data.ts. */
import { $agentIdentity } from '../../agent'
import { defineEconData } from '../../app-data'
import { type AcpFailure, acpJson, type AcpResult, invalidateAcp } from '../../cli'

import {
  ACP_ID,
  BASE_CHAIN_ID,
  FEATURED_TTL_MS,
  HISTORY_TTL_MS,
  JOBS_ARGV,
  JOBS_TTL_MS,
  NETWORK_TIMEOUT_MS,
  OFFERINGS_ARGV,
  OFFERINGS_TTL_MS,
  RESOURCES_ARGV,
  SEARCH_TTL_MS,
  SUBSCRIPTIONS_ARGV
} from './constants'
import { shapeJobHistory } from './history'
import { publishJobsBadge, shapeJobs } from './jobs'
import { browseShaper, isChainId, shapeOwnOfferings, shapeResources, shapeSubscriptions } from './offerings'
import { browseArgv, isFeatured, paramsDirty, readParams } from './params'
import { readMarketSnapshot } from './snapshot'
import {
  type BrowsePage,
  type BrowseParams,
  DEFAULT_PARAMS,
  type JobHistory,
  type MarketJob,
  type MarketResource,
  type MarketSubscription,
  type OwnOffering
} from './types'

// ── loaders ─────────────────────────────────────────────────────────────────

/** A read that always settles to a result: a rejected IPC call becomes an
 *  `unavailable` failure, so a loading slot always ends. */
export function settled<T>(read: Promise<AcpResult<T>>): Promise<AcpResult<T>> {
  return read.catch((error: unknown): AcpFailure => ({
    ok: false,
    kind: 'unavailable',
    error: error instanceof Error ? error.message : String(error)
  }))
}

export function browse(
  inftId: string,
  slug: string,
  params: BrowseParams,
  force = false
): Promise<AcpResult<BrowsePage>> {
  return settled(
    acpJson(inftId, slug, browseArgv(params), browseShaper(params.chainId), {
      ttlMs: isFeatured(params) ? FEATURED_TTL_MS : SEARCH_TTL_MS,
      force,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
  )
}

export function readJobs(inftId: string, slug: string, force = false): Promise<AcpResult<MarketJob[]>> {
  return settled(
    acpJson(inftId, slug, [...JOBS_ARGV], shapeJobs, { ttlMs: JOBS_TTL_MS, force, timeoutMs: NETWORK_TIMEOUT_MS })
  )
}

/** The room's argv, or null when the job id is not one the bridge admits. */
export function jobHistoryArgv(job: Pick<MarketJob, 'chainId' | 'id'>): null | string[] {
  if (!ACP_ID.test(job.id)) {
    return null
  }

  const chainId = isChainId(job.chainId) ? job.chainId : BASE_CHAIN_ID

  return ['job', 'history', '--job-id', job.id, '--chain-id', String(chainId), '--json']
}

export function readJobHistory(
  inftId: string,
  slug: string,
  job: Pick<MarketJob, 'chainId' | 'id'>,
  force = false
): Promise<AcpResult<JobHistory>> {
  const argv = jobHistoryArgv(job)

  if (!argv) {
    return Promise.resolve({ ok: false, kind: 'cli', error: 'This job’s id cannot be read by the ACP CLI.' })
  }

  return settled(
    acpJson(inftId, slug, argv, shapeJobHistory, { ttlMs: HISTORY_TTL_MS, force, timeoutMs: NETWORK_TIMEOUT_MS })
  )
}

export function readOfferings(inftId: string, slug: string, force = false): Promise<AcpResult<OwnOffering[]>> {
  return settled(
    acpJson(inftId, slug, [...OFFERINGS_ARGV], shapeOwnOfferings, {
      ttlMs: OFFERINGS_TTL_MS,
      force,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
  )
}

export function readResources(inftId: string, slug: string, force = false): Promise<AcpResult<MarketResource[]>> {
  return settled(
    acpJson(inftId, slug, [...RESOURCES_ARGV], shapeResources, {
      ttlMs: OFFERINGS_TTL_MS,
      force,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
  )
}

export function readSubscriptions(
  inftId: string,
  slug: string,
  force = false
): Promise<AcpResult<MarketSubscription[]>> {
  return settled(
    acpJson(inftId, slug, [...SUBSCRIPTIONS_ARGV], shapeSubscriptions, {
      ttlMs: OFFERINGS_TTL_MS,
      force,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
  )
}

/** Forget every market answer for this iNFT: a cached sign-in failure must
 *  not outlive the sign-in it sent the owner to. */
export function invalidateMarket(slug: string): void {
  for (const prefix of [['browse'], ['job'], ['offering'], ['resource'], ['subscription'], ['chain']]) {
    invalidateAcp(slug, prefix)
  }
}

/**
 * Warm the cache for the window's first paint: the search the window will
 * actually open on (the stored one, else the featured feed), with the same
 * argv and TTL as its mount read — then the featured feed too when they
 * differ, so a Reset paints at once (a cache hit when the stored search only
 * narrows it by chain). The dock badge comes from the last snapshot (no
 * CLI): `job list` is a rail read, not first paint.
 */
export const { prefetch } = defineEconData({
  kind: 'acp',
  last: slug => {
    const identity = $agentIdentity.get()[slug]
    const jobs = identity ? readMarketSnapshot(slug, identity.id)?.jobs : null

    return identity && jobs ? { jobs: jobs.data, wallet: identity.walletAddress } : null
  },
  badge: (slug, last) => publishJobsBadge(slug, last.jobs, last.wallet),
  async warm(inftId, slug) {
    const params = readParams(slug)

    await browse(inftId, slug, params)

    if (paramsDirty(params)) {
      await browse(inftId, slug, DEFAULT_PARAMS)
    }
  }
})
