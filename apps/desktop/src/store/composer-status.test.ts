import { JsonRpcGatewayError } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearSingleFlightSessionResumeState } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { $providerBlock } from '@/lib/provider-block'

import {
  $backgroundGoneSessions,
  $backgroundStatusBySession,
  $backgroundStopWatch,
  backgroundDismissalOf,
  dismissBackgroundProcess,
  isSessionGoneForBackgroundPolling,
  reconcileBackgroundProcesses,
  refreshBackgroundProcesses,
  resetBackgroundPollingGuard,
  resetSessionBackground,
  stopBackgroundProcess
} from './composer-status'
import { $gateway } from './gateway'
import { $sessionStates } from './session-states'

// The resume resolves the owning profile through a REST read; the poll test
// only cares about the gateway sequence.
vi.mock('@/app/session/hooks/use-session-actions/utils', () => ({ resolveSessionProfile: async () => undefined }))

const SID = 'sess-1'

const running = (id: string, command = `cmd ${id}`) => ({ command, session_id: id, status: 'running' })

const exited = (id: string, exit_code = 0, command = `cmd ${id}`) => ({
  command,
  exit_code,
  session_id: id,
  status: 'exited'
})

const items = () => $backgroundStatusBySession.get()[SID] ?? []

describe('reconcileBackgroundProcesses', () => {
  beforeEach(() => {
    // Fake timers so the success self-clear (a real setTimeout) is deterministic
    // and never leaks a pending timer between tests.
    vi.useFakeTimers()
    $backgroundStatusBySession.set({})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('maps registry entries to status items', () => {
    reconcileBackgroundProcesses(SID, [running('a'), exited('b', 0), exited('c', 1)])

    expect(items().map(i => [i.id, i.state])).toEqual([
      ['a', 'running'],
      ['b', 'done'],
      ['c', 'failed']
    ])
    expect(items()[2]!.exitCode).toBe(1)
  })

  it('keeps row order stable when a process flips state or the snapshot reorders', () => {
    reconcileBackgroundProcesses(SID, [running('a'), running('b')])
    // Snapshot arrives reordered AND `a` has exited — rows must not move.
    reconcileBackgroundProcesses(SID, [running('b'), exited('a', 0)])

    expect(items().map(i => [i.id, i.state])).toEqual([
      ['a', 'done'],
      ['b', 'running']
    ])
  })

  it('appends new processes after existing rows', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    reconcileBackgroundProcesses(SID, [running('b'), running('a')])

    expect(items().map(i => i.id)).toEqual(['a', 'b'])
  })

  it('preserves object identity for unchanged rows (memo stability)', () => {
    reconcileBackgroundProcesses(SID, [running('a'), running('b')])
    const [a1] = items()

    reconcileBackgroundProcesses(SID, [running('a'), exited('b', 0)])
    const [a2, b2] = items()

    expect(a2).toBe(a1)
    expect(b2!.state).toBe('done')
  })

  it('is a no-op store write when nothing changed', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    const before = $backgroundStatusBySession.get()

    reconcileBackgroundProcesses(SID, [running('a')])

    expect($backgroundStatusBySession.get()).toBe(before)
  })

  it('never resurrects a dismissed process while the registry still reports it', () => {
    reconcileBackgroundProcesses(SID, [exited('a', 0), running('b')])
    dismissBackgroundProcess(SID, 'a')

    reconcileBackgroundProcesses(SID, [exited('a', 0), running('b')])

    expect(items().map(i => i.id)).toEqual(['b'])
  })

  it('forgets a dismissal once the registry prunes the process', () => {
    reconcileBackgroundProcesses(SID, [exited('a', 0)])
    dismissBackgroundProcess(SID, 'a')

    // Registry pruned it…
    reconcileBackgroundProcesses(SID, [])
    // …so a future process reusing the id (new spawn) shows again.
    reconcileBackgroundProcesses(SID, [running('a')])

    expect(items().map(i => i.id)).toEqual(['a'])
  })

  it('drops the session key entirely when the last row goes away', () => {
    reconcileBackgroundProcesses(SID, [running('a')])
    reconcileBackgroundProcesses(SID, [])

    expect($backgroundStatusBySession.get()).toEqual({})
  })

  // The self-clear path calls dismissBackgroundProcess, which records the id in
  // the module-level dismissed set; use a fresh session per test so that record
  // can't bleed into another test's reconcile.
  const itemsOf = (sid: string) => $backgroundStatusBySession.get()[sid] ?? []

  it('self-clears a finished success after a short linger', () => {
    reconcileBackgroundProcesses('sess-clear', [exited('a', 0)])
    expect(itemsOf('sess-clear').map(i => i.id)).toEqual(['a'])

    vi.advanceTimersByTime(5_000)

    expect(itemsOf('sess-clear')).toEqual([])
  })

  it('self-clears a failed task too, but only after a longer linger', () => {
    reconcileBackgroundProcesses('sess-fail', [exited('a', 1)])

    // Still visible after the success window — the failure gets a longer one so
    // its exit code stays readable.
    vi.advanceTimersByTime(5_000)
    expect(itemsOf('sess-fail').map(i => [i.id, i.state])).toEqual([['a', 'failed']])

    vi.advanceTimersByTime(10_000)
    expect(itemsOf('sess-fail')).toEqual([])
  })

  it('never self-clears a still-running task', () => {
    reconcileBackgroundProcesses('sess-run', [running('a')])

    vi.advanceTimersByTime(60_000)

    expect(itemsOf('sess-run').map(i => i.id)).toEqual(['a'])
  })

  it('arms the self-clear only once a task finishes', () => {
    reconcileBackgroundProcesses('sess-arm', [running('a')])
    vi.advanceTimersByTime(60_000)
    // Still running after a minute — nothing scheduled yet.
    expect(itemsOf('sess-arm').map(i => i.id)).toEqual(['a'])

    reconcileBackgroundProcesses('sess-arm', [exited('a', 0)])
    vi.advanceTimersByTime(5_000)

    expect(itemsOf('sess-arm')).toEqual([])
  })
})

