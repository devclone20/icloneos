/**
 * EconomyOS — Market · My jobs: the iNFT's ACP jobs — searchable, split by
 * whose move it is — and one job's room (`job history`) as a timeline.
 */
import { Briefcase, CheckCheck, Compass, Search, SearchX, Sparkles, X } from 'lucide-react'
import { memo, useDeferredValue, useMemo, useState } from 'react'

import { readKey, writeKey } from '@/lib/storage'

import { chainById, explorerAddressUrl, shortAddress, timeAgo, when } from '../format'
import {
  Action,
  AddressChip,
  Cell,
  Empty,
  IconAction,
  Note,
  Pill,
  Row,
  Rows,
  SearchBox,
  SkeletonRows,
  Tabs,
  Toolbar
} from '../ui'

import {
  counterpartOf,
  inJobsTab,
  isoOf,
  type JobEntry,
  type JobHistory,
  jobRole,
  type JobRowModel,
  jobRows,
  JOBS_TAB_KEY,
  type JobsTab,
  jobWhen,
  type MarketJob,
  matchesJob,
  needsSetup,
  oneLine,
  parseJobsTab,
  type Slot,
  speakerOf,
  usdcLabel
} from './market-data'
import { ChainName, FailureState, StaleNote, StatusPill } from './market-ui'

const TAB_LABELS: Record<JobsTab, string> = {
  needs: 'Needs action',
  active: 'Active',
  done: 'Done',
  all: 'All'
}

function readTab(slug: string): JobsTab | null {
  return parseJobsTab(readKey(JOBS_TAB_KEY + slug))
}

/** Best-effort: the tab is a convenience, the list already switched. */
function writeTab(slug: string, tab: JobsTab): void {
  writeKey(JOBS_TAB_KEY + slug, tab)
}

interface JobsProps {
  agentName: string
  /** Epoch ms "expires in …" is computed against — advances per refresh. */
  clock: number
  jobs: Slot<MarketJob[]>
  myWallet: string
  selectedKey: null | string
  slug: string
  onDiscover: () => void
  onOffer: () => void
  onRetry: () => void
  onSelect: (job: MarketJob) => void
  onSetup: () => void
}

export function JobsView(props: JobsProps) {
  const { jobs, myWallet, onDiscover, onRetry, slug } = props
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<JobsTab | null>(() => readTab(slug))
  // The list filters on the deferred text: typing stays instant while a long
  // list catches up a beat later, never the other way round.
  const deferred = useDeferredValue(query.trim())
  const rows = useMemo(() => (jobs.data ? jobRows(jobs.data, myWallet) : null), [jobs.data, myWallet])

  const counts = useMemo(() => {
    const tally: Record<JobsTab, number> = { needs: 0, active: 0, done: 0, all: 0 }

    for (const row of rows ?? []) {
      tally.all += 1
      tally.needs += row.needs ? 1 : 0
      tally.active += row.done ? 0 : 1
      tally.done += row.done ? 1 : 0
    }

    return tally
  }, [rows])

  // Until the owner picks a tab, open where the work is.
  const tab: JobsTab = picked ?? (counts.needs > 0 ? 'needs' : 'active')

  const visible = useMemo(
    () => (rows ? rows.filter(row => inJobsTab(row, tab) && matchesJob(row, deferred)) : null),
    [deferred, rows, tab]
  )

  const tabs = useMemo(
    () =>
      (Object.keys(TAB_LABELS) as JobsTab[]).map(id => ({
        id,
        label: TAB_LABELS[id],
        count: rows ? counts[id] : undefined
      })),
    [counts, rows]
  )

  const pick = (next: JobsTab) => {
    setPicked(next)
    writeTab(slug, next)
  }

  const stale = jobs.data && jobs.error && !needsSetup(jobs.error)

  return (
    <>
      <Toolbar
        end={
          <Action kind="quiet" onClick={onDiscover}>
            <Compass size={13} strokeWidth={1.8} />
            Find an agent
          </Action>
        }
      >
        <SearchBox onChange={setQuery} placeholder="Search jobs — id, service, provider, address" value={query} />
        {query ? (
          <IconAction label="Clear search" onClick={() => setQuery('')}>
            <X size={13} strokeWidth={1.8} />
          </IconAction>
        ) : null}
      </Toolbar>
      <div className="mk-filters">
        <Tabs items={tabs} onChange={pick} value={tab} />
      </div>
      {stale && jobs.error ? <StaleNote at={jobs.at} failure={jobs.error} onRetry={onRetry} /> : null}
      <div className="e-scroll mk-list">
        <JobsBody
          {...props}
          onClearSearch={() => setQuery('')}
          onTab={pick}
          query={deferred}
          tab={tab}
          visible={visible}
        />
      </div>
    </>
  )
}

