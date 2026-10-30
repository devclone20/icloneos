/**
 * The all-session poller (contract §2.3). The composer stack polls `process.list` only for the session it is
 * mounted on, only while a running row is on screen — so a job in any other session could die and stay "running"
 * forever: that is how a death went unseen. This polls EVERY session that has a running job, every 5 s, at most
 * 4 requests in flight (round-robin when more sessions are running), and arms no timer at all when nothing runs.
 *
 * "A running job" includes one whose row the composer's X or a rewind already removed while the registry still
 * reports it (the stop watch): the panel says "Stopping…" until a poll confirms it. A session latched as lost (4001)
 * is not one: nothing is sent to it, so no timer is kept for it until it comes back.
 *
 * Cost: 12 `process.list` per minute per running session, INCLUDING the one on screen. Its mounted stack already
 * polls it every 5 s, so a session someone else refreshed since this poller's own last request, within 1.5 periods,
 * is skipped this tick.
 */
import type { ReadableAtom } from 'nanostores'

import {
  $backgroundGoneSessions,
  $backgroundStatusBySession,
  $backgroundStopWatch,
  type BackgroundStopWatch,
  type ComposerStatusItem,
  lastBackgroundRefreshAt,
  refreshBackgroundProcesses
} from '@/store/composer-status'

export const BACKGROUND_POLL_MS = 5_000
export const MAX_POLLS_IN_FLIGHT = 4

/** Another poller's refresh this recent counts as this tick's: 1.5 periods absorbs the two timers' jitter. */
const SHARED_REFRESH_WINDOW_MS = BACKGROUND_POLL_MS * 1.5

interface PollerDeps {
  bySession: ReadableAtom<Record<string, ComposerStatusItem[]>>
  stopWatch: ReadableAtom<Readonly<Record<string, Readonly<Record<string, BackgroundStopWatch>>>>>
  gone: ReadableAtom<ReadonlySet<string>>
  refresh: (sid: string) => Promise<void>
  lastRefreshAt: (sid: string) => number | undefined
}

const DEFAULT_DEPS: PollerDeps = {
  bySession: $backgroundStatusBySession,
  gone: $backgroundGoneSessions,
  lastRefreshAt: lastBackgroundRefreshAt,
  refresh: refreshBackgroundProcesses,
  stopWatch: $backgroundStopWatch
}

function runningSessions(deps: PollerDeps): string[] {
  const gone = deps.gone.get()
  const due = new Set<string>()

  for (const [sid, items] of Object.entries(deps.bySession.get())) {
    if (items.some(item => item.state === 'running')) {
      due.add(sid)
    }
  }

  for (const [sid, watches] of Object.entries(deps.stopWatch.get())) {
    if (Object.values(watches).some(watch => watch.item.state === 'running')) {
      due.add(sid)
    }
  }

  return [...due].filter(sid => !gone.has(sid)).sort()
}

export function startBackgroundPoller(overrides: Partial<PollerDeps> = {}): () => void {
  const deps: PollerDeps = { ...DEFAULT_DEPS, ...overrides }
  const inFlight = new Set<string>()
  const ownRefreshAt = new Map<string, number | undefined>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let cursor = 0
  let stopped = false

  const refreshedElsewhere = (sid: string, now: number): boolean => {
    const last = deps.lastRefreshAt(sid)

    return last !== undefined && last !== ownRefreshAt.get(sid) && now - last < SHARED_REFRESH_WINDOW_MS
  }

  const tick = () => {
    timer = null

    const now = Date.now()
    const due = runningSessions(deps)
    const start = due.length > 0 ? cursor % due.length : 0

    // Round-robin from the cursor so a fifth running session is not starved by the first four.
    for (let step = 0; step < due.length && inFlight.size < MAX_POLLS_IN_FLIGHT; step += 1) {
      const sid = due[(start + step) % due.length]!

      if (inFlight.has(sid) || refreshedElsewhere(sid, now)) {
        continue
      }

      inFlight.add(sid)
      cursor = start + step + 1
      void deps
        .refresh(sid)
        .catch(() => undefined)
        .finally(() => inFlight.delete(sid))
      // The refresh stamps its send time synchronously; reading it back marks this request as the poller's own.
      ownRefreshAt.set(sid, deps.lastRefreshAt(sid))
    }

    arm()
  }

  const arm = () => {
    const wanted = !stopped && runningSessions(deps).length > 0

    if (wanted && timer === null) {
      timer = setTimeout(tick, BACKGROUND_POLL_MS)
    } else if (!wanted && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const offs = [deps.bySession.listen(arm), deps.stopWatch.listen(arm), deps.gone.listen(arm)]

  arm()

  return () => {
    stopped = true
    offs.forEach(off => off())
    arm()
  }
}
