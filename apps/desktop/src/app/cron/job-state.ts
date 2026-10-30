import './job-state.css'

import type { CronJob } from '@/types/hermes'

// Status-pip tone per cron job state. Single source for the chat sidebar and
// the Cron page so the two never drift, now on OUR tones (job-state.css, E3):
// the values are class names, as before, so every caller keeps compiling.
// (Animation/size live at the call site.)
export const STATE_DOT: Record<string, string> = {
  completed: 'cron-dot-idle',
  disabled: 'cron-dot-idle',
  enabled: 'cron-dot-live',
  error: 'cron-dot-danger',
  paused: 'cron-dot-warn',
  running: 'cron-dot-live',
  scheduled: 'cron-dot-live'
}

// Effective state: explicit state wins; otherwise infer from the enabled flag.
export function jobState(job: CronJob): string {
  const state = typeof job.state === 'string' ? job.state.trim() : ''

  return state || (job.enabled === false ? 'disabled' : 'scheduled')
}

// Human label for a job: name → first 60 of prompt → first 60 of script → id.
// One source for the sidebar row and the Cron page so the two never drift.
export function jobTitle(job: CronJob): string {
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)

  return pick(job.name) || clip(pick(job.prompt)) || clip(pick(job.script)) || job.id || 'Cron job'
}
