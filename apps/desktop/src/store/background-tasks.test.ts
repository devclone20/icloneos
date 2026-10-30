import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'

import {
  $backgroundBadge,
  $backgroundTasks,
  $stopAttempts,
  $taskSourceErrors,
  badgeOf,
  type BgTask,
  dismissTask,
  foldTasks,
  isActiveTask,
  ledgerTransitions,
  markTaskSeen,
  registerTaskSource,
  resetBackgroundTasksForTests,
  STOP_UNCONFIRMED_MS,
  STOP_VERIFY_MS,
  type StopResult,
  stopTask,
  type TaskSource
} from './background-tasks'

const LEDGER_KEY = ICLONE_STORAGE.backgroundTasksLedger.key

function task(source: string, native: string, patch: Partial<BgTask> = {}): BgTask {
  return {
    id: `${source}:${native}`,
    kind: 'shell',
    lastLine: null,
    lastLineAt: null,
    seen: true,
    source,
    startedAt: null,
    state: 'running',
    stop: 'none',
    title: native,
    ...patch
  }
}

/** A source the test drives by hand: `set` replaces its snapshot and notifies the registry. */
function fakeSource(
  id: string,
  stop: (native: string) => Promise<StopResult> = () => Promise.resolve({ ok: true, effect: 'killed' })
) {
  let tasks: BgTask[] = []
  let failure: string | null = null
  const listeners = new Set<() => void>()

  const src: TaskSource = {
    id,
    snapshot: () => {
      if (failure) {
        throw new Error(failure)
      }

      return tasks
    },
    stop: vi.fn(stop),
    subscribe(cb) {
      listeners.add(cb)

      return () => listeners.delete(cb)
    }
  }

  return {
    fail(message: string | null) {
      failure = message
      listeners.forEach(cb => cb())
    },
    set(next: BgTask[]) {
      tasks = next
      listeners.forEach(cb => cb())
    },
    src
  }
}

const byId = (id: string) => $backgroundTasks.get().find(t => t.id === id)

beforeEach(() => {
  window.localStorage.clear()
  resetBackgroundTasksForTests()
})

afterEach(() => {
  resetBackgroundTasksForTests()
  window.localStorage.clear()
})

