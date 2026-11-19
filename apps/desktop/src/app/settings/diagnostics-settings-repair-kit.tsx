import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { f3Kit } from '@/i18n/en/v009-f3'
import { Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type {
  RepairClassId,
  RepairFinding,
  RepairHistoryEntry,
  RepairKitBridge,
  RepairReport,
  RepairStep,
  UndoReport
} from '../../../electron/repair-kit/types'

import { SettingRow } from './setting-row'

/**
 * v0.0.9 F3 — Settings › Diagnostics › Repair kit: the known causes of an agent that will not start, each with a
 * Preview (dry run, nothing touched), a Repair (the owner's own click: `data-repair-kit-confirm`) and, for every past
 * repair, an Undo that replays its dated manifest backwards. Reachable while the agent is stopped (point B).
 */

/** The bridge (preload, requested from F1-S as `window.hermesDesktop.icloneRepairKit`); absent on an older preload. */
export function repairKitBridge(): RepairKitBridge | undefined {
  return (window.hermesDesktop as unknown as { icloneRepairKit?: RepairKitBridge } | undefined)?.icloneRepairKit
}

const TONE: Record<RepairFinding['status'], string> = {
  found: 'bg-(--ic-danger)',
  manual: 'bg-(--ic-warning)',
  ok: 'bg-(--ic-success)',
  skipped: 'border border-(--ic-text-3)'
}

function describeStep(step: RepairStep): string {
  switch (step.kind) {
    case 'move-aside':
      return `Move ${step.from} → ${step.to}`

    case 'chmod':
      return `${step.path}: ${step.fromMode.toString(8)} → ${step.toMode.toString(8)}`

    case 'edit-config':
      return `${step.file}: remove ${step.remove.join(', ')} from plugins.disabled`

    case 'reap-orphans':
      return `Stop the app's own leftover processes ${step.pids.join(', ')}`

    case 'reinstall-runtime':
      return 'Reinstall the agent runtime at the next start'
  }
}

function reportText(report: RepairReport): string {
  if (report.refused === 'gesture') {
    return f3Kit.refusedGesture
  }

  if (report.refused === 'busy') {
    return f3Kit.refusedBusy
  }

  if (report.error) {
    return f3Kit.failed(report.error)
  }

  if (report.dryRun) {
    return report.steps.length ? f3Kit.planned(report.steps.length) : f3Kit.nothingToDo
  }

  if (report.applied.length === 0) {
    return f3Kit.nothingToDo
  }

  return report.verify === 'next-start' ? f3Kit.repairedNextStart : f3Kit.repaired(report.manifestDir ?? '')
}

function undoText(report: UndoReport): string {
  if (report.refused === 'gesture') {
    return f3Kit.refusedGesture
  }

  if (report.refused === 'busy') {
    return f3Kit.refusedBusy
  }

  const parts = [f3Kit.undoDone(report.restored.length)]

  if (report.skipped.length) {
    parts.push(f3Kit.undoSkipped(report.skipped.length))
  }

  return parts.join(' ')
}

export function RepairKitSection() {
  // Read once: the context bridge hands out a fresh proxy per property read.
  const [bridge] = useState(repairKitBridge)
  const [findings, setFindings] = useState<RepairFinding[] | null>(null)
  const [history, setHistory] = useState<RepairHistoryEntry[]>([])
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<null | string>(null)
  const [reports, setReports] = useState<Partial<Record<RepairClassId, RepairReport>>>({})
  const [undone, setUndone] = useState<Record<string, UndoReport>>({})
  const [changed, setChanged] = useState(false)

  const refreshHistory = useCallback(async () => {
    setHistory((await bridge?.history()) ?? [])
  }, [bridge])

  const check = useCallback(async () => {
    if (!bridge) {
      return
    }

    setChecking(true)

    try {
      setFindings(await bridge.scan())
      await refreshHistory()
    } finally {
      setChecking(false)
    }
  }, [bridge, refreshHistory])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const run = async (classId: RepairClassId, dryRun: boolean) => {
    if (!bridge) {
      return
    }

    setBusy(classId)

    try {
      const report = await bridge.apply({ classId, dryRun })

      if (report) {
        setReports(prev => ({ ...prev, [classId]: report }))
        setChanged(prev => prev || (!dryRun && report.applied.length > 0))
      }

      if (!dryRun) {
        setFindings((await bridge.scan()) ?? null)
        await refreshHistory()
      }
    } finally {
      setBusy(null)
    }
  }

  const undo = async (id: string) => {
    if (!bridge) {
      return
    }

    setBusy(id)

    try {
      const report = await bridge.undo(id)

      if (report) {
        setUndone(prev => ({ ...prev, [id]: report }))
        setChanged(prev => prev || report.restored.length > 0)
      }

      await refreshHistory()
    } finally {
      setBusy(null)
    }
  }

  // After a repair the latch is cleared in main; the agent starts again (through the gate) on a fresh boot.
  const restart = async () => {
    await window.hermesDesktop?.resetBootstrap().catch(() => undefined)
    window.location.reload()
  }

  if (!bridge) {
    return <SettingRow hint={f3Kit.unavailable} title={f3Kit.title} />
  }

  const problems = findings?.filter(f => f.status === 'found' || f.status === 'manual') ?? []

  return (
    <div data-repair-kit={checking ? 'checking' : findings ? (problems.length ? 'found' : 'clear') : 'idle'}>
      <SettingRow
        control={
          <div className="flex items-center gap-2">
            {changed && (
              <Button onClick={() => void restart()} size="sm" variant="textStrong">
                {f3Kit.restart}
              </Button>
            )}
            <Button data-repair-kit-check disabled={checking} onClick={() => void check()} size="sm" variant="textStrong">
              {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {checking ? f3Kit.checking : f3Kit.check}
            </Button>
          </div>
        }
        hint={
          <>
            {f3Kit.intro}{' '}
            <span className="font-mono">{findings ? (problems.length ? '' : f3Kit.allClear) : f3Kit.notChecked}</span>
          </>
        }
        title={f3Kit.title}
      />

      {findings && (
        <ul className="border-l border-border/60 pl-3">
          {findings
            .filter(f => f.status !== 'skipped')
            .map(finding => {
              const report = reports[finding.classId]

              return (
                <li data-repair-class={finding.classId} key={finding.classId}>
                  <SettingRow
                    below={
                      (finding.facts.length > 0 && finding.status !== 'ok') || report ? (
                        <div className="grid gap-1 text-xs" role="status">
                          {finding.status !== 'ok' &&
                            finding.facts.map(fact => (
                              <p className="font-mono text-muted-foreground [overflow-wrap:anywhere]" key={fact}>
                                {fact}
                              </p>
                            ))}
                          {report && (
                            <>
                              <p className={cn(report.ok ? 'text-muted-foreground' : 'text-destructive')}>
                                {reportText(report)}
                              </p>
                              {report.dryRun &&
                                report.steps.map(step => (
                                  <p className="font-mono [overflow-wrap:anywhere]" key={describeStep(step)}>
                                    {describeStep(step)}
                                  </p>
                                ))}
                            </>
                          )}
                        </div>
                      ) : undefined
                    }
                    control={
                      finding.status === 'found' && (
                        <div className="flex items-center gap-2">
                          <Button
                            disabled={busy !== null}
                            onClick={() => void run(finding.classId, true)}
                            size="sm"
                            variant="text"
                          >
                            {f3Kit.preview}
                          </Button>
                          <Button
                            data-repair-kit-confirm=""
                            disabled={busy !== null}
                            onClick={() => void run(finding.classId, false)}
                            size="sm"
                          >
                            {busy === finding.classId && <Loader2 className="size-3 animate-spin" />}
                            {f3Kit.repair}
                          </Button>
                        </div>
                      )
                    }
                    hint={f3Kit.status[finding.status]}
                    title={
                      <span className="inline-flex items-baseline gap-2">
                        <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE[finding.status])} />
                        {f3Kit.classes[finding.classId]}
                      </span>
                    }
                  />
                </li>
              )
            })}
        </ul>
      )}

      <SettingRow
        below={
          history.length > 0 ? (
            <ul className="grid gap-1 text-xs">
              {history.map(entry => (
                <li className="flex items-center justify-between gap-3" data-repair-history={entry.id} key={entry.id}>
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-muted-foreground">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>{' '}
                    {f3Kit.classes[entry.classId]}
                    {undone[entry.id] ? ` — ${undoText(undone[entry.id])}` : entry.undoneAt ? ` — ${f3Kit.undone}` : ''}
                  </span>
                  {entry.undoable && (
                    <Button
                      data-repair-kit-confirm=""
                      disabled={busy !== null}
                      onClick={() => void undo(entry.id)}
                      size="sm"
                      variant="text"
                    >
                      {busy === entry.id && <Loader2 className="size-3 animate-spin" />}
                      {f3Kit.undo}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : undefined
        }
        hint={history.length ? undefined : f3Kit.historyEmpty}
        title={f3Kit.history}
      />
    </div>
  )
}
