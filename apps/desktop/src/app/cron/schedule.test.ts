import { describe, expect, it } from 'vitest'

import type { CronJob } from '@/hermes'
import { en } from '@/i18n/en'

import {
  cronProfileForScope,
  formatTime,
  jobDeliver,
  jobModel,
  jobName,
  jobPrompt,
  jobProvider,
  jobScheduleDisplay,
  jobScheduleExpr,
  matchesQuery,
  SCHEDULE_OPTIONS,
  scheduleOptionForExpr,
  scheduleSummary,
  STATE_TONE,
  truncate
} from './schedule'

// The rules a SAVED job depends on: which preset an expression maps back to,
// what the dialog says the expression means, and how a loosely typed backend
// job is read. Lifted out of the page in r2 — these tests pin the behaviour so
// the rewritten UI cannot quietly change what a user's schedule means.

const job = (fields: Partial<Record<string, unknown>>) => fields as unknown as CronJob

describe('cron schedule presets', () => {
  it('maps an exact preset expression back to its preset', () => {
    expect(scheduleOptionForExpr('0 9 * * *').value).toBe('daily')
    expect(scheduleOptionForExpr('0 9 * * 1-5').value).toBe('weekdays')
    expect(scheduleOptionForExpr('*/15 * * * *').value).toBe('every-15-minutes')
  })

  it('infers the preset from the SHAPE of a hand-written expression', () => {
    expect(scheduleOptionForExpr('30 7 * * *').value).toBe('daily')
    expect(scheduleOptionForExpr('15 6 * * 3').value).toBe('weekly')
    expect(scheduleOptionForExpr('0 5 12 * *').value).toBe('monthly')
    expect(scheduleOptionForExpr('17 * * * *').value).toBe('hourly')
  })

  it('falls back to custom for anything it cannot name', () => {
    expect(scheduleOptionForExpr('*/7 */3 * * 2,4').value).toBe('custom')
    expect(scheduleOptionForExpr('nonsense').value).toBe('custom')
    expect(SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1].value).toBe('custom')
  })

  it('collapses runs of whitespace before matching', () => {
    expect(scheduleOptionForExpr('  0   9  *  *  *  ').value).toBe('daily')
  })

  it('treats an expression without five fields as custom', () => {
    expect(scheduleOptionForExpr('0 9 * *').value).toBe('custom')
  })
})

describe('scheduleSummary', () => {
  const c = en.cron

  it('describes each preset in the owner-facing words', () => {
    // The hour itself is rendered in the user's locale, so the assertion pins
    // the sentence and that a time of day landed in it, not the clock format.
    const withoutClock = (text: string) => text.replace(/\d{1,2}:\d{2}(\s?[AP]M)?/i, 'TIME')

    expect(withoutClock(scheduleSummary({ expr: '0 9 * * *', value: 'daily' }, '0 9 * * *', c))).toBe(
      c.everyDayAt('TIME')
    )
    expect(withoutClock(scheduleSummary({ expr: '0 9 * * 1-5', value: 'weekdays' }, '0 9 * * 1-5', c))).toBe(
      c.weekdaysAt('TIME')
    )
    expect(scheduleSummary({ expr: '0 * * * *', value: 'hourly' }, '0 * * * *', c)).toBe(c.topOfHour)
    expect(scheduleSummary({ expr: '0 * * * *', value: 'hourly' }, '20 * * * *', c)).toBe(c.everyHourAt('20'))
  })

  it('falls back to the static hint when the expression is unparseable', () => {
    expect(scheduleSummary({ value: 'custom' }, 'not a cron', c)).toBe(c.scheduleHints.custom ?? '')
  })
})

describe('job field readers', () => {
  it('reads every field through a string guard', () => {
    const saved = job({
      deliver: 'local,telegram',
      model: 'opus',
      name: 'Morning digest',
      prompt: 'summarise',
      provider: 'anthropic',
      schedule: { expr: '0 9 * * *' },
      schedule_display: 'Every day at 09:00'
    })

    expect(jobName(saved)).toBe('Morning digest')
    expect(jobPrompt(saved)).toBe('summarise')
    expect(jobScheduleExpr(saved)).toBe('0 9 * * *')
    expect(jobScheduleDisplay(saved)).toBe('Every day at 09:00')
    expect(jobDeliver(saved)).toBe('local,telegram')
    expect(jobModel(saved)).toBe('opus')
    expect(jobProvider(saved)).toBe('anthropic')
  })

  it('never hands the UI a non-string, whatever the backend sent', () => {
    const broken = job({ deliver: 7, name: null, prompt: undefined, schedule: {} })

    // null/undefined read as empty; anything else is stringified rather than
    // crashing a row (asText, the canonical guard).
    expect(jobName(broken)).toBe('')
    expect(jobPrompt(broken)).toBe('')
    expect(jobDeliver(broken)).toBe('7')
    expect(typeof jobScheduleExpr(broken)).toBe('string')
  })
})

describe('list helpers', () => {
  it('matches a query against the job title, prompt and schedule', () => {
    const saved = job({ name: 'Digest', prompt: 'summarise the inbox', schedule: { expr: '0 9 * * *' } })

    expect(matchesQuery(saved, '')).toBe(true)
    expect(matchesQuery(saved, 'digest')).toBe(true)
    expect(matchesQuery(saved, 'inbox')).toBe(true)
    expect(matchesQuery(saved, 'nothing here')).toBe(false)
  })

  it('formats a timestamp, dashes an empty one and echoes an unparseable one', () => {
    expect(formatTime(null)).toBe('—')
    // A backend value we cannot parse is shown as it came, never as a dash:
    // "—" would claim the job has never run.
    expect(formatTime('not a date')).toBe('not a date')
    expect(formatTime(new Date(0).toISOString())).not.toBe('—')
  })

  it('truncates a long title at the row width', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdefgh', 4)).toBe('abcd…')
  })

  it('collapses the all-profiles scope to the aggregate profile', () => {
    expect(cronProfileForScope('all')).toBe('all')
    expect(cronProfileForScope('work')).toBe('work')
  })

  it('keeps every job state in OUR tone scale', () => {
    for (const tone of Object.values(STATE_TONE)) {
      expect(['danger', 'done', 'live', 'muted', 'warn']).toContain(tone)
    }
  })
})
