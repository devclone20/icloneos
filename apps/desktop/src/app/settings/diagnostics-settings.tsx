import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ChevronRight, Loader2, Lock, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { requestSendDiagnostics } from '@/store/send-diagnostics'

import {
  ageLabel,
  type DoctorCatalogue,
  type DoctorCheckRow,
  type DoctorFixResult,
  type DoctorProgress,
  type DoctorReport,
  type DoctorStatus,
  formatRunDuration,
  packRows
} from './diagnostics-settings-model'
import { type DiagnosticsCheckCopy, useDiagnosticsCheckCopy } from './machine/diagnostics-checks-copy'
import { type DiagnosticsCopy, useDiagnosticsCopy } from './machine/diagnostics-copy'
import { SettingsContent } from './primitives'
import { SettingRow } from './setting-row'
import type { SettingsView } from './types'

const DOT: Record<DoctorStatus, string> = {
  pass: 'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-destructive',
  skip: 'border border-muted-foreground/50'
}

function StatusDot({ status }: { status: DoctorStatus }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[status])} />
}

interface FixState {
  fixId: string
  result: DoctorFixResult | null
  busy: boolean
}

function CheckLine({
  check,
  d,
  fix,
  onFix,
  w
}: {
  check: DoctorCheckRow
  d: DiagnosticsCopy
  w: DiagnosticsCheckCopy
  fix: FixState | null
  onFix(fixId: string, dryRun: boolean): void
}) {
  const failing = check.status === 'fail' || check.status === 'warn'
  const result = fix?.fixId === check.fixId ? fix?.result : null

  return (
    <li data-check={check.id}>
      <SettingRow
        below={
          result && (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs" role="status">
              {result.needsConsent ? (
                <p>{w.needsConsent}</p>
              ) : result.error ? (
                <p className="text-destructive">{w.fixFailed}</p>
              ) : result.dryRun ? (
                <>
                  <p className="font-medium">{d.previewTitle}</p>
                  <p className="mt-1 text-muted-foreground">
                    {result.plan.length ? w.planCount(result.plan.length) : d.previewEmpty}
                  </p>
                </>
              ) : (
                <>
                  <p>{d.applied(result.backupDir)}</p>
                  {result.backupDir && <p className="mt-1 text-muted-foreground">{d.undoHint}</p>}
                </>
              )}
            </div>
          )
        }
        control={
          failing &&
          check.fixId && (
            <div className="flex items-center gap-2">
              <Button disabled={fix?.busy} onClick={() => onFix(check.fixId!, true)} size="sm" variant="text">
                {d.preview}
              </Button>
              <Button data-fix={check.fixId} disabled={fix?.busy} onClick={() => onFix(check.fixId!, false)} size="sm">
                {check.risk === 'high' && <Lock aria-label={d.needsYou} className="size-3" />}
                {w.fixes[check.fixId] ?? w.fixFallback}
              </Button>
            </div>
          )
        }
        hint={w.status[check.status]}
        title={
          <span className="inline-flex items-baseline gap-2">
            <StatusDot status={check.status} />
            {w.checks[check.id] ?? d.packTitles[check.id.split('.')[0]] ?? d.packFallback}
          </span>
        }
      />
    </li>
  )
}

