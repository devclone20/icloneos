/**
 * The warm read-ahead of thread bodies: once a list paints, the newest rows'
 * threads are read into the thread memo so a first open paints from memory
 * (U4 p3: first opens took 8.7–16 s of skeleton, reopens were instant).
 *
 * Idle priority, by construction. A speculative read is a background read:
 * the per-iNFT lane (econ/cli.ts) gives it one slot and keeps the other for
 * the owner's open while no open runs. Still ONE speculative read at a time
 * (two at once slowed every CLI read on lab 1), the first only after the plan has been quiet for `THREAD_READ_AHEAD_IDLE_MS`,
 * none while an owner's open is in flight, and the next only after the same
 * quiet window once that open settled. The cursor's row leads the plan. One
 * plan at a time: a new plan (another folder, another iNFT) replaces the
 * pending rows, and a cancel drops them. A thread already remembered or
 * already being read costs no read.
 *
 * The stage-time warm is separate (`warm`): the newest inbox threads — the
 * last-seen inbox's at stage time, then page one's once it lands — go to the
 * CLI queue at once, before the caller's next read, and lead every later plan
 * of that iNFT until they are read, so a folder flip in the window never drops
 * them.
 */

export interface PrefetchScope {
  inftId: string
  slug: string
}

export interface PrefetchRow {
  threadId: string
  /** Epoch ms; 0 = unknown (keeps its list position). */
  at: number
}

interface Plan<S> {
  scope: S
  queue: string[]
}

export interface ThreadPrefetchDeps<S extends PrefetchScope> {
  read: (scope: S, threadId: string) => Promise<unknown>
  /** The memo already holds this thread: its open paints without a read. */
  known: (scope: S, threadId: string) => boolean
  /** Run `run` after `ms`; returns its cancel. */
  defer?: (run: () => void, ms: number) => () => void
  now?: () => number
}

export const THREAD_PREFETCH_CAP = 6

/** The stage-time warm reads the newest inbox threads above the fold: the likeliest first opens. */
const WARM_CAP = 4

/** No speculative read starts sooner than this after a plan, a lead change or an owner's open: long enough to let
 *  the list's own reads go first, short enough that the newest threads are warm before the first click (the U4 p3
 *  owner clicks ~1.5 s after the list paints). An open of the thread being read joins that read; an open of another
 *  waits for at most one read (econ/cli.ts lanes). */
export const THREAD_READ_AHEAD_IDLE_MS = 250

const NEXT_READ_GAP_MS = 50

function defaultDefer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)

  return () => clearTimeout(timer)
}

/** The first `cap` distinct threads, newest first (stable for equal dates);
 *  `lead` (the cursor's row) goes first. */
export function prefetchOrder(rows: readonly PrefetchRow[], cap = THREAD_PREFETCH_CAP, lead?: null | string): string[] {
  const seen = new Set<string>()
  const ordered = lead ? [{ at: Number.POSITIVE_INFINITY, threadId: lead }, ...rows] : rows

  return ordered
    .map((row, index) => ({ ...row, index }))
    .filter(row => row.threadId)
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .filter(row => !seen.has(row.threadId) && Boolean(seen.add(row.threadId)))
    .slice(0, cap)
    .map(row => row.threadId)
}

