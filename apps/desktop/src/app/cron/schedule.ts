/**
 * Cron SCHEDULE + JOB-FIELD logic, lifted out of the page unchanged: cron
 * expression <-> preset mapping, the human summary of a schedule, the job-field
 * readers (a backend job is loosely typed, so every read goes through `asText`)
 * and the list filter. Pure — no React, no DOM — so the page can be rewritten
 * without touching the rules a user's saved job depends on.
 */

import type { CronJob } from '@/hermes'
import type { Translations } from '@/i18n'
import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'
import { asText } from '@/lib/text'
import { ALL_PROFILES } from '@/store/profile'

import type { IcTone } from '../command-center/ui/feedback'

import { jobTitle } from './job-state'

export const DEFAULT_DELIVER = 'local'

// Radix <SelectItem> rejects empty-string values, so the "no override" row in
// the model picker carries this sentinel and is mapped back to '' on save.
export const MODEL_DEFAULT_VALUE = '__default__'

// "Start from" default: the manual editor (blank cron). Any other value is a
// blueprint key. Blueprint keys never collide with this sentinel.
export const CUSTOM_TEMPLATE = 'custom'

export function cronProfileForScope(scope: string): string {
  return scope === ALL_PROFILES ? 'all' : scope
}

export const SCHEDULE_OPTIONS: ReadonlyArray<ScheduleOption> = [
  { expr: '0 9 * * *', value: 'daily' },
  { expr: '0 9 * * 1-5', value: 'weekdays' },
  { expr: '0 9 * * 1', value: 'weekly' },
  { expr: '0 9 1 * *', value: 'monthly' },
  { expr: '0 * * * *', value: 'hourly' },
  { expr: '*/15 * * * *', value: 'every-15-minutes' },
  { value: 'custom' }
]

export const STATE_TONE: Record<string, IcTone> = {
  enabled: 'live',
  scheduled: 'live',
  running: 'live',
  paused: 'warn',
  disabled: 'muted',
  error: 'danger',
  completed: 'muted'
}

export const truncate = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max)}…` : value)

export function jobName(job: CronJob): string {
  return asText(job.name).trim()
}

export function jobPrompt(job: CronJob): string {
  return asText(job.prompt)
}

export function jobScheduleDisplay(job: CronJob): string {
  return asText(job.schedule_display) || asText(job.schedule?.display) || asText(job.schedule?.expr) || '—'
}

export function jobScheduleExpr(job: CronJob): string {
  return asText(job.schedule?.expr) || asText(job.schedule_display) || ''
}

export function jobDeliver(job: CronJob): string {
  return asText(job.deliver) || DEFAULT_DELIVER
}

export function jobModel(job: CronJob): string {
  return asText(job.model).trim()
}

export function jobProvider(job: CronJob): string {
  return asText(job.provider).trim()
}

function cronParts(expr: string): null | string[] {
  const parts = expr.trim().replace(/\s+/g, ' ').split(' ')

  return parts.length === 5 ? parts : null
}

function dayName(value: string, c: Translations['cron']): string {
  return c.days[value] ?? c.dayFallback(value)
}

function formatCronTime(minute: string, hour: string): string {
  const numericHour = Number(hour)
  const numericMinute = Number(minute)

  if (!Number.isInteger(numericHour) || !Number.isInteger(numericMinute)) {
    return `${hour}:${minute}`
  }

  return new Date(2000, 0, 1, numericHour, numericMinute).toLocaleTimeString(APP_INTL_LOCALE, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function isIntegerToken(value: string): boolean {
  return /^\d+$/.test(value)
}

export function scheduleOptionForExpr(expr: string): ScheduleOption {
  const normalized = expr.trim().replace(/\s+/g, ' ')
  const exactMatch = SCHEDULE_OPTIONS.find(option => option.expr === normalized)

  if (exactMatch) {
    return exactMatch
  }

  const parts = cronParts(normalized)

  if (!parts) {
    return SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1]
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && isIntegerToken(minute) && isIntegerToken(hour)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'daily') ?? SCHEDULE_OPTIONS[0]
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5' && isIntegerToken(minute) && isIntegerToken(hour)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'weekdays') ?? SCHEDULE_OPTIONS[0]
  }

  if (
    dayOfMonth === '*' &&
    month === '*' &&
    isIntegerToken(dayOfWeek) &&
    isIntegerToken(minute) &&
    isIntegerToken(hour)
  ) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'weekly') ?? SCHEDULE_OPTIONS[0]
  }

  if (
    month === '*' &&
    dayOfWeek === '*' &&
    isIntegerToken(dayOfMonth) &&
    isIntegerToken(minute) &&
    isIntegerToken(hour)
  ) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'monthly') ?? SCHEDULE_OPTIONS[0]
  }

  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && isIntegerToken(minute)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'hourly') ?? SCHEDULE_OPTIONS[0]
  }

  if (normalized === '*/15 * * * *') {
    return SCHEDULE_OPTIONS.find(option => option.value === 'every-15-minutes') ?? SCHEDULE_OPTIONS[0]
  }

  return SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1]
}

export function scheduleSummary(option: ScheduleOption, expr: string, c: Translations['cron']): string {
  const parts = cronParts(expr)

  if (!parts) {
    return c.scheduleHints[option.value] ?? ''
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts

  if (option.value === 'daily') {
    return c.everyDayAt(formatCronTime(minute, hour))
  }

  if (option.value === 'weekdays') {
    return c.weekdaysAt(formatCronTime(minute, hour))
  }

  if (option.value === 'weekly') {
    return c.everyDayOfWeekAt(dayName(dayOfWeek, c), formatCronTime(minute, hour))
  }

  if (option.value === 'monthly') {
    return c.monthlyOnDayAt(dayOfMonth, formatCronTime(minute, hour))
  }

  if (option.value === 'hourly') {
    return minute === '0' ? c.topOfHour : c.everyHourAt(minute.padStart(2, '0'))
  }

  return c.scheduleHints[option.value] ?? ''
}

export function formatTime(iso?: null | string): string {
  if (!iso) {
    return '—'
  }

  const date = new Date(iso)

  if (Number.isNaN(date.valueOf())) {
    return iso
  }

  return date.toLocaleString(APP_INTL_LOCALE)
}

export function matchesQuery(job: CronJob, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [jobTitle(job), jobPrompt(job), jobScheduleDisplay(job), jobScheduleExpr(job), jobDeliver(job)].some(value =>
    value.toLowerCase().includes(needle)
  )
}

interface ScheduleOption {
  expr?: string
  value: string
}

export type EditorState =
  | { job: CronJob; mode: 'edit' }
  | { mode: 'closed' }
  // `blueprintKey` pre-selects a blueprint in the create dialog's "Start from"
  // dropdown (set when a recipe row in the list rail is clicked).
  | { blueprintKey?: string; mode: 'create' }

export interface EditorValues {
  deliver: string
  /** Per-job model override ('' = follow the global default). */
  model: string
  name: string
  prompt: string
  /** Provider slug for the model override ('' = none). */
  provider: string
  schedule: string
}
