/** Shared atoms of the App Atualisation pane: formatting, tone, status cards. */

import type { ReactNode } from 'react'

import { formatBytes } from '@/iclone-shared/format'
import { type AgoLabels, formatAgo, toEpochMs } from '@/iclone-shared/time'
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { SettingRow } from '../setting-row'

const DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

export const MINUTE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
  year: 'numeric'
})

export function formatDate(iso: null | string | undefined, format = DAY): string {
  const at = Date.parse(iso ?? '')

  return Number.isFinite(at) ? format.format(at) : 'an unknown date'
}

export const count = (value: number) => value.toLocaleString('en-US')

export function formatDownloadSize(bytes: number): string {
  return formatBytes(Math.max(bytes, 1e6), { base: 1000, fractionDigits: { GB: 1 }, maxUnit: 'GB', minUnit: 'MB' })
}

const AGO_LABELS: AgoLabels = {
  days: days => `${days} d ago`,
  hours: hours => `${hours} h ago`,
  minutes: minutes => `${minutes} min ago`,
  now: 'just now'
}

export function timeAgo(at: null | number | string | undefined, now: number): string {
  const ms = toEpochMs(at)

  return ms === null ? 'never' : formatAgo(ms, AGO_LABELS, { nowMs: now, rounding: 'round' })
}

export function shortSha(sha: null | string | undefined): string {
  return sha ? sha.slice(0, 10) : 'unknown'
}

// ── shared visuals ─────────────────────────────────────────────────────────

// 'unknown' is its own tone: an unverified state must never borrow the success mark that 'idle' carries.
type Tone = 'available' | 'error' | 'idle' | 'unknown' | 'warn'

const TONE_CLASS: Record<Tone, string> = {
  available: 'border-primary/30 bg-primary/5',
  error: 'border-destructive/35 bg-destructive/5',
  idle: 'border-border/70 bg-muted/20',
  unknown: 'border-dashed border-border bg-transparent',
  warn: 'border-amber-500/40 bg-amber-500/10'
}

function ToneIcon({ busy, tone }: { busy: boolean; tone: Tone }) {
  if (busy) {
    return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
  }

  if (tone === 'idle') {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  }

  if (tone === 'unknown') {
    return <HelpCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  }

  if (tone === 'available') {
    return <RefreshCw className="mt-0.5 size-4 shrink-0 text-primary" />
  }

  return (
    <AlertTriangle
      className={cn(
        'mt-0.5 size-4 shrink-0',
        tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
      )}
    />
  )
}

export function StatusCard({
  actions,
  busy = false,
  children,
  detail,
  title,
  tone
}: {
  actions?: ReactNode
  busy?: boolean
  children?: ReactNode
  detail?: ReactNode
  title: ReactNode
  tone: Tone
}) {
  return (
    <div
      className={cn('rounded-xl border px-4 py-1 text-sm transition-colors duration-200', TONE_CLASS[tone])}
      data-tone={tone}
    >
      <SettingRow
        below={children}
        control={actions && <div className="flex flex-wrap items-center gap-4">{actions}</div>}
        hint={detail}
        title={
          <span className="flex items-start gap-2">
            <ToneIcon busy={busy} tone={tone} />
            <span className="min-w-0">{title}</span>
          </span>
        }
        wide
      />
    </div>
  )
}

export function Aside({ children }: { children: ReactNode }) {
  return <span className="text-xs font-normal text-muted-foreground tabular-nums">{children}</span>
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-foreground/80">{children}</code>
}

export interface RuntimeSummary {
  detail: string
  title: string
  tone: Tone
}
