import './market.css'

/**
 * EconomyOS — Market: the Virtuals ACP marketplace for the iNFT on stage.
 *
 * Discover searches live agents (`acp browse`) and reads the answer with the
 * owner's words (market-search). My jobs, My offerings and My resources are
 * the iNFT's own ACP state. Hiring an agent moves value, so it is drafted as
 * a brief for the iNFT (`useAskInft`), never run here. The catalogue — the
 * iNFT's offerings and resources — is the owner's to write: created, edited
 * and deleted through the bridge, only on the owner's click, with the exact
 * argv market-editor builds.
 *
 * Load order. The first frame paints the last snapshot; the first CLI read is
 * the search on screen (the featured feed unless the owner left a search),
 * and the rail's jobs and offerings queue behind it — never ahead. Resources
 * and subscription packages are read only when their view or the editor
 * opens. The timer refreshes the own lists only: a search re-runs on submit,
 * a filter, "Show more" and the header's refresh.
 */
import { type RefObject, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { acpToolsReady } from '@/iclone-shared/acp-tools'
import { hasAcpToolsBridge, useAcpTools } from '@/store/acp-tools'

import { AcpToolsPanel } from '../acp-tools-panel'
import { type AcpResult, setupNotice } from '../cli'
import { EconWindowContext, useAskInft, useOpenSetup } from '../handoff'
import { reportEconStatus } from '../live'
import { clearSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'
import { AppFrame } from '../ui'

import {
  type AcpChain,
  browse,
  browseKey,
  type BrowsePage,
  type BrowseParams,
  type BrowseSlot,
  chainNames,
  cleanQuery,
  counterpartOf,
  countNeedsAction,
  DEFAULT_PARAMS,
  emptySlot,
  failureText,
  hireBrief,
  invalidateMarket,
  type JobHistory,
  type MarketAgent,
  type MarketJob,
  type MarketOffering,
  type MarketResource,
  type MarketSnapshot,
  type MarketSubscription,
  nextTopK,
  OFFERING_BRIEF,
  type OwnOffering,
  pushRecent,
  readMarketSnapshot,
  readParams,
  readRecent,
  resourceBrief,
  type ResourceChange,
  sameAddress,
  type Stamped,
  TOP_K,
  writeParams,
  writeRecent
} from './market-data'
import { type FindMiss, type SearchSeed } from './market-discover'
import {
  draftFromOffering,
  emptyOfferingDraft,
  offeringCreateArgv,
  type OfferingDraft,
  offeringLimitProblem,
  offeringUpdateArgv,
  type OfferingValues,
  offeringValuesOf,
  type ResourceDraft,
  writeCatalogue
} from './market-editor'
import { offeringKey } from './market-offerings'
import { resourceKey } from './market-resources'
import { tokenize } from './market-search'
import { type Notice, type OfferingSession, stampedSlot, useStable, type View, type WriteKind } from './market-shared'
import { BackBar, ChainNamesContext } from './market-ui'
import { useMarketBrowse } from './use-market-browse'
import { useMarketEditors } from './use-market-editors'
import { useMarketPanes } from './use-market-panes'

// Below this width the detail replaces the list instead of sitting beside it.
const NARROW_PX = 900

const BACK_LABELS: Record<Exclude<View, 'work'>, string> = {
  discover: 'Back to results',
  jobs: 'Back to jobs',
  offerings: 'Back to offerings',
  resources: 'Back to resources'
}

/** True while the element is narrower than `limit` — re-renders only when
 *  the answer flips, not on every pixel of a window resize. Measured before
 *  the first paint, so a narrow window never flashes the wide layout. */
function useNarrow(ref: RefObject<HTMLElement | null>, limit: number): boolean {
  const [narrow, setNarrow] = useState(false)

  useLayoutEffect(() => {
    const node = ref.current

    if (!node) {
      return
    }

    const measure = (width: number) => setNarrow(width > 0 && width < limit)

    measure(node.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(entries => measure(entries[0]?.contentRect.width ?? 0))

    observer.observe(node)

    return () => observer.disconnect()
  }, [limit, ref])

  return narrow
}

function snapshotAt(snapshot: MarketSnapshot | null): number {
  return Math.max(snapshot?.featured?.at ?? 0, snapshot?.jobs?.at ?? 0, snapshot?.offerings?.at ?? 0)
}

/** A Find on ACP in flight: which search answers it, and whom it looks for. */
interface Finding {
  key: string
  address: string
  name: string
}

/**
 * REL-6 (ruling 26): every view here runs the ACP CLI, which the app installs at first use from npm. Until main says
 * it is installed and verified, the pane shows the tools' state (Install, progress, Reinstall) instead of itself, so
 * no read is fired at a CLI that is not there. The Work tab lives here, so it is covered too (and guards itself).
 */
export default function MarketApp(props: EconAppProps) {
  const tools = useAcpTools()

  if (hasAcpToolsBridge() && !acpToolsReady(tools)) {
    return (
      <div className="mk">
        <AppFrame className="mk-app">
          <AcpToolsPanel view={tools ?? { state: 'checking', cliVersion: null }} />
        </AppFrame>
      </div>
    )
  }

  return <MarketAppBody {...props} />
}

function MarketAppBody({ identity, inftId, refreshKey, slug }: EconAppProps) {
  const ask = useAskInft()
  const openSetupWindow = useOpenSetup()
  const { agentName } = useContext(EconWindowContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(rootRef, NARROW_PX)
  const myWallet = identity?.walletAddress ?? ''
  const agentId = identity?.id ?? null

  // Read once, synchronously, in the state initializer: the very first frame
  // shows the last answers instead of a skeleton (useSnapshot's hydrate lands
  // one commit later, and would parse the same store a second time). The
  // window keys this app by iNFT, so a switch is a fresh mount and read.
  const [boot] = useState(() => {
    const stored = readMarketSnapshot(slug, null)
    // Another agent's lists (the iNFT was re-provisioned): discarded whole.
    const foreign = Boolean(stored && agentId && stored.agentId !== agentId)
    const snapshot = foreign ? null : stored

    return { params: readParams(slug), snapshot, foreign, verified: snapshot != null && agentId != null }
  })

  const [view, setView] = useState<View>('discover')
  const [params, setParams] = useState<BrowseParams>(boot.params)
  const [seed, setSeed] = useState<SearchSeed>(() => ({ text: boot.params.query, nonce: 0 }))

  const [found, setFound] = useState<BrowseSlot>(() => ({
    ...stampedSlot(boot.snapshot?.featured),
    params: boot.snapshot?.featured ? DEFAULT_PARAMS : null,
    exhausted: false,
    breaks: []
  }))

  // The agent's own lists are shown from disk only once the stored agent is
  // known to be this one; with no identity yet they wait in `pendingOwn`.
  const [jobs, setJobs] = useState(() => stampedSlot(boot.verified ? boot.snapshot?.jobs : null))
  const [mine, setMine] = useState(() => stampedSlot(boot.verified ? boot.snapshot?.offerings : null))
  const [pendingOwn, setPendingOwn] = useState<MarketSnapshot | null>(boot.verified ? null : boot.snapshot)
  // The featured feed to persist, kept while the grid shows another search.
  const [featured, setFeatured] = useState<null | Stamped<MarketAgent[]>>(() => boot.snapshot?.featured ?? null)
  const [chains, setChains] = useState<AcpChain[]>(() => boot.snapshot?.chains ?? [])
  const [agent, setAgent] = useState<MarketAgent | null>(null)
  const [job, setJob] = useState<MarketJob | null>(null)
  const [history, setHistory] = useState(() => emptySlot<JobHistory>())
  const [offering, setOffering] = useState<null | OwnOffering>(null)
  const [resources, setResources] = useState(() => emptySlot<MarketResource[]>())
  const [resource, setResource] = useState<MarketResource | null>(null)
  const [packages, setPackages] = useState(() => emptySlot<MarketSubscription[]>())
  const [offerSession, setOfferSession] = useState<null | OfferingSession>(null)
  const [resourceDraft, setResourceDraft] = useState<null | ResourceDraft>(null)
  const [busy, setBusy] = useState<null | WriteKind>(null)
  const [writeError, setWriteError] = useState<null | string>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [recent, setRecent] = useState<string[]>(() => readRecent(slug))
  const [findMiss, setFindMiss] = useState<FindMiss | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  // What should be on screen. An answer for anything else that lands late
  // (a slow query, the previous job's room) is dropped, never shown.
  const wantedSearch = useRef<BrowseParams>(boot.params)
  const wantedJob = useRef('')
  // The search the CLI last answered live — a hydrated grid is not an answer.
  const answeredKey = useRef('')
  const finding = useRef<Finding | null>(null)
  // The newest read already on disk: only a newer one is worth a write.
  const writtenAt = useRef(snapshotAt(boot.snapshot))
  // The agent the lists on screen were read for.
  const listsFor = useRef(agentId)
  // A write in flight — set in the click itself, so a double click never
  // reaches the CLI twice (state lands a render later).
  const writing = useRef(false)

  const names = useMemo(() => chainNames(chains), [chains])

  useEffect(() => {
    const at = snapshotAt(boot.snapshot)

    if (boot.foreign) {
      clearSnapshot('acp', slug)
    } else if (at > 0) {
      reportEconStatus('acp', slug, { updatedAt: at })
    }
  }, [boot, slug])

  const resolveFind = (key: string, result: AcpResult<BrowsePage>) => {
    const target = finding.current

    if (!target || target.key !== key) {
      return
    }

    finding.current = null

    if (!result.ok) {
      return
    }

    const match = result.data.agents.find(
      item => sameAddress(item.walletAddress, target.address) || sameAddress(item.solWalletAddress, target.address)
    )

    if (match) {
      setAgent(match)
    } else {
      setFindMiss({ address: target.address, name: target.name })
    }
  }

  /** The featured feed, for a typed search the service answered with
   *  nothing — the local fallback searches it. A cache hit after prefetch. */
  const ensurePool = async () => {
    const result = await browse(inftId, slug, DEFAULT_PARAMS)

    if (result.ok) {
      setFeatured(current => current ?? { data: result.data.agents, at: result.at })
    }
  }

  const { fetchBrowse, loadJobs, loadResources, loadOfferings, loadHistory, loadPackages } = useMarketBrowse({
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
  })

  const remember = (query: string) => {
    const next = pushRecent(recent, query)

    setRecent(next)
    writeRecent(slug, next)
  }

  const runSearch = (next: BrowseParams) => {
    wantedSearch.current = next
    finding.current = null
    setFindMiss(null)
    setParams(next)
    // Same nonce: the box keeps what the owner typed, but a remount (back
    // from a detail or another view) starts from the search on screen.
    setSeed(current => (current.text === next.query ? current : { ...current, text: next.query }))
    writeParams(slug, next)
    setView('discover')
    void fetchBrowse(next, false)
  }

  const onSearch = useStable((text: string) => {
    const next = { ...wantedSearch.current, query: cleanQuery(text), topK: TOP_K }

    runSearch(next)

    if (next.query) {
      remember(next.query)
    }
  })

  const onPick = useStable((query: string) => {
    setSeed(current => ({ text: cleanQuery(query), nonce: current.nonce + 1 }))
    onSearch(query)
  })

  const onClear = useStable(() => runSearch({ ...wantedSearch.current, query: '', topK: TOP_K }))

  const onFilter = useStable((patch: Partial<BrowseParams>) =>
    runSearch({ ...wantedSearch.current, ...patch, topK: TOP_K })
  )

  const onMore = useStable(() => {
    const topK = nextTopK(wantedSearch.current.topK)

    if (topK) {
      runSearch({ ...wantedSearch.current, topK })
    }
  })

  const onReset = useStable(() => {
    setSeed(current => ({ text: '', nonce: current.nonce + 1 }))
    runSearch(DEFAULT_PARAMS)
  })

  const onResetFilters = useStable(() =>
    runSearch({
      ...wantedSearch.current,
      online: DEFAULT_PARAMS.online,
      mode: DEFAULT_PARAMS.mode,
      sortBy: DEFAULT_PARAMS.sortBy,
      chainId: DEFAULT_PARAMS.chainId,
      topK: TOP_K
    })
  )

  const onRetryBrowse = useStable(() => void fetchBrowse(wantedSearch.current, true))

  /** Search the marketplace for someone: by name first when there is one;
   *  the result whose wallet matches opens by itself. */
  const findOnAcp = (address: string, name: string) => {
    const query = cleanQuery(name || address)

    if (!query) {
      return
    }

    const next = { ...DEFAULT_PARAMS, query }

    setAgent(null)
    setSeed(current => ({ text: query, nonce: current.nonce + 1 }))
    runSearch(next)
    finding.current = { key: browseKey(next), address, name }
  }

  const onFindJob = useStable((target: MarketJob) => {
    const counterpart = counterpartOf(target, myWallet)

    findOnAcp(counterpart.address, counterpart.label === 'provider' ? target.providerName : '')
  })

  const onFindWallet = useStable((address: string) => findOnAcp(address, ''))

  const clearRecent = () => {
    setRecent([])
    writeRecent(slug, [])
  }

  const selectView = (next: View) => {
    setView(next)

    // Catch up on entry — served from cache unless it went stale meanwhile.
    // The search is not re-asked once answered: it moves with the owner.
    if (next === 'discover') {
      if (answeredKey.current !== browseKey(wantedSearch.current)) {
        void fetchBrowse(wantedSearch.current, false)
      }
    } else if (next === 'jobs') {
      void loadJobs(false)
    } else if (next === 'resources') {
      void loadResources(false)
    } else if (next === 'offerings') {
      void loadOfferings(false)
    }
  }

  const openJob = useStable((target: MarketJob) => {
    wantedJob.current = target.key
    setJob(target)
    setHistory(emptySlot<JobHistory>())
    void loadHistory(target, false)
  })

  const closeDetail = useStable(() => {
    if (view === 'discover') {
      setAgent(null)
    } else if (view === 'jobs') {
      setJob(null)
    } else if (view === 'resources') {
      setResource(null)
    } else if (view === 'offerings') {
      setOffering(null)
    }
  })

  const openSetup = useStable(() => {
    invalidateMarket(slug)
    openSetupWindow()
  })

  const askOffering = useStable(() => ask(OFFERING_BRIEF))
  const onHire = useStable((target: MarketAgent, offer: MarketOffering) => ask(hireBrief(target, offer)))
  const onDiscover = useStable(() => selectView('discover'))
  const onRetryJobs = useStable(() => void loadJobs(true))
  const onRetryOfferings = useStable(() => void loadOfferings(true))
  const onRetryResources = useStable(() => void loadResources(true))
  const onRetryPackages = useStable(() => void loadPackages(true))
  const onRetryHistory = useStable(() => void (job ? loadHistory(job, true) : undefined))

  const onAskResource = useStable((target: MarketResource, change: ResourceChange) =>
    ask(resourceBrief(target, change))
  )

  const onSelectOffering = useStable((target: OwnOffering) => {
    setWriteError(null)
    setOffering(target)
  })

  const onSelectResource = useStable((target: MarketResource) => setResource(target))

  // ── the catalogue: writes, on the owner's click ───────────────────────────

  /** One write through the bridge; the list it changed is read again after —
   *  a failed one too, since a write that timed out may still have landed. */
  const runWrite = async (kind: WriteKind, argv: string[]): Promise<AcpResult<unknown> | null> => {
    if (writing.current) {
      return null
    }

    writing.current = true
    setBusy(kind)
    setWriteError(null)

    const result = await writeCatalogue(inftId, slug, argv, kind === 'resource-create' ? 'resource' : 'offering')

    writing.current = false
    setBusy(null)

    if (!result.ok) {
      // An expired Virtuals session is a sign-in, not a setup — same words as the Setup action it leads to.
      setWriteError(
        result.kind === 'reauth-acp'
          ? `${setupNotice(result)} — the Virtuals session for this iNFT expired.`
          : failureText(result)
      )
    }

    return result
  }

  const openOfferingEditor = (target: null | OwnOffering) => {
    // The 41st is refused here, before any CLI runs.
    if (!target && offeringLimitProblem(mine.data?.length ?? null)) {
      return
    }

    setWriteError(null)
    setNotice(null)
    setOfferSession({ target, draft: target ? draftFromOffering(target) : emptyOfferingDraft() })
    void loadPackages(false)
  }

  const onNewOffering = useStable(() => openOfferingEditor(null))
  const onEditOffering = useStable((target: OwnOffering) => openOfferingEditor(target))

  const onOfferingDraft = useStable((draft: OfferingDraft) =>
    setOfferSession(current => (current ? { ...current, draft } : current))
  )

  const onCancelOffering = useStable(() => {
    setOfferSession(null)
    setWriteError(null)
  })

  /** The argv a save sends, or null — after saying why when it is not the
   *  form's own validation (which the editor already shows). */
  const offeringArgv = (session: OfferingSession, values: OfferingValues): null | string[] => {
    if (!session.target) {
      const limit = offeringLimitProblem(mine.data?.length ?? null)

      if (limit) {
        setWriteError(limit)

        return null
      }

      return offeringCreateArgv(values)
    }

    const update = offeringUpdateArgv(session.target.id, values, offeringValuesOf(session.target))

    if (!update.ok) {
      setWriteError(update.error)

      return null
    }

    return update.value
  }

  const { onDeleteOffering, onSaveOffering, onCancelResource, onResourceDraft, onSaveResource, onNewResource } =
    useMarketEditors({
      offerSession,
      offeringArgv,
      runWrite,
      loadOfferings,
      setOfferSession,
      setOffering,
      setNotice,
      setWriteError,
      setResourceDraft,
      resourceDraft,
      loadResources,
      setResource,
      rootRef,
      setAgent,
      setJob,
      setView
    })

  // Prefer the freshest copy from the latest results; keep the pinned one
  // when a new search no longer contains it.
  const shownAgent = useMemo(
    () => (agent ? (found.data?.find(item => item.id === agent.id) ?? agent) : null),
    [agent, found.data]
  )

  const needsCount = useMemo(() => (jobs.data ? countNeedsAction(jobs.data, myWallet) : 0), [jobs.data, myWallet])
  const shownQuery = (found.params ?? params).query
  const searchTokens = useMemo(() => tokenize(shownQuery), [shownQuery])

  // The own lists move under an open detail: it shows the freshest copy.
  const shownOffering = useMemo(
    () => (offering ? (mine.data?.find(item => offeringKey(item) === offeringKey(offering)) ?? offering) : null),
    [mine.data, offering]
  )

  const shownResource = useMemo(
    () => (resource ? (resources.data?.find(item => resourceKey(item) === resourceKey(resource)) ?? resource) : null),
    [resource, resources.data]
  )

  const { renderDetail, rail, renderMain } = useMarketPanes({
    closeDetail,
    view,
    shownAgent,
    agentName,
    clock,
    onHire,
    searchTokens,
    job,
    history,
    myWallet,
    onFindJob,
    onRetryHistory,
    openSetup,
    shownOffering,
    offerSession,
    busy,
    writeError,
    onDeleteOffering,
    onEditOffering,
    shownResource,
    resourceDraft,
    onAskResource,
    jobs,
    onDiscover,
    askOffering,
    onRetryJobs,
    openJob,
    slug,
    mine,
    onCancelOffering,
    onOfferingDraft,
    onRetryPackages,
    onSaveOffering,
    packages,
    notice,
    onNewOffering,
    onRetryOfferings,
    onSelectOffering,
    offering,
    onCancelResource,
    onResourceDraft,
    onSaveResource,
    onNewResource,
    onRetryResources,
    onSelectResource,
    resources,
    resource,
    found,
    chains,
    findMiss,
    onClear,
    onFilter,
    onFindWallet,
    onMore,
    onPick,
    onReset,
    onResetFilters,
    onRetryBrowse,
    onSearch,
    setAgent,
    params,
    featured,
    seed,
    agent,
    selectView,
    needsCount,
    recent,
    clearRecent
  })

  const detail = renderDetail(!narrow)

  return (
    <ChainNamesContext.Provider value={names}>
      <div className="mk" ref={rootRef}>
        <AppFrame aside={narrow ? undefined : (detail ?? undefined)} className="mk-app" rail={rail}>
          {narrow && detail && view !== 'work' ? (
            <>
              <BackBar label={BACK_LABELS[view]} onBack={closeDetail} />
              <div className="e-scroll mk-narrow">{detail}</div>
            </>
          ) : (
            renderMain()
          )}
        </AppFrame>
      </div>
    </ChainNamesContext.Provider>
  )
}
