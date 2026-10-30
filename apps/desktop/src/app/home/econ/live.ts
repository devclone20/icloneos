/**
 * EconomyOS — the refresh rhythm shared by every Dock app, and the status the
 * window header shows for it ("updated 12s ago", the spinning refresh).
 *
 * An app calls `useAutoRefresh(load, deps, refreshKey)` once. It runs `load`
 * on mount and whenever `deps` change (a new iNFT), then on an adaptive
 * rhythm (`cadenceMs`): every 20 s while its window is on screen and the app
 * has focus, every 60 s while it is open behind something, and — through
 * `keepWarm` — every 120 s while no window of it is open, so the next open
 * paints fresh data. Coming back (focus, visible) reads at once, silently.
 * The Settings interval is the open-window period; the other two follow it.
 *
 * `force` (cache bypass) is reserved for the header's refresh button — that
 * is what `refreshKey` carries. The mount run and the timer honour every
 * read's TTL, which is what lets a prefetch (prefetch.ts) and the in-memory
 * cache (cli.ts) turn an open into an instant paint instead of a CLI spawn.
 */
import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { $acpStreamLive } from './events'
import { timeAgo } from './format'
import { $liveEconEnabled, $liveEconIntervalSecs } from './prefs'
import type { EconKind } from './types'

export interface EconStatus {
  refreshing: boolean
  /** True while every running load is the engine's own (the mount run, a
   *  timer tick, `reload(false)`) — the header keeps its words and only its
   *  live dot pulses. A forced `reload()` (a write's re-read, a Try again) or
   *  the header's button is the owner's: false while one is out. */
  silent: boolean
  /** Epoch ms of the last completed load, 0 before the first. */
  updatedAt: number
  /** Epoch ms of the last load that changed what the app shows (apps report
   *  it), 0 when none did this session. */
  changedAt: number
  /** Epoch ms of the saved copy on screen while it still comes from disk
   *  (Email), 0 once a live answer replaced it. */
  snapshotAt: number
  /** What a long load is doing right now ('refreshing markets…'), set by the
   *  app's loader for the head to name; cleared when the load ends. */
  stage: null | string
  /** Epoch ms of the oldest figure on screen when the data is older than the
   *  load that fetched it (a quote catalogue), 0 when it is as fresh as `updatedAt`. */
  dataAt: number
  error: null | string
}

const IDLE: EconStatus = {
  refreshing: false,
  silent: true,
  updatedAt: 0,
  changedAt: 0,
  snapshotAt: 0,
  stage: null,
  dataAt: 0,
  error: null
}

export const $econStatus = atom<Record<string, EconStatus>>({})

function statusKey(kind: EconKind, slug: string): string {
  return `${kind}:${slug}`
}

export function reportEconStatus(kind: EconKind, slug: string, patch: Partial<EconStatus>): void {
  const key = statusKey(kind, slug)
  const current = $econStatus.get()[key] ?? IDLE

  if ((Object.keys(patch) as Array<keyof EconStatus>).every(field => current[field] === patch[field])) {
    return
  }

  $econStatus.set({ ...$econStatus.get(), [key]: { ...current, ...patch } })
}

interface RunCount {
  inFlight: number
  loud: number
}

// The runs still out per (kind, slug), one count per mounted hook: only a live
// hook owns "refreshing…", so a window closed mid forced read reopens on its
// last words instead of a spinner nobody will ever stop.
const liveRuns = new Map<string, Set<RunCount>>()

function runState(key: string): Pick<EconStatus, 'refreshing' | 'silent'> {
  let inFlight = 0
  let loud = 0

  for (const count of liveRuns.get(key) ?? []) {
    inFlight += count.inFlight
    loud += count.loud
  }

  return { refreshing: inFlight > 0, silent: loud === 0 }
}

/** One window's status only: a tick for another (kind, slug) leaves this
 *  subscriber alone, so the header re-renders for its own loads and nothing
 *  else. */
export function useEconStatus(kind: EconKind, slug: string | undefined): EconStatus {
  const key = slug ? statusKey(kind, slug) : ''
  const store = useMemo(() => computed($econStatus, all => (key && all[key]) || IDLE), [key])

  return useStore(store)
}

interface AutoRefreshHandle {
  /** Run the load now — after a write, or from a "Try again". Forces by
   *  default; a forced run is the owner's and shows as "refreshing…". */
  reload: (force?: boolean) => Promise<void>
}