function JobsBody({
  agentName,
  clock,
  jobs,
  onClearSearch,
  onDiscover,
  onOffer,
  onRetry,
  onSelect,
  onSetup,
  onTab,
  query,
  selectedKey,
  tab,
  visible
}: JobsProps & {
  onClearSearch: () => void
  onTab: (tab: JobsTab) => void
  query: string
  tab: JobsTab
  visible: JobRowModel[] | null
}) {
  const list = jobs.data

  if (jobs.error && (!list || needsSetup(jobs.error))) {
    return <FailureState failure={jobs.error} onRetry={onRetry} onSetup={onSetup} title="Your jobs could not be read" />
  }

  if (!list || !visible) {
    return <SkeletonRows rows={5} />
  }

  if (list.length === 0) {
    return (
      <Empty
        action={
          <span className="mk-actions">
            <Action onClick={onDiscover}>Open Discover</Action>
            <Action kind="quiet" onClick={onOffer}>
              <Sparkles size={13} strokeWidth={1.8} />
              Ask {agentName} to offer a service
            </Action>
          </span>
        }
        hint={`Hire an agent from Discover, or ask ${agentName} to offer a service.`}
        icon={<Briefcase size={22} strokeWidth={1.6} />}
        title="No jobs yet"
      />
    )
  }

  if (visible.length === 0) {
    return query ? (
      <Empty
        action={<Action onClick={onClearSearch}>Clear search</Action>}
        hint={
          tab === 'all'
            ? 'Search reads job ids, services, provider names and wallet addresses.'
            : `Only ${TAB_LABELS[tab].toLowerCase()} jobs are searched — try All.`
        }
        icon={<SearchX size={22} strokeWidth={1.6} />}
        title={`No jobs match “${query}”`}
      />
    ) : (
      <TabEmpty agentName={agentName} onDiscover={onDiscover} onTab={onTab} tab={tab} />
    )
  }

  return <JobList clock={clock} onSelect={onSelect} rows={visible} selectedKey={selectedKey} />
}

function TabEmpty({
  agentName,
  onDiscover,
  onTab,
  tab
}: {
  agentName: string
  onDiscover: () => void
  onTab: (tab: JobsTab) => void
  tab: JobsTab
}) {
  if (tab === 'needs') {
    return (
      <Empty
        action={<Action onClick={() => onTab('active')}>Show active jobs</Action>}
        hint={`A budget to approve, a delivery to judge, a funded job for ${agentName} to work — they land here.`}
        icon={<CheckCheck size={22} strokeWidth={1.6} />}
        title="Nothing needs you"
      />
    )
  }

  if (tab === 'done') {
    return (
      <Empty
        action={<Action onClick={() => onTab('active')}>Show active jobs</Action>}
        hint="Completed, rejected and expired jobs are kept here."
        icon={<Briefcase size={22} strokeWidth={1.6} />}
        title="Nothing finished yet"
      />
    )
  }

  return (
    <Empty
      action={<Action onClick={onDiscover}>Open Discover</Action>}
      hint="Every job is finished. Hire an agent from Discover to start another."
      icon={<Briefcase size={22} strokeWidth={1.6} />}
      title="No active jobs"
    />
  )
}

