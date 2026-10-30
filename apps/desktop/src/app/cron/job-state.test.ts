import { describe, expect, it } from 'vitest'

import type { CronJob } from '@/types/hermes'

import { jobState, jobTitle, STATE_DOT } from './job-state'

// This module is read by the chat sidebar as well as the Cron page, so its
// contract is pinned here: every state the backend can report resolves to a
// tone, and the tones are OURS (job-state.css) — never an upstream colour.

const job = (fields: Partial<CronJob>): CronJob => fields as CronJob

describe('jobState', () => {
  it('prefers the explicit state, trimmed', () => {
    expect(jobState(job({ state: '  running  ' }))).toBe('running')
  })

  it('falls back to the enabled flag when the backend sends no state', () => {
    expect(jobState(job({ enabled: false }))).toBe('disabled')
    expect(jobState(job({ enabled: true, state: '   ' }))).toBe('scheduled')
    expect(jobState(job({}))).toBe('scheduled')
  })
})

describe('jobTitle', () => {
  it('reads name, then prompt, then script, then id', () => {
    expect(jobTitle(job({ name: ' Nightly digest ', prompt: 'ignored' }))).toBe('Nightly digest')
    expect(jobTitle(job({ prompt: 'summarise the inbox' }))).toBe('summarise the inbox')
    expect(jobTitle(job({ script: 'backup.sh' }))).toBe('backup.sh')
    expect(jobTitle(job({ id: 'job-7' }))).toBe('job-7')
    expect(jobTitle(job({}))).toBe('Cron job')
  })

  it('clips a long prompt instead of flooding the row', () => {
    const title = jobTitle(job({ prompt: 'x'.repeat(200) }))

    expect(title).toHaveLength(61)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('STATE_DOT', () => {
  it('maps every state the page and the sidebar can show', () => {
    expect(Object.keys(STATE_DOT).sort()).toEqual([
      'completed',
      'disabled',
      'enabled',
      'error',
      'paused',
      'running',
      'scheduled'
    ])
  })

  it('uses OUR tone classes only — no upstream colour utility survives here', () => {
    const tones = new Set(['cron-dot-danger', 'cron-dot-idle', 'cron-dot-live', 'cron-dot-warn'])

    for (const value of Object.values(STATE_DOT)) {
      expect(tones.has(value)).toBe(true)
      expect(
        /\b(?:bg|text|border)-(?:primary|destructive|foreground|background|muted|accent|secondary)\b/.test(value)
      ).toBe(false)
      expect(value.includes('--ui-')).toBe(false)
    }
  })
})