/**
 * `load` receives `{ force }`: true only on a manual refresh (`refreshKey`
 * changed) — the mount run and the timer let every read's TTL decide.
 *
 * Apps that pass no `refreshKey` keep the older contract: force on every
 * deps change. Prefer passing it.
 */
/** The market timer's period while its job stream is live (events.ts) — the
 *  timer is then only the fallback for a stream that died quietly. */
export const STREAM_FALLBACK_SECS = 300

/** Seconds between silent reads, by where the app is (owner's rule:
 *  "online, updating all the time"), at the default 60 s Settings interval. */
const CADENCE_SECS = { focused: 20, open: 60, closed: 120 } as const
type CadenceState = keyof typeof CADENCE_SECS

/** Mounted refresh hooks per app, and the order their windows were raised
 *  in (last = frontmost): only the front window runs the focused rhythm. */
const mountedApps = new Map<EconKind, number>()
let raisedOrder: EconKind[] = []
const rearms = new Set<() => void>()

/** The frontmost open dock app, or null when none is open. */
export function frontEconApp(): EconKind | null {
  for (let index = raisedOrder.length - 1; index >= 0; index -= 1) {
    if ((mountedApps.get(raisedOrder[index]) ?? 0) > 0) {
      return raisedOrder[index]
    }
  }

  return null
}

function rearmAll(): void {
  for (const rearm of rearms) {
    rearm()
  }
}

/** A dock window came to the front (opened, clicked, focused): it takes the
 *  focused rhythm, the windows behind it the open one, from the next tick. */
export function raiseEconApp(kind: EconKind): void {
  if (raisedOrder.at(-1) === kind) {
    return
  }

  raisedOrder = [...raisedOrder.filter(other => other !== kind), kind]
  rearmAll()
}

/** On screen with the app's window frontmost and focused, or open behind
 *  something (another app window, another program).
 *  @public — the out-of-tree dock cadence lab probes (R3d) call it. */
export function cadenceState(kind: EconKind): Exclude<CadenceState, 'closed'> {
  const front = frontEconApp()

  return document.visibilityState === 'visible' && document.hasFocus() && (front === null || front === kind)
    ? 'focused'
    : 'open'
}

/** A read's cache life under the app's live period: a tick must find it
 *  expired (5 s under the period), never longer than the read's own `maxMs`
 *  and never under 10 s. */
export function cadenceTtlMs(cadenceSecs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(10_000, cadenceSecs * 1000 - 5_000))
}

function cadenceMs(state: CadenceState, intervalSecs: number): number {
  const secs =
    state === 'focused'
      ? Math.min(CADENCE_SECS.focused, intervalSecs)
      : state === 'open'
        ? intervalSecs
        : Math.max(CADENCE_SECS.closed, intervalSecs * 2)

  return secs * 1000
}

/** The period each mounted app runs at now, by status key — what read TTLs
 *  follow (a tick must find its read expired). */
const periods = new Map<string, number>()
/** When each (app, iNFT) last loaded, mounted or warmed. */
const lastLoads = new Map<string, number>()

/** The app's current period in seconds: its window's, or the closed one. */
export function liveCadenceSecs(kind: EconKind, slug: string): number {
  return (periods.get(statusKey(kind, slug)) ?? cadenceMs('closed', $liveEconIntervalSecs.get())) / 1000
}

type WarmFn = (inftId: string, slug: string) => Promise<void>

interface Warmer {
  kind: EconKind
  inftId: string
  slug: string
  warm: WarmFn
}

/** The staged iNFT's closed apps, one warmer per app. */
const warmers = new Map<EconKind, Warmer>()
const WARM_TICK_MS = 10_000
/** While a dock window is frontmost and focused, a closed app warms this
 *  rarely: the front window already reads every 20 s, the closed ones read at
 *  once when they open, and the per-iNFT budget is 3.5 spawns a minute. */
export const FOCUSED_WARM_MS = 600_000
let warmTimer = 0

function warmTick(): void {
  if (document.visibilityState !== 'visible' || !$liveEconEnabled.get()) {
    return
  }

  const now = Date.now()
  const front = frontEconApp()
  const closedMs = cadenceMs('closed', $liveEconIntervalSecs.get())
  const dueMs = front !== null && cadenceState(front) === 'focused' ? Math.max(closedMs, FOCUSED_WARM_MS) : closedMs

  for (const { inftId, kind, slug, warm } of warmers.values()) {
    const key = statusKey(kind, slug)

    if (!periods.has(key) && now - (lastLoads.get(key) ?? 0) >= dueMs) {
      lastLoads.set(key, now)
      void warm(inftId, slug).catch(() => undefined)

      // One closed app per tick: the per-iNFT queue never takes a burst.
      return
    }
  }
}