describe('ledgerTransitions — the died-unnoticed rule', () => {
  const running = task('shell', 's/1')

  it.each([
    ['exited non-zero', { exit: { code: 2 }, state: 'failed' as const }],
    ['killed by a signal', { exit: { signal: 'SIGKILL' }, state: 'failed' as const }],
    ['reported failed with no exit', { state: 'failed' as const }]
  ])('running → %s ⇒ died, unseen', (_label, patch) => {
    const [entry] = ledgerTransitions([running], [task('shell', 's/1', patch)], new Set(), 10)

    expect(entry?.task.state).toBe('died')
    expect(entry?.task.seen).toBe(false)
    expect(entry?.task.stop).toBe('none')
    expect(entry?.at).toBe(10)
  })

  it('running → absent ⇒ died (the registry forgot it, nobody saw it end)', () => {
    expect(ledgerTransitions([running], [], new Set(), 1).map(e => e.task.state)).toEqual(['died'])
  })

  it('a panel stop that did not take, then the session is lost ⇒ "Session ended", not "Stopped by you" (r4 MAJOR-5)', () => {
    const [entry] = ledgerTransitions([running], [], new Set([running.id]), 1, () => 'session')

    expect(entry?.task).toMatchObject({ endedBy: 'session', seen: true, state: 'stopped' })
  })

  it("a stopped job seen exiting before its session is lost stays the owner's (control)", () => {
    const exited = task('shell', 's/1', { exit: { code: 1 }, state: 'failed' })
    const [entry] = ledgerTransitions([running], [exited], new Set([running.id]), 1, () => 'session')

    expect(entry?.task).toMatchObject({ endedBy: 'owner', exit: { code: 1 }, state: 'stopped' })
  })

  it('stopped through the panel ⇒ stopped (seen), never died', () => {
    const [entry] = ledgerTransitions([running], [], new Set([running.id]), 1)

    expect(entry?.task.state).toBe('stopped')
    expect(entry?.task.seen).toBe(true)
  })

  it.each(['owner', 'rewind', 'session'] as const)(
    'a vanish its source explains (%s) ⇒ stopped with that reason, seen, never died',
    reason => {
      const explain = vi.fn(() => reason)
      const [entry] = ledgerTransitions([running], [], new Set(), 1, explain)

      expect(explain).toHaveBeenCalledWith(running.id)
      expect(entry?.task).toMatchObject({ endedBy: reason, seen: true, state: 'stopped' })
    }
  )

  it('a failure still in the snapshot is never explained away; a panel stop reads "owner"', () => {
    const explain = vi.fn(() => 'session' as const)
    const failed = task('shell', 's/1', { exit: { code: 2 }, state: 'failed' })

    expect(ledgerTransitions([running], [failed], new Set(), 1, explain)[0]?.task.state).toBe('died')
    expect(explain).not.toHaveBeenCalled()
    expect(ledgerTransitions([running], [], new Set([running.id]), 1)[0]?.task.endedBy).toBe('owner')
    expect(ledgerTransitions([running], [], new Set(), 1, () => null)[0]?.task).not.toHaveProperty('endedBy')
  })

  it('running → done with exit 0, and anything that was not running, record nothing', () => {
    expect(
      ledgerTransitions([running], [task('shell', 's/1', { exit: { code: 0 }, state: 'done' })], new Set(), 1)
    ).toEqual([])
    expect(ledgerTransitions([task('shell', 's/1', { state: 'waiting' })], [], new Set(), 1)).toEqual([])
    expect(ledgerTransitions([task('shell', 's/1', { state: 'done' })], [], new Set(), 1)).toEqual([])
  })

  it('keeps the dying snapshot (exit and last line) over the last running one', () => {
    const after = task('shell', 's/1', { exit: { code: 137 }, lastLine: 'Killed', state: 'failed' })
    const [entry] = ledgerTransitions([{ ...running, lastLine: 'tick' }], [after], new Set(), 1)

    expect(entry?.task.exit).toEqual({ code: 137 })
    expect(entry?.task.lastLine).toBe('Killed')
  })
})

describe('foldTasks', () => {
  it('lays the ledger over live tasks, orders unseen deaths first, then waiting, running, the rest', () => {
    const tasks = foldTasks(
      [
        [task('a', '1', { startedAt: 1 }), task('a', '2', { state: 'done' }), task('a', '3', { state: 'failed' })],
        [task('b', '1', { state: 'waiting' }), task('b', '2', { startedAt: 5 })]
      ],
      [
        { at: 1, task: task('a', '3', { seen: false, state: 'died' }) },
        { at: 1, task: task('z', 'old', { seen: true, state: 'died' }) }
      ]
    )

    expect(tasks.map(t => `${t.id}=${t.state}`)).toEqual([
      'a:3=died',
      'b:1=waiting',
      'b:2=running',
      'a:1=running',
      'z:old=died',
      'a:2=done'
    ])
  })

  it('R3: session-scoped rows of the same session fold into one — waiting wins, the newest line wins', () => {
    const agent = task('agent', 'p/1', { kind: 'agent', lastLine: 'reading', lastLineAt: 1, sessionId: 'child' })

    const ask = task('perm', 'child', {
      kind: 'agent',
      lastLine: 'terminal · rm -rf',
      lastLineAt: 9,
      sessionId: 'child',
      state: 'waiting'
    })

    const pane = task('pane', 'x', { kind: 'pane', sessionId: 'child' })
    const shell = task('shell', 'child/p1', { sessionId: 'child' })

    const tasks = foldTasks([[agent], [ask], [pane], [shell]], [])

    expect(tasks).toHaveLength(2)
    expect(tasks.find(t => t.id === 'agent:p/1')).toMatchObject({ lastLine: 'terminal · rm -rf', state: 'waiting' })
    // A shell job is its own work, never folded into the agent that started it.
    expect(tasks.some(t => t.id === 'shell:child/p1')).toBe(true)
  })

  it('a pane that leads takes the agent kind of the row folded into it', () => {
    const [only] = foldTasks(
      [[task('pane', 'x', { kind: 'pane', sessionId: 's' })], [task('agent', 'y', { kind: 'agent', sessionId: 's' })]],
      []
    )

    expect(only?.kind).toBe('agent')
  })
})

