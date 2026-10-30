import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { emitGatewayEvent } from '@/contrib/events'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $currentUsage } from '@/store/session'

import { $compactions, claimCompaction } from './compact-store'
import {
  type CompactionDeps,
  CONTEXT_SNAPSHOT_DEADLINE_MS,
  runCompaction,
  SESSION_COMPRESS_TIMEOUT_MS
} from './run-compaction'

const SESSION = 'rt-compact'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))

  return { promise, resolve }
}

function makeDeps(handlers: Record<string, (params?: Record<string, unknown>) => Promise<unknown> | unknown>) {
  const states = new Map<string, ClientSessionState>()

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const handler = handlers[method]

    if (!handler) {
      throw new Error(`unexpected ${method}`)
    }

    return handler(params)
  }) as unknown as CompactionDeps['requestGateway'] & ReturnType<typeof vi.fn>

  const deps: CompactionDeps = {
    isActiveSession: () => false,
    onProgress: vi.fn(),
    requestGateway,
    updateSessionState: (sessionId, updater) => {
      const next = updater(states.get(sessionId) ?? createClientSessionState('stored-1'))
      states.set(sessionId, next)

      return next
    }
  }

  return { deps, requestGateway, states }
}

const calls = (fn: ReturnType<typeof vi.fn>, method: string) => fn.mock.calls.filter(call => call[0] === method)

const COMPACTED = {
  after_messages: 2,
  after_tokens: 9_000,
  before_messages: 12,
  before_tokens: 30_000,
  messages: [{ content: '[summary of earlier turns]', role: 'user' }],
  removed: 10,
  summary: { headline: 'Compressed: 12 → 2 messages', noop: false }
}

const methods = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(call => call[0])

afterEach(() => {
  vi.useRealTimers()
  $compactions.set({})
  $currentUsage.set({ calls: 0, input: 0, output: 0, total: 0 })
})

