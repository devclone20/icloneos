import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { type CronJob, getCronJobRuns, type SessionInfo } from '@/hermes'
import type { Translations } from '@/i18n'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import { Pause, Play, Zap } from '@/lib/icons'
import { $changeEventsAvailable, $cronChangeTick } from '@/store/live-sync'

import { IcAction } from '../command-center/ui/controls'
import { IcNote, IcPill, IcSkeleton } from '../command-center/ui/feedback'
import { IcMeta, IcScroll, IcSectionLabel } from '../command-center/ui/layout'
import { IcRow, IcRows } from '../command-center/ui/rows'

import { jobState, jobTitle } from './job-state'
import { formatTime, jobDeliver, jobModel, jobPrompt, jobScheduleDisplay, STATE_TONE } from './schedule'

/** The cron page's right pane: one job's state, its schedule facts, its prompt
 *  and the sessions its runs produced. */
export function CronJobDetail({
  busy,
  c,
  job,
  onOpenSession,
  onPauseResume,
  onTrigger
}: {
  busy: boolean
  c: Translations['cron']
  job: CronJob
  onOpenSession?: (sessionId: string) => void
  onPauseResume: () => void
  onTrigger: () => void
}) {
  const state = jobState(job)
  const isPaused = state === 'paused'
  const deliver = jobDeliver(job)
  const prompt = jobPrompt(job)
  const modelOverride = jobModel(job)

  const rows: { label: string; value: string }[] = [
    { label: c.frequencyLabel, value: jobScheduleDisplay(job) },
    { label: c.last.replace(/:$/, ''), value: formatTime(job.last_run_at) },
    { label: c.next.replace(/:$/, ''), value: formatTime(job.next_run_at) },
    { label: c.deliverLabel, value: c.deliveryLabels[deliver] ?? deliver },
    ...(modelOverride ? [{ label: c.modelLabel, value: modelOverride }] : [])
  ]

  return (
    <div className="cron-detail">
      <IcScroll>
        <header className="cron-detail__head">
          <div className="cron-detail__ident">
            <h3 className="cron-detail__title">{jobTitle(job)}</h3>
            <IcPill tone={STATE_TONE[state] ?? 'muted'}>{c.states[state] ?? state}</IcPill>
          </div>
          <div className="cron-detail__actions">
            <IcAction disabled={busy} onClick={onPauseResume}>
              {isPaused ? <Play size={13} /> : <Pause size={13} />}
              {isPaused ? c.resumeTitle : c.pauseTitle}
            </IcAction>
            <IcAction disabled={busy} onClick={onTrigger} tone="accent">
              <Zap size={13} />
              {c.triggerNow}
            </IcAction>
          </div>
        </header>

        <dl className="cron-meta">
          {rows.map(row => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>

        {job.last_error ? <IcNote tone="danger">{job.last_error}</IcNote> : null}

        {prompt ? (
          <section>
            <IcSectionLabel>{c.promptLabel}</IcSectionLabel>
            <pre className="cron-prompt" data-selectable-text="true">
              {prompt}
            </pre>
          </section>
        ) : null}

        <CronJobRuns c={c} jobId={job.id} onOpenSession={onOpenSession} />
      </IcScroll>
    </div>
  )
}

function formatRunTime(seconds?: null | number): string {
  if (!seconds) {
    return '—'
  }

  const date = new Date(seconds * 1000)

  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString(APP_INTL_LOCALE)
}

// Runs are produced by the background scheduler tick. cron.changed /
// sessions.changed broadcasts re-load immediately on event-capable backends
// (the tick dep below), so the poll drops to a slow backstop there; older
// backends keep the legacy cadence.
const RUNS_POLL_INTERVAL_MS = 8000
const RUNS_BACKSTOP_INTERVAL_MS = 60_000

function CronJobRuns({
  c,
  jobId,
  onOpenSession
}: {
  c: Translations['cron']
  jobId: string
  onOpenSession?: (sessionId: string) => void
}) {
  const [runs, setRuns] = useState<null | SessionInfo[]>(null)
  const changeEventsAvailable = useStore($changeEventsAvailable)
  const cronChangeTick = useStore($cronChangeTick)

  useEffect(() => {
    let cancelled = false

    const load = () =>
      getCronJobRuns(jobId)
        .then(result => {
          if (!cancelled) {
            setRuns(result)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRuns(prev => prev ?? [])
          }
        })

    void load()

    const intervalId = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') {
          void load()
        }
      },
      changeEventsAvailable ? RUNS_BACKSTOP_INTERVAL_MS : RUNS_POLL_INTERVAL_MS
    )

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load()
      }
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // cronChangeTick: a fired run moves jobs.json bookkeeping → reload now.
  }, [changeEventsAvailable, cronChangeTick, jobId])

  return (
    <section>
      <IcSectionLabel>
        {c.runHistory}
        {runs && runs.length > 0 ? ` · ${runs.length}` : ''}
      </IcSectionLabel>
      {runs === null ? (
        <IcSkeleton label={c.runHistory} rows={2} />
      ) : runs.length === 0 ? (
        <IcMeta>{c.noRuns}</IcMeta>
      ) : (
        <IcRows>
          {runs.map(run => (
            <IcRow
              key={run.id}
              meta={formatRunTime(run.last_active || run.started_at)}
              onOpen={() => onOpenSession?.(run.id)}
              title={run.title?.trim() || run.preview?.trim() || run.id}
            />
          ))}
        </IcRows>
      )}
    </section>
  )
}