/** Keep a closed app's reads (and snapshot) fresh for the staged iNFT. */
function keepWarm(kind: EconKind, inftId: string, slug: string, warm: WarmFn): void {
  const key = statusKey(kind, slug)

  warmers.set(kind, { kind, inftId, slug, warm })
  lastLoads.set(key, Math.max(lastLoads.get(key) ?? 0, Date.now()))

  if (!warmTimer) {
    warmTimer = window.setInterval(warmTick, WARM_TICK_MS)
  }
}

/** Tests: forget every warmer, period and load time. */
export function resetLiveCadence(): void {
  window.clearInterval(warmTimer)
  warmTimer = 0
  warmers.clear()
  periods.clear()
  lastLoads.clear()
  mountedApps.clear()
  raisedOrder = []
  rearms.clear()
}

const running = new Set<Promise<unknown>>()

/** Every prefetch `parallelPrefetch` started, settled (tests, and anyone who must wait). */
export async function prefetchesSettled(): Promise<void> {
  while (running.size > 0) {
    await Promise.all([...running])
  }
}

/**
 * A dock app's `prefetch`, made to hold nobody: the dock's warm-up
 * (prefetch.ts) awaits each app in turn, so this one returns at once and its
 * reads go straight into the per-iNFT queue — the five first loads run back
 * to back, none waiting on the one before it — and the app stays warm at the
 * closed cadence from then on.
 */
export function parallelPrefetch(kind: EconKind, prefetch: WarmFn): WarmFn {
  return (inftId, slug) => {
    keepWarm(kind, inftId, slug, prefetch)

    const pending = prefetch(inftId, slug).catch(() => undefined)

    running.add(pending)
    void pending.then(() => running.delete(pending))

    return Promise.resolve()
  }
}

interface AutoRefreshOptions {
  /** The app's reads are pushed by the job stream: stretch the timer while it is live. */
  streamed?: boolean
}

