import { useCallback, useEffect, useState } from 'react'

import {
  type ActionResponse,
  type CuratorStatusResponse,
  getActionStatus,
  getCuratorStatus,
  getMemoryStatus,
  type MemoryStatusResponse,
  resetMemory,
  runBackup,
  runCurator,
  runDoctor,
  runSecurityAudit,
  setCuratorPaused
} from '@/hermes'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { formatBytes } from '@/iclone-shared/format'
import { upsertDesktopActionTask } from '@/store/activity'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'
import { requestSendDiagnostics } from '@/store/send-diagnostics'
import type { ActionStatusResponse } from '@/types/hermes'

import { IcAction } from './ui/controls'
import { IcNote, IcPill, IcSkeleton, type IcTone } from './ui/feedback'
import { IcHint } from './ui/field'
import { IcSectionLabel, IcStack } from './ui/layout'
import { IcMonoLines } from './ui/mono'
import { IcRow, IcRows } from './ui/rows'

const ACTION_POLL_MS = 1200
const ACTION_POLL_LIMIT = 240 // ~5 minutes of polling before giving up.

/** Maintenance panel — desktop parity for `hermes doctor` / `security audit` /
 *  `backup` / a local diagnostics report / `curator` / `memory` (the dashboard System page's
 *  ops section). Spawn-based actions tail their logs inline via the shared
 *  /api/actions status endpoint. */
export function MaintenancePanel() {
  const { t } = useI18n()
  const mm = t.commandCenter.maintenance

  const [actionName, setActionName] = useState<null | string>(null)
  const [actionStatus, setActionStatus] = useState<ActionStatusResponse | null>(null)
  const [curator, setCurator] = useState<CuratorStatusResponse | null>(null)
  const [curatorBusy, setCuratorBusy] = useState(false)
  const [memory, setMemory] = useState<MemoryStatusResponse | null>(null)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    getCuratorStatus()
      .then(next => !cancelled && setCurator(next))
      .catch(() => {})
    getMemoryStatus()
      .then(next => !cancelled && setMemory(next))
      .catch(() => {})

    return () => void (cancelled = true)
  }, [])

  // Tail the most recently launched spawn action.
  useEffect(() => {
    if (!actionName) {
      return
    }

    let cancelled = false
    let polls = 0
    let timer: null | number = null

    const poll = async () => {
      try {
        const status = await getActionStatus(actionName, 200)

        if (cancelled) {
          return
        }

        setActionStatus(status)
        upsertDesktopActionTask(status)
        polls += 1

        if (status.running && polls < ACTION_POLL_LIMIT) {
          timer = window.setTimeout(() => void poll(), ACTION_POLL_MS)
        }
      } catch {
        // Status endpoint hiccup — stop tailing; the activity rail still has the task.
      }
    }

    void poll()

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [actionName])

  const launch = useCallback(
    async (label: string, start: () => Promise<ActionResponse>) => {
      setError('')

      try {
        const started = await start()
        setActionStatus(null)
        setActionName(started.name)
        notify({ kind: 'success', title: mm.actionStarted(label), message: '' })
      } catch (err) {
        setError(errorMessage(err))
        notifyError(err, mm.actionFailed(label))
      }
    },
    [mm]
  )

  const toggleCurator = useCallback(async () => {
    if (!curator) {
      return
    }

    setCuratorBusy(true)

    try {
      const next = !curator.paused
      await setCuratorPaused(next)
      setCurator({ ...curator, paused: next })
    } catch (err) {
      notifyError(err, mm.actionFailed(mm.curator))
    } finally {
      setCuratorBusy(false)
    }
  }, [curator, mm])

  const doResetMemory = useCallback(
    async (target: 'all' | 'memory' | 'user', label: string) => {
      if (!(await confirm({ destructive: true, title: mm.resetConfirm(label) }))) {
        return
      }

      setMemoryBusy(true)

      try {
        const result = await resetMemory(target)
        notify({ kind: 'success', title: mm.resetDone(result.deleted.join(', ') || label), message: '' })
        setMemory(await getMemoryStatus())
      } catch (err) {
        notifyError(err, mm.resetFailed)
      } finally {
        setMemoryBusy(false)
      }
    },
    [mm]
  )

  return (
    <IcStack>
      {error ? <IcNote tone="danger">{error}</IcNote> : null}

      <section>
        <IcSectionLabel>{mm.runOps}</IcSectionLabel>
        <IcRows>
          <OpRow
            description={mm.doctorDesc}
            disabled={actionStatus?.running === true}
            label={mm.doctor}
            onRun={() => void launch(mm.doctor, runDoctor)}
          />
          <OpRow
            description={mm.securityAuditDesc}
            disabled={actionStatus?.running === true}
            label={mm.securityAudit}
            onRun={() => void launch(mm.securityAudit, runSecurityAudit)}
          />
          <OpRow
            description={mm.backupDesc}
            disabled={actionStatus?.running === true}
            label={mm.backup}
            onRun={() => void launch(mm.backup, runBackup)}
          />
          {/* FX-7: a diagnostics report saved to a file the owner chooses; nothing is uploaded. */}
          <OpRow
            description={mm.diagnosticsReportDesc}
            label={mm.diagnosticsReport}
            onRun={() => requestSendDiagnostics()}
          />
        </IcRows>

        {actionStatus ? (
          <div className="cc-maint__block">
            <IcSectionLabel>
              {mm.viewLog}
              {actionStatus.running ? ` · ${mm.running}` : ''}
            </IcSectionLabel>
            <IcMonoLines emptyLabel={mm.viewLog} lines={actionStatus.lines} />
          </div>
        ) : null}
      </section>

      <section>
        <IcSectionLabel>{mm.curator}</IcSectionLabel>
        {!curator ? (
          <IcSkeleton label={mm.curator} rows={1} />
        ) : (
          <IcRows>
            <IcRow
              actions={
                <>
                  {curator.enabled ? (
                    <IcAction disabled={curatorBusy} onClick={() => void toggleCurator()}>
                      {curator.paused ? mm.resume : mm.pause}
                    </IcAction>
                  ) : null}
                  <IcAction
                    disabled={actionStatus?.running === true}
                    onClick={() => void launch(mm.curator, runCurator)}
                    tone="accent"
                  >
                    {mm.runNow}
                  </IcAction>
                </>
              }
              meta={`${mm.curatorDesc} · ${curator.last_run_at ? mm.curatorLastRun(curator.last_run_at) : mm.curatorNeverRan}`}
              status={<IcPill tone={curatorTone(curator)}>{curatorStateLabel(curator, mm)}</IcPill>}
              title={mm.curator}
            />
          </IcRows>
        )}
      </section>

      <section>
        <IcSectionLabel>{mm.memoryData}</IcSectionLabel>
        {!memory ? (
          <IcSkeleton label={mm.memoryData} rows={2} />
        ) : (
          <>
            <IcHint>
              {mm.memoryDataDesc} · {mm.memoryProvider(memory.active || mm.builtinMemory)}
            </IcHint>
            <IcRows>
              <MemoryFileRow
                busy={memoryBusy}
                label={mm.memoryFile}
                onReset={() => void doResetMemory('memory', mm.memoryFile)}
                resetLabel={mm.resetMemory}
                size={memory.builtin_files.memory}
                sizeLabel={memorySizeLabel(memory.builtin_files.memory, mm.empty)}
              />
              <MemoryFileRow
                busy={memoryBusy}
                label={mm.userFile}
                onReset={() => void doResetMemory('user', mm.userFile)}
                resetLabel={mm.resetUser}
                size={memory.builtin_files.user}
                sizeLabel={memorySizeLabel(memory.builtin_files.user, mm.empty)}
              />
            </IcRows>
          </>
        )}
      </section>
    </IcStack>
  )
}