describe('runCompaction', () => {
  it('sends one session.compress for concurrent requests and publishes the outcome', async () => {
    const gate = deferred<unknown>()

    const { deps, requestGateway, states } = makeDeps({
      'session.compress': () => gate.promise,
      'session.context_breakdown': () => ({ context_used: 30_000 })
    })

    const first = runCompaction(deps, { sessionId: SESSION, storedSessionId: 'stored-1' })
    const second = runCompaction(deps, { sessionId: SESSION, storedSessionId: 'stored-1' })

    await expect(second).resolves.toBeNull()
    expect($compactions.get()[SESSION]?.phase).toBe('running')

    gate.resolve({
      after_messages: 2,
      after_tokens: 9_000,
      before_messages: 12,
      before_tokens: 30_000,
      messages: [
        { content: '[summary of earlier turns]', role: 'user' },
        { content: 'latest answer', role: 'assistant' }
      ],
      removed: 10,
      summary: { headline: 'Compressed: 12 → 2 messages', noop: false, token_line: '~30,000 → ~9,000 tokens' }
    })

    const outcome = await first

    expect(calls(requestGateway, 'session.compress')).toHaveLength(1)
    expect(calls(requestGateway, 'session.compress')[0]).toEqual([
      'session.compress',
      { session_id: SESSION },
      SESSION_COMPRESS_TIMEOUT_MS
    ])
    expect(outcome).toMatchObject({ afterTokens: 9_000, beforeTokens: 30_000, kind: 'compacted' })
    expect(states.get(SESSION)?.messages).toHaveLength(2)
    expect($compactions.get()[SESSION]).toMatchObject({ outcome: { kind: 'compacted' }, phase: 'done' })
  })

  it('takes over a UI claim instead of coalescing it away', async () => {
    const { deps, requestGateway } = makeDeps({
      'session.compress': () => ({ removed: 3 }),
      'session.context_breakdown': () => ({})
    })

    expect(claimCompaction(SESSION)).toBe(true)
    expect(claimCompaction(SESSION)).toBe(false)

    await expect(runCompaction(deps, { sessionId: SESSION, storedSessionId: null })).resolves.toMatchObject({
      kind: 'compacted',
      removed: 3
    })
    expect(calls(requestGateway, 'session.compress')).toHaveLength(1)
  })

  it('shows the runtime progress line for this session only', async () => {
    const gate = deferred<unknown>()

    const { deps } = makeDeps({
      'session.compress': () => gate.promise,
      'session.context_breakdown': () => ({})
    })

    const run = runCompaction(deps, { focusTopic: ' auth ', sessionId: SESSION, storedSessionId: null })
    await vi.waitFor(() => expect($compactions.get()[SESSION]?.phase).toBe('running'))

    emitGatewayEvent({ payload: { kind: 'compressing', text: 'other' }, session_id: 'rt-other', type: 'status.update' })
    emitGatewayEvent({ payload: { kind: 'ready', text: 'ready' }, session_id: SESSION, type: 'status.update' })
    expect($compactions.get()[SESSION]?.progress).toBeNull()

    emitGatewayEvent({
      payload: { kind: 'compressing', text: '⠋ compressing 12 messages (~30,000 tok), focus: "auth"…' },
      session_id: SESSION,
      type: 'status.update'
    })
    expect($compactions.get()[SESSION]?.progress).toBe('⠋ compressing 12 messages (~30,000 tok), focus: "auth"…')

    emitGatewayEvent({
      payload: { kind: 'compacting', text: 'compacting context…' },
      session_id: SESSION,
      type: 'status.update'
    })
    expect(deps.onProgress).toHaveBeenCalledTimes(2)

    gate.resolve({ removed: 0 })
    await run

    emitGatewayEvent({ payload: { kind: 'compressing', text: 'late' }, session_id: SESSION, type: 'status.update' })
    expect(deps.onProgress).toHaveBeenCalledTimes(2)
  })

  it('passes the focus topic and never waits on a failing breakdown', async () => {
    const { deps, requestGateway } = makeDeps({
      'session.compress': () => ({
        removed: 0,
        summary: { headline: 'No changes from compression: 3 messages', noop: true }
      }),
      'session.context_breakdown': () => {
        throw new Error('method not found: session.context_breakdown')
      }
    })

    const outcome = await runCompaction(deps, {
      focusTopic: 'auth refactor',
      sessionId: SESSION,
      storedSessionId: null
    })

    expect(outcome?.kind).toBe('noop')
    expect(calls(requestGateway, 'session.compress')[0]?.[1]).toEqual({
      focus_topic: 'auth refactor',
      session_id: SESSION
    })
  })

  it('ends a refused request in a visible busy outcome and frees the session', async () => {
    const { deps } = makeDeps({
      'session.compress': () => {
        throw new Error('session busy — /interrupt the current turn before /compress')
      },
      'session.context_breakdown': () => ({})
    })

    await expect(runCompaction(deps, { sessionId: SESSION, storedSessionId: null })).resolves.toMatchObject({
      kind: 'busy'
    })
    expect($compactions.get()[SESSION]?.phase).toBe('done')
    expect(claimCompaction(SESSION)).toBe(true)
  })

  it('re-reads the breakdown after compress and publishes the new context to the header', async () => {
    const breakdowns = [{ context_used: 30_000 }, { context_max: 200_000, context_percent: 4.5, context_used: 9_000 }]

    const { deps, requestGateway, states } = makeDeps({
      'session.compress': () => COMPACTED,
      'session.context_breakdown': () => breakdowns.shift()
    })

    deps.isActiveSession = () => true
    deps.updateSessionState(SESSION, state => ({
      ...state,
      usage: { calls: 1, context_used: 30_000, input: 1, output: 1, total: 2 }
    }))

    await expect(runCompaction(deps, { sessionId: SESSION, storedSessionId: 'stored-1' })).resolves.toMatchObject({
      kind: 'compacted'
    })
    await vi.waitFor(() => expect($currentUsage.get().context_used).toBe(9_000))
    expect(methods(requestGateway)).toEqual([
      'session.context_breakdown',
      'session.compress',
      'session.context_breakdown'
    ])
    expect($currentUsage.get()).toMatchObject({ context_max: 200_000, context_percent: 4.5 })
    expect(states.get(SESSION)?.usage).toMatchObject({ calls: 1, context_used: 9_000 })
  })

  it('never lets the after-read overwrite a usage tick that landed while it was in flight', async () => {
    const afterRead = deferred<unknown>()
    const breakdowns: Array<() => unknown> = [() => ({ context_used: 30_000 }), () => afterRead.promise]

    const { deps, requestGateway, states } = makeDeps({
      'session.compress': () => COMPACTED,
      'session.context_breakdown': () => breakdowns.shift()?.()
    })

    deps.isActiveSession = () => true
    deps.updateSessionState(SESSION, state => ({
      ...state,
      usage: { calls: 1, context_used: 30_000, input: 1, output: 1, total: 2 }
    }))

    await runCompaction(deps, { sessionId: SESSION, storedSessionId: 'stored-1' })
    await vi.waitFor(() => expect(calls(requestGateway, 'session.context_breakdown')).toHaveLength(2))

    // The next turn's session.usage tick, written the way the message stream writes it.
    $currentUsage.set({ ...$currentUsage.get(), context_used: 12_500 })
    deps.updateSessionState(SESSION, state => ({
      ...state,
      usage: { calls: 1, context_used: 12_500, input: 1, output: 1, total: 2 }
    }))

    afterRead.resolve({ context_max: 200_000, context_percent: 4.5, context_used: 9_000 })
    await afterRead.promise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect($currentUsage.get().context_used).toBe(12_500)
    expect($currentUsage.get().context_max).toBeUndefined()
    expect(states.get(SESSION)?.usage?.context_used).toBe(12_500)
  })

  it('skips the before-read when the header already knows the context, and the after-read on a noop', async () => {
    $currentUsage.set({ calls: 1, context_used: 50_000, input: 1, output: 1, total: 2 })

    const { deps, requestGateway } = makeDeps({
      'session.compress': () => ({
        before_messages: 5,
        removed: 0,
        summary: { headline: 'Nothing to compress', noop: true }
      }),
      'session.context_breakdown': () => ({ context_used: 1 })
    })

    deps.isActiveSession = () => true

    const outcome = await runCompaction(deps, { sessionId: SESSION, storedSessionId: null })

    expect(outcome).toMatchObject({ beforeTokens: 50_000, kind: 'noop' })
    expect(methods(requestGateway)).toEqual(['session.compress'])
  })

  it('never lets a hanging breakdown hold the compaction or its outcome back', async () => {
    vi.useFakeTimers()

    const { deps, requestGateway } = makeDeps({
      'session.compress': () => COMPACTED,
      'session.context_breakdown': () => new Promise(() => undefined)
    })

    const run = runCompaction(deps, { sessionId: SESSION, storedSessionId: null })

    await vi.advanceTimersByTimeAsync(CONTEXT_SNAPSHOT_DEADLINE_MS)
    await expect(run).resolves.toMatchObject({ kind: 'compacted' })
    expect(methods(requestGateway)).toEqual([
      'session.context_breakdown',
      'session.compress',
      'session.context_breakdown'
    ])
    expect($compactions.get()[SESSION]?.phase).toBe('done')
  })
})