export function DiagnosticsSettings({ navigate }: { navigate?: (view: SettingsView) => void }) {
  // Read once: the context bridge hands out a fresh proxy per property read, which would re-fire every effect.
  const d = useDiagnosticsCopy()
  const w = useDiagnosticsCheckCopy()
  const [bridge] = useState(() => window.hermesDesktop?.icloneDoctor)
  const [catalogue, setCatalogue] = useState<DoctorCatalogue | null>(null)
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<DoctorProgress | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [live, setLive] = useState(false)
  const [fix, setFix] = useState<FixState | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    void bridge.list().then(setCatalogue)
    void bridge.report().then(setReport)

    return bridge.onProgress(setProgress)
  }, [bridge])

  const runAll = useCallback(async () => {
    if (!bridge) {
      return
    }

    setRunning(true)
    setProgress(null)
    setFix(null)

    try {
      const next = await bridge.run({ live })

      if (next) {
        setReport(next)
        setOpen(new Set(next.packs.filter(p => p.status === 'fail' || p.status === 'warn').map(p => p.id)))
      }
    } finally {
      setRunning(false)
    }
  }, [bridge, live])

  const onFix = useCallback(
    async (fixId: string, dryRun: boolean) => {
      if (!bridge) {
        return
      }

      setFix({ fixId, result: null, busy: true })
      const result = await bridge.fix({ fixId, dryRun })
      setFix({ fixId, result, busy: false })

      if (result && !dryRun && result.ok) {
        const next = await bridge.report()
        const fresh = await bridge.run({ live: false })

        setReport(fresh ?? next)
      }
    },
    [bridge]
  )

  if (!bridge) {
    return (
      <SettingsContent>
        <p className="mx-auto mt-6 max-w-2xl text-sm text-muted-foreground">{d.unavailable}</p>
      </SettingsContent>
    )
  }

  const rows = packRows(catalogue, report)
  const age = report ? ageLabel(report.startedAt, Date.now(), d) : ''
  const clear = report && report.counts.fail === 0 && report.counts.warn === 0
  const packTitle = progress ? (d.packTitles[progress.packId] ?? d.packFallback) : ''

  return (
    <SettingsContent>
      <div data-diagnostics-state={running ? 'running' : !report ? 'idle' : clear ? 'pass' : 'fail'}>
        <SettingRow
          control={
            <Button data-run-all disabled={running} onClick={() => void runAll()} size="sm" variant="textStrong">
              {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {running ? d.running : d.runAll}
            </Button>
          }
          hint={
            <>
              {d.intro}{' '}
              <span className="font-mono" data-progress>
                {running
                  ? progress
                    ? d.progress(packTitle, progress.done, progress.total)
                    : d.running
                  : report
                    ? clear
                      ? d.allClear(age)
                      : `${d.summary(report.counts.fail, report.counts.warn)} · ${d.lastRun(age, formatRunDuration(report.durationMs))}`
                    : d.notRun}
              </span>
            </>
          }
          title={d.runTitle}
        />

        <ul>
          {rows.map(pack => {
            const expanded = open.has(pack.id)

            return (
              <li data-pack={pack.id} key={pack.id}>
                <SettingRow
                  below={
                    expanded && (
                      <ul className="border-l border-border/60 pl-3">
                        {pack.checks.map(check => (
                          <CheckLine
                            check={check}
                            d={d}
                            fix={fix}
                            key={check.id}
                            onFix={(id, dry) => void onFix(id, dry)}
                            w={w}
                          />
                        ))}
                      </ul>
                    )
                  }
                  control={
                    pack.checks.length > 0 && (
                      <Button
                        aria-expanded={expanded}
                        onClick={() =>
                          setOpen(prev => {
                            const next = new Set(prev)

                            if (next.has(pack.id)) {
                              next.delete(pack.id)
                            } else {
                              next.add(pack.id)
                            }

                            return next
                          })
                        }
                        size="sm"
                        variant="text"
                      >
                        {expanded ? d.hide : d.show}
                        <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
                      </Button>
                    )
                  }
                  hint={report ? d.packHint(d.state[pack.status], pack.checks.length) : undefined}
                  title={
                    <span className="inline-flex items-baseline gap-2">
                      <StatusDot status={report ? pack.status : 'skip'} />
                      {d.packTitles[pack.id] ?? d.packFallback}
                    </span>
                  }
                />
              </li>
            )
          })}
        </ul>

        {fix?.result?.needsConsent && navigate && (
          <SettingRow
            control={
              <Button onClick={() => navigate('privacy')} size="sm" variant="textStrong">
                {d.openPrivacy}
              </Button>
            }
            hint={d.permissionHint}
            title={d.permissionTitle}
          />
        )}

        <SettingRow
          control={<Switch aria-label={d.live} checked={live} onCheckedChange={setLive} />}
          hint={d.liveHint}
          title={d.live}
        />
        <SettingRow
          control={
            <Button
              disabled={!report}
              onClick={() => {
                if (report) {
                  void navigator.clipboard?.writeText(report.lines.join('\n')).then(() => setCopied(true))
                }
              }}
              size="sm"
              variant="textStrong"
            >
              {copied ? d.copied : d.copyReport}
            </Button>
          }
          hint={d.copyHint}
          title={d.copyTitle}
        />
        <SettingRow
          control={
            <Button onClick={() => requestSendDiagnostics()} size="sm" variant="textStrong">
              {d.sendDiagnostics}
            </Button>
          }
          hint={d.sendHint}
          title={d.sendTitle}
        />
        <SettingRow
          control={
            <Button onClick={() => void bridge.openLogs()} size="sm" variant="text">
              {d.openLogs}
            </Button>
          }
          hint={d.logsHint}
          title={d.logsTitle}
        />
      </div>
    </SettingsContent>
  )
}
