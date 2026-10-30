/**
 * EconomyOS — Market · Discover: live search over the Virtuals ACP
 * marketplace, category chips, filters, and the agent cards.
 *
 * The service ranks; market-search reads its answer with the owner's words:
 * cards whose name or offerings hold every word rise within the service's
 * order, the words are marked where they matched, and the offerings that
 * matched are listed on the card. A search the service could not answer
 * falls back to the featured feed already loaded — and says so.
 *
 * The search box owns its text: a keystroke re-renders the box and nothing
 * else. The grid re-renders when an answer lands or the selection moves, and
 * each card only when its own agent, match, presence or selection changed.
 */
import { ChevronDown, RotateCcw, Search, SearchX, X } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { number, shortAddress } from '../format'
import { Action, Avatar, Empty, IconAction, Note, Pill, SearchBox, SectionTitle, Tabs, Toolbar } from '../ui'

import {
  type AcpChain,
  type BrowseMode,
  type BrowseParams,
  type BrowseSlot,
  cleanQuery,
  filtersDirty,
  type MarketAgent,
  needsSetup,
  nextTopK,
  type OnlineFilter,
  paramsDirty,
  presenceOf,
  priceLabel,
  ratingLabel,
  sameSearch,
  slaLabel,
  type SortField
} from './market-data'
import {
  type AgentMatch,
  CATEGORIES,
  countMatches,
  excerpt,
  localMatches,
  type MatchCount,
  rankAgents,
  type RankedAgent,
  shouldRerank,
  tokenize
} from './market-search'
import { ChainPills, FailureState, Highlight, OnlineDot, StaleNote } from './market-ui'

const ONLINE_ITEMS: Array<{ id: OnlineFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' }
]

const MODE_ITEMS: Array<{ id: BrowseMode; label: string }> = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'relevance', label: 'Best match' },
  { id: 'recency', label: 'Newest' }
]

const SORT_OPTIONS: Array<{ id: SortField; label: string }> = [
  { id: '', label: 'Any order' },
  { id: 'successfulJobCount', label: 'Most jobs done' },
  { id: 'successRate', label: 'Success rate' },
  { id: 'uniqueBuyerCount', label: 'Most buyers' },
  { id: 'minsFromLastOnlineTime', label: 'Recently online' }
]

const SKELETON_CARDS = 6
// Placeholders at the grid's end while a wider page loads.
const GHOST_CARDS = 3
// Matching offerings listed on a card before "+N more".
const CARD_MATCHES = 3

/** Text pushed into the search box from outside (a category, a recent
 *  search, Find on ACP). A new `nonce` is what makes the box take it. */
export interface SearchSeed {
  text: string
  nonce: number
}

/** "Find on ACP" searched and found no agent with the job's wallet. */
export interface FindMiss {
  address: string
  /** The name searched first, '' when the search already was the wallet. */
  name: string
}

interface DiscoverProps {
  browse: BrowseSlot
  chains: AcpChain[]
  /** Epoch ms presence is computed against — advances once per refresh. */
  clock: number
  findMiss: FindMiss | null
  params: BrowseParams
  /** The featured feed — where a typed search the service could not answer
   *  looks for local matches. */
  pool: MarketAgent[] | null
  seed: SearchSeed
  selectedId: null | string
  onClear: () => void
  onFilter: (patch: Partial<BrowseParams>) => void
  onFindWallet: (address: string) => void
  onMore: () => void
  onPick: (query: string) => void
  onReset: () => void
  onResetFilters: () => void
  onRetry: () => void
  onSearch: (text: string) => void
  onSelect: (agent: MarketAgent) => void
  onSetup: () => void
}

/** What the grid shows for one answer: ranked cards, the words that ranked
 *  them, and whether they are the local fallback. */
interface ResultsModel {
  ranked: RankedAgent[]
  tokens: string[]
  fallback: boolean
  count: MatchCount
}

/** Rank each page on its own: the cards already on screen keep their places
 *  when "Show more" appends, whatever the wider page brought. */
function rankPages(agents: MarketAgent[], breaks: readonly number[], tokens: string[], rerank: boolean): RankedAgent[] {
  const edges = [0, ...breaks, agents.length]

  return edges.slice(1).flatMap((end, index) => rankAgents(agents.slice(edges[index], end), tokens, rerank))
}