type Maintenance = ReturnType<typeof useI18n>['t']['commandCenter']['maintenance']

/** Disabled / paused / running, in our own tone scale. */
function curatorTone(curator: CuratorStatusResponse): IcTone {
  return !curator.enabled ? 'muted' : curator.paused ? 'warn' : 'live'
}

function curatorStateLabel(curator: CuratorStatusResponse, mm: Maintenance): string {
  return !curator.enabled ? mm.curatorDisabled : curator.paused ? mm.curatorPaused : mm.curatorActive
}

function memorySizeLabel(bytes: number, emptyLabel: string): string {
  return bytes > 0 ? formatBytes(bytes, { fractionDigits: 1, maxUnit: 'MB' }) : emptyLabel
}

function OpRow({
  description,
  disabled,
  label,
  onRun
}: {
  description: string
  disabled?: boolean
  label: string
  onRun: () => void
}) {
  return (
    <IcRow
      actions={
        <IcAction disabled={disabled} onClick={onRun} tone="accent">
          {label}
        </IcAction>
      }
      meta={description}
      title={label}
    />
  )
}

function MemoryFileRow({
  busy,
  label,
  onReset,
  resetLabel,
  size,
  sizeLabel
}: {
  busy: boolean
  label: string
  onReset: () => void
  resetLabel: string
  size: number
  sizeLabel: string
}) {
  return (
    <IcRow
      actions={
        <IcAction disabled={busy || size <= 0} onClick={onReset} tone="danger">
          {resetLabel}
        </IcAction>
      }
      meta={sizeLabel}
      title={label}
    />
  )
}
