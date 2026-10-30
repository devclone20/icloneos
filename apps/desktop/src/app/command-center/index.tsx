import './command-center.css'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { IcTip } from '@/components/ic/ic-system'
import { getActionStatus, getLogs, getStatus, getUsageAnalytics, restartGateway, updateHermes } from '@/hermes'
import type { ActionStatusResponse, AnalyticsResponse, StatusResponse } from '@/hermes'
import { useI18n } from '@/i18n'
import { sleep } from '@/iclone-shared/async'
import { errorMessage } from '@/iclone-shared/errors'
import { sessionTitle } from '@/lib/chat-runtime'
import { compactNumber } from '@/lib/format'
import { Activity, BarChart3, Bookmark, BookmarkFilled, Download, MessageCircle, Trash2, Wrench } from '@/lib/icons'
import { exportSession } from '@/lib/session-export'
import { useStoreSelector } from '@/lib/use-session-slice'
import { upsertDesktopActionTask } from '@/store/activity'
import { $pinnedSessionIds, pinSession, unpinSession } from '@/store/layout'
import { $sessions, sessionPinId } from '@/store/session'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'

import {
  actionOutcome,
  CC_SECTIONS,
  type CommandCenterSection,
  filterLines,
  filterSessions,
  formatTimestamp,
  LOG_FILES,
  LOG_LEVELS,
  type LogFile,
  type LogLevel,
  USAGE_PERIODS,
  usageBars,
  type UsagePeriod
} from './cc-model'
import { MaintenancePanel } from './maintenance'
import { PageFrame, type PageFrameSection } from './page-frame'
import { IcAction, IcIconAction, IcSearchInput, IcSegmented } from './ui/controls'
import { IcDot, IcEmpty, IcNote, IcSkeleton } from './ui/feedback'
import { IcEyebrow, IcMeta, IcScroll, IcStack, IcStat, IcStats } from './ui/layout'
import { IcMonoLines } from './ui/mono'
import { IcRow, IcRows } from './ui/rows'

export type { CommandCenterSection } from './cc-model'

// Stable empty arrays so the selector returns the same reference while we are
// NOT on the Sessions tab — useStoreSelector bails out on Object.is, so the
// page never re-renders from a $sessions tick while System/Usage is open.
const EMPTY_SESSIONS: readonly never[] = []
const EMPTY_PINNED: readonly string[] = []

const SECTION_ICON = {
  maintenance: Wrench,
  sessions: MessageCircle,
  system: Activity,
  usage: BarChart3
} as const

const ACTION_POLL_ATTEMPTS = 18
const ACTION_POLL_INTERVAL_MS = 1200
const LOG_TAIL_LINES = 200

interface CommandCenterViewProps {
  /** Absent until the controller publishes it (`session-delete.ts`): the row
   *  then shows no delete control at all, never a dead one. */
  onDeleteSession?: (sessionId: string) => Promise<void> | void
  onOpenSession: (sessionId: string) => void
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)

    return () => window.clearTimeout(id)
  }, [delayMs, value])

  return debounced
}

