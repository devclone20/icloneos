import './bank.css'

/**
 * EconomyOS — Bank (AgentCard): the agent's virtual card for its own
 * purchases. Read-only — issuing a card, changing the limit, and completing
 * sign-in all hand off to Setup or to the iNFT itself.
 *
 * The first frame paints from `seedBank` (the last snapshot, or the boot
 * probe's gate); `loadBank` then confirms it with `card whoami` and lands the
 * secondary reads one by one. A refresh never blanks what is on screen.
 */
import { X } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type AgentcardAccountState, agentcardAccountState } from '@/app/home/acp-setup'
import { readSignInRecord, sendSignInLink } from '@/app/settings/inft-setup-card-resend'
import { type CardErrorInfo, RESEND_WAIT_MS } from '@/app/settings/inft-setup-card-signup'
import { cardErrorSentence, useInftWizardCopy } from '@/app/settings/inft-setup-wizard-copy'
import { useI18n } from '@/i18n'

import { type AcpResult, humanizeAcpError } from '../cli'
import { timeAgo, usd, when } from '../format'
import { useAskInft, useOpenSetup } from '../handoff'
import { reportEconStatus, useAutoRefresh } from '../live'
import { useSnapshot } from '../snapshot'
import type { EconAppProps } from '../types'
import {
  Action,
  AppFrame,
  Cell,
  CopyText,
  Empty,
  IconAction,
  Money,
  Note,
  Pill,
  Row,
  Rows,
  SectionTitle,
  SkeletonRows,
  SkeletonStats,
  Stat,
  StatRow,
  Tabs,
  Toolbar
} from '../ui'

import {
  BANK_SNAPSHOT_VERSION,
  type BankSnapshot,
  type CardLimit,
  type CardProfile,
  type CardState,
  centsToUsd,
  codeAmountLabel,
  codeExpiresAt,
  countActiveCodes,
  formatCountdown,
  isOpenStatus,
  limitLeftLabel,
  nextExpiryMs,
  openRequests,
  paymentMethodLabel,
  pickSelectedRequest,
  publishBankBadge,
  readRequestDetail,
  type RequestDetailEntry,
  sameCardState,
  sameLimit,
  seedBank,
  shortRequestId,
  sortRequests,
  type SpendRequest,
  THREE_DS_WINDOW_MS,
  type ThreeDsCode
} from './bank-data'
import { type BankNotice, type BankSink, forgetCard, loadBank, sameNotice } from './bank-loaders'
import { CardVisual, NoCardYet, SessionExpired, SignInPending } from './faces'

type RequestTab = 'all' | 'open'

/** The 3DS list with the moment it was read — the floor for "now" when
 *  judging which codes are still usable, so a list never looks fresher than
 *  it is. */
interface CodesState {
  list: ThreeDsCode[]
  at: number
}

const NO_REQUESTS: SpendRequest[] = []
/** A code is "about to go" under this — the row turns amber. */
const SOON_MS = 60_000

function bankStatusTone(status: string): 'down' | 'muted' | 'up' | 'warn' {
  const lower = status.trim().toLowerCase()

  if (isOpenStatus(status)) {
    return 'warn'
  }

  if (/cancel|declin|fail|reject/.test(lower)) {
    return 'down'
  }

  if (/approv|captur|complet|settl/.test(lower)) {
    return 'up'
  }

  return 'muted'
}

// ── clocks ───────────────────────────────────────────────────────────────

/** Re-renders exactly when the next code expires, never on a timer. */
function useExpiryClock(codes: CodesState | null): number {
  const [tick, setTick] = useState(() => Date.now())
  const nowMs = Math.max(tick, codes?.at ?? 0)

  useEffect(() => {
    if (!codes) {
      return
    }

    const at = Math.max(Date.now(), tick)
    const next = nextExpiryMs(codes.list, at)

    if (next === null) {
      return
    }

    // Land just past the boundary, never a hair before it.
    const timer = window.setTimeout(() => setTick(Date.now()), next - at + 25)

    return () => window.clearTimeout(timer)
  }, [codes, tick])

  return nowMs
}

