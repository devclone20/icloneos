import './cron.css'

import { createCronTriggerController, type CronTriggerController } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type AutomationBlueprint,
  createCronJob,
  type CronJob,
  deleteCronJob,
  getAutomationBlueprints,
  instantiateAutomationBlueprint,
  pauseCronJob,
  resumeCronJob,
  updateCronJob
} from '@/hermes'
import { useI18n } from '@/i18n'
import { Clock, Package, Pencil, Trash2 } from '@/lib/icons'
import { asText } from '@/lib/text'
import { $cronFocusJobId, $cronJobs, invalidateCronJobsRequests, setCronFocusJobId } from '@/store/cron'
import { notify, notifyError } from '@/store/notifications'
import { $profileScope, ALL_PROFILES } from '@/store/profile'

import { PageFrame } from '../command-center/page-frame'
import { IcAction, IcIconAction, IcSearchInput } from '../command-center/ui/controls'
import { IcDot, IcEmpty, IcSkeleton } from '../command-center/ui/feedback'
import { IcMeta, IcScroll, IcSectionLabel } from '../command-center/ui/layout'
import { IcConfirm } from '../command-center/ui/modal'
import { IcRow, IcRows } from '../command-center/ui/rows'
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'

import { mutateAndRefreshCronJobs, refreshCronJobs, triggerAndRefreshCronJobs } from './cron-actions'
import { cronEditorUpdates, jobIsScriptOnly } from './cron-job-model'
import { CronJobDetail } from './detail'
import { CronEditorDialog } from './editor-dialog'
import { clearCronEditorDraft, readCronEditorDraft } from './editor-draft'
import { jobState, jobTitle } from './job-state'
import {
  cronProfileForScope,
  DEFAULT_DELIVER,
  type EditorState,
  type EditorValues,
  jobName,
  jobScheduleDisplay,
  matchesQuery,
  STATE_TONE,
  truncate
} from './schedule'

/**
 * OUR cron page: the scheduled-job list, its detail pane and the editor dialog,
 * drawn on our page frame with our own primitives (owner #8 — written anew, not
 * re-skinned). Everything a saved job depends on is reused as LOGIC only:
 * `schedule.ts` (expression <-> preset, job readers), `cron-job-model.ts`
 * (validation, delivery targets), `cron-actions.ts` (the fenced refresh the
 * sidebar's 'Scheduled' group shares) and `job-state.ts`.
 */

interface CronViewProps {
  onClose: () => void
  onOpenSession?: (sessionId: string) => void
}

