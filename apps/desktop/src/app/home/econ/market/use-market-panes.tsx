import { Activity, Briefcase, Compass, Globe, History, Package } from 'lucide-react'
import { type ReactNode } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import { RailItem, RailSection } from '../ui'

import { AgentDetail } from './market-agent'
import {
  type AcpChain,
  type BrowseParams,
  type BrowseSlot,
  type JobHistory,
  type MarketAgent,
  type MarketJob,
  type MarketOffering,
  type MarketResource,
  type MarketSubscription,
  type OwnOffering,
  type ResourceChange,
  type Slot,
  type Stamped
} from './market-data'
import { DiscoverView, type FindMiss, type SearchSeed } from './market-discover'
import { type OfferingDraft, type ResourceDraft } from './market-editor'
import { JobDetail, JobsView } from './market-jobs'
import { OfferingEditor } from './market-offering-form'
import { OfferingDetail, offeringKey, OfferingsView } from './market-offerings'
import { ResourceDetail, ResourceEditor, resourceKey, ResourcesView } from './market-resources'
import { type Notice, type OfferingSession, type View, type WriteKind } from './market-shared'
import { useWorkCopy } from './work/work-copy'
import { WorkTab } from './work/work-tab'

/** Everything the market's panes read and the handlers they call, owned by MarketApp. */
interface MarketPanesInput {
  closeDetail: () => void
  view: View
  shownAgent: MarketAgent | null
  agentName: string
  clock: number
  onHire: (target: MarketAgent, offer: MarketOffering) => void
  searchTokens: string[]
  job: MarketJob | null
  history: Slot<JobHistory>
  myWallet: string
  onFindJob: (target: MarketJob) => void
  onRetryHistory: () => undefined
  openSetup: () => void
  shownOffering: OwnOffering | null
  offerSession: OfferingSession | null
  busy: WriteKind | null
  writeError: string | null
  onDeleteOffering: (target: OwnOffering) => Promise<void>
  onEditOffering: (target: OwnOffering) => void
  shownResource: MarketResource | null
  resourceDraft: ResourceDraft | null
  onAskResource: (target: MarketResource, change: ResourceChange) => void
  jobs: Slot<MarketJob[]>
  onDiscover: () => void
  askOffering: () => void
  onRetryJobs: () => undefined
  openJob: (target: MarketJob) => void
  slug: string
  mine: Slot<OwnOffering[]>
  onCancelOffering: () => void
  onOfferingDraft: (draft: OfferingDraft) => void
  onRetryPackages: () => undefined
  onSaveOffering: () => Promise<void>
  packages: Slot<MarketSubscription[]>
  notice: Notice | null
  onNewOffering: () => void
  onRetryOfferings: () => undefined
  onSelectOffering: (target: OwnOffering) => void
  offering: OwnOffering | null
  onCancelResource: () => void
  onResourceDraft: (draft: ResourceDraft) => void
  onSaveResource: () => Promise<void>
  onNewResource: () => void
  onRetryResources: () => undefined
  onSelectResource: (target: MarketResource) => void
  resources: Slot<MarketResource[]>
  resource: MarketResource | null
  found: BrowseSlot
  chains: AcpChain[]
  findMiss: FindMiss | null
  onClear: () => void
  onFilter: (patch: Partial<BrowseParams>) => void
  onFindWallet: (address: string) => void
  onMore: () => void
  onPick: (query: string) => void
  onReset: () => void
  onResetFilters: () => void
  onRetryBrowse: () => undefined
  onSearch: (text: string) => void
  setAgent: Dispatch<SetStateAction<MarketAgent | null>>
  params: BrowseParams
  featured: Stamped<MarketAgent[]> | null
  seed: SearchSeed
  agent: MarketAgent | null
  selectView: (next: View) => void
  needsCount: number
  recent: string[]
  clearRecent: () => void
}

