import { type RefObject, useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { AcpResult } from '../cli'
import { useAcpEvents } from '../events'
import { useAutoRefresh } from '../live'
import { clearSnapshot, writeSnapshot } from '../snapshot'

import {
  type AcpChain,
  browse,
  browseKey,
  type BrowsePage,
  type BrowseParams,
  type BrowseSlot,
  buildSnapshot,
  cleanQuery,
  emptySlot,
  failureText,
  invalidateMarket,
  type JobHistory,
  type MarketAgent,
  type MarketJob,
  type MarketResource,
  type MarketSnapshot,
  type MarketSubscription,
  type OwnOffering,
  paramsDirty,
  publishJobsBadge,
  readChains,
  readJobHistory,
  readJobs,
  readOfferings,
  readResources,
  readSubscriptions,
  settle,
  settleBrowse,
  settled,
  type Slot,
  SNAPSHOT_VERSION,
  type Stamped
} from './market-data'
import { type ResourceDraft } from './market-editor'
import { type Notice, type OfferingSession, stampedSlot, useStable, type View } from './market-shared'

function sameChains(a: AcpChain[], b: AcpChain[]): boolean {
  return a.length === b.length && a.every((chain, index) => chain.id === b[index].id && chain.name === b[index].name)
}

export function useMarketBrowse({
  setFound,
  inftId,
  slug,
  wantedSearch,
  answeredKey,
  setFeatured,
  featured,
  ensurePool,
  resolveFind,
  listsFor,
  setJobs,
  setMine,
  setResources,
  setPackages,
  setHistory,
  wantedJob,
  setChains,
  chains,
  setClock,
  view,
  job,
  refreshKey,
  pendingOwn,
  agentId,
  setPendingOwn,
  jobs,
  myWallet,
  setJob,
  setOffering,
  setResource,
  setOfferSession,
  setResourceDraft,
  setNotice,
  writtenAt,
  mine
}: {
  setFound: Dispatch<SetStateAction<BrowseSlot>>
  inftId: string
  slug: string
  wantedSearch: RefObject<BrowseParams>
  answeredKey: RefObject<string>
  setFeatured: Dispatch<SetStateAction<Stamped<MarketAgent[]> | null>>
  featured: Stamped<MarketAgent[]> | null
  ensurePool: () => Promise<void>
  resolveFind: (key: string, result: AcpResult<BrowsePage>) => void
  listsFor: RefObject<string | null>
  setJobs: Dispatch<SetStateAction<Slot<MarketJob[]>>>
  setMine: Dispatch<SetStateAction<Slot<OwnOffering[]>>>
  setResources: Dispatch<SetStateAction<Slot<MarketResource[]>>>
  setPackages: Dispatch<SetStateAction<Slot<MarketSubscription[]>>>
  setHistory: Dispatch<SetStateAction<Slot<JobHistory>>>
  wantedJob: RefObject<string>
  setChains: Dispatch<SetStateAction<AcpChain[]>>
  chains: AcpChain[]
  setClock: Dispatch<SetStateAction<number>>
  view: View
  job: MarketJob | null
  refreshKey: number
  pendingOwn: MarketSnapshot | null
  agentId: string | null
  setPendingOwn: Dispatch<SetStateAction<MarketSnapshot | null>>
  jobs: Slot<MarketJob[]>
  myWallet: string
  setJob: Dispatch<SetStateAction<MarketJob | null>>
  setOffering: Dispatch<SetStateAction<OwnOffering | null>>
  setResource: Dispatch<SetStateAction<MarketResource | null>>
  setOfferSession: Dispatch<SetStateAction<OfferingSession | null>>
  setResourceDraft: Dispatch<SetStateAction<ResourceDraft | null>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  writtenAt: RefObject<number>
  mine: Slot<OwnOffering[]>
}) {
  const fetchBrowse = async (next: BrowseParams, force: boolean): Promise<AcpResult<BrowsePage>> => {
    const key = browseKey(next)

    setFound(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await browse(inftId, slug, next, force)

    if (browseKey(wantedSearch.current) !== key) {
      return result
    }

    if (result.ok) {
      answeredKey.current = key

      const { agents } = result.data

      if (!paramsDirty(next)) {
        setFeatured(current =>
          current?.data === agents && current.at === result.at ? current : { data: agents, at: result.at }
        )
      } else if (agents.length === 0 && cleanQuery(next.query) && !featured) {
        void ensurePool()
      }
    }

    // "Show more" merges the wider page into the one on screen (settleBrowse).
    setFound(slot => settleBrowse(slot, result, next))
    resolveFind(key, result)

    return result
  }

  // An answer read for a known agent that is no longer this iNFT's is dropped.
  const loadJobs = async (force: boolean) => {
    const readFor = listsFor.current

    setJobs(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await readJobs(inftId, slug, force)

    if (!readFor || listsFor.current === readFor) {
      setJobs(slot => settle(slot, result))
    }

    return result
  }

  const loadOfferings = async (force: boolean) => {
    const readFor = listsFor.current

    setMine(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await readOfferings(inftId, slug, force)

    if (!readFor || listsFor.current === readFor) {
      setMine(slot => settle(slot, result))
    }

    return result
  }

  const loadResources = async (force: boolean) => {
    const readFor = listsFor.current

    setResources(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await readResources(inftId, slug, force)

    if (!readFor || listsFor.current === readFor) {
      setResources(slot => settle(slot, result))
    }

    return result
  }

  const loadPackages = async (force: boolean) => {
    const readFor = listsFor.current

    setPackages(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await readSubscriptions(inftId, slug, force)

    if (!readFor || listsFor.current === readFor) {
      setPackages(slot => settle(slot, result))
    }

    return result
  }

  const loadHistory = async (target: MarketJob, force: boolean) => {
    setHistory(slot => (slot.loading ? slot : { ...slot, loading: true }))

    const result = await readJobHistory(inftId, slug, target, force)

    if (wantedJob.current === target.key) {
      setHistory(slot => settle(slot, result))
    }

    return result
  }

  const loadChains = async () => {
    const result = await settled(readChains(inftId, slug))

    if (result.ok && result.data.length > 0) {
      // An unchanged list keeps its identity: every pill would re-render.
      setChains(current => (sameChains(current, result.data) ? current : result.data))
    }
  }

  /** After the first paint: the chain names when there are none yet, then
   *  the rail counts, then — last — a revalidation of stored chain names.
   *  Queued behind the paint on the per-iNFT queue, never awaited by it. */
  const readRail = async (force: boolean) => {
    const cold = chains.length === 0

    if (cold) {
      await loadChains()
    }

    await loadJobs(force)
    await loadOfferings(force)

    if (!cold) {
      await loadChains()
    }
  }

  const { reload } = useAutoRefresh(
    'acp',
    slug,
    async ({ force }) => {
      setClock(Date.now())

      const wanted = wantedSearch.current
      const browseDue = force || answeredKey.current !== browseKey(wanted)

      if (view === 'discover' && browseDue) {
        const primary = await fetchBrowse(wanted, force)

        void readRail(force)

        if (!primary.ok) {
          throw new Error(failureText(primary))
        }

        return
      }

      // The timer's work: the live lists and an open job's room — never the
      // search, which only moves when the owner moves it.
      const primary =
        view === 'offerings'
          ? await loadOfferings(force)
          : view === 'resources'
            ? await loadResources(force)
            : await loadJobs(force)

      if (view === 'jobs' && job && wantedJob.current === job.key) {
        await loadHistory(job, force)
      }

      // The rail's counts and the dock badge stay current from any view.
      if (view !== 'jobs') {
        await loadJobs(force)
      }

      if (view !== 'offerings') {
        await loadOfferings(force)
      }

      if (chains.length === 0) {
        void loadChains()
      }

      if (browseDue) {
        void fetchBrowse(wanted, force)
      }

      if (!primary.ok) {
        throw new Error(failureText(primary))
      }
    },
    [inftId],
    refreshKey,
    { streamed: true }
  )

  // A job event dropped the stale reads: one silent re-read of what is shown.
  useAcpEvents(slug, () => void reload(false))

  // The stored lists belong to the agent the snapshot names; once the
  // identity is known they are shown — or the snapshot is dropped.
  useEffect(() => {
    if (!pendingOwn || !agentId) {
      return
    }

    if (pendingOwn.agentId === agentId) {
      setJobs(slot => (slot.data ? slot : stampedSlot(pendingOwn.jobs)))
      setMine(slot => (slot.data ? slot : stampedSlot(pendingOwn.offerings)))
    } else {
      clearSnapshot('acp', slug)
    }

    setPendingOwn(null)
  }, [agentId, pendingOwn, setJobs, setMine, setPendingOwn, slug])

  useEffect(() => {
    if (jobs.data) {
      publishJobsBadge(slug, jobs.data, myWallet)
    }
  }, [jobs.data, myWallet, slug])

  // The iNFT was re-provisioned while the window was open: the lists on
  // screen and on disk are the old agent's. Featured agents are public.
  const rereadOwn = useStable(() => void readRail(false))

  // eslint-disable-next-line no-restricted-syntax -- which agent the lists belong to, not an atom mirror
  useEffect(() => {
    const previous = listsFor.current

    listsFor.current = agentId

    if (!previous || !agentId || previous === agentId) {
      return
    }

    setJobs(emptySlot<MarketJob[]>())
    setMine(emptySlot<OwnOffering[]>())
    setResources(emptySlot<MarketResource[]>())
    setPackages(emptySlot<MarketSubscription[]>())
    setJob(null)
    setOffering(null)
    setResource(null)
    setOfferSession(null)
    setResourceDraft(null)
    setNotice(null)
    clearSnapshot('acp', slug)
    writtenAt.current = 0
    invalidateMarket(slug)
    rereadOwn()
  }, [
    agentId,
    listsFor,
    rereadOwn,
    setJob,
    setJobs,
    setMine,
    setNotice,
    setOfferSession,
    setOffering,
    setPackages,
    setResource,
    setResourceDraft,
    setResources,
    slug,
    writtenAt
  ])

  // Persist after real answers only: `settle` keeps old data on a failure, so
  // an error never reaches disk, and nothing is written while the identity
  // that owns the lists is unknown. A render with nothing newer than the last
  // write costs no serialisation at all.
  // eslint-disable-next-line no-restricted-syntax -- write bookkeeping, not an atom mirror
  useEffect(() => {
    if (!agentId || pendingOwn) {
      return
    }

    const newest = Math.max(featured?.at ?? 0, jobs.data ? jobs.at : 0, mine.data ? mine.at : 0)

    if (newest <= writtenAt.current) {
      return
    }

    writtenAt.current = newest

    const next = buildSnapshot({
      agentId,
      featured,
      jobs: jobs.data ? { data: jobs.data, at: jobs.at } : null,
      offerings: mine.data ? { data: mine.data, at: mine.at } : null,
      chains
    })

    if (next) {
      writeSnapshot('acp', slug, SNAPSHOT_VERSION, next.data, next.at)
    }
  }, [agentId, chains, featured, jobs.at, jobs.data, mine.at, mine.data, pendingOwn, slug, writtenAt])

  return { fetchBrowse, loadJobs, loadResources, loadOfferings, loadHistory, loadPackages }
}
