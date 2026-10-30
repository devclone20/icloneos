import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createThreadPrefetcher,
  prefetchOrder,
  type PrefetchRow,
  THREAD_PREFETCH_CAP,
  THREAD_READ_AHEAD_IDLE_MS
} from './thread-prefetch'

const IDLE = THREAD_READ_AHEAD_IDLE_MS + 100
const A = { inftId: 'a', slug: 'slug-6' }
const B = { inftId: 'b', slug: 'slug-7' }

const rows = (...items: Array<[string, number]>): PrefetchRow[] => items.map(([threadId, at]) => ({ threadId, at }))

/** A fake CLI: every read stays open until the test answers it. */
function fakeCli() {
  const memo = new Set<string>()
  const calls: string[] = []
  const open: Array<() => void> = []
  let running = 0
  let peak = 0

  const prefetcher = createThreadPrefetcher<typeof A>({
    known: (scope, id) => memo.has(`${scope.slug}/${id}`),
    read: (scope, id) => {
      calls.push(`${scope.slug}/${id}`)
      running += 1
      peak = Math.max(peak, running)

      return new Promise<void>(resolve =>
        open.push(() => {
          memo.add(`${scope.slug}/${id}`)
          running -= 1
          resolve()
        })
      )
    }
  })

  /** Answer the read in flight, then let the idle gap pass. */
  const answer = async () => {
    open.shift()?.()
    await vi.advanceTimersByTimeAsync(IDLE)
  }

  return { answer, calls, memo, peak: () => peak, prefetcher }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('prefetchOrder', () => {
  it('newest first, distinct threads, capped at six', () => {
    const list = rows(['t1', 1], ['t2', 9], ['t3', 5], ['t2', 9], ['t4', 0], ['t5', 7], ['t6', 3], ['t7', 2], ['t8', 8])

    expect(THREAD_PREFETCH_CAP).toBe(6)
    expect(prefetchOrder(list)).toEqual(['t2', 't8', 't5', 't3', 't6', 't7'])
    expect(prefetchOrder(rows(['x', 0], ['y', 0], ['', 5]))).toEqual(['x', 'y'])
    expect(prefetchOrder(list, 3, 't1')).toEqual(['t1', 't2', 't8'])
  })
})

describe('createThreadPrefetcher — the warm read-ahead (R3d r4)', () => {
  it('reads the newest six one at a time, each only after the last settled', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['t1', 1], ['t2', 2], ['t3', 3], ['t4', 4], ['t5', 5], ['t6', 6], ['t7', 7], ['t8', 8]))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/t8'])

    for (let i = 0; i < 8; i += 1) {
      await cli.answer()
    }

    expect(cli.calls).toEqual(['slug-6/t8', 'slug-6/t7', 'slug-6/t6', 'slug-6/t5', 'slug-6/t4', 'slug-6/t3'])
    expect(cli.peak()).toBe(1)
    expect(cli.prefetcher.pendingIds()).toEqual([])
  })

  it('never spawns twice: remembered threads and a re-plan of the same rows cost no read', async () => {
    const cli = fakeCli()
    const list = rows(['t1', 3], ['t2', 2], ['t3', 1])

    cli.memo.add('slug-6/t2')
    cli.prefetcher.plan(A, list)
    await vi.advanceTimersByTimeAsync(IDLE)
    cli.prefetcher.plan(A, list)
    cli.prefetcher.plan(A, list)
    await cli.answer()
    await cli.answer()
    await cli.answer()
    cli.prefetcher.plan(A, list)
    await vi.advanceTimersByTimeAsync(1000)

    expect(cli.calls).toEqual(['slug-6/t1', 'slug-6/t3'])
  })

  it('an iNFT switch cancels the pending reads; the next plan is the new iNFT only', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['a1', 3], ['a2', 2], ['a3', 1]))
    await vi.advanceTimersByTimeAsync(IDLE)
    cli.prefetcher.cancel('slug-7')
    expect(cli.prefetcher.pendingIds()).toEqual(['a2', 'a3'])
    cli.prefetcher.cancel('slug-6')
    await cli.answer()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cli.calls).toEqual(['slug-6/a1'])

    cli.prefetcher.plan(A, rows(['a2', 2]))
    cli.prefetcher.plan(B, rows(['b1', 2], ['b2', 1]))
    await vi.advanceTimersByTimeAsync(IDLE)
    await cli.answer()
    await cli.answer()
    expect(cli.calls).toEqual(['slug-6/a1', 'slug-7/b1', 'slug-7/b2'])
  })

  it('a cancel before the idle gap starts nothing; a failed read moves on', async () => {
    const memo = new Set<string>()

    const read = vi.fn(async (_scope: typeof A, id: string) => {
      if (id === 'bad') {
        throw new Error('Not authenticated')
      }

      memo.add(id)
    })

    const prefetcher = createThreadPrefetcher<typeof A>({ known: (_s, id) => memo.has(id), read })

    prefetcher.plan(A, rows(['x', 1]))
    prefetcher.cancel()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(read).not.toHaveBeenCalled()

    prefetcher.plan(A, rows(['bad', 2], ['ok', 1]))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(read.mock.calls.map(call => call[1])).toEqual(['bad', 'ok'])
    expect(memo.has('ok')).toBe(true)
  })
})

