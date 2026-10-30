import { useStore } from '@nanostores/react'
import { computed, type ReadableAtom } from 'nanostores'
import { useEffect, useState } from 'react'

import type { SessionView } from '@/app/chat/session-view'
import { onGatewayEvent } from '@/contrib/events'
import { getHermesConfigRecord, getUsageAnalytics, type HermesGateway } from '@/hermes'
import { $gateway } from '@/store/gateway'
import { $currentUsage } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import type { AnalyticsResponse, ContextBreakdown, UsageStats } from '@/types/hermes'

import { type CompressionSettings, compressionSettingsFromConfig } from './threshold'
import { $usageSnapshots, rememberUsage } from './usage-snapshot'

/** Breakdown RPCs while a turn streams: at most one per tick period. */
export const BREAKDOWN_MIN_INTERVAL_MS = 1000
export const SPEND_REFRESH_MS = 60_000
const CONFIG_MAX_AGE_MS = 60_000

/**
 * Turn boundaries re-read the breakdown at once when the 1 s window is free and
 * join its trailing run otherwise: the RPC never runs more than once a second
 * (live lab 2 measure, 2026-10-18: a flush per boundary made 24 reads for 18 ticks).
 */
const SETTLED_EVENTS = ['message.complete', 'session.info'] as const
const THROTTLED_EVENTS = ['session.usage', 'tool.complete'] as const

const usageAtoms = new WeakMap<SessionView, ReadableAtom<null | UsageStats>>()

/**
 * The surface's live usage: its own per-session slice, else (primary only)
 * the global mirror, so the chip paints from cache before any network.
 */
function usageAtomFor(view: SessionView): ReadableAtom<null | UsageStats> {
  let $usage = usageAtoms.get(view)

  if (!$usage) {
    $usage = computed(
      [view.$runtimeId, view.$storedId, $sessionStates, $currentUsage, $usageSnapshots],
      (runtimeId, storedId, states, current, snapshots) =>
        (runtimeId ? states[runtimeId]?.usage : null) ??
        (view.kind === 'primary' && runtimeId ? current : null) ??
        (storedId ? (snapshots[storedId] ?? null) : null)
    )
    usageAtoms.set(view, $usage)
  }

  return $usage
}

export function useContextUsage(view: SessionView): null | UsageStats {
  const usage = useStore(usageAtomFor(view))
  const runtimeId = useStore(view.$runtimeId)
  const storedId = useStore(view.$storedId)

  // Live usage is remembered per stored session so a restored thread paints
  // its last known context before the agent runs again.
  useEffect(() => {
    if (usage && runtimeId && storedId) {
      rememberUsage(storedId, usage)
    }
  }, [usage, runtimeId, storedId])

  return usage
}

interface SchedulerClock {
  clearTimeout: typeof clearTimeout
  now: () => number
  setTimeout: typeof setTimeout
}

/**
 * Leading + trailing throttle: the first call runs at once, calls inside the
 * window collapse into one trailing run, `flush` bypasses the window.
 */
export function createRefreshScheduler(
  run: () => void,
  minIntervalMs: number,
  clock: SchedulerClock = { clearTimeout, now: () => performance.now(), setTimeout }
) {
  let last = Number.NEGATIVE_INFINITY
  let timer: null | ReturnType<typeof setTimeout> = null

  const fire = () => {
    timer = null
    last = clock.now()
    run()
  }

  return {
    cancel() {
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
    },
    flush() {
      this.cancel()
      fire()
    },
    request() {
      if (timer !== null) {
        return
      }

      const wait = last + minIntervalMs - clock.now()

      if (wait <= 0) {
        fire()
      } else {
        timer = clock.setTimeout(fire, wait)
      }
    }
  }
}

const breakdownCache = new Map<string, ContextBreakdown>()
let compressionCache: { at: number; settings: CompressionSettings } | null = null
let spendCache: AnalyticsResponse | null = null

function activeGatewayClient(): HermesGateway | null {
  return $gateway.get() as HermesGateway | null
}

export interface ContextPanelData {
  breakdown: ContextBreakdown | null
  breakdownError: boolean
  compression: CompressionSettings | null
  spend: AnalyticsResponse | null
}

/**
 * Card data while it is open. Paints the last cached breakdown first, then
 * re-reads it on every settled event and at most once per second while
 * `session.usage` ticks stream; spend refreshes every 60 s and per turn.
 */
export function useContextPanelData(runtimeId: null | string, open: boolean): ContextPanelData {
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(() =>
    runtimeId ? (breakdownCache.get(runtimeId) ?? null) : null
  )

  const [breakdownError, setBreakdownError] = useState(false)
  const [compression, setCompression] = useState<CompressionSettings | null>(() => compressionCache?.settings ?? null)
  const [spend, setSpend] = useState<AnalyticsResponse | null>(() => spendCache)

  useEffect(() => {
    if (!open || !runtimeId) {
      return
    }

    let alive = true
    let inFlight = false
    let again = false

    setBreakdown(breakdownCache.get(runtimeId) ?? null)

    const readBreakdown = async () => {
      const gateway = activeGatewayClient()

      if (!gateway) {
        return
      }

      if (inFlight) {
        again = true

        return
      }

      inFlight = true

      try {
        const next = await gateway.request<ContextBreakdown>('session.context_breakdown', { session_id: runtimeId })

        breakdownCache.set(runtimeId, next)

        if (alive) {
          setBreakdown(next)
          setBreakdownError(false)
        }
      } catch {
        if (alive) {
          setBreakdownError(true)
        }
      } finally {
        inFlight = false

        if (again && alive) {
          again = false
          void readBreakdown()
        }
      }
    }

    const readSpend = async () => {
      try {
        const next = await getUsageAnalytics(1)

        spendCache = next

        if (alive) {
          setSpend(next)
        }
      } catch {
        // Spend is best-effort: providers that report nothing leave it empty.
      }
    }

    const scheduler = createRefreshScheduler(() => void readBreakdown(), BREAKDOWN_MIN_INTERVAL_MS)
    const forThisSession = (sessionId: string | undefined) => !sessionId || sessionId === runtimeId

    const offs = [
      ...THROTTLED_EVENTS.map(type =>
        onGatewayEvent(type, event => {
          if (forThisSession(event.session_id)) {
            scheduler.request()
          }
        })
      ),
      ...SETTLED_EVENTS.map(type =>
        onGatewayEvent(type, event => {
          if (!forThisSession(event.session_id)) {
            return
          }

          scheduler.request()

          if (type === 'message.complete') {
            void readSpend()
          }
        })
      )
    ]

    scheduler.flush()
    void readSpend()

    const spendTimer = setInterval(() => void readSpend(), SPEND_REFRESH_MS)

    if (!compressionCache || Date.now() - compressionCache.at > CONFIG_MAX_AGE_MS) {
      getHermesConfigRecord()
        .then(config => {
          compressionCache = { at: Date.now(), settings: compressionSettingsFromConfig(config) }

          if (alive) {
            setCompression(compressionCache.settings)
          }
        })
        .catch(() => undefined)
    }

    return () => {
      alive = false
      scheduler.cancel()
      clearInterval(spendTimer)
      offs.forEach(off => off())
    }
  }, [open, runtimeId])

  return { breakdown, breakdownError, compression, spend }
}