export function useAutoRefresh(
  kind: EconKind,
  slug: string,
  load: (options: { force: boolean }) => Promise<void>,
  deps: readonly unknown[],
  refreshKey?: number,
  options?: AutoRefreshOptions
): AutoRefreshHandle {
  const intervalSecs = useStore($liveEconIntervalSecs)
  // A pushed app (Market, R3b) keeps its own period; the rest follow the cadence.
  const streamed = options?.streamed === true
  const streamLive = useStore($acpStreamLive)[slug] === true && streamed

  // The period is read when the timer is armed (focus, blur, a stream flip),
  // through a ref: none of those re-runs `load`.
  const periodOf = useCallback(
    () =>
      streamed
        ? (streamLive ? Math.max(intervalSecs, STREAM_FALLBACK_SECS) : intervalSecs) * 1000
        : cadenceMs(cadenceState(kind), intervalSecs),
    [intervalSecs, kind, streamLive, streamed]
  )

  const periodRef = useRef(periodOf)

  periodRef.current = periodOf
  // The latest `load` — read at fire time, never captured by the effect, so
  // the timer does not restart every render.
  const loadRef = useRef(load)

  // One mutable session per effect run (its fields are reset in place — the
  // ref itself is never reassigned from an effect). `epoch` lets a load that
  // resolves after a re-run drop its report instead of overwriting the new one.
  // `counts` holds the runs still out per status key for the hook's whole
  // life, so a silent tick that overlaps a forced run neither hides its
  // "refreshing…" nor ends it early.
  const session = useRef({
    disposed: false,
    lastRun: 0,
    epoch: 0,
    seenKey: refreshKey,
    counts: new Map<string, RunCount>(),
    rearm: (): void => undefined
  })

  loadRef.current = load

  const run = useCallback(
    async (force: boolean, silent: boolean) => {
      const current = session.current
      const epoch = current.epoch

      if (current.disposed) {
        return
      }

      const key = statusKey(kind, slug)
      const count = current.counts.get(key) ?? { inFlight: 0, loud: 0 }
      const owners = liveRuns.get(key) ?? new Set<RunCount>()

      current.counts.set(key, count)
      liveRuns.set(key, owners.add(count))
      current.lastRun = Date.now()
      lastLoads.set(key, current.lastRun)
      count.inFlight += 1
      count.loud += silent ? 0 : 1
      reportEconStatus(kind, slug, runState(key))

      let outcome: Partial<EconStatus> = {}

      try {
        await loadRef.current({ force })
        outcome = { updatedAt: Date.now(), stage: null, error: null }
      } catch (error) {
        outcome = { stage: null, error: readError(error) }
      } finally {
        count.inFlight -= 1
        count.loud -= silent ? 0 : 1

        if (!current.disposed) {
          reportEconStatus(kind, slug, { ...(current.epoch === epoch ? outcome : {}), ...runState(key) })
        }
      }
    },
    [kind, slug]
  )

  // Unmount (or a new slug): this hook stops owning its runs for that key, and
  // the header drops a "refreshing…" no live hook will end.
  useEffect(() => {
    const counts = session.current.counts

    return () => {
      const key = statusKey(kind, slug)
      const count = counts.get(key)

      if (count && liveRuns.get(key)?.delete(count)) {
        reportEconStatus(kind, slug, runState(key))
      }
    }
  }, [kind, slug])

  useEffect(() => {
    const current = session.current

    // A changed refreshKey is the header's button — the one forced read.
    const manual = refreshKey === undefined ? true : refreshKey !== current.seenKey

    Object.assign(current, { disposed: false, lastRun: 0, epoch: current.epoch + 1, seenKey: refreshKey })

    // Only the button is the owner's: the mount run (even an older-contract
    // forced one) and every tick are silent.
    void run(manual, refreshKey === undefined || !manual)

    let timer = 0
    const key = statusKey(kind, slug)

    // Each (re-)arm takes the period of the state the app is in then: focus,
    // blur and visibility re-arm it.
    const arm = () => {
      window.clearInterval(timer)

      if (current.disposed) {
        return
      }

      const period = periodRef.current()

      periods.set(key, period)
      timer = window.setInterval(() => {
        void run(false, true)
      }, period)
    }

    // Held on the session (never a ref write in an effect): the flip effect below re-arms it.
    Object.assign(current, { rearm: arm })
    mountedApps.set(kind, (mountedApps.get(kind) ?? 0) + 1)
    rearms.add(arm)
    // A window that opens is the front one; the others drop to the open rhythm.
    raiseEconApp(kind)
    arm()

    // Back on screen or focused: read now, silently (the read's TTL decides
    // whether the CLI runs), and tick at the new state's rhythm from here.
    const onBack = () => {
      if (document.visibilityState === 'visible') {
        void run(false, true)
      }

      arm()
    }

    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)
    window.addEventListener('blur', arm)

    return () => {
      current.disposed = true
      window.clearInterval(timer)
      periods.delete(key)
      rearms.delete(arm)

      const front = frontEconApp()

      mountedApps.set(kind, (mountedApps.get(kind) ?? 1) - 1)

      // The front window closed: the one behind it takes the focused rhythm.
      if (frontEconApp() !== front) {
        rearmAll()
      }

      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
      window.removeEventListener('blur', arm)
    }
    // `deps` is the app's own trigger list; `load` is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalSecs, refreshKey, ...deps])

  // The stream went live or dropped: the next tick follows the new period.
  useEffect(() => {
    session.current.rearm()
  }, [periodOf])

  const reload = useCallback((force = true) => run(force, !force), [run])

  return useMemo(() => ({ reload }), [reload])
}

export const SAVED_MAIL_TEXT = 'showing saved mail · checking…'

/** The words of a failed read whose error carries none (`throw new Error()`). */
export const READ_FAILED_TEXT = 'read failed'

function readError(error: unknown): string {
  const words = error instanceof Error ? error.message : String(error)

  return words.trim() || READ_FAILED_TEXT
}

/** A blank error is still a failed read: it must not leave the last "updated" line. */
export function hasError(status: EconStatus): status is EconStatus & { error: string } {
  return typeof status.error === 'string'
}

/** What the header says. A silent run (mount, timer) keeps the words of the
 *  last answer — only the owner's own refresh reads "refreshing…". */
export function statusText(status: EconStatus, kind: EconKind, periodMs: number, now: number = Date.now()): string {
  if (hasError(status)) {
    return status.error.trim() || READ_FAILED_TEXT
  }

  if (status.refreshing && !status.silent) {
    return 'refreshing…'
  }

  // Fixed words (no age): the longest routine text, and the status line's
  // width floor (econ.css) is sized to hold it.
  if (status.snapshotAt) {
    return SAVED_MAIL_TEXT
  }

  if (kind === 'email' && status.changedAt && now - status.changedAt < periodMs) {
    return `new mail ${timeAgo(status.changedAt)}`
  }

  return status.updatedAt ? `updated ${timeAgo(status.updatedAt)}` : ''
}