describe("createThreadPrefetcher — yields to the owner's open (R3d r5)", () => {
  it('starts nothing inside the quiet window after a plan', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['t1', 1], ['t2', 2]))
    await vi.advanceTimersByTimeAsync(THREAD_READ_AHEAD_IDLE_MS - 50)
    expect(cli.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(cli.calls).toEqual(['slug-6/t2'])
  })

  it("holds every speculative read while an owner's open is in flight, then waits the quiet window", async () => {
    const cli = fakeCli()
    let settle: () => void = () => undefined

    cli.prefetcher.plan(A, rows(['t1', 1], ['t2', 2], ['t3', 3]))
    await vi.advanceTimersByTimeAsync(100)
    cli.prefetcher.yieldTo(new Promise<void>(resolve => (settle = resolve)))
    await vi.advanceTimersByTimeAsync(5000)
    expect(cli.calls).toEqual([])

    settle()
    await vi.advanceTimersByTimeAsync(THREAD_READ_AHEAD_IDLE_MS - 50)
    expect(cli.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(cli.calls).toEqual(['slug-6/t3'])

    // An open while a speculative read runs: the next one waits for it too.
    cli.prefetcher.yieldTo(new Promise<void>(resolve => (settle = resolve)))
    await cli.answer()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cli.calls).toEqual(['slug-6/t3'])
    settle()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/t3', 'slug-6/t2'])
    expect(cli.peak()).toBe(1)
  })

  it('a failed open still releases the read-ahead', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['t1', 1]))
    cli.prefetcher.yieldTo(Promise.reject(new Error('Not authenticated')))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/t1'])
  })

  it('the cursor leads: its thread is the next speculative read, never a second one beside it', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['t1', 1], ['t2', 2], ['t3', 3]), 't1')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/t1'])

    cli.prefetcher.lead(A, 't2')
    cli.prefetcher.lead(A, 't9')
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/t1'])
    expect(cli.prefetcher.pendingIds()).toEqual(['t9', 't2', 't3'])
    await cli.answer()
    expect(cli.calls).toEqual(['slug-6/t1', 'slug-6/t9'])
    expect(cli.peak()).toBe(1)

    cli.prefetcher.lead(B, 'b1')
    expect(cli.prefetcher.pendingIds()).toEqual(['b1'])
  })
})