describe('the registry', () => {
  it("folds every registered source and reads a source failure as that source's error only", () => {
    expect($taskSourceErrors.get()).toBeNull()

    const a = fakeSource('a')
    const b = fakeSource('b')

    registerTaskSource(a.src)
    registerTaskSource(b.src)
    a.set([task('a', '1')])
    b.set([task('b', '1', { state: 'waiting' })])

    expect(
      $backgroundTasks
        .get()
        .map(t => t.id)
        .sort()
    ).toEqual(['a:1', 'b:1'])
    expect($taskSourceErrors.get()).toEqual([])

    b.fail('bridge gone')

    // The failing source is named; its last good tasks are not "gone", so nothing is called dead.
    expect($taskSourceErrors.get()).toEqual([{ detail: 'bridge gone', source: 'b' }])
    expect(
      $backgroundTasks
        .get()
        .map(t => t.id)
        .sort()
    ).toEqual(['a:1', 'b:1'])
    expect($backgroundBadge.get()).toEqual({ active: 2, diedUnseen: 0 })
  })

  it('records a death across snapshots, persists it in ONE key, and keeps it after the source forgets', () => {
    const a = fakeSource('a')

    registerTaskSource(a.src)
    a.set([task('a', '1'), task('a', '2')])
    a.set([task('a', '2'), task('a', '1', { exit: { signal: 'SIGKILL' }, state: 'failed' })])
    a.set([task('a', '2')])

    expect(byId('a:1')).toMatchObject({ seen: false, state: 'died' })
    expect($backgroundBadge.get()).toEqual({ active: 1, diedUnseen: 1 })

    const stored = JSON.parse(window.localStorage.getItem(LEDGER_KEY) ?? '[]') as { task: BgTask }[]

    expect(stored.map(e => [e.task.id, e.task.state, e.task.seen])).toEqual([['a:1', 'died', false]])
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))

    expect(keys.filter(k => k?.startsWith('iclone.bgTasks'))).toEqual([LEDGER_KEY])

    // A restart reads it back.
    resetBackgroundTasksForTests()
    expect(byId('a:1')).toMatchObject({ seen: false, state: 'died' })
  })

  it('opening the row marks it seen (the mark clears, the row stays); dismiss removes it', () => {
    const a = fakeSource('a')

    registerTaskSource(a.src)
    a.set([task('a', '1')])
    a.set([])
    markTaskSeen('a:1')

    expect(byId('a:1')).toMatchObject({ seen: true, state: 'died' })
    expect($backgroundBadge.get().diedUnseen).toBe(0)

    dismissTask('a:1')
    expect(byId('a:1')).toBeUndefined()
    expect(window.localStorage.getItem(LEDGER_KEY)).toBe('[]')
  })

  it('unregistering a source drops its tasks without calling them dead', () => {
    const a = fakeSource('a')
    const off = registerTaskSource(a.src)

    a.set([task('a', '1')])
    off()

    expect($backgroundTasks.get()).toEqual([])
    expect($backgroundBadge.get()).toEqual({ active: 0, diedUnseen: 0 })
  })

  it('ignores a corrupt ledger on disk instead of throwing', () => {
    window.localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify([{ nope: 1 }, { at: 1, task: { id: 'x', title: 't', state: 'running', seen: false } }])
    )
    resetBackgroundTasksForTests()

    expect($backgroundTasks.get()).toEqual([])
  })
})

