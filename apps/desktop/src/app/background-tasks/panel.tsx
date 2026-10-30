/**
 * The Background tasks panel (contract §2.6): every worker the registry knows, one row each, plus a read-only view of
 * V3-F's permission log. Built from our own chassis (`components/ic`) and tokens; it hangs from the band with the
 * same 360 px rules as the context card.
 */
import './background-tasks.css'

import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { IcSegmented } from '@/components/ic/controls'
import { IcNote } from '@/components/ic/feedback'
import { IcRow, IcRows } from '@/components/ic/rows'
import { IcState } from '@/components/ic/state'
import { auditTitle, describeAuditRecord } from '@/components/permissions/audit-detail'
import { useI18n } from '@/i18n'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import type { AuditRecordView } from '@/iclone-shared/permissions'
import { $backgroundBadge, $backgroundTasks, $taskSourceErrors, type BgTask } from '@/store/background-tasks'

import { TaskRow } from './row'
import { $permissionAudit } from './sources/permissions'

/** Rows mounted at once; the rest wait behind "Show 50 more" (G6: 200 tasks ⇒ ≤ 50 rows in the DOM). */
const ROWS_PER_PAGE = 50

const LOG_SHOWN = 40
const ELAPSED_TICK_MS = 1_000

type Tab = 'log' | 'tasks'

/** Elapsed times tick only while something is running and the panel is on screen. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!ticking) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)

    return () => clearInterval(timer)
  }, [ticking])

  return now
}

function TaskList({ tasks }: { tasks: readonly BgTask[] }) {
  const copy = useI18n().t.backgroundTasks
  const [shown, setShown] = useState(ROWS_PER_PAGE)
  const [openId, setOpenId] = useState<string | null>(null)
  const now = useNow(tasks.some(task => task.state === 'running' && task.startedAt !== null))
  const rest = tasks.length - shown

  return (
    <>
      <IcRows>
        {tasks.slice(0, shown).map(task => (
          <TaskRow
            copy={copy}
            key={task.id}
            now={now}
            onToggle={() => setOpenId(openId === task.id ? null : task.id)}
            open={openId === task.id}
            task={task}
          />
        ))}
      </IcRows>
      {rest > 0 ? (
        <button
          className="icui-btn ibg-panel__more"
          data-testid="bg-tasks-more"
          onClick={() => setShown(shown + ROWS_PER_PAGE)}
          type="button"
        >
          {copy.showMore(Math.min(rest, ROWS_PER_PAGE))}
        </button>
      ) : null}
    </>
  )
}

function when(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(APP_INTL_LOCALE, { timeStyle: 'short' })
}

function PermissionLog({ records }: { records: readonly AuditRecordView[] | null }) {
  const { t } = useI18n()
  const copy = t.backgroundTasks
  const permissions = t.settings.permissions

  if (records === null) {
    return <IcState kind="empty" title={copy.logUnavailable} />
  }

  if (records.length === 0) {
    return <IcState kind="empty" title={copy.logEmpty} />
  }

  return (
    <div data-testid="bg-tasks-log">
      <IcRows>
        {records
          .slice(-LOG_SHOWN)
          .reverse()
          .map(record => (
            <IcRow
              key={record.seq_main}
              meta={[when(record.ts), describeAuditRecord(record, permissions), record.agent?.inft]
                .filter(Boolean)
                .join(' · ')}
              title={[auditTitle(permissions, record), record.action?.tool].filter(Boolean).join(' · ')}
            />
          ))}
      </IcRows>
    </div>
  )
}

export function BackgroundTasksPanel() {
  const copy = useI18n().t.backgroundTasks
  const tasks = useStore($backgroundTasks)
  const badge = useStore($backgroundBadge)
  const errors = useStore($taskSourceErrors)
  const audit = useStore($permissionAudit)
  const [tab, setTab] = useState<Tab>('tasks')

  const sourceName = (id: string) => (id in copy.sources ? copy.sources[id as keyof typeof copy.sources] : id)

  return (
    <div className="ibg-panel">
      <div className="ibg-panel__head">
        <h3 className="ibg-panel__title">{copy.title}</h3>
        <IcSegmented
          onChange={setTab}
          options={[
            { id: 'tasks', label: copy.tabs.tasks },
            { id: 'log', label: copy.tabs.log }
          ]}
          value={tab}
        />
      </div>
      {tab === 'log' ? (
        <PermissionLog records={audit} />
      ) : errors === null ? (
        <IcState kind="loading" title={copy.loading} />
      ) : (
        <>
          {badge.diedUnseen > 0 ? (
            <div className="ibg-panel__note" data-testid="bg-tasks-died-banner">
              <IcNote tone="danger">{copy.diedBanner(badge.diedUnseen)}</IcNote>
            </div>
          ) : null}
          {errors.map(error => (
            <div className="ibg-panel__note" data-testid="bg-tasks-source-error" key={error.source}>
              <IcNote tone="danger">{copy.sourceError(sourceName(error.source), error.detail)}</IcNote>
            </div>
          ))}
          {tasks.length === 0 ? (
            <IcState description={copy.emptyText} kind="empty" title={copy.emptyTitle} />
          ) : (
            <TaskList tasks={tasks} />
          )}
        </>
      )}
    </div>
  )
}