describe('warm — the stage-time read-ahead (FE r2)', () => {
  it('hands the newest four to the CLI queue in the call itself, together (its lane runs them back to back)', async () => {
    const cli = fakeCli()

    cli.prefetcher.warm(A, rows(['t1', 1], ['t3', 3], ['t2', 2], ['t5', 5], ['t4', 4]))
    // No timer, no microtask: a read the caller queues next lands behind these.
    expect(cli.calls).toEqual(['slug-6/t5', 'slug-6/t4', 'slug-6/t3', 'slug-6/t2'])
    expect(cli.prefetcher.pendingIds()).toEqual([])

    // Nothing else starts until all answered.
    cli.prefetcher.plan(A, rows(['t6', 6]))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toHaveLength(4)

    for (let i = 0; i < 4; i++) {
      await cli.answer()
    }

    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls.slice(4)).toEqual(['slug-6/t6'])
  })

  it('a re-pin with the same rows costs nothing; changed rows wait behind the running reads', async () => {
    const cli = fakeCli()

    cli.prefetcher.warm(A, rows(['n1', 9], ['n2', 8]))
    cli.prefetcher.warm(A, rows(['n1', 9], ['n2', 8]))
    expect(cli.calls).toEqual(['slug-6/n1', 'slug-6/n2'])

    cli.prefetcher.warm(A, rows(['n0', 10], ['n1', 9], ['n2', 8]))
    expect(cli.calls).toHaveLength(2)
    expect(cli.prefetcher.pendingIds()).toEqual(['n0'])
    await cli.answer()
    await cli.answer()
    expect(cli.calls).toEqual(['slug-6/n1', 'slug-6/n2', 'slug-6/n0'])
    await cli.answer()
    cli.prefetcher.warm(A, rows(['n0', 10], ['n1', 9]))
    expect(cli.calls).toHaveLength(3)
  })

  it("waits for an open in flight; another iNFT's window plan still goes first", async () => {
    const cli = fakeCli()
    let settle: () => void = () => undefined

    cli.prefetcher.yieldTo(new Promise<void>(resolve => (settle = resolve)))
    cli.prefetcher.warm(A, rows(['n1', 9]))
    cli.prefetcher.lead(B, 'b1')
    expect(cli.calls).toEqual([])
    settle()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-7/b1'])
    await cli.answer()
    expect(cli.calls).toEqual(['slug-7/b1', 'slug-6/n1'])
  })

  it('a folder flip keeps a waiting stage warm in front of the window plan; a window close drops the plan only', async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(A, rows(['first', 9]))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(cli.calls).toEqual(['slug-6/first'])

    cli.prefetcher.warm(A, rows(['n1', 9], ['n2', 8]))
    cli.prefetcher.plan(A, rows(['arch1', 5], ['arch2', 4]))
    cli.prefetcher.plan(A, rows(['sent1', 3], ['sent2', 2]))
    expect(cli.prefetcher.pendingIds()).toEqual(['n1', 'n2', 'sent1', 'sent2'])

    await cli.answer()
    expect(cli.calls).toEqual(['slug-6/first', 'slug-6/n1', 'slug-6/n2'])
    await cli.answer()
    await cli.answer()
    expect(cli.calls).toEqual(['slug-6/first', 'slug-6/n1', 'slug-6/n2', 'slug-6/sent1'])
    expect(cli.prefetcher.pendingIds()).toEqual(['sent2'])

    cli.prefetcher.warm(A, rows(['n3', 9]))
    cli.prefetcher.plan(A, rows(['sent3', 1]))
    cli.prefetcher.cancel(A.slug)
    expect(cli.prefetcher.pendingIds()).toEqual(['n3'])
  })

  it("while it waits: the cursor's thread goes first; another iNFT's list goes before the warm; cancel() drops it", async () => {
    const cli = fakeCli()

    cli.prefetcher.plan(B, rows(['busy', 1]))
    await vi.advanceTimersByTimeAsync(IDLE)
    cli.prefetcher.warm(A, rows(['n1', 9], ['n2', 8]))
    cli.prefetcher.lead(A, 'cursor')
    expect(cli.prefetcher.pendingIds().slice(0, 3)).toEqual(['cursor', 'n1', 'n2'])

    cli.prefetcher.plan(B, rows(['b1', 1]))
    expect(cli.prefetcher.pendingIds()).toEqual(['b1', 'cursor', 'n1', 'n2'])

    cli.prefetcher.cancel()
    expect(cli.prefetcher.pendingIds()).toEqual([])
  })
})