describe('honest stop (contract §2.7, G4)', () => {
  /** The verdict timers, in order; the "Can't confirm" timers are kept apart so each can be fired on its own. */
  const scheduled: (() => void)[] = []
  const unconfirmTimers: (() => void)[] = []

  const schedule = (fn: () => void, ms: number) =>
    void (ms === STOP_UNCONFIRMED_MS ? unconfirmTimers : scheduled).push(fn)

  beforeEach(() => {
    scheduled.length = 0
    unconfirmTimers.length = 0
  })

  it('a real stop: the row stays running until a snapshot says otherwise, then reads stopped — never died', async () => {
    const a = fakeSource('a')

    registerTaskSource(a.src)
    a.set([task('a', '1', { stop: 'real' })])

    await stopTask('a:1', schedule)

    expect(a.src.stop).toHaveBeenCalledWith('1')
    expect(byId('a:1')?.state).toBe('running')
    expect($stopAttempts.get()['a:1']?.phase).toBe('pending')

    a.set([task('a', '1', { exit: { signal: 'SIGTERM' }, state: 'failed' })])
    scheduled.forEach(fn => fn())

    expect(byId('a:1')).toMatchObject({ seen: true, state: 'stopped' })
    expect($stopAttempts.get()['a:1']).toBeUndefined()
  })

  it('NEGATIVE CONTROL: a gateway that acknowledges the kill but kills nothing ⇒ "Did not stop", not stopped', async () => {
    const a = fakeSource('a', () => Promise.resolve({ effect: 'killed', ok: true, detail: 'still alive' }))

    registerTaskSource(a.src)
    a.set([task('a', '1', { stop: 'real' })])

    await stopTask('a:1', schedule)
    expect(scheduled).toHaveLength(1)

    scheduled[0]!()

    expect(byId('a:1')?.state).toBe('running')
    expect($stopAttempts.get()['a:1']).toEqual({ detail: 'still alive', effect: 'killed', phase: 'failed' })
  })

  it('the verdict waits STOP_VERIFY_MS (3 s) with the real timer', async () => {
    vi.useFakeTimers()

    try {
      const a = fakeSource('a')

      registerTaskSource(a.src)
      a.set([task('a', '1', { stop: 'real' })])
      await stopTask('a:1')

      vi.advanceTimersByTime(STOP_VERIFY_MS - 1)
      expect($stopAttempts.get()['a:1']?.phase).toBe('pending')
      vi.advanceTimersByTime(1)
      expect($stopAttempts.get()['a:1']?.phase).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a source that re-reads: no verdict until a reading lands; an unreadable source is asked again, never guessed', async () => {
    const a = fakeSource('a')
    const readings = [false, true]

    a.src.reread = vi.fn(() => Promise.resolve(readings.shift() ?? true))
    registerTaskSource(a.src)
    a.set([task('a', '1', { stop: 'real' })])
    await stopTask('a:1', schedule)

    scheduled.shift()!()
    await vi.waitFor(() => expect(scheduled).toHaveLength(1))
    expect(a.src.reread).toHaveBeenCalledWith('1')
    expect($stopAttempts.get()['a:1']?.phase).toBe('pending')

    scheduled.shift()!()
    await vi.waitFor(() => expect($stopAttempts.get()['a:1']?.phase).toBe('failed'))
  })

  it("a Retry is judged on its own clock: the first press's verdict does not land on the second", async () => {
    const a = fakeSource('a')

    registerTaskSource(a.src)
    a.set([task('a', '1', { stop: 'real' })])
    await stopTask('a:1', schedule)
    await stopTask('a:1', schedule)

    scheduled[0]!()
    expect($stopAttempts.get()['a:1']?.phase).toBe('pending')

    scheduled[1]!()
    expect($stopAttempts.get()['a:1']?.phase).toBe('failed')
  })

  it('a refused or unsupported stop is a failure at once, and the source is never asked for stop:none rows', async () => {
    const refused = fakeSource('r', () => Promise.reject(new Error('process not found')))
    const none = fakeSource('n')

    registerTaskSource(refused.src)
    registerTaskSource(none.src)
    refused.set([task('r', '1', { stop: 'real' })])
    none.set([task('n', '1', { stop: 'none' })])

    await stopTask('r:1', schedule)
    await stopTask('n:1', schedule)

    expect($stopAttempts.get()['r:1']).toEqual({ detail: 'process not found', effect: 'killed', phase: 'failed' })
    expect($stopAttempts.get()['n:1']?.effect).toBe('unsupported')
    expect(none.src.stop).not.toHaveBeenCalled()

    // The owner asked: even a refused stop makes the job's later end theirs, never a death.
    refused.set([])
    expect(byId('r:1')).toMatchObject({ endedBy: 'owner', seen: true, state: 'stopped' })
  })

  describe('MAJOR-4: once the owner asked, the end is theirs, however late it comes', () => {
    it.each([
      ['a SIGTERM exit', { exit: { signal: 'SIGTERM' }, state: 'failed' as const }],
      ['a non-zero exit', { exit: { code: 1 }, state: 'failed' as const }],
      ['a vanish', null]
    ])('after "Did not stop", %s reads "Stopped by you", seen, no death', async (_label, after) => {
      const a = fakeSource('a')

      registerTaskSource(a.src)
      a.set([task('a', '1', { stop: 'real' })])
      await stopTask('a:1', schedule)
      scheduled.shift()!()
      expect($stopAttempts.get()['a:1']?.phase).toBe('failed')

      a.set(after ? [task('a', '1', after)] : [])

      expect(byId('a:1')).toMatchObject({ endedBy: 'owner', seen: true, state: 'stopped' })
      expect($backgroundBadge.get().diedUnseen).toBe(0)
    })

    it('CONTROL: a job nobody asked to stop still dies', () => {
      const a = fakeSource('a')

      registerTaskSource(a.src)
      a.set([task('a', '1', { stop: 'real' })])
      a.set([])

      expect(byId('a:1')).toMatchObject({ seen: false, state: 'died' })
    })
  })

  describe('minor-8: no reading for STOP_UNCONFIRMED_MS ⇒ "Can\'t confirm", and a later reading still decides', () => {
    const unreadable = () => {
      const a = fakeSource('a')
      const fresh = { now: false }

      a.src.reread = vi.fn(() => Promise.resolve(fresh.now))
      registerTaskSource(a.src)
      a.set([task('a', '1', { stop: 'real' })])

      return { a, fresh }
    }

    it('turns "Stopping…" into "unconfirmed", never "failed" and never a death', async () => {
      unreadable()
      await stopTask('a:1', schedule)
      scheduled.shift()!()
      await vi.waitFor(() => expect(scheduled).toHaveLength(1))
      expect($stopAttempts.get()['a:1']?.phase).toBe('pending')

      unconfirmTimers.shift()!()

      expect($stopAttempts.get()['a:1']).toMatchObject({ phase: 'unconfirmed' })
      expect(byId('a:1')?.state).toBe('running')
    })

    it.each([
      ['still running ⇒ "Did not stop"', true],
      ['gone ⇒ cleared, "Stopped by you"', false]
    ])('a reading that lands later decides: %s', async (_label, stillRunning) => {
      const { a, fresh } = unreadable()

      await stopTask('a:1', schedule)
      scheduled.shift()!()
      await vi.waitFor(() => expect(scheduled).toHaveLength(1))
      unconfirmTimers.shift()!()

      fresh.now = true

      if (!stillRunning) {
        a.set([])
      }

      scheduled.shift()!()

      if (stillRunning) {
        await vi.waitFor(() => expect($stopAttempts.get()['a:1']?.phase).toBe('failed'))
      } else {
        await vi.waitFor(() => expect($stopAttempts.get()['a:1']).toBeUndefined())
        expect(byId('a:1')).toMatchObject({ endedBy: 'owner', state: 'stopped' })
      }
    })

    it.each([
      ['"Did not stop" from a reading', () => Promise.resolve<StopResult>({ effect: 'killed', ok: true })],
      ['a refused kill', () => Promise.reject(new Error('process not found'))]
    ])('a verdict that already landed (%s) is never replaced by "Can\'t confirm"', async (_label, stop) => {
      const a = fakeSource('a', stop)

      registerTaskSource(a.src)
      a.set([task('a', '1', { stop: 'real' })])
      await stopTask('a:1', schedule)
      scheduled.shift()?.()
      unconfirmTimers.shift()!()

      expect($stopAttempts.get()['a:1']?.phase).toBe('failed')
    })
  })
})

/**
 * G2 — the badge is derived. 1 000 random operations over several sources (spawn, wait, finish, die by exit, die by
 * signal, vanish, stop, dismiss, open); after each one the badge must equal the count of running|waiting rows in the
 * fold, and the unseen-death mark must equal the unseen `died` rows. A seeded generator keeps a failure replayable.
 */
describe('G2 — the badge never drifts from the list (property test)', () => {
  it('1 000 random ops, 0 mismatches', async () => {
    let seed = 0x5eed

    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31

      return seed % n
    }

    const sources = ['shell', 'agent', 'cron', 'perm'].map(id => fakeSource(id))
    const live = new Map<string, BgTask[]>(sources.map(s => [s.src.id, []]))

    sources.forEach(s => registerTaskSource(s.src))

    let next = 0
    let mismatches = 0
    let examined = 0
    const ops = ['spawn', 'wait', 'finish', 'exit', 'signal', 'vanish', 'stop', 'dismiss', 'open'] as const

    for (let i = 0; i < 1_000; i += 1) {
      const s = sources[rand(sources.length)]!
      const tasks = live.get(s.src.id)!
      const op = ops[rand(ops.length)]!
      const pick = tasks.length > 0 ? rand(tasks.length) : -1
      const target = pick >= 0 ? tasks[pick]! : null

      const replace = (patch: Partial<BgTask>) => {
        tasks[pick] = { ...target!, ...patch }
      }

      if (op === 'spawn' || !target) {
        tasks.push(task(s.src.id, String((next += 1)), { stop: 'real' }))
      } else if (op === 'wait') {
        replace({ state: target.state === 'waiting' ? 'running' : 'waiting' })
      } else if (op === 'finish') {
        replace({ exit: { code: 0 }, state: 'done' })
      } else if (op === 'exit') {
        replace({ exit: { code: 1 + rand(255) }, state: 'failed' })
      } else if (op === 'signal') {
        replace({ exit: { signal: 'SIGKILL' }, state: 'failed' })
      } else if (op === 'vanish') {
        tasks.splice(pick, 1)
      } else if (op === 'stop') {
        await stopTask(target.id, () => undefined)
        tasks.splice(pick, 1)
      } else {
        const shown = $backgroundTasks.get()
        const remembered = shown.filter(t => t.state === 'died' || t.state === 'stopped')
        const victim = remembered[rand(Math.max(1, remembered.length))]

        if (victim) {
          op === 'dismiss' ? dismissTask(victim.id) : markTaskSeen(victim.id)
        }
      }

      s.set([...tasks])

      const fold = $backgroundTasks.get()
      const badge = $backgroundBadge.get()

      examined += fold.length

      if (
        badge.active !== fold.filter(t => t.state === 'running' || t.state === 'waiting').length ||
        badge.diedUnseen !== fold.filter(t => t.state === 'died' && !t.seen).length ||
        badge.active !== fold.filter(isActiveTask).length
      ) {
        mismatches += 1
      }
    }

    expect(mismatches).toBe(0)
    // A property test that examined nothing proves nothing.
    expect(examined).toBeGreaterThan(1_000)
    expect(badgeOf([])).toEqual({ active: 0, diedUnseen: 0 })
  })
})