export function CommandCenterView({ onDeleteSession, onOpenSession }: CommandCenterViewProps) {
  const { t } = useI18n()
  const cc = t.commandCenter
  const [section, setSection] = useRouteEnumParam('section', CC_SECTIONS, 'sessions')
  const sessions = useStoreSelector($sessions, s => (section === 'sessions' ? s : EMPTY_SESSIONS))
  const pinnedSessionIds = useStoreSelector($pinnedSessionIds, s => (section === 'sessions' ? s : EMPTY_PINNED))

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<null | StatusResponse>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [logFile, setLogFile] = useState<LogFile>('agent')
  const [logLevel, setLogLevel] = useState<LogLevel>('ALL')
  const [logQuery, setLogQuery] = useState('')
  const [systemLoading, setSystemLoading] = useState(false)
  const [systemError, setSystemError] = useState('')
  const [systemAction, setSystemAction] = useState<ActionStatusResponse | null>(null)
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>(30)
  const [usage, setUsage] = useState<AnalyticsResponse | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState('')
  const usageRequestRef = useRef(0)

  const debouncedQuery = useDebouncedValue(query.trim(), 180)
  const visibleSessions = useMemo(() => filterSessions(sessions, debouncedQuery), [debouncedQuery, sessions])
  const visibleLogs = useMemo(() => filterLines(logs, logQuery), [logQuery, logs])

  const refreshSystem = useCallback(async () => {
    setSystemLoading(true)
    setSystemError('')

    try {
      const [nextStatus, nextLogs] = await Promise.all([
        getStatus(),
        getLogs({ file: logFile, level: logLevel, lines: LOG_TAIL_LINES })
      ])

      setStatus(nextStatus)
      setLogs(nextLogs.lines)
    } catch (error) {
      setSystemError(errorMessage(error))
    } finally {
      setSystemLoading(false)
    }
  }, [logFile, logLevel])

  const refreshUsage = useCallback(async (days: UsagePeriod) => {
    const requestId = usageRequestRef.current + 1
    usageRequestRef.current = requestId
    setUsageLoading(true)
    setUsageError('')

    try {
      const response = await getUsageAnalytics(days)

      if (usageRequestRef.current === requestId) {
        setUsage(response)
      }
    } catch (error) {
      if (usageRequestRef.current === requestId) {
        setUsageError(errorMessage(error))
      }
    } finally {
      if (usageRequestRef.current === requestId) {
        setUsageLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    // Refetch when the page opens and whenever the log file/level filters
    // change (refreshSystem's identity tracks them).
    if (section === 'system') {
      void refreshSystem()
    }
  }, [refreshSystem, section])

  useEffect(() => {
    if (section === 'usage') {
      void refreshUsage(usagePeriod)
    }
  }, [refreshUsage, section, usagePeriod])

  useRefreshHotkey(() => {
    if (section === 'system') {
      void refreshSystem()
    } else if (section === 'usage') {
      void refreshUsage(usagePeriod)
    }
  })

  const runSystemAction = useCallback(
    async (kind: 'restart' | 'update') => {
      setSystemError('')

      try {
        const started = kind === 'restart' ? await restartGateway() : await updateHermes()
        let nextStatus: ActionStatusResponse | null = null

        for (let attempt = 0; attempt < ACTION_POLL_ATTEMPTS; attempt += 1) {
          await sleep(ACTION_POLL_INTERVAL_MS)
          const polled = await getActionStatus(started.name, 180)
          nextStatus = polled
          setSystemAction(polled)
          upsertDesktopActionTask(polled)

          if (!polled.running) {
            break
          }
        }

        if (!nextStatus) {
          const pendingStatus = {
            exit_code: null,
            lines: [cc.actionStartedWaiting],
            name: started.name,
            pid: started.pid,
            running: true
          }

          setSystemAction(pendingStatus)
          upsertDesktopActionTask(pendingStatus)
        }
      } catch (error) {
        setSystemError(errorMessage(error))
      } finally {
        void refreshSystem()
      }
    },
    [cc, refreshSystem]
  )

  const sections: readonly PageFrameSection<CommandCenterSection>[] = useMemo(
    () => CC_SECTIONS.map(id => ({ icon: SECTION_ICON[id], id, label: cc.sections[id] })),
    [cc]
  )

  const tools =
    section === 'sessions' ? (
      <IcSearchInput onChange={setQuery} placeholder={cc.searchPlaceholder} value={query} width="16rem" />
    ) : section === 'usage' ? (
      <IcSegmented
        onChange={id => setUsagePeriod(Number(id) as UsagePeriod)}
        options={USAGE_PERIODS.map(value => ({ id: String(value), label: cc.days(value) }))}
        value={String(usagePeriod)}
      />
    ) : null

  return (
    <PageFrame
      // Inside the Settings body (front K5): the Settings card is the only
      // card, and it owns Esc and the ✕.
      frame="bare"
      hint={cc.sectionDescriptions[section]}
      onSelectSection={setSection}
      section={section}
      sections={sections}
      title={cc.sections[section]}
      tools={tools}
    >
      {section === 'sessions' ? (
        <IcScroll>
          {visibleSessions.length === 0 ? (
            <IcEmpty description={debouncedQuery ? cc.noResults : cc.noSessions} />
          ) : (
            <IcRows>
              {visibleSessions.map(session => {
                const pinId = sessionPinId(session)
                const pinned = pinnedSessionIds.includes(pinId)
                const title = sessionTitle(session)

                return (
                  <IcRow
                    actions={
                      <>
                        <IcIconAction
                          label={pinned ? cc.unpinSession : cc.pinSession}
                          onClick={() => (pinned ? unpinSession(pinId) : pinSession(pinId))}
                        >
                          {pinned ? <BookmarkFilled size={14} /> : <Bookmark size={14} />}
                        </IcIconAction>
                        <IcIconAction
                          label={cc.exportSession}
                          onClick={() => void exportSession(session.id, { session, title })}
                        >
                          <Download size={14} />
                        </IcIconAction>
                        {onDeleteSession ? (
                          <IcIconAction
                            label={cc.deleteSession}
                            onClick={() => void onDeleteSession(session.id)}
                            tone="danger"
                          >
                            <Trash2 size={14} />
                          </IcIconAction>
                        ) : null}
                      </>
                    }
                    key={session.id}
                    meta={formatTimestamp(session.last_active || session.started_at)}
                    onOpen={() => onOpenSession(session.id)}
                    title={title}
                  />
                )
              })}
            </IcRows>
          )}
        </IcScroll>
      ) : section === 'usage' ? (
        <UsagePanel
          error={usageError}
          loading={usageLoading}
          onRefresh={() => void refreshUsage(usagePeriod)}
          period={usagePeriod}
          usage={usage}
        />
      ) : section === 'maintenance' ? (
        <MaintenancePanel />
      ) : (
        <IcStack>
          {status ? (
            <div className="icc-status">
              <div>
                <p className="icc-status__line">
                  <IcDot tone={status.gateway_running ? 'done' : 'warn'} />
                  {status.gateway_running ? cc.gatewayRunning : cc.gatewayStopped}
                </p>
                <IcMeta>{cc.hermesActiveSessions(status.version, status.active_sessions)}</IcMeta>
              </div>
              <div className="icc-status__actions">
                <IcAction onClick={() => void runSystemAction('restart')}>{cc.restartGateway}</IcAction>
                <IcAction onClick={() => void runSystemAction('update')} tone="accent">
                  {cc.updateHermes}
                </IcAction>
              </div>
            </div>
          ) : (
            <IcSkeleton label={cc.loadingStatus} rows={2} />
          )}

          {systemAction ? (
            <IcMeta>
              {systemAction.name} ·{' '}
              {actionOutcome(systemAction.running, systemAction.exit_code) === 'running'
                ? cc.actionRunning
                : actionOutcome(systemAction.running, systemAction.exit_code) === 'done'
                  ? cc.actionDone
                  : cc.actionFailed}
            </IcMeta>
          ) : null}

          <div className="icc-logs">
            <div className="icc-logs__bar">
              <IcEyebrow>{cc.recentLogs}</IcEyebrow>
              <div className="icc-logs__filters">
                <IcSegmented
                  onChange={setLogFile}
                  options={LOG_FILES.map(value => ({ id: value, label: value }))}
                  value={logFile}
                />
                <IcSegmented
                  onChange={setLogLevel}
                  options={LOG_LEVELS.map(value => ({
                    id: value,
                    label: value === 'ALL' ? 'all' : value.toLowerCase()
                  }))}
                  value={logLevel}
                />
                <IcSearchInput
                  onChange={setLogQuery}
                  placeholder={cc.logSearchPlaceholder}
                  value={logQuery}
                  width="11rem"
                />
              </div>
            </div>
            {systemError ? <IcNote tone="danger">{systemError}</IcNote> : null}
            <IcMonoLines emptyLabel={cc.noLogs} lines={systemLoading && logs.length === 0 ? null : visibleLogs} />
          </div>
        </IcStack>
      )}
    </PageFrame>
  )
}

interface UsagePanelProps {
  error: string
  loading: boolean
  onRefresh: () => void
  period: UsagePeriod
  usage: AnalyticsResponse | null
}

function UsagePanel({ error, loading, onRefresh, period, usage }: UsagePanelProps) {
  const { t } = useI18n()
  const cc = t.commandCenter
  const totals = usage?.totals
  const bars = useMemo(() => usageBars(usage?.daily, compactNumber), [usage])
  const byModel = usage?.by_model ?? []
  const topSkills = usage?.skills?.top_skills ?? []

  if (!totals) {
    return loading ? (
      <IcSkeleton label={cc.loadingUsage} />
    ) : (
      <IcEmpty action={<IcAction onClick={onRefresh}>{cc.retry}</IcAction>} description={cc.noUsage(period)} />
    )
  }

  return (
    <IcScroll>
      <div className="icc-usage">
        {error ? <IcNote tone="danger">{error}</IcNote> : null}

        <IcStats>
          <IcStat label={cc.statSessions} value={compactNumber(totals.total_sessions)} />
          <IcStat label={cc.statApiCalls} value={compactNumber(totals.total_api_calls)} />
          <IcStat
            label={cc.statTokens}
            value={`${compactNumber(totals.total_input)} / ${compactNumber(totals.total_output)}`}
          />
        </IcStats>

        <section>
          <div className="icc-usage__head">
            <IcEyebrow>{cc.dailyTokens}</IcEyebrow>
            <p className="icc-usage__legend">
              <span className="icc-usage__key" data-series="input" /> {cc.input}
              <span className="icc-usage__key" data-series="output" /> {cc.output}
            </p>
          </div>
          {bars.length === 0 ? (
            <IcMeta>{cc.noDailyActivity}</IcMeta>
          ) : (
            <>
              <div className="icc-chart">
                {bars.map(bar => (
                  <IcTip key={bar.day} label={bar.title}>
                    <div className="icc-chart__col">
                      <span data-series="input" style={{ height: `${bar.inputPct}%` }} />
                      <span data-series="output" style={{ height: `${bar.outputPct}%` }} />
                    </div>
                  </IcTip>
                ))}
              </div>
              <div className="icc-chart__axis">
                <IcMeta>{bars[0]?.day}</IcMeta>
                <IcMeta>{bars.at(-1)?.day}</IcMeta>
              </div>
            </>
          )}
        </section>

        <div className="icc-usage__lists">
          <UsageList
            emptyLabel={cc.noModelUsage}
            rows={byModel.slice(0, 6).map(entry => ({
              key: entry.model,
              label: entry.model,
              value: compactNumber((entry.input_tokens || 0) + (entry.output_tokens || 0))
            }))}
            title={cc.topModels}
          />
          <UsageList
            emptyLabel={cc.noSkillActivity}
            rows={topSkills.slice(0, 6).map(entry => ({
              key: entry.skill,
              label: entry.skill,
              value: cc.actions(compactNumber(entry.total_count))
            }))}
            title={cc.topSkills}
          />
        </div>
      </div>
    </IcScroll>
  )
}

function UsageList({
  emptyLabel,
  rows,
  title
}: {
  emptyLabel: string
  rows: { key: string; label: string; value: string }[]
  title: string
}) {
  return (
    <section>
      <IcEyebrow>{title}</IcEyebrow>
      {rows.length === 0 ? (
        <IcMeta>{emptyLabel}</IcMeta>
      ) : (
        <ul className="icc-list">
          {rows.map(row => (
            <li key={row.key}>
              <span className="icc-list__label">{row.label}</span>
              <span className="icc-list__value">{row.value}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