/** Holds while the search box types: its rows array only changes when the
 *  deferred query, the tab or the answer does. */
const JobList = memo(function JobList({
  clock,
  onSelect,
  rows,
  selectedKey
}: {
  clock: number
  onSelect: (job: MarketJob) => void
  rows: JobRowModel[]
  selectedKey: null | string
}) {
  return (
    <div className="mk-rows mk-rows--jobs">
      <Rows>
        {rows.map(row => (
          <JobRow active={row.job.key === selectedKey} clock={clock} key={row.job.key} onSelect={onSelect} row={row} />
        ))}
      </Rows>
    </div>
  )
})

const JobRow = memo(function JobRow({
  active,
  clock,
  onSelect,
  row
}: {
  active: boolean
  clock: number
  onSelect: (job: MarketJob) => void
  row: JobRowModel
}) {
  const { counterpart, job, needs, role } = row

  return (
    <Row active={active} onClick={() => onSelect(job)}>
      <Cell mono width={92}>
        #{job.id}
      </Cell>
      <Cell grow>
        <span className="mk-row__main">
          {needs ? <span aria-label="needs your action" className="mk-needs" role="img" /> : null}
          {job.title || job.providerName || shortAddress(counterpart.address) || '—'}
        </span>
        <span className="mk-row__sub">
          {counterpart.address ? `${counterpart.label} ${shortAddress(counterpart.address)} · ` : ''}
          <ChainName chainId={job.chainId} />
        </span>
      </Cell>
      <Cell width={112}>
        <StatusPill status={job.status} />
      </Cell>
      <Cell align="end" mono width={108}>
        {usdcLabel(job.budgetUsdc)}
      </Cell>
      <Cell width={84}>{role ? <Pill tone="muted">{role}</Pill> : null}</Cell>
      <Cell align="end" muted width={120}>
        {jobWhen(job, clock)}
      </Cell>
    </Row>
  )
})

export const JobDetail = memo(function JobDetail({
  agentName,
  history,
  job,
  myWallet,
  onClose,
  onFind,
  onRetry,
  onSetup
}: {
  agentName: string
  history: Slot<JobHistory>
  job: MarketJob
  myWallet: string
  onClose?: () => void
  onFind: (job: MarketJob) => void
  onRetry: () => void
  onSetup: () => void
}) {
  const role = jobRole(job, myWallet)
  const status = history.data?.status || job.status
  const budget = history.data?.budgetUsdc ?? job.budgetUsdc
  const counterpart = counterpartOf(job, myWallet)
  const counterpartName = counterpart.label === 'provider' ? job.providerName : ''

  return (
    <div className="mk-detail">
      <header className="mk-detail__head">
        <span aria-hidden="true" className="mk-glyph">
          <Briefcase size={18} strokeWidth={1.6} />
        </span>
        <div className="mk-detail__id">
          <h3 className="mk-detail__name mk-mono">Job #{job.id}</h3>
          <p className="mk-detail__sub">
            <StatusPill status={status} />
            <span>
              <ChainName chainId={job.chainId} />
            </span>
            {job.legacy ? <Pill tone="muted">legacy</Pill> : null}
            {role ? <span>· you are the {role}</span> : null}
          </p>
        </div>
        {onClose ? (
          <IconAction label="Close" onClick={onClose}>
            <X size={14} strokeWidth={1.8} />
          </IconAction>
        ) : null}
      </header>

      {job.title ? <p className="e-prose mk-detail__desc">{job.title}</p> : null}

      <dl className="e-kv">
        <dt>Budget</dt>
        <dd className="e-money">{usdcLabel(budget)}</dd>
        <Party address={job.clientAddress} chainId={job.chainId} label="Client" myWallet={myWallet} />
        <Party address={job.providerAddress} chainId={job.chainId} label="Provider" myWallet={myWallet} />
        <Party address={job.evaluatorAddress} chainId={job.chainId} label="Evaluator" myWallet={myWallet} />
        {job.expiredAt ? (
          <>
            <dt>Expires</dt>
            <dd>{when(job.expiredAt)}</dd>
          </>
        ) : null}
      </dl>

      {counterpart.address ? (
        <div className="mk-detail__actions">
          <Action kind="quiet" onClick={() => onFind(job)}>
            <Search size={13} strokeWidth={1.8} />
            {counterpartName ? `Find ${oneLine(counterpartName, 40)} on ACP` : `Find the ${counterpart.label} on ACP`}
          </Action>
        </div>
      ) : null}

      {history.data?.deliverable ? (
        <div>
          <p className="mk-label">Deliverable</p>
          <p className="e-prose mk-deliverable">{history.data.deliverable}</p>
        </div>
      ) : null}

      <section aria-label="Job timeline">
        <p className="mk-label">
          Timeline
          {history.data ? <span className="mk-label__count">{history.data.entries.length}</span> : null}
        </p>
        <TimelineBody
          agentName={agentName}
          history={history}
          job={job}
          myWallet={myWallet}
          onRetry={onRetry}
          onSetup={onSetup}
        />
      </section>
    </div>
  )
})

