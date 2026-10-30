import type { AnalyticsResponse, SessionInfo } from '@/hermes'
import { sessionTitle } from '@/lib/chat-runtime'
import { fmtDateTime } from '@/lib/time'

/** The page's own sections, in rail order. */
export const CC_SECTIONS = ['sessions', 'system', 'usage', 'maintenance'] as const
export type CommandCenterSection = (typeof CC_SECTIONS)[number]

export const LOG_FILES = ['agent', 'errors', 'gateway', 'desktop'] as const
export type LogFile = (typeof LOG_FILES)[number]

export const LOG_LEVELS = ['ALL', 'INFO', 'WARNING', 'ERROR'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const USAGE_PERIODS = [7, 30, 90] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

/** Epoch SECONDS (the gateway's unit) → the app's date-time format; '' when
 *  there is no usable instant, so a row never prints "Invalid Date". */
export function formatTimestamp(value?: null | number): string {
  if (!value) {
    return ''
  }

  const date = new Date(value * 1000)

  return Number.isNaN(date.getTime()) ? '' : fmtDateTime.format(date)
}

function sessionInstant(session: SessionInfo): number {
  return session.last_active || session.started_at || 0
}

/** Newest first, then a case-insensitive substring match over title + id. The
 *  needle is already trimmed by the caller's debounce. */
export function filterSessions(sessions: readonly SessionInfo[], needle: string): SessionInfo[] {
  const sorted = [...sessions].sort((a, b) => sessionInstant(b) - sessionInstant(a))
  const query = needle.toLowerCase()

  if (!query) {
    return sorted
  }

  return sorted.filter(session => `${sessionTitle(session)} ${session.id}`.toLowerCase().includes(query))
}

/** Client-side substring filter over the fetched tail (matches `hermes logs --search`). */
export function filterLines(lines: readonly string[], needle: string): string[] {
  const query = needle.trim().toLowerCase()

  return query ? lines.filter(line => line.toLowerCase().includes(query)) : [...lines]
}

interface UsageBar {
  day: string
  inputPct: number
  outputPct: number
  title: string
}

/**
 * Daily token bars as PERCENTAGES of the busiest day, so the chart needs no
 * pixel height at build time and scales with the text size. A day with any
 * traffic keeps a visible sliver (1 %) instead of rounding to nothing.
 */
export function usageBars(
  daily: AnalyticsResponse['daily'] | undefined,
  compact: (value: number) => string
): UsageBar[] {
  const rows = daily ?? []
  const peak = rows.reduce((max, entry) => Math.max(max, (entry.input_tokens || 0) + (entry.output_tokens || 0)), 0)

  const scale = (value: number) => {
    if (value <= 0 || peak <= 0) {
      return 0
    }

    return Math.max(1, Math.round((value / peak) * 100))
  }

  return rows.map(entry => ({
    day: entry.day,
    inputPct: scale(entry.input_tokens || 0),
    outputPct: scale(entry.output_tokens || 0),
    title: `${entry.day} · in ${compact(entry.input_tokens)} · out ${compact(entry.output_tokens)}`
  }))
}

/** How a finished gateway action reads: running → done → failed. */
export function actionOutcome(running: boolean, exitCode: null | number | undefined): 'done' | 'failed' | 'running' {
  if (running) {
    return 'running'
  }

  return exitCode === 0 ? 'done' : 'failed'
}