/** One tick a second while any code is still counting down; silent otherwise. */
function useSecondClock(codes: CodesState | null): number {
  const [tick, setTick] = useState(() => Date.now())
  const nowMs = Math.max(tick, codes?.at ?? 0)
  const running = codes !== null && nextExpiryMs(codes.list, nowMs) !== null

  useEffect(() => {
    if (!running) {
      return
    }

    const timer = window.setInterval(() => setTick(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [running])

  return nowMs
}

// ── the card visual ──────────────────────────────────────────────────────

/** A stat that does something when clicked — the same face as `Stat`, as a
 *  real button, so spans rather than paragraphs. */
function ActionStat({
  disabled,
  label,
  onClick,
  sub,
  tone,
  value
}: {
  disabled?: boolean
  label: string
  onClick: () => void
  sub?: ReactNode
  tone?: 'down' | 'up' | 'warn'
  value: ReactNode
}) {
  return (
    <button className="e-stat bk-stat-btn" disabled={disabled} onClick={onClick} type="button">
      <span className="e-stat__label">{label}</span>
      <span className={tone ? `e-stat__value e-stat__value--${tone}` : 'e-stat__value'}>{value}</span>
      {sub ? <span className="e-stat__sub">{sub}</span> : null}
    </button>
  )
}

/** The message, then the one thing that can fix it. */
function NoticeBar({
  notice,
  onOpenSetup,
  onRetry
}: {
  notice: BankNotice
  onOpenSetup: () => void
  onRetry: () => void
}) {
  const copy = useI18n().t.bank

  return (
    <Note kind={notice.setup ? 'warn' : 'error'}>
      {notice.message}
      <span className="bk-note__action">
        <Action kind="quiet" onClick={notice.setup ? onOpenSetup : onRetry}>
          {notice.setup ? copy.gate.openSetup : copy.notice.tryAgain}
        </Action>
      </span>
    </Note>
  )
}

// ── ready state: account · requests · 3DS codes ──────────────────────────

const AccountCard = memo(function AccountCard({
  onOpenSetup,
  profile
}: {
  onOpenSetup: () => void
  profile: AcpResult<CardProfile> | null
}) {
  const copy = useI18n().t.bank
  let body: ReactNode
  let settled = false

  if (!profile) {
    body = (
      <span aria-busy="true" className="bk-account__skeleton">
        <span />
        <span />
      </span>
    )
  } else if (!profile.ok) {
    body = <span className="bk-account__empty">{copy.account.unavailable(humanizeAcpError(profile.error))}</span>
  } else if (!profile.data.name && !profile.data.phone && !profile.data.email) {
    settled = true
    body = <span className="bk-account__empty">{copy.account.onFileHidden}</span>
  } else {
    const { email, name, phone } = profile.data

    settled = Boolean(name && phone)
    body = (
      <>
        <b className={name ? 'bk-account__name' : 'bk-account__name bk-account__name--missing'}>
          {name || copy.account.noName}
        </b>
        <span className="bk-account__meta">{[phone || copy.account.noPhone, email].filter(Boolean).join(' · ')}</span>
        {settled ? null : <span className="bk-account__empty">{copy.account.needsNamePhone}</span>}
      </>
    )
  }

  return (
    <div className="bk-account">
      <div className="bk-account__body">
        <span className="bk-account__label">{copy.account.label}</span>
        {body}
      </div>
      <Action kind="quiet" onClick={onOpenSetup}>
        {settled ? copy.account.changeInSetup : copy.gate.openSetup}
      </Action>
    </div>
  )
})

const RequestRow = memo(function RequestRow({
  active,
  onSelect,
  request
}: {
  active: boolean
  onSelect: (id: string) => void
  request: SpendRequest
}) {
  const copy = useI18n().t.bank.requests

  return (
    <Row active={active} onClick={() => onSelect(request.id)}>
      <Cell grow>
        <b className="bk-req__amount">{usd(request.amountUsd)}</b>
        <span className="bk-req__id">{shortRequestId(request.id)}</span>
        {request.last4 ? <span className="bk-req__id">•••• {request.last4}</span> : null}
      </Cell>
      <Cell align="end" mono width={90}>
        {request.capturedAmountUsd === null ? '—' : <Money value={request.capturedAmountUsd} />}
      </Cell>
      <Cell align="end" width={110}>
        <Pill tone={bankStatusTone(request.status)}>{request.status}</Pill>
      </Cell>
      <Cell align="end" muted width={90}>
        {request.issuedAt ? timeAgo(request.issuedAt) : '—'}
      </Cell>
      <Cell align="end" muted width={100}>
        {request.expiresAt ? copy.expires(timeAgo(request.expiresAt)) : '—'}
      </Cell>
    </Row>
  )
})

const RequestsSection = memo(function RequestsSection({
  agentName,
  hasAny,
  loaded,
  onSelect,
  onShowAll,
  requests,
  selectedId,
  tab
}: {
  agentName: string
  /** Any request at all, across both tabs. */
  hasAny: boolean
  loaded: boolean
  onSelect: (id: string) => void
  onShowAll: () => void
  requests: SpendRequest[]
  selectedId: null | string
  tab: RequestTab
}) {
  const copy = useI18n().t.bank

  if (!loaded) {
    return <SkeletonRows rows={4} />
  }

  if (requests.length === 0) {
    if (tab === 'open' && hasAny) {
      return (
        <Empty
          action={
            <Action kind="quiet" onClick={onShowAll}>
              {copy.requests.showAll}
            </Action>
          }
          hint={copy.requests.nothingOpenHint(agentName)}
          title={copy.requests.nothingOpenTitle}
        />
      )
    }

    return <Empty hint={copy.requests.emptyHint(agentName, copy.toolbar.issueCard)} title={copy.requests.emptyTitle} />
  }

  return (
    <>
      <div className="bk-thead">
        <Row>
          <Cell grow>{copy.requests.colRequest}</Cell>
          <Cell align="end" mono width={90}>
            {copy.requests.colCaptured}
          </Cell>
          <Cell align="end" width={110}>
            {copy.requests.colStatus}
          </Cell>
          <Cell align="end" muted width={90}>
            {copy.requests.colIssued}
          </Cell>
          <Cell align="end" muted width={100}>
            {copy.requests.colExpires}
          </Cell>
        </Row>
      </div>
      <Rows>
        {requests.map((request, index) => (
          <RequestRow
            active={request.id === selectedId}
            key={request.id || `row-${index}`}
            onSelect={onSelect}
            request={request}
          />
        ))}
      </Rows>
    </>
  )
})

const CodeRow = memo(function CodeRow({ code, nowMs }: { code: ThreeDsCode; nowMs: number }) {
  const copy = useI18n().t.bank.codes
  const expires = codeExpiresAt(code.receivedAt)
  const left = Number.isFinite(expires) ? expires - nowMs : NaN
  const active = Number.isFinite(left) && left >= 0
  const fraction = active ? Math.min(1, left / THREE_DS_WINDOW_MS) : 0

  const className = ['bk-code', active ? '' : 'bk-code--stale', active && left < SOON_MS ? 'bk-code--soon' : '']
    .join(' ')
    .trim()

  return (
    <div className={className}>
      <span className="bk-code__value">{code.code}</span>
      <span className="bk-code__meta">
        <span className="bk-code__amount">{codeAmountLabel(code.amountUsd, copy.amountNotGiven)}</span>
        <span className="bk-code__left">{active ? copy.left(formatCountdown(left)) : copy.expired}</span>
        <span aria-hidden="true" className="bk-code__bar">
          <span className="bk-code__bar-fill" style={{ transform: `scaleX(${fraction})` }} />
        </span>
      </span>
      <CopyText text={code.code} />
    </div>
  )
})

const CodesSection = memo(function CodesSection({ codes }: { codes: CodesState | null }) {
  const copy = useI18n().t.bank.codes
  const nowMs = useSecondClock(codes)

  if (!codes) {
    return <SkeletonRows rows={2} />
  }

  if (codes.list.length === 0) {
    return <Note kind="info">{copy.none}</Note>
  }

  return (
    <div className="bk-codes">
      {codes.list.map((code, index) => (
        <CodeRow code={code} key={`${code.code}-${code.receivedAt}-${index}`} nowMs={nowMs} />
      ))}
    </div>
  )
})

const RequestDetail = memo(function RequestDetail({
  onClose,
  request
}: {
  onClose: () => void
  request: SpendRequest
}) {
  const copy = useI18n().t.bank.detail

  return (
    <>
      <SectionTitle
        end={
          <IconAction label={copy.close} onClick={onClose}>
            <X size={12} strokeWidth={2} />
          </IconAction>
        }
      >
        {copy.title}
      </SectionTitle>
      <dl className="e-kv">
        <dt>{copy.request}</dt>
        <dd className="bk-detail__id">
          <span className="e-cell--mono">{request.id || '—'}</span>
          {request.id ? <CopyText text={request.id} /> : null}
        </dd>
        <dt>{copy.amount}</dt>
        <dd>
          <Money value={request.amountUsd} />
        </dd>
        <dt>{copy.status}</dt>
        <dd>
          <Pill tone={bankStatusTone(request.status)}>{request.status}</Pill>
        </dd>
        <dt>{copy.created}</dt>
        <dd>{when(request.createdAt)}</dd>
        {request.issuedAt ? (
          <>
            <dt>{copy.issued}</dt>
            <dd>{when(request.issuedAt)}</dd>
          </>
        ) : null}
        {request.capturedAmountUsd === null ? null : (
          <>
            <dt>{copy.captured}</dt>
            <dd>
              <Money value={request.capturedAmountUsd} />
            </dd>
          </>
        )}
        {request.capturedAt ? (
          <>
            <dt>{copy.capturedAt}</dt>
            <dd>{when(request.capturedAt)}</dd>
          </>
        ) : null}
        <dt>{copy.expires}</dt>
        <dd>{request.expiresAt ? when(request.expiresAt) : '—'}</dd>
        {request.last4 ? (
          <>
            <dt>{copy.card}</dt>
            <dd className="e-cell--mono">•••• {request.last4}</dd>
          </>
        ) : null}
      </dl>
    </>
  )
})

// ── the app ───────────────────────────────────────────────────────────────

export default function BankApp({ identity, inftId, refreshKey, slug }: EconAppProps) {
  const ask = useAskInft()
  const handOffToSetup = useOpenSetup()
  const copy = useI18n().t.bank
  const agentName = identity?.name || copy.agentFallback

  const [seed] = useState(() => seedBank(slug))
  const [state, setState] = useState<CardState | null>(seed.state)
  const [limit, setLimit] = useState<CardLimit | undefined>(() => seed.snapshot?.data.limit)
  const [requests, setRequests] = useState<null | SpendRequest[]>(() => seed.snapshot?.data.requests ?? null)
  const [codes, setCodes] = useState<CodesState | null>(null)
  const [profile, setProfile] = useState<AcpResult<CardProfile> | null>(null)
  const [notice, setNotice] = useState<BankNotice | null>(null)
  const [flipped, setFlipped] = useState(false)
  // `null` = follow the data (Open while something is open, else All) until
  // the owner picks a tab.
  const [tab, setTab] = useState<null | RequestTab>(null)
  const [selectedId, setSelectedId] = useState<null | string>(null)
  const [detail, setDetail] = useState<null | RequestDetailEntry>(null)
  const limitRef = useRef<CardLimit | undefined>(seed.snapshot?.data.limit)
  const stateRef = useRef<CardState | null>(seed.state)
  // Set only while a refresh failed: when the list on screen was read.
  const [listUpdatedAt, setListUpdatedAt] = useState<null | number>(null)

  const { clear, persist } = useSnapshot<BankSnapshot>('bank', slug, BANK_SNAPSHOT_VERSION, snapshot => {
    if (seed.snapshot && snapshot.at === seed.snapshot.at) {
      reportEconStatus('bank', slug, { updatedAt: seed.snapshot.at })
      publishBankBadge(slug, seed.snapshot.data.requests, [], Date.now())
    }
  })

  const sink = useMemo<BankSink>(
    () => ({
      clearSnapshot: clear,
      listUpdatedAt: setListUpdatedAt,
      codes: (list, at) => setCodes(current => (current && current.list === list ? current : { at, list })),
      limit: next => {
        limitRef.current = next
        setLimit(current => (sameLimit(current, next) ? current : next))
      },
      notice: next => setNotice(current => (sameNotice(current, next) ? current : next)),
      persist,
      profile: next => setProfile(current => (current?.ok && next.ok && current.data === next.data ? current : next)),
      requests: setRequests,
      resetReady: keepLimit => {
        if (!keepLimit) {
          limitRef.current = undefined
          setLimit(undefined)
        }

        setRequests(null)
        setCodes(null)
        setProfile(null)
        setSelectedId(null)
      },
      state: next => {
        stateRef.current = next
        setState(current => (sameCardState(current, next) ? current : next))
      }
    }),
    [clear, persist]
  )

  const load = useCallback(
    ({ force }: { force: boolean }) =>
      loadBank(
        inftId,
        slug,
        { force, knownLimit: limitRef.current, knownListAt: seed.snapshot?.at, knownState: stateRef.current },
        sink
      ),
    [inftId, seed, sink, slug]
  )

  const { reload } = useAutoRefresh('bank', slug, load, [inftId], refreshKey)

  const retry = useCallback(() => {
    void reload()
  }, [reload])

  // Doc 07 item 9: `card whoami` only reads — opening the window sends nothing. The link goes out on the owner's
  // click (`sendSignInLink`, the wizard's own), and "sent" is the time the CLI confirmed it, or the last confirmed
  // send on record. The one-minute wait and the 403/429 hold are read back from that record on every (re)mount.
  const signInPending = state?.kind === 'signin-pending'
  const signInEmail = signInPending ? state.email : undefined
  const [linkSentAt, setLinkSentAt] = useState<null | number>(null)
  const [resendReadyAt, setResendReadyAt] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const lastTick = useRef(clock)
  const wizardCopy = useInftWizardCopy().card

  /** Reads the clock. Set back since the last read, the countdown keeps what it had left: a wait in memory
   *  never grows by the step back (the record and main clamp theirs the same way). */
  const tickClock = useCallback((): number => {
    const t = Date.now()
    const back = lastTick.current - t

    lastTick.current = t

    if (back > 0) {
      setResendReadyAt(readyAt => Math.max(0, readyAt - back))
    }

    setClock(t)

    return t
  }, [])

  useEffect(() => {
    if (!signInPending) {
      setLinkSentAt(null)

      return
    }

    let cancelled = false

    void readSignInRecord(inftId).then(({ confirmedAt, readyAt }) => {
      if (cancelled) {
        return
      }

      if (confirmedAt !== null) {
        setLinkSentAt(current => (current === null || current < confirmedAt ? confirmedAt : current))
      }

      tickClock()
      setResendReadyAt(current => Math.max(current, readyAt))
    })

    const timer = setInterval(tickClock, 1000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [inftId, signInPending, tickClock])

  // K74: bumped whenever the window stops showing this iNFT (a switch, or closing): an answer that lands after a
  // bump belongs to the old one. A generation counter, not a mirror of `inftId`.
  const shownGeneration = useRef(0)

  useEffect(
    () => () => {
      shownGeneration.current += 1
    },
    [inftId]
  )

  const resendLink = useCallback(async () => {
    if (!signInEmail) {
      return
    }

    const clickedAt = tickClock()
    const generation = shownGeneration.current

    setResendReadyAt(clickedAt + RESEND_WAIT_MS)

    const result = await sendSignInLink(inftId, signInEmail)

    // K74: the window switched to another iNFT (or closed) while the link was going out: this answer is about
    // the old one, so none of it is stamped on what the window shows now.
    if (shownGeneration.current !== generation) {
      return
    }

    if (result.kind === 'sent') {
      setLinkSentAt(result.at)
      setResendReadyAt(Math.max(clickedAt, result.at) + RESEND_WAIT_MS)
      setNotice(null)
      void reload()

      return
    }

    // The minute after the last link (sent from this window before a reopen, or from Setup): the button counts it.
    if (result.kind === 'wait') {
      tickClock()
      setResendReadyAt(result.until)

      return
    }

    const info: CardErrorInfo =
      result.kind === 'failed'
        ? result.info
        : result.kind === 'held'
          ? { code: 'held', heldUntil: result.until }
          : result.kind === 'busy'
            ? { code: 'busy' }
            : { code: 'failed', detail: copy.gate.linkNotRecorded }

    setNotice({ message: cardErrorSentence(wizardCopy, info), setup: false })
  }, [copy.gate.linkNotRecorded, inftId, reload, signInEmail, tickClock, wizardCopy])

  const resendWait = Math.max(0, Math.ceil((resendReadyAt - clock) / 1000))

  // The second path's state, read only while a setup gate shows it (main keeps the answer five minutes).
  const setupGate = state?.kind === 'none' || signInPending
  const [agentcardAccount, setAgentcardAccount] = useState<AgentcardAccountState | null>(null)

  useEffect(() => {
    if (!setupGate) {
      return
    }

    let cancelled = false

    void agentcardAccountState().then(account => {
      if (!cancelled) {
        setAgentcardAccount(account)
      }
    })

    return () => {
      cancelled = true
    }
  }, [setupGate])

  const openSetup = useCallback(() => {
    forgetCard(slug)
    handOffToSetup({ inftId, step: 'signin' })
  }, [handOffToSetup, inftId, slug])

  // `refreshKey` is a dependency so the header's refresh re-reads the open
  // detail. This effect must stay declared after `useAutoRefresh`: its forced
  // load runs first and has already dropped the cached `card get` answers.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null)

      return
    }

    let cancelled = false

    setDetail(current => (current?.forId === selectedId ? current : null))

    void readRequestDetail(inftId, slug, selectedId).then(result => {
      if (!cancelled && result.ok) {
        setDetail({ forId: selectedId, request: result.data })
      }
    })

    return () => {
      cancelled = true
    }
  }, [inftId, refreshKey, selectedId, slug])

  const sorted = useMemo(() => sortRequests(requests ?? NO_REQUESTS), [requests])
  const open = useMemo(() => openRequests(sorted), [sorted])
  const activeTab: RequestTab = tab ?? (open.length > 0 ? 'open' : 'all')
  const visible = activeTab === 'open' ? open : sorted
  const nowMs = useExpiryClock(codes)
  const activeCount = codes ? countActiveCodes(codes.list, nowMs) : 0
  const selectedRequest = useMemo(() => pickSelectedRequest(detail, selectedId, sorted), [detail, selectedId, sorted])
  const limitUsd = limit === undefined ? undefined : centsToUsd(limit.limitCents)
  const locked = profile?.ok === true && profile.data.locked
  const funding = profile?.ok ? paymentMethodLabel(profile.data.paymentMethod) : null

  const limitSub =
    limit === undefined
      ? copy.stats.reading
      : limit.limitCents === null
        ? copy.stats.notSet
        : (limitLeftLabel(limit, copy.stats.limitLeft) ?? undefined)

  // The dock badge follows the clock too: a code expiring drops the count
  // without waiting for the next read.
  useEffect(() => {
    if (state?.kind === 'ready' && requests && codes) {
      publishBankBadge(slug, requests, codes.list, nowMs)
    }
  }, [codes, nowMs, requests, slug, state])

  const toggleFlip = useCallback(() => setFlipped(current => !current), [])
  const select = useCallback((id: string) => setSelectedId(id), [])
  const closeDetail = useCallback(() => setSelectedId(null), [])
  const showAll = useCallback(() => setTab('all'), [])

  const selectFirstOpen = useCallback(() => {
    const first = open[0]

    if (first) {
      setTab('open')
      setSelectedId(first.id)
    }
  }, [open])

  const askIssueCard = useCallback(() => {
    ask(
      'issue a card for an upcoming purchase — tell me the merchant and the amount you need approved, run `acp card issue` for it, then report back the limit and status once it is ready'
    )
  }, [ask])

  const askFetchLink = useCallback(() => {
    ask(
      "read the latest 'Sign in to agentcard.ai' email with `acp email extract-links` and open it, then run `acp card signup-poll`"
    )
  }, [ask])

  const noticeBar = notice ? <NoticeBar notice={notice} onOpenSetup={openSetup} onRetry={retry} /> : null

  if (!state) {
    return (
      <div className="bk-root">
        {noticeBar ?? (
          <div className="e-pad">
            <SkeletonStats count={3} />
            <SkeletonRows rows={5} />
          </div>
        )}
      </div>
    )
  }

  // Nothing is known yet and the last read could not answer: never "No card yet".
  if (state.kind === 'unknown') {
    return (
      <div className="bk-root">
        <div className="e-pad">
          <p className="bk-hint">{copy.checking}</p>
        </div>
        {noticeBar ?? (
          <div className="e-pad">
            <SkeletonStats count={3} />
            <SkeletonRows rows={5} />
          </div>
        )}
      </div>
    )
  }

  if (state.kind === 'session-expired') {
    return (
      <div className="bk-root">
        {noticeBar}
        <SessionExpired
          agentName={agentName}
          cardKnown={state.cardKnown}
          email={state.email}
          limit={limit}
          onSignIn={openSetup}
        />
      </div>
    )
  }

  if (state.kind === 'none') {
    return (
      <div className="bk-root">
        {noticeBar}
        <NoCardYet agentcardAccount={agentcardAccount} agentName={agentName} onOpenSetup={openSetup} />
      </div>
    )
  }

  if (state.kind === 'signin-pending') {
    return (
      <div className="bk-root">
        {noticeBar}
        <SignInPending
          agentcardAccount={agentcardAccount}
          agentName={agentName}
          cardKnown={state.cardKnown}
          email={state.email}
          limit={limit}
          onAskInft={askFetchLink}
          onOpenSetup={openSetup}
          onResend={state.email ? () => void resendLink() : undefined}
          resendWait={resendWait}
          sentAt={linkSentAt}
        />
      </div>
    )
  }

  return (
    <div className="bk-root">
      <AppFrame
        aside={selectedRequest ? <RequestDetail onClose={closeDetail} request={selectedRequest} /> : undefined}
        className="bk-frame"
      >
        <div className="bk-hero">
          <CardVisual
            agentName={agentName}
            face="live"
            flipped={flipped}
            funding={funding}
            limit={limit}
            locked={locked}
            onToggle={toggleFlip}
          />
          <div className="bk-hero__side">
            <StatRow>
              <Stat label={copy.card.spendLimit} sub={limitSub} value={<Money value={limitUsd} />} />
              <ActionStat
                disabled={open.length === 0}
                label={copy.stats.openRequests}
                onClick={selectFirstOpen}
                sub={open.length > 0 ? copy.stats.reviewFirst : requests ? copy.stats.nothingWaiting : undefined}
                tone={open.length > 0 ? 'warn' : undefined}
                value={requests ? open.length : '—'}
              />
              <Stat
                label={copy.stats.codesWaiting}
                sub={activeCount > 0 ? copy.stats.codesLive : undefined}
                tone={activeCount > 0 ? 'up' : undefined}
                value={codes ? activeCount : '—'}
              />
            </StatRow>
            <AccountCard onOpenSetup={openSetup} profile={profile} />
          </div>
        </div>

        {noticeBar}

        <Toolbar
          end={
            <>
              <Action kind="quiet" onClick={openSetup}>
                {copy.toolbar.changeLimit}
              </Action>
              <Action kind="primary" onClick={askIssueCard}>
                {copy.toolbar.issueCard}
              </Action>
            </>
          }
        >
          <span className="bk-hint">{copy.toolbar.readOnly(agentName)}</span>
        </Toolbar>

        <div className="e-scroll">
          <SectionTitle
            end={
              <Tabs<RequestTab>
                items={[
                  { id: 'open', label: copy.requests.tabOpen, count: open.length },
                  { id: 'all', label: copy.requests.tabAll, count: sorted.length }
                ]}
                onChange={setTab}
                value={activeTab}
              />
            }
          >
            {copy.requests.title}
          </SectionTitle>
          {listUpdatedAt !== null ? (
            <p className="bk-hint bk-stale">{copy.requests.updated(timeAgo(listUpdatedAt))}</p>
          ) : null}
          <RequestsSection
            agentName={agentName}
            hasAny={sorted.length > 0}
            loaded={requests !== null}
            onSelect={select}
            onShowAll={showAll}
            requests={visible}
            selectedId={selectedId}
            tab={activeTab}
          />

          <SectionTitle end={activeCount > 0 ? <Pill tone="up">{copy.codes.active(activeCount)}</Pill> : undefined}>
            {copy.codes.title}
          </SectionTitle>
          <CodesSection codes={codes} />
        </div>
      </AppFrame>
    </div>
  )
}
