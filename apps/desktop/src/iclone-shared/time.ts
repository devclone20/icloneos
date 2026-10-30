/**
 * iCLONE OS — timestamp parsing and coarse "time ago" bucketing shared by the
 * electron main process and the renderer. Labels come from the caller, so the
 * copy (and its language) stays where it is owned.
 */

export const SECOND_MS = 1000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export type ElapsedUnit = 'day' | 'hour' | 'minute' | 'second'

/** 'floor' (default): 90 s is "1 minute". 'round': 90 s is "2 minutes". */
export type ElapsedRounding = 'floor' | 'round'

/** The largest whole unit of a duration; negative durations read as 0 seconds. */
export function elapsedBucket(
  deltaMs: number,
  rounding: ElapsedRounding = 'floor'
): { unit: ElapsedUnit; value: number } {
  const ms = Math.max(0, deltaMs)
  const whole = rounding === 'round' ? Math.round : Math.floor

  if (ms >= DAY_MS) {
    return { unit: 'day', value: whole(ms / DAY_MS) }
  }

  if (ms >= HOUR_MS) {
    return { unit: 'hour', value: whole(ms / HOUR_MS) }
  }

  if (ms >= MINUTE_MS) {
    return { unit: 'minute', value: whole(ms / MINUTE_MS) }
  }

  return { unit: 'second', value: whole(ms / SECOND_MS) }
}

export interface AgoLabels {
  /** Under a minute (or under 2 s when `seconds` is given). */
  now: string
  /** Without it, every age under a minute reads as `now`. */
  seconds?: ((seconds: number) => string) | undefined
  minutes: (minutes: number) => string
  hours: (hours: number) => string
  days: (days: number) => string
}

export interface FormatAgoOptions {
  nowMs?: number | undefined
  rounding?: ElapsedRounding | undefined
}

/** "now" / "5 min ago" / "3 h ago"… for a past timestamp; future timestamps read as now. */
export function formatAgo(fromMs: number, labels: AgoLabels, options: FormatAgoOptions = {}): string {
  const { unit, value } = elapsedBucket((options.nowMs ?? Date.now()) - fromMs, options.rounding)

  if (unit === 'second') {
    return labels.seconds && value >= 2 ? labels.seconds(value) : labels.now
  }

  const byUnit = { day: labels.days, hour: labels.hours, minute: labels.minutes }

  return byUnit[unit](value)
}

/** Epoch milliseconds from a number or a `Date.parse`-able string; null for anything unusable. */
export function toEpochMs(value: unknown): number | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN

  return Number.isFinite(ms) ? ms : null
}