function useResults(browse: BrowseSlot, shown: BrowseParams, pool: MarketAgent[] | null, clock: number) {
  const agents = browse.data
  const tokens = useMemo(() => tokenize(shown.query), [shown.query])
  const rerank = shouldRerank(shown)

  const ranked = useMemo(
    () => (agents ? rankPages(agents, browse.breaks, tokens, rerank) : null),
    [agents, browse.breaks, rerank, tokens]
  )

  const { chainId, online } = shown

  // Only when the service answered a typed search with nothing.
  const local = useMemo(
    () =>
      agents && agents.length === 0 && tokens.length > 0 && pool
        ? localMatches(pool, tokens, { chainId, online }, clock)
        : null,
    [agents, chainId, clock, online, pool, tokens]
  )

  return useMemo((): null | ResultsModel => {
    if (!ranked) {
      return null
    }

    const fallback = local != null && local.length > 0
    const cards = fallback ? local : ranked

    return { ranked: cards, tokens, fallback, count: countMatches(cards) }
  }, [local, ranked, tokens])
}

function plural(count: number, one: string, many: string): string {
  return `${number(count)} ${count === 1 ? one : many}`
}

function countLine(results: ResultsModel): string {
  const agents = plural(results.count.agents, 'agent', 'agents')
  const offerings = plural(results.count.offerings, 'offering', 'offerings')

  return results.tokens.length > 0 ? `${agents} · ${offerings} match` : `${agents} · ${offerings}`
}

export function DiscoverView(props: DiscoverProps) {
  const { browse, clock, findMiss, onClear, onFindWallet, onPick, onRetry, onSearch, params, pool, seed } = props
  const shown = browse.params ?? params
  const stale = browse.data && browse.error && !needsSetup(browse.error)
  const results = useResults(browse, shown, pool, clock)
  // A failure with nothing to show replaces the grid — and its count.
  const failed = Boolean(browse.error && (!browse.data || needsSetup(browse.error)))

  const title = results?.fallback
    ? `Local matches for “${shown.query}”`
    : shown.query
      ? `Results for “${shown.query}”`
      : 'Featured on ACP'

  return (
    <>
      <SearchField onClear={onClear} onSearch={onSearch} seed={seed} />
      <Filters
        chains={props.chains}
        loading={browse.loading}
        onFilter={props.onFilter}
        onReset={props.onReset}
        params={params}
      />
      {stale && browse.error ? <StaleNote at={browse.at} failure={browse.error} onRetry={onRetry} /> : null}
      <div className="e-scroll mk-results">
        <Categories active={cleanQuery(params.query).toLowerCase()} onPick={onPick} />
        {findMiss ? <FindMissNote miss={findMiss} onFindWallet={onFindWallet} /> : null}
        <SectionTitle end={results && !failed ? <span className="mk-count">{countLine(results)}</span> : null}>
          {title}
        </SectionTitle>
        {results?.fallback ? (
          <div className="mk-fallback">
            <Note>
              No marketplace match for “{shown.query}” — showing local matches from the featured feed. Try broader words
              for a new marketplace search.
            </Note>
          </div>
        ) : null}
        <Results {...props} results={results} />
      </div>
    </>
  )
}

/** The box keeps its own text; the app hears about it only on submit. */
const SearchField = memo(function SearchField({
  onClear,
  onSearch,
  seed
}: {
  onClear: () => void
  onSearch: (text: string) => void
  seed: SearchSeed
}) {
  const [text, setText] = useState(seed.text)
  const [seen, setSeen] = useState(seed.nonce)

  if (seen !== seed.nonce) {
    setSeen(seed.nonce)
    setText(seed.text)
  }

  const clear = () => {
    setText('')
    onClear()
  }

  return (
    <Toolbar
      end={
        <Action kind="quiet" onClick={() => onSearch(text)} title="Search (Enter)">
          <Search size={13} strokeWidth={1.8} />
          Search
        </Action>
      }
    >
      <SearchBox
        autoFocus
        onChange={setText}
        onSubmit={() => onSearch(text)}
        placeholder="Search agents, offerings and resources on ACP"
        value={text}
      />
      {text ? (
        <IconAction label="Clear search" onClick={clear}>
          <X size={13} strokeWidth={1.8} />
        </IconAction>
      ) : null}
    </Toolbar>
  )
})