export function createThreadPrefetcher<S extends PrefetchScope>(
  deps: ThreadPrefetchDeps<S>,
  cap = THREAD_PREFETCH_CAP
) {
  const defer = deps.defer ?? defaultDefer
  const now = deps.now ?? Date.now
  const key = (scope: S, threadId: string) => `${scope.slug}\u0000${threadId}`
  const unread = (scope: S, threadId: string) => !reading.has(key(scope, threadId)) && !deps.known(scope, threadId)

  const readNow = (scope: S, threadId: string): Promise<unknown> => {
    try {
      return Promise.resolve(deps.read(scope, threadId))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const reading = new Set<string>()
  let pending: Plan<S> | null = null
  let pinned: Plan<S> | null = null
  let busy = false
  let owners = 0
  let quietUntil = 0
  let cancelWait: (() => void) | null = null

  const stopWaiting = () => {
    cancelWait?.()
    cancelWait = null
  }

  const schedule = () => {
    stopWaiting()

    if (busy || owners > 0 || (!pending && !pinned)) {
      return
    }

    cancelWait = defer(pump, Math.max(NEXT_READ_GAP_MS, quietUntil - now()))
  }

  const quiet = () => {
    quietUntil = Math.max(quietUntil, now() + THREAD_READ_AHEAD_IDLE_MS)
  }

  // The warm's threads lead, unless the owner is looking at another iNFT's list.
  const plans = (): Plan<S>[] => {
    const order = pinned && pending?.scope.slug !== pinned.scope.slug && pending ? [pending, pinned] : [pinned, pending]

    return order.filter((plan): plan is Plan<S> => plan !== null)
  }

  // The owner's cursor outranks the warm: its thread goes ahead of the warm's own.
  const ahead = (scope: S, threadId: null | string | undefined) => {
    if (threadId && pinned?.scope.slug === scope.slug) {
      pinned.queue = [threadId, ...pinned.queue.filter(id => id !== threadId)]
    }
  }

  const takeFrom = (plan: Plan<S>): { scope: S; threadId: string } | null => {
    for (let threadId = plan.queue.shift(); threadId !== undefined; threadId = plan.queue.shift()) {
      if (unread(plan.scope, threadId)) {
        return { scope: plan.scope, threadId }
      }
    }

    return null
  }

  // The next reads: one thread, or every thread of the stage warm when it leads — handed to the CLI queue together,
  // they run back to back in the background slot, so no warm-up of another app gets in between.
  const take = (): { scope: S; threadId: string }[] => {
    for (const plan of plans()) {
      const first = takeFrom(plan)

      if (first) {
        const batch = [first]

        for (let more = plan === pinned ? takeFrom(plan) : null; more; more = takeFrom(plan)) {
          batch.push(more)
        }

        return batch
      }
    }

    return []
  }

  function pump(): void {
    cancelWait = null

    if (busy || owners > 0 || (!pending && !pinned)) {
      return
    }

    if (now() < quietUntil) {
      schedule()

      return
    }

    const batch = take()

    pending = pending?.queue.length ? pending : null
    pinned = pinned?.queue.length ? pinned : null

    if (batch.length === 0) {
      return
    }

    const ids = batch.map(({ scope, threadId }) => key(scope, threadId))

    busy = true
    ids.forEach(id => reading.add(id))

    // Read in this call, not a microtask later: a warm's reads reach the CLI queue before the warm's own list read.
    void Promise.allSettled(batch.map(({ scope, threadId }) => readNow(scope, threadId)))
      .then(() => undefined)
      .finally(() => {
        ids.forEach(id => reading.delete(id))
        busy = false
        schedule()
      })
  }

  return {
    /** Read ahead the newest `cap` threads of `rows`, `lead` first; replaces any pending plan, never the warm. */
    plan(scope: S, rows: readonly PrefetchRow[], lead?: null | string): void {
      const queue = prefetchOrder(rows, cap, lead)

      pending = queue.length ? { scope, queue } : null

      // Every plan opens the quiet window — also while a speculative read runs or a wait is pending: the next read
      // never starts within THREAD_READ_AHEAD_IDLE_MS of a plan.
      quiet()

      if (pending && !busy) {
        schedule()
      }
    },

    /** The stage-time warm: `rows`' newest threads go to the CLI queue in this call (no quiet window) unless a
     *  speculative read or an owner's open runs, and lead every later plan of that iNFT until read — a plan never
     *  replaces them. Replaces an earlier warm; the same threads again (read, being read or waiting) cost nothing. */
    warm(scope: S, rows: readonly PrefetchRow[]): void {
      const queue = prefetchOrder(rows, WARM_CAP).filter(threadId => unread(scope, threadId))
      const mine = pinned?.scope.slug === scope.slug

      if ((mine && pinned?.queue.join('\u0000') === queue.join('\u0000')) || (!mine && queue.length === 0)) {
        return
      }

      pinned = queue.length ? { scope, queue } : null

      if (!pinned || busy) {
        return
      }

      if (owners === 0 && now() >= quietUntil) {
        stopWaiting()
        pump()
      } else {
        schedule()
      }
    },

    /** The cursor rests on `threadId`: it is the next speculative read. */
    lead(scope: S, threadId: string): void {
      const rest = pending?.scope.slug === scope.slug ? pending.queue.filter(id => id !== threadId) : []

      pending = { scope, queue: [threadId, ...rest] }
      ahead(scope, threadId)

      // The cursor moved: the owner is active — hold the speculative reads for another quiet window.
      quiet()

      if (!busy) {
        schedule()
      }
    },

    /** The owner opened a thread: no speculative read starts until `open`
     *  settled and the quiet window after it passed. */
    yieldTo(open: Promise<unknown>): void {
      owners += 1
      stopWaiting()

      void open
        .catch(() => undefined)
        .finally(() => {
          owners -= 1
          quiet()
          schedule()
        })
    },

    /** Drop the pending reads (all, or one iNFT's window plan — the stage-time warm outlives a window); a read
     *  already running finishes. */
    cancel(slug?: string): void {
      if (slug === undefined) {
        pinned = null
      }

      if (pending && (slug === undefined || pending.scope.slug === slug)) {
        pending = null
      }

      if (!pending && !pinned) {
        stopWaiting()
      }
    },

    /** Threads waiting, in read order (tests, the lab). */
    pendingIds(): string[] {
      return plans().flatMap(plan => plan.queue)
    }
  }
}
