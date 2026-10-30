/**
 * Cron runs — `$cronJobs` as the sidebar and the Cron page keep it. A job is background WORK only while a run is
 * going (`state: running`); a scheduled job waiting for its next time is not, and stays in Cron.
 *
 * When a run ends the job goes back to `scheduled`, which would make it vanish from this list — and a vanished
 * running task reads as died. So a run that ends is reported `done` (or `failed` when the job lands in `error`)
 * for a while, the way the composer stack lets a finished process linger.
 *
 * Stop is `unsupported` (owner decision O5: stopping means "kill this run", never "pause the schedule"): `cron.manage`
 * can pause, resume, run and remove a job, but nothing kills a run in flight.
 */
import { jobState, jobTitle } from '@/app/cron/job-state'
import type { BgTask, TaskSource } from '@/store/background-tasks'
import { $cronJobs } from '@/store/cron'
import type { CronJob } from '@/types/hermes'

const CRON_SOURCE_ID = 'cron'

const ENDED_RUN_LINGER_MS = 10 * 60_000

const parsedTime = (iso: null | string | undefined): number | null => {
  const at = iso ? Date.parse(iso) : Number.NaN

  return Number.isFinite(at) ? at : null
}

function toTask(job: CronJob, state: BgTask['state']): BgTask {
  const failed = state === 'failed'

  return {
    id: `${CRON_SOURCE_ID}:${job.id}`,
    kind: 'cron',
    lastLine: failed ? (job.last_error ?? null) : (job.schedule_display ?? job.schedule?.display ?? null),
    lastLineAt: null,
    seen: true,
    source: CRON_SOURCE_ID,
    startedAt: state === 'running' ? parsedTime(job.last_run_at) : null,
    state,
    stop: 'none',
    title: jobTitle(job)
  }
}

export function cronSource(now: () => number = Date.now): TaskSource {
  const running = new Set<string>()
  const ended = new Map<string, number>()

  return {
    id: CRON_SOURCE_ID,
    snapshot() {
      const at = now()
      const tasks: BgTask[] = []

      for (const job of $cronJobs.get()) {
        const state = jobState(job)

        if (state === 'running') {
          running.add(job.id)
          ended.delete(job.id)
          tasks.push(toTask(job, 'running'))

          continue
        }

        if (running.delete(job.id)) {
          ended.set(job.id, at)
        }

        const endedAt = ended.get(job.id)

        if (endedAt !== undefined && at - endedAt <= ENDED_RUN_LINGER_MS) {
          tasks.push(toTask(job, state === 'error' ? 'failed' : 'done'))
        } else {
          ended.delete(job.id)
        }
      }

      return tasks
    },
    stop: () =>
      Promise.resolve({ detail: 'cron.manage has no verb that ends a run', effect: 'unsupported', ok: false }),
    subscribe: cb => $cronJobs.listen(cb)
  }
}