export function useMarketPanes(input: MarketPanesInput) {
  const workCopy = useWorkCopy()

  const renderDetail = (closable: boolean): ReactNode => {
    const onClose = closable ? input.closeDetail : undefined

    if (input.view === 'discover' && input.shownAgent) {
      return (
        <AgentDetail
          agent={input.shownAgent}
          agentName={input.agentName}
          clock={input.clock}
          key={input.shownAgent.id}
          onClose={onClose}
          onHire={input.onHire}
          tokens={input.searchTokens}
        />
      )
    }

    if (input.view === 'jobs' && input.job) {
      return (
        <JobDetail
          agentName={input.agentName}
          history={input.history}
          job={input.job}
          key={input.job.key}
          myWallet={input.myWallet}
          onClose={onClose}
          onFind={input.onFindJob}
          onRetry={input.onRetryHistory}
          onSetup={input.openSetup}
        />
      )
    }

    if (input.view === 'offerings' && input.shownOffering && !input.offerSession) {
      return (
        <OfferingDetail
          deleting={input.busy === 'offering-delete'}
          error={input.writeError}
          key={offeringKey(input.shownOffering)}
          offering={input.shownOffering}
          onClose={onClose}
          onDelete={input.onDeleteOffering}
          onEdit={input.onEditOffering}
        />
      )
    }

    if (input.view === 'resources' && input.shownResource && !input.resourceDraft) {
      return (
        <ResourceDetail
          agentName={input.agentName}
          key={resourceKey(input.shownResource)}
          onAsk={input.onAskResource}
          onClose={onClose}
          resource={input.shownResource}
        />
      )
    }

    return null
  }

  const renderMain = (): ReactNode => {
    if (input.view === 'work') {
      return <WorkTab slug={input.slug} />
    }

    if (input.view === 'jobs') {
      return (
        <JobsView
          agentName={input.agentName}
          clock={input.clock}
          jobs={input.jobs}
          myWallet={input.myWallet}
          onDiscover={input.onDiscover}
          onOffer={input.askOffering}
          onRetry={input.onRetryJobs}
          onSelect={input.openJob}
          onSetup={input.openSetup}
          selectedKey={input.job?.key ?? null}
          slug={input.slug}
        />
      )
    }

    if (input.view === 'offerings') {
      if (input.offerSession) {
        return (
          <OfferingEditor
            agentName={input.agentName}
            busy={input.busy === 'offering-create' || input.busy === 'offering-update'}
            count={input.mine.data?.length ?? null}
            draft={input.offerSession.draft}
            error={input.writeError}
            key={input.offerSession.target ? offeringKey(input.offerSession.target) : 'new'}
            onCancel={input.onCancelOffering}
            onChange={input.onOfferingDraft}
            onRetrySubscriptions={input.onRetryPackages}
            onSubmit={() => void input.onSaveOffering()}
            subscriptions={input.packages}
            target={input.offerSession.target}
          />
        )
      }

      return (
        <OfferingsView
          agentName={input.agentName}
          notice={input.notice?.view === 'offerings' ? input.notice.text : null}
          offerings={input.mine}
          onAsk={input.askOffering}
          onNew={input.onNewOffering}
          onRetry={input.onRetryOfferings}
          onSelect={input.onSelectOffering}
          onSetup={input.openSetup}
          selectedId={input.offering ? offeringKey(input.offering) : null}
        />
      )
    }

    if (input.view === 'resources') {
      if (input.resourceDraft) {
        return (
          <ResourceEditor
            busy={input.busy === 'resource-create'}
            draft={input.resourceDraft}
            error={input.writeError}
            onCancel={input.onCancelResource}
            onChange={input.onResourceDraft}
            onSubmit={() => void input.onSaveResource()}
          />
        )
      }

      return (
        <ResourcesView
          notice={input.notice?.view === 'resources' ? input.notice.text : null}
          onNew={input.onNewResource}
          onRetry={input.onRetryResources}
          onSelect={input.onSelectResource}
          onSetup={input.openSetup}
          resources={input.resources}
          selectedKey={input.resource ? resourceKey(input.resource) : null}
        />
      )
    }

    return (
      <DiscoverView
        browse={input.found}
        chains={input.chains}
        clock={input.clock}
        findMiss={input.findMiss}
        onClear={input.onClear}
        onFilter={input.onFilter}
        onFindWallet={input.onFindWallet}
        onMore={input.onMore}
        onPick={input.onPick}
        onReset={input.onReset}
        onResetFilters={input.onResetFilters}
        onRetry={input.onRetryBrowse}
        onSearch={input.onSearch}
        onSelect={input.setAgent}
        onSetup={input.openSetup}
        params={input.params}
        pool={input.featured?.data ?? null}
        seed={input.seed}
        selectedId={input.agent?.id ?? null}
      />
    )
  }

  const activeQuery = input.view === 'discover' ? input.params.query.toLowerCase() : null

  const rail = (
    <>
      <RailSection>
        <RailItem
          active={input.view === 'discover'}
          icon={<Compass size={15} strokeWidth={1.7} />}
          label="Discover"
          onClick={() => input.selectView('discover')}
        />
        <RailItem
          active={input.view === 'jobs'}
          count={input.needsCount > 0 ? input.needsCount : input.jobs.data?.length}
          icon={<Briefcase size={15} strokeWidth={1.7} />}
          label="My jobs"
          onClick={() => input.selectView('jobs')}
          tone={input.needsCount > 0 ? 'warn' : undefined}
        />
        <RailItem
          active={input.view === 'offerings'}
          count={input.mine.data?.length}
          icon={<Package size={15} strokeWidth={1.7} />}
          label="My offerings"
          onClick={() => input.selectView('offerings')}
        />
        <RailItem
          active={input.view === 'resources'}
          count={input.resources.data?.length}
          icon={<Globe size={15} strokeWidth={1.7} />}
          label="My resources"
          onClick={() => input.selectView('resources')}
        />
        <RailItem
          active={input.view === 'work'}
          icon={<Activity size={15} strokeWidth={1.7} />}
          label={workCopy.tab}
          onClick={() => input.selectView('work')}
        />
      </RailSection>
      <div className="mk-rail-recent">
        <RailSection title="Recent searches">
          {input.recent.length > 0 ? (
            <>
              {input.recent.map(query => (
                <RailItem
                  active={activeQuery === query.toLowerCase()}
                  icon={<History size={13} strokeWidth={1.7} />}
                  key={query}
                  label={query}
                  onClick={() => input.onPick(query)}
                />
              ))}
              <button className="mk-rail-clear" onClick={input.clearRecent} type="button">
                Clear
              </button>
            </>
          ) : (
            <p className="mk-rail-hint">Searches you run appear here.</p>
          )}
        </RailSection>
      </div>
      <p className="mk-rail-foot">
        Hiring is drafted for {input.agentName} — nothing runs until you send it. Offerings and resources you save here
        go to ACP on your click.
      </p>
    </>
  )

  return { renderDetail, rail, renderMain }
}
