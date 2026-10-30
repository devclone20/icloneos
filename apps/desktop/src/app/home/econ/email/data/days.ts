/** The email data module's `days` section — its public names are re-exported by ../email-data.ts. */
import { LOCALE, relativeTime } from '../../format'

import type { DayGroup, MailMessage } from './types'

// ── day groups ──────────────────────────────────────────────────────────────

const DAY_FORMAT = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' })
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })

/** Epoch ms of the local midnight that starts `ms`'s day. */
export function startOfDay(ms: number): number {
  const date = new Date(ms)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function startOfYesterday(now: number): number {
  const date = new Date(now)

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime()
}

function dayKey(ms: number): string {
  const date = new Date(ms)

  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function dayLabel(at: number, now = Date.now()): string {
  if (at <= 0) {
    return 'Undated'
  }

  if (at >= startOfDay(now)) {
    return 'Today'
  }

  if (at >= startOfYesterday(now)) {
    return 'Yesterday'
  }

  return new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY_FORMAT.format(at) : DAY_YEAR_FORMAT.format(at)
}

const CLOCK_FORMAT = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' })
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' })

/** Today's and yesterday's mail read as an age ("3 min ago"), so its label
 *  moves with the clock; anything older has a fixed one. */
export function isRecent(at: number, now: number): boolean {
  return at > 0 && at >= startOfYesterday(now)
}

/** A row's time: the age for today and yesterday, else the clock under a day
 *  heading, or the date in an ungrouped list (search results). */
export function rowTime(at: number, grouped: boolean, now = Date.now()): string {
  if (at <= 0) {
    return '—'
  }

  // A clock-skewed future date reads as "now", never as "in 3 min".
  if (isRecent(at, now)) {
    return relativeTime(Math.min(at, now), now)
  }

  if (grouped) {
    return CLOCK_FORMAT.format(at)
  }

  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? MONTH_DAY_FORMAT.format(at)
    : DAY_YEAR_FORMAT.format(at)
}

/** Buckets by local calendar day, in the order the messages come. */
export function groupByDay(messages: readonly MailMessage[], now = Date.now()): DayGroup[] {
  const groups = new Map<string, DayGroup>()

  for (const message of messages) {
    // A clock-skewed future date reads as today, not as its own group.
    const at = Math.min(message.at, now)
    const key = at > 0 ? dayKey(at) : 'undated'
    const group = groups.get(key) ?? { key, label: dayLabel(at, now), messages: [] }

    group.messages.push(message)
    groups.set(key, group)
  }

  return [...groups.values()]
}