function Party({
  address,
  chainId,
  label,
  myWallet
}: {
  address: string
  chainId: number
  label: string
  myWallet: string
}) {
  if (!address) {
    return null
  }

  const network = chainById(chainId)?.network ?? 'base-mainnet'
  const mine = address.toLowerCase() === myWallet.toLowerCase()

  return (
    <>
      <dt>{label}</dt>
      <dd>
        <AddressChip
          address={address}
          href={explorerAddressUrl(network, address) || undefined}
          label={mine ? 'you' : undefined}
        />
      </dd>
    </>
  )
}

function TimelineBody({
  agentName,
  history,
  job,
  myWallet,
  onRetry,
  onSetup
}: {
  agentName: string
  history: Slot<JobHistory>
  job: MarketJob
  myWallet: string
  onRetry: () => void
  onSetup: () => void
}) {
  if (history.error && (!history.data || needsSetup(history.error))) {
    return (
      <FailureState
        failure={history.error}
        onRetry={onRetry}
        onSetup={onSetup}
        title="The job room could not be read"
      />
    )
  }

  if (!history.data) {
    return <SkeletonRows rows={4} />
  }

  if (history.data.entries.length === 0) {
    return <Note>No messages or events in this job yet.</Note>
  }

  return (
    <>
      {history.error ? <StaleNote at={history.at} failure={history.error} onRetry={onRetry} /> : null}
      <ol className="mk-timeline">
        {history.data.entries.map(entry => (
          <TimelineEntry agentName={agentName} entry={entry} job={job} key={entry.id} myWallet={myWallet} />
        ))}
      </ol>
    </>
  )
}

const TimelineEntry = memo(function TimelineEntry({
  agentName,
  entry,
  job,
  myWallet
}: {
  agentName: string
  entry: JobEntry
  job: MarketJob
  myWallet: string
}) {
  const speaker = entry.kind === 'message' ? speakerOf(entry.from, job, myWallet) : ''
  const iso = isoOf(entry.at)

  return (
    <li className={`mk-event mk-event--${entry.kind} mk-event--${entry.tone}`}>
      <div className="mk-event__top">
        <span className="mk-event__title">
          {entry.kind === 'message' ? (speaker === 'you' ? `${agentName} (you)` : speaker) : entry.title}
        </span>
        {entry.kind === 'message' && entry.title !== 'text' ? <Pill tone="muted">{entry.title}</Pill> : null}
        {iso ? (
          <time className="mk-event__time" dateTime={iso} title={when(iso)}>
            {timeAgo(entry.at)}
          </time>
        ) : null}
      </div>
      {entry.detail ? <p className="mk-event__detail">{entry.detail}</p> : null}
      {entry.body ? (
        <p className={entry.bodyIsJson ? 'mk-event__body mk-event__body--json' : 'mk-event__body e-prose'}>
          {entry.body}
        </p>
      ) : null}
    </li>
  )
})