// ── Dead-session polling guard (#94219 fallout) ──────────────────────────────
// The status stack polls `process.list` every 5s while a background row is on
// screen. `process.list` is session-scoped: against a runtime id the gateway no
// longer holds it returns 4001 "session not found". That failure was swallowed
// as "transient socket loss", so the poll re-sent the SAME dead id every 5s for
// the life of the window — 18,614 rejections against a single runtime id in one
// day on a real machine, and the log line the user reads as "session not found".
//
// A gone session is terminal, not transient: stop polling it.
describe('V3-A readable exports: why a row left, and which sessions are gone', () => {
  afterEach(() => {
    $backgroundStatusBySession.set({})
    $backgroundStopWatch.set({})
    $gateway.set(null)
    resetBackgroundPollingGuard()
    vi.useRealTimers()
  })

  it('a running row that leaves the stack is watched until the registry confirms it exited', () => {
    $gateway.set({ request: () => Promise.resolve({}) } as never)
    reconcileBackgroundProcesses('sw-1', [running('a'), running('b')])

    dismissBackgroundProcess('sw-1', 'a')
    expect($backgroundStopWatch.get()['sw-1']?.a).toMatchObject({ failed: false, item: { state: 'running' } })

    reconcileBackgroundProcesses('sw-1', [exited('a', -15), running('b')])

    expect($backgroundStopWatch.get()['sw-1']).toBeUndefined()
    expect(backgroundDismissalOf('sw-1', 'a')).toBe('owner')
    // The X never resurrects the row in the stack.
    expect(($backgroundStatusBySession.get()['sw-1'] ?? []).map(item => item.id)).toEqual(['b'])
  })

  it('a watched process still running STOP_VERIFY_MS after the X is a failed stop; the owner stays its reason', () => {
    vi.useFakeTimers()
    $gateway.set({ request: () => Promise.resolve({}) } as never)
    reconcileBackgroundProcesses('sw-2', [running('a')])
    dismissBackgroundProcess('sw-2', 'a')

    vi.advanceTimersByTime(2_999)
    reconcileBackgroundProcesses('sw-2', [running('a')])
    expect($backgroundStopWatch.get()['sw-2']?.a?.failed).toBe(false)

    vi.advanceTimersByTime(1)
    reconcileBackgroundProcesses('sw-2', [running('a')])
    expect($backgroundStopWatch.get()['sw-2']?.a?.failed).toBe(true)
    // MAJOR-4: the kill outlived its window, but the owner asked: whenever the job ends, the end is theirs.
    expect(backgroundDismissalOf('sw-2', 'a')).toBe('owner')
    expect($backgroundStatusBySession.get()['sw-2']).toBeUndefined()

    // Its exit, however late, ends the watch with the reason still readable; the row never returns to the stack.
    vi.advanceTimersByTime(27_000)
    reconcileBackgroundProcesses('sw-2', [exited('a', -15)])
    expect($backgroundStopWatch.get()['sw-2']).toBeUndefined()
    expect(backgroundDismissalOf('sw-2', 'a')).toBe('owner')
    expect($backgroundStatusBySession.get()['sw-2']).toBeUndefined()
  })

  it("minor-11: an X whose kill the gateway refused is still the owner's stop, shown as did-not-stop", async () => {
    $gateway.set({ request: () => Promise.reject(new Error('not connected')) } as never)
    reconcileBackgroundProcesses('sw-11', [running('a')])

    await stopBackgroundProcess('sw-11', 'a')

    expect(backgroundDismissalOf('sw-11', 'a')).toBe('owner')
    expect($backgroundStopWatch.get()['sw-11']?.a?.failed).toBe(true)
  })

  it('minor-8: a watch no reading decided in 15 s turns unconfirmed; a later reading still decides it', () => {
    vi.useFakeTimers()
    $gateway.set({ request: () => new Promise(() => undefined) } as never)
    reconcileBackgroundProcesses('sw-3', [running('a'), running('b')])
    dismissBackgroundProcess('sw-3', 'a')
    dismissBackgroundProcess('sw-3', 'b')

    vi.advanceTimersByTime(14_999)
    expect($backgroundStopWatch.get()['sw-3']?.a?.unconfirmed).toBe(false)
    vi.advanceTimersByTime(1)
    expect($backgroundStopWatch.get()['sw-3']?.a).toMatchObject({ failed: false, unconfirmed: true })

    reconcileBackgroundProcesses('sw-3', [running('a')])
    expect($backgroundStopWatch.get()['sw-3']?.a).toMatchObject({ failed: true })
    expect($backgroundStopWatch.get()['sw-3']?.b).toBeUndefined()
    expect(backgroundDismissalOf('sw-3', 'b')).toBeNull()
  })

  it('minor-8: a watch already judged "did not stop" is never turned unconfirmed', () => {
    vi.useFakeTimers()
    $gateway.set({ request: () => Promise.resolve({}) } as never)
    reconcileBackgroundProcesses('sw-4', [running('a')])
    dismissBackgroundProcess('sw-4', 'a')

    vi.advanceTimersByTime(3_000)
    reconcileBackgroundProcesses('sw-4', [running('a')])
    vi.advanceTimersByTime(12_000)

    expect($backgroundStopWatch.get()['sw-4']?.a).toMatchObject({ failed: true, unconfirmed: false })
  })

  it('an X records "owner", a rewind "rewind"; an id never dismissed is null', () => {
    $gateway.set({ request: () => Promise.resolve({}) } as never)
    reconcileBackgroundProcesses('dz-1', [running('a'), running('b')])

    dismissBackgroundProcess('dz-1', 'a')
    resetSessionBackground('dz-1')

    expect(backgroundDismissalOf('dz-1', 'a')).toBe('owner')
    expect(backgroundDismissalOf('dz-1', 'b')).toBe('rewind')
    expect(backgroundDismissalOf('dz-1', 'c')).toBeNull()
  })

  it('$backgroundGoneSessions publishes the 4001 latch and its reset', async () => {
    $gateway.set({
      request: () => Promise.reject(new JsonRpcGatewayError('session not found', { code: 4001 }))
    } as never)

    await refreshBackgroundProcesses('gone-1')
    expect([...$backgroundGoneSessions.get()]).toEqual(['gone-1'])

    resetBackgroundPollingGuard('gone-1')
    expect($backgroundGoneSessions.get().size).toBe(0)
  })
})