const Filters = memo(function Filters({
  chains,
  loading,
  onFilter,
  onReset,
  params
}: {
  chains: AcpChain[]
  loading: boolean
  onFilter: (patch: Partial<BrowseParams>) => void
  onReset: () => void
  params: BrowseParams
}) {
  return (
    <div className="mk-filters">
      <Tabs items={ONLINE_ITEMS} onChange={online => onFilter({ online })} value={params.online} />
      <Tabs items={MODE_ITEMS} onChange={mode => onFilter({ mode })} value={params.mode} />
      <select
        aria-label="Sort by"
        className="e-select mk-select"
        onChange={event =>
          onFilter({ sortBy: SORT_OPTIONS.find(option => option.id === event.target.value)?.id ?? '' })
        }
        value={params.sortBy}
      >
        {SORT_OPTIONS.map(option => (
          <option key={option.id || 'any'} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Chain"
        className="e-select mk-select"
        disabled={chains.length === 0 && params.chainId == null}
        onChange={event => onFilter({ chainId: Number(event.target.value) || null })}
        value={params.chainId ?? ''}
      >
        <option value="">All chains</option>
        {chains.map(chain => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </select>
      {paramsDirty(params) ? (
        <button aria-label="Reset search and filters" className="mk-reset" onClick={onReset} type="button">
          <RotateCcw size={11} strokeWidth={1.9} />
          Reset
        </button>
      ) : null}
      <span aria-live="polite" className="mk-filters__meta">
        {loading ? 'searching the marketplace…' : ''}
      </span>
      {loading ? <span aria-hidden="true" className="mk-progress" /> : null}
    </div>
  )
})

const Categories = memo(function Categories({
  active,
  onPick
}: {
  /** The search on screen, lower-case — its chip is lit. */
  active: string
  onPick: (query: string) => void
}) {
  return (
    <div aria-label="Categories" className="mk-cats" role="group">
      {CATEGORIES.map(category => {
        const on = category.query === active

        return (
          <Tip key={category.label} label={`Search “${category.query}”`}>
            <button
              aria-pressed={on}
              className={on ? 'mk-cat mk-cat--on' : 'mk-cat'}
              onClick={() => onPick(category.query)}
              type="button"
            >
              {category.label}
            </button>
          </Tip>
        )
      })}
    </div>
  )
})

function FindMissNote({ miss, onFindWallet }: { miss: FindMiss; onFindWallet: (address: string) => void }) {
  return (
    <div className="mk-findmiss">
      <Note>
        {miss.name
          ? `No agent named “${miss.name}” in these results uses ${shortAddress(miss.address)}. `
          : `No listed ACP agent answers to ${shortAddress(miss.address)} — it may not be public. `}
        {miss.name ? (
          <button className="e-link" onClick={() => onFindWallet(miss.address)} type="button">
            Search by the wallet
          </button>
        ) : null}
      </Note>
    </div>
  )
}

function Results({
  browse,
  clock,
  onMore,
  onResetFilters,
  onRetry,
  onSelect,
  onSetup,
  params,
  results,
  selectedId
}: DiscoverProps & { results: null | ResultsModel }) {
  const shown = browse.params ?? params

  // Computed once per answer and per refresh — never per keystroke or card.
  const presence = useMemo(
    () => new Map((results?.ranked ?? []).map(({ agent }) => [agent.id, presenceOf(agent, clock)])),
    [results, clock]
  )

  if (browse.error && (!browse.data || needsSetup(browse.error))) {
    return (
      <FailureState failure={browse.error} onRetry={onRetry} onSetup={onSetup} title="The marketplace didn’t answer" />
    )
  }

  if (!results) {
    return <SkeletonGrid />
  }

  if (results.ranked.length === 0) {
    return (
      <Empty
        action={filtersDirty(shown) ? <Action onClick={onResetFilters}>Reset filters</Action> : undefined}
        hint="Try a broader phrase, or widen the filters — Online: All, every chain."
        icon={<SearchX size={22} strokeWidth={1.6} />}
        title={shown.query ? `No agents match “${shown.query}”` : 'No agents to show'}
      />
    )
  }

  // An earlier search stays readable, dimmed, while a different one runs; a
  // wider page of the same search keeps the cards bright and loads below.
  const sameQuery = sameSearch(shown, params)
  const stale = browse.loading && !sameQuery
  const loadingMore = browse.loading && sameQuery && params.topK > shown.topK
  const next = nextTopK(shown.topK)
  const canMore = !results.fallback && next != null && !browse.exhausted

  return (
    <>
      <div aria-busy={browse.loading} className={stale ? 'mk-grid mk-grid--stale' : 'mk-grid'}>
        {results.ranked.map(({ agent, match }) => {
          const where = presence.get(agent.id)

          return (
            <AgentCard
              agent={agent}
              key={agent.id}
              match={match}
              online={where?.online ?? false}
              onSelect={onSelect}
              presence={where?.label ?? 'offline'}
              selected={agent.id === selectedId}
              tokens={results.tokens}
            />
          )
        })}
        {loadingMore
          ? Array.from({ length: GHOST_CARDS }, (_, index) => (
              <div
                aria-hidden="true"
                className="mk-card mk-card--skeleton mk-card--ghost"
                key={`ghost-${index}`}
                style={{ animationDelay: `${index * 60}ms` }}
              />
            ))
          : null}
      </div>
      {canMore || loadingMore ? (
        <div className="mk-more">
          <Action disabled={loadingMore || stale} onClick={onMore}>
            <ChevronDown size={13} strokeWidth={1.8} />
            {loadingMore ? 'Loading more…' : 'Show more results'}
          </Action>
          <span className="mk-more__meta">
            {loadingMore
              ? `${number(results.ranked.length)} shown · asking for ${params.topK}`
              : `${number(results.ranked.length)} shown · up to ${next} next`}
          </span>
        </div>
      ) : results.fallback ? null : browse.exhausted ? (
        <p className="mk-end">That’s everything the marketplace has for this search.</p>
      ) : next == null ? (
        <p className="mk-end">The marketplace answers {shown.topK} per search at most — refine it to reach others.</p>
      ) : null}
    </>
  )
}

function SkeletonGrid() {
  return (
    <div aria-busy="true" className="mk-grid">
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <div className="mk-card mk-card--skeleton" key={index} style={{ animationDelay: `${index * 60}ms` }} />
      ))}
    </div>
  )
}

const AgentCard = memo(function AgentCard({
  agent,
  match,
  online,
  onSelect,
  presence,
  selected,
  tokens
}: {
  agent: MarketAgent
  match: AgentMatch | null
  online: boolean
  onSelect: (agent: MarketAgent) => void
  presence: string
  selected: boolean
  tokens: readonly string[]
}) {
  const count = agent.offerings.length
  const matching = match?.offerings ?? []
  const description = useMemo(() => excerpt(agent.description, tokens), [agent.description, tokens])

  return (
    <button
      aria-pressed={selected}
      className={selected ? 'mk-card mk-card--on' : 'mk-card'}
      onClick={() => onSelect(agent)}
      type="button"
    >
      <span className="mk-card__head">
        <Avatar name={agent.name} size={36} src={agent.imageUrl} />
        <span className="mk-card__id">
          <span className="mk-card__name">
            <Highlight text={agent.name} tokens={tokens} />
          </span>
          <span className="mk-card__meta">
            <span className={agent.rating == null ? '' : 'mk-rating'}>{ratingLabel(agent.rating)}</span>
            {agent.cluster ? (
              <>
                <span aria-hidden="true" className="mk-sep">
                  ·
                </span>
                <span className="mk-card__cluster">
                  <Highlight text={agent.cluster} tokens={tokens} />
                </span>
              </>
            ) : null}
          </span>
        </span>
        <OnlineDot label={presence} online={online} />
      </span>
      <span className="mk-card__desc">
        {description ? <Highlight text={description} tokens={tokens} /> : 'No description yet.'}
      </span>
      {matching.length > 0 ? (
        <span className="mk-card__matches">
          {matching.slice(0, CARD_MATCHES).map(offering => {
            const sla = slaLabel(offering.slaMinutes)

            return (
              <span className="mk-match" key={offering.id || offering.name}>
                <span className="mk-match__name">
                  <Highlight text={offering.name} tokens={tokens} />
                </span>
                <span className="mk-match__meta">
                  {priceLabel(offering)}
                  {sla ? ` · ${sla}` : ''}
                </span>
              </span>
            )
          })}
          {matching.length > CARD_MATCHES ? (
            <span className="mk-match__more">+{matching.length - CARD_MATCHES} more matching</span>
          ) : null}
        </span>
      ) : null}
      <span className="mk-card__foot">
        <span className="mk-card__offers">
          {count > 0 ? `${count} ${count === 1 ? 'offering' : 'offerings'}` : 'no offerings'}
          {agent.priceFrom ? (
            <>
              <span aria-hidden="true" className="mk-sep">
                ·
              </span>
              <span className="mk-card__price">
                {count > 1 ? 'from ' : ''}
                {agent.priceFrom}
              </span>
            </>
          ) : null}
        </span>
        <span className="mk-card__tags">
          {agent.isNew && agent.rating != null ? <Pill tone="tone">new</Pill> : null}
          <ChainPills chainIds={agent.chainIds} max={2} />
        </span>
      </span>
    </button>
  )
})