export function CronView({ onClose, onOpenSession }: CronViewProps) {
  const { t } = useI18n()
  const c = t.cron
  // Source of truth is the shared atom (also fed by the controller poll), so the
  // sidebar and this page never drift — a delete here clears the sidebar row
  // immediately. `loading` only gates the first paint before the atom is filled.
  const jobs = useStore($cronJobs)
  const [loading, setLoading] = useState(jobs.length === 0)
  const [query, setQuery] = useState('')
  const [busyJobTokens, setBusyJobTokens] = useState<ReadonlyMap<string, symbol>>(() => new Map())
  const [triggeringJobKeys, setTriggeringJobKeys] = useState<ReadonlySet<string>>(() => new Set())
  const triggerControllerRef = useRef<CronTriggerController | null>(null)

  // eslint-disable-next-line no-restricted-syntax -- controller mount identity, not an atom mirror
  useEffect(() => {
    const controller = createCronTriggerController((key, running) => {
      if (triggerControllerRef.current !== controller) {
        return
      }

      setTriggeringJobKeys(current => {
        const next = new Set(current)

        if (running) {
          next.add(key)
        } else {
          next.delete(key)
        }

        return next
      })
    })

    triggerControllerRef.current = controller

    return () => {
      triggerControllerRef.current = null
    }
  }, [])

  // Master/detail: the job whose schedule + run history fill the right pane.
  const [selectedJobId, setSelectedJobId] = useState<null | string>(null)
  // Set when a job is opened from the sidebar so we scroll it into view once the
  // row exists. Cleared after the scroll fires.
  const pendingScrollRef = useRef<null | string>(null)
  const focusJobId = useStore($cronFocusJobId)

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [pendingDelete, setPendingDelete] = useState<CronJob | null>(null)
  const draftRestoredRef = useRef(false)

  // Jobs live per-profile on disk and the list endpoint aggregates 'all' by
  // default — scope the fetch to the sidebar's profile scope so this page
  // and the sidebar (which share the $cronJobs atom) agree on what's shown.
  const profileScope = useStore($profileScope)
  const profile = cronProfileForScope(profileScope)

  const refresh = useCallback(async () => {
    const { refreshError, stale } = await refreshCronJobs(profile)

    if (stale) {
      return
    }

    if (refreshError) {
      notifyError(refreshError, c.failedLoad)
    }

    setLoading(false)
  }, [c, profile])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
    // Fence the previous profile's request before the next profile effect, and
    // fence every pending completion when the page unmounts.

    return () => invalidateCronJobsRequests()
  }, [refresh])

  // A dialog the user was typing in when the window reloaded reopens with its
  // draft. An edit draft waits for its job to arrive and is dropped if the job
  // is gone; a create draft reopens straight away.
  // eslint-disable-next-line no-restricted-syntax -- one-shot restore latch, not an atom mirror
  useEffect(() => {
    if (draftRestoredRef.current) {
      return
    }

    const draft = readCronEditorDraft()

    if (!draft) {
      draftRestoredRef.current = true

      return
    }

    if (draft.mode === 'create') {
      draftRestoredRef.current = true
      setEditor({ blueprintKey: draft.blueprintKey, mode: 'create' })

      return
    }

    const job = jobs.find(candidate => candidate.id === draft.jobId)

    if (job) {
      draftRestoredRef.current = true
      setEditor({ job, mode: 'edit' })
    } else if (jobs.length > 0) {
      draftRestoredRef.current = true
      clearCronEditorDraft()
    }
  }, [jobs])

  // Sidebar → "open this job": resolve the focus id (or name) to a job, select
  // it, queue a scroll, then clear the one-shot focus so re-opening cron
  // normally doesn't re-trigger it.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!focusJobId) {
      return
    }

    const match = jobs.find(job => job.id === focusJobId || jobName(job) === focusJobId)

    if (match) {
      setSelectedJobId(match.id)
      pendingScrollRef.current = match.id
    }

    setCronFocusJobId(null)
  }, [focusJobId, jobs])

  const visibleJobs = useMemo(
    () => jobs.filter(job => matchesQuery(job, query.trim())).sort((a, b) => jobTitle(a).localeCompare(jobTitle(b))),
    [jobs, query]
  )

  // Blueprint recipes render in the same list rail, below the jobs — clicking
  // one opens the create dialog pre-seeded to that recipe. Same query key as
  // the dialog's "Start from" dropdown, so the catalog is fetched once.
  const blueprintsQuery = useQuery({
    queryKey: ['cron-blueprints'],
    queryFn: async () => (await getAutomationBlueprints()).blueprints
  })

  const visibleBlueprints = useMemo(() => {
    const list = blueprintsQuery.data ?? []
    const needle = query.trim().toLowerCase()

    return needle ? list.filter(item => `${item.title} ${item.description}`.toLowerCase().includes(needle)) : list
  }, [blueprintsQuery.data, query])

  // Detail always reflects a concrete job: the explicitly selected one, else the
  // first visible row, so the right pane is never empty while jobs exist.
  const selectedJob = useMemo(
    () => visibleJobs.find(job => job.id === selectedJobId) ?? visibleJobs[0] ?? null,
    [visibleJobs, selectedJobId]
  )

  // Scroll a sidebar-opened job into view once its list row is mounted.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const target = pendingScrollRef.current

    if (!target || selectedJob?.id !== target) {
      return
    }

    pendingScrollRef.current = null
    requestAnimationFrame(() => {
      document.querySelector(`[data-ic-row="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }, [selectedJob])

  const totalCount = jobs.length

  function closeEditor() {
    // An explicit cancel is the user discarding the draft on purpose.
    clearCronEditorDraft()
    setEditor({ mode: 'closed' })
  }

  function beginJobBusy(jobId: string): symbol {
    const token = Symbol(jobId)

    setBusyJobTokens(current => new Map(current).set(jobId, token))

    return token
  }

  function endJobBusy(jobId: string, token: symbol): void {
    setBusyJobTokens(current => {
      if (current.get(jobId) !== token) {
        return current
      }

      const next = new Map(current)

      next.delete(jobId)

      return next
    })
  }

  async function handlePauseResume(job: CronJob) {
    const busyToken = beginJobBusy(job.id)

    try {
      const isPaused = jobState(job) === 'paused'

      const { refreshError, stale } = await mutateAndRefreshCronJobs(profile, () =>
        isPaused ? resumeCronJob(job.id) : pauseCronJob(job.id)
      )

      if (stale) {
        return
      }

      if (refreshError) {
        notifyError(refreshError, c.failedLoad)
      }

      notify({
        kind: 'success',
        title: isPaused ? c.resumed : c.paused,
        message: truncate(jobTitle(job), 60)
      })
    } catch (err) {
      notifyError(err, c.failedUpdate)
    } finally {
      endJobBusy(job.id, busyToken)
    }
  }

  async function handleTrigger(job: CronJob) {
    const viewProfile = profile
    const key = `${viewProfile}:${job.id}`
    const controller = triggerControllerRef.current

    if (!controller) {
      return
    }

    try {
      const run = await controller.run(
        key,
        () => triggerAndRefreshCronJobs(job.id, viewProfile),
        () => notify({ kind: 'info', title: c.triggerNow, message: truncate(jobTitle(job), 60) })
      )

      if (
        triggerControllerRef.current !== controller ||
        cronProfileForScope($profileScope.get()) !== viewProfile ||
        !run.started ||
        !run.value
      ) {
        return
      }

      const { refreshError, stale } = run.value

      if (stale) {
        return
      }

      if (refreshError) {
        notifyError(refreshError, c.failedLoad)
      }

      notify({ kind: 'success', title: c.triggered, message: truncate(jobTitle(job), 60) })
    } catch (err) {
      if (triggerControllerRef.current === controller && cronProfileForScope($profileScope.get()) === viewProfile) {
        notifyError(err, c.failedTrigger)
      }
    }
  }

  // Throws on failure — IcConfirm reports it inline and stays open.
  async function handleConfirmDelete() {
    if (!pendingDelete) {
      return
    }

    const { refreshError, stale } = await mutateAndRefreshCronJobs(profile, () => deleteCronJob(pendingDelete.id))

    if (stale) {
      return
    }

    if (refreshError) {
      notifyError(refreshError, c.failedLoad)
    }

    notify({ kind: 'success', title: c.deleted, message: truncate(jobTitle(pendingDelete), 60) })
  }

  async function handleEditorSave(values: EditorValues) {
    if (editor.mode === 'create') {
      const {
        value: created,
        refreshError,
        stale
      } = await mutateAndRefreshCronJobs(profile, () =>
        createCronJob({
          prompt: values.prompt,
          schedule: values.schedule,
          name: values.name || undefined,
          deliver: values.deliver || DEFAULT_DELIVER,
          ...(values.model.trim() ? { model: values.model.trim(), provider: values.provider.trim() || undefined } : {})
        })
      )

      if (stale || !created) {
        return
      }

      if (refreshError) {
        notifyError(refreshError, c.failedLoad)
      }

      notify({ kind: 'success', title: c.created, message: truncate(jobTitle(created), 60) })
    } else if (editor.mode === 'edit') {
      const scriptOnlyJob = jobIsScriptOnly(editor.job)

      const {
        value: updated,
        refreshError,
        stale
      } = await mutateAndRefreshCronJobs(profile, () =>
        updateCronJob(editor.job.id, cronEditorUpdates(values, { scriptOnlyJob }))
      )

      if (stale || !updated) {
        return
      }

      if (refreshError) {
        notifyError(refreshError, c.failedLoad)
      }

      notify({ kind: 'success', title: c.updated, message: truncate(jobTitle(updated), 60) })
    }

    clearCronEditorDraft()
    setEditor({ mode: 'closed' })
  }

  // Blueprint instantiation is a distinct backend path (fills typed slots, then
  // creates the job) so it can't share the raw-cron onSave contract. Merge the
  // created job into $cronJobs like every other create path. A blueprint writes a
  // real per-profile job, and "all" is not a writable target — collapse it to
  // 'default', matching the manual create path in handleEditorSave.
  async function handleBlueprintCreate(blueprint: AutomationBlueprint, values: Record<string, string>) {
    const writableProfile = profileScope === ALL_PROFILES ? 'default' : profileScope

    const {
      value: job,
      refreshError,
      stale
    } = await mutateAndRefreshCronJobs(profile, () =>
      instantiateAutomationBlueprint({ blueprint: blueprint.key, values }, writableProfile)
    )

    if (stale || !job) {
      return
    }

    if (refreshError) {
      notifyError(refreshError, c.failedLoad)
    }

    notify({ kind: 'success', title: c.blueprints.scheduled, message: asText(job.schedule_display) || blueprint.title })
    clearCronEditorDraft()
    setEditor({ mode: 'closed' })
  }

  const emptyPage = totalCount === 0 && visibleBlueprints.length === 0

  return (
    <PageFrame
      closeLabel={c.close}
      hint={c.count(totalCount)}
      onClose={onClose}
      title={c.title}
      tools={
        <>
          <IcSearchInput onChange={setQuery} placeholder={c.search} value={query} width="196px" />
          <IcAction onClick={() => setEditor({ mode: 'create' })} tone="accent">
            {c.newCron}
          </IcAction>
        </>
      }
    >
      {loading && jobs.length === 0 ? (
        <IcSkeleton label={c.loading} rows={7} />
      ) : emptyPage ? (
        <IcEmpty
          action={
            <IcAction onClick={() => setEditor({ mode: 'create' })} tone="accent">
              {c.newCron}
            </IcAction>
          }
          description={c.emptyDescNew}
          icon={Clock}
          title={c.emptyTitleNew}
        />
      ) : (
        <div className="cron-split">
          <div className="cron-list">
            <IcScroll>
              <IcRows>
                {visibleJobs.map(job => (
                  <IcRow
                    actions={
                      <>
                        <IcIconAction label={c.edit} onClick={() => setEditor({ job, mode: 'edit' })}>
                          <Pencil size={13} />
                        </IcIconAction>
                        <IcIconAction label={t.common.delete} onClick={() => setPendingDelete(job)} tone="danger">
                          <Trash2 size={13} />
                        </IcIconAction>
                      </>
                    }
                    current={selectedJob?.id === job.id}
                    key={job.id}
                    meta={jobScheduleDisplay(job)}
                    onOpen={() => setSelectedJobId(job.id)}
                    rowKey={job.id}
                    status={
                      <IcDot
                        label={c.states[jobState(job)] ?? jobState(job)}
                        tone={STATE_TONE[jobState(job)] ?? 'muted'}
                      />
                    }
                    title={jobTitle(job)}
                  />
                ))}
              </IcRows>

              {visibleJobs.length === 0 ? <IcMeta>{query.trim() ? c.emptyTitleSearch : c.emptyTitleNew}</IcMeta> : null}

              {visibleBlueprints.length > 0 ? (
                <div className="cron-recipes">
                  <IcSectionLabel>{c.blueprints.tab}</IcSectionLabel>
                  <IcRows>
                    {visibleBlueprints.map(item => (
                      <IcRow
                        key={item.key}
                        meta={item.description}
                        onOpen={() => setEditor({ blueprintKey: item.key, mode: 'create' })}
                        status={<Package size={13} />}
                        title={item.title}
                      />
                    ))}
                  </IcRows>
                </div>
              ) : null}
            </IcScroll>
          </div>

          {selectedJob ? (
            <CronJobDetail
              busy={busyJobTokens.has(selectedJob.id) || triggeringJobKeys.has(`${profile}:${selectedJob.id}`)}
              c={c}
              job={selectedJob}
              onOpenSession={onOpenSession}
              onPauseResume={() => void handlePauseResume(selectedJob)}
              onTrigger={() => void handleTrigger(selectedJob)}
            />
          ) : (
            // A search with no selected job gets search-flavoured copy; with no
            // search, "try a broader query" would only confuse.
            <IcEmpty
              description={query.trim() ? c.emptyDescSearch : c.emptyDescNew}
              icon={Clock}
              title={query.trim() ? undefined : c.emptyTitleNew}
            />
          )}
        </div>
      )}

      {editor.mode === 'closed' ? null : (
        <CronEditorDialog
          editor={editor}
          onBlueprintCreate={handleBlueprintCreate}
          onClose={closeEditor}
          onSave={handleEditorSave}
        />
      )}

      {pendingDelete ? (
        <IcConfirm
          busyLabel={c.deleting}
          cancelLabel={t.common.cancel}
          confirmLabel={t.common.delete}
          description={`${c.deleteDescPrefix}${truncate(jobTitle(pendingDelete), 60)}${c.deleteDescSuffix}`}
          onClose={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
          title={c.deleteTitle}
        />
      ) : null}
    </PageFrame>
  )
}