describe('refreshBackgroundProcesses dead-session guard', () => {
  beforeEach(() => {
    $backgroundStatusBySession.set({})
    resetBackgroundPollingGuard()
  })

  afterEach(() => {
    $gateway.set(null as never)
    resetBackgroundPollingGuard()
  })

  it('classifies a 4001 session-not-found as gone, and a timeout as transient', () => {
    expect(isSessionGoneForBackgroundPolling(new Error('session not found'))).toBe(true)
    expect(isSessionGoneForBackgroundPolling(new Error('4001 session not found'))).toBe(true)
    expect(isSessionGoneForBackgroundPolling(new Error('Session Not Found'))).toBe(true)

    // Transient failures must NOT latch the guard — the session may still be alive.
    expect(isSessionGoneForBackgroundPolling(new Error('request timed out after 30s: process.list'))).toBe(false)
    expect(isSessionGoneForBackgroundPolling(new Error('not connected'))).toBe(false)
  })

  it('stops re-polling a session after the gateway reports it gone', async () => {
    const request = vi.fn(async () => {
      throw new Error('session not found')
    })

    $gateway.set({ request } as never)

    // First poll discovers the session is gone.
    await refreshBackgroundProcesses(SID)
    expect(request).toHaveBeenCalledTimes(1)

    // Every subsequent tick must be suppressed. Before the fix these all went
    // to the wire and each produced another gateway-side 4001.
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a transient failure', async () => {
    const request = vi.fn(async () => {
      throw new Error('request timed out after 30s: process.list')
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)

    // A timeout is not proof of death — the poll must retry.
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not suppress a different, healthy session', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.session_id === SID) {
        throw new Error('session not found')
      }

      return { processes: [] }
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses('sess-healthy')
    await refreshBackgroundProcesses('sess-healthy')

    const targets = request.mock.calls.map(c => (c[1] as { session_id?: string } | undefined)?.session_id)
    expect(targets.filter(t => t === SID)).toHaveLength(1)
    expect(targets.filter(t => t === 'sess-healthy')).toHaveLength(2)
  })

  it('resumes polling a session that comes back (guard cleared on rebind)', async () => {
    const request = vi.fn(async () => {
      throw new Error('session not found')
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)
    expect(request).toHaveBeenCalledTimes(1)

    // A fresh runtime bound to this session id clears the guard.
    resetBackgroundPollingGuard(SID)
    await refreshBackgroundProcesses(SID)

    expect(request).toHaveBeenCalledTimes(2)
  })
})

// ── Review-thread hardenings on the guard (#94950) ───────────────────────────
describe('refreshBackgroundProcesses dead-session guard hardenings', () => {
  beforeEach(() => {
    $backgroundStatusBySession.set({})
    resetBackgroundPollingGuard()
  })

  afterEach(() => {
    $gateway.set(null as never)
    resetBackgroundPollingGuard()
  })

  it('matches the structured 4001 code, not a message substring, when a code is present', () => {
    // Structured gateway rejection: the code decides, both directions.
    expect(isSessionGoneForBackgroundPolling(new JsonRpcGatewayError('session not found', { code: 4001 }))).toBe(true)
    expect(isSessionGoneForBackgroundPolling(new JsonRpcGatewayError('gone', { code: 4001 }))).toBe(true)

    // An unrelated coded error whose text merely MENTIONS the phrase must not
    // latch — that would freeze the status stack on a healthy session.
    expect(
      isSessionGoneForBackgroundPolling(
        new JsonRpcGatewayError('tool failed: upstream said session not found', { code: 5007 })
      )
    ).toBe(false)

    // Codeless errors keep the message fallback (legacy frames).
    expect(isSessionGoneForBackgroundPolling(new JsonRpcGatewayError('session not found'))).toBe(true)
  })

  /**
   * minor-9 (critic r3, R2): a `process.list` sent before a rebind answers "session not found" for the runtime the
   * rebind replaced. Landing before any post-rebind reading, it must not latch the rebound session as gone.
   */
  it.each([
    ['a rebind of that session', () => resetBackgroundPollingGuard(SID)],
    ['a reset of every session (reconnect)', () => resetBackgroundPollingGuard()]
  ])('minor-9: a stale 4001 sent before %s is ignored; polling goes on', async (_label, rebind) => {
    let rejectStale: (error: unknown) => void = () => undefined
    let calls = 0

    const request = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          calls += 1

          if (calls === 1) {
            rejectStale = reject
          } else {
            setTimeout(() => resolve({ processes: [running('a')] }), 0)
          }
        })
    )

    $gateway.set({ request } as never)

    const stale = refreshBackgroundProcesses(SID)

    rebind()

    const fresh = refreshBackgroundProcesses(SID)

    rejectStale(new JsonRpcGatewayError('session not found', { code: 4001 }))
    await stale

    expect($backgroundGoneSessions.get().has(SID)).toBe(false)

    await fresh
    expect(items().map(item => item.id)).toEqual(['a'])

    await refreshBackgroundProcesses(SID)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('minor-9 CONTROL: a 4001 to a request sent AFTER the rebind still latches the session as gone', async () => {
    const request = vi.fn(async () => {
      throw new JsonRpcGatewayError('session not found', { code: 4001 })
    })

    $gateway.set({ request } as never)
    resetBackgroundPollingGuard(SID)
    await refreshBackgroundProcesses(SID)

    expect($backgroundGoneSessions.get().has(SID)).toBe(true)
  })

  it('a full guard reset (runtime re-mint) resumes polling every latched session', async () => {
    const request = vi.fn(async () => {
      throw new JsonRpcGatewayError('session not found', { code: 4001 })
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses('sess-2')
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses('sess-2')
    expect(request).toHaveBeenCalledTimes(2)

    // Gateway reconnect re-mints runtimes: the no-arg reset (wired at the
    // reconnect seams) must clear every latched id, not just one.
    resetBackgroundPollingGuard()
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses('sess-2')

    expect(request).toHaveBeenCalledTimes(4)
  })
})

describe('refreshBackgroundProcesses resume-then-retry (reaped runtime)', () => {
  beforeEach(() => {
    $backgroundStatusBySession.set({})
    $providerBlock.set(null)
    clearSingleFlightSessionResumeState()
    resetBackgroundPollingGuard()
    $sessionStates.set({ [SID]: { storedSessionId: 'stored-1' } } as never)
  })

  afterEach(() => {
    $gateway.set(null as never)
    $sessionStates.set({})
    $providerBlock.set(null)
    resetBackgroundPollingGuard()
  })

  it('resumes the stored session once, retries once, then polls the live runtime directly', async () => {
    const calls: Array<[string, unknown]> = []

    const request = vi.fn(async (method: string, params: { session_id?: string }) => {
      calls.push([method, params.session_id])

      if (method === 'session.resume') {
        return { session_id: 'live-2' }
      }

      if (params.session_id === SID) {
        throw new JsonRpcGatewayError('session not found', { code: 4001 })
      }

      return { processes: [running('p1')] }
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    expect(items()).toHaveLength(1)

    await refreshBackgroundProcesses(SID)

    expect(calls).toEqual([
      ['process.list', SID],
      ['session.resume', 'stored-1'],
      ['process.list', 'live-2'],
      ['process.list', 'live-2']
    ])
    expect($providerBlock.get()).toBeNull()
  })

  it('a failed retry raises the reconnecting banner and latches the id (no resume loop)', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.resume') {
        return { session_id: 'live-2' }
      }

      throw new Error('session not found')
    })

    $gateway.set({ request } as never)

    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)
    await refreshBackgroundProcesses(SID)

    expect(request.mock.calls.map(call => call[0])).toEqual(['process.list', 'session.resume', 'process.list'])
    expect($providerBlock.get()?.kind).toBe('reconnecting')
  })
})
