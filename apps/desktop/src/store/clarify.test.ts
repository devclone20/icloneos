import type { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $serverRequests, replayOpenRequests, resetServerRequestsForTest } from '@/lib/server-requests'

import {
  $clarifyRequest,
  $clarifyRequests,
  answerClarifyBatch,
  type ClarifyOwnerRequest,
  type ClarifyRequest,
  clearClarifyRequest,
  hasClarifyRequest,
  lockClarifyAnswer,
  normalizeChoices,
  normalizeQuestions,
  setClarifyRequest,
  skipClarifyRequest
} from './clarify'
import { $activeSessionId } from './session'

function clarify(sessionId: string | null, requestId: string): ClarifyRequest {
  return {
    requestId,
    question: `question-${requestId}`,
    choices: null,
    multiSelect: false,
    sessionId
  }
}

describe('clarify store', () => {
  beforeEach(() => {
    $clarifyRequests.set({})
    $activeSessionId.set(null)
  })

  afterEach(() => {
    $clarifyRequests.set({})
    $activeSessionId.set(null)
  })

  it('keeps clarify requests from concurrent sessions independent', () => {
    setClarifyRequest(clarify('session-a', 'req-a'))
    setClarifyRequest(clarify('session-b', 'req-b'))

    expect($clarifyRequests.get()['session-a']?.requestId).toBe('req-a')
    expect($clarifyRequests.get()['session-b']?.requestId).toBe('req-b')
  })

  it('exposes only the active session via the focus-scoped view', () => {
    setClarifyRequest(clarify('session-a', 'req-a'))
    setClarifyRequest(clarify('session-b', 'req-b'))

    $activeSessionId.set('session-a')
    expect($clarifyRequest.get()?.requestId).toBe('req-a')

    $activeSessionId.set('session-b')
    expect($clarifyRequest.get()?.requestId).toBe('req-b')

    $activeSessionId.set('session-c')
    expect($clarifyRequest.get()).toBeNull()
  })

  it('clears only the targeted session, leaving the other pending', () => {
    setClarifyRequest(clarify('session-a', 'req-a'))
    setClarifyRequest(clarify('session-b', 'req-b'))

    clearClarifyRequest('req-a', 'session-a')

    expect($clarifyRequests.get()['session-a']).toBeUndefined()
    expect($clarifyRequests.get()['session-b']?.requestId).toBe('req-b')
  })

  it('ignores a stale clear whose request id no longer matches', () => {
    setClarifyRequest(clarify('session-a', 'req-a2'))

    clearClarifyRequest('req-a1', 'session-a')

    expect($clarifyRequests.get()['session-a']?.requestId).toBe('req-a2')
  })

  it('clears by request id across sessions when no session hint is given', () => {
    setClarifyRequest(clarify('session-a', 'shared'))
    setClarifyRequest(clarify('session-b', 'other'))

    clearClarifyRequest('shared')

    expect($clarifyRequests.get()['session-a']).toBeUndefined()
    expect($clarifyRequests.get()['session-b']?.requestId).toBe('other')
  })
})

// Drives the real seam: open requests are replayed through a fake gateway and
// every answer must leave as that gateway's `respond(id, {result})` frame.
function fakeGateway() {
  const respond = vi.fn((_id: number | string, _outcome: unknown) => true)

  const unsubscribe = () => () => {}

  const gateway = {
    on: unsubscribe,
    onOpen: unsubscribe,
    onServerRequest: unsubscribe,
    request: vi.fn(async () => ({})),
    respond
  } as unknown as JsonRpcGatewayClient

  return { gateway, respond }
}

function openClarify(gateway: JsonRpcGatewayClient, id: string, params: Record<string, unknown>) {
  replayOpenRequests(gateway, [{ id, method: 'clarify', params }])
}

describe('skipClarifyRequest', () => {
  let fake: ReturnType<typeof fakeGateway>

  beforeEach(() => {
    resetServerRequestsForTest()
    $clarifyRequests.set({})
    fake = fakeGateway()
  })

  afterEach(() => {
    resetServerRequestsForTest()
    $clarifyRequests.set({})
  })

  it('answers the session\u2019s clarify with a skipped answer and drops it', async () => {
    openClarify(fake.gateway, 'req-a', { question: 'question-a', session_id: 'session-a' })
    openClarify(fake.gateway, 'req-b', { question: 'question-b', session_id: 'session-b' })

    expect(hasClarifyRequest('session-a')).toBe(true)

    await expect(skipClarifyRequest('session-a')).resolves.toBe(true)

    expect(fake.respond).toHaveBeenCalledTimes(1)
    expect(fake.respond).toHaveBeenCalledWith('req-a', { result: { answers: { q0: null } } })
    expect(hasClarifyRequest('session-a')).toBe(false)
    expect($serverRequests.get().map(entry => entry.id)).toEqual(['req-b'])
    // A background session's question is untouched — only the one being typed
    // over is skipped.
    expect(hasClarifyRequest('session-b')).toBe(true)
  })

  it('skips every question of a batch, never cancelling the whole set', async () => {
    openClarify(fake.gateway, 'req-batch', {
      questions: [
        { qid: 'q0', question: 'Name?' },
        { qid: 'q1', question: 'Colour?', choices: ['red', 'blue'] }
      ],
      session_id: 'session-a'
    })

    await expect(skipClarifyRequest('session-a')).resolves.toBe(true)

    expect(fake.respond).toHaveBeenCalledWith('req-batch', { result: { answers: { q0: null, q1: null } } })
  })

  it('is a no-op when the session has no clarify parked', async () => {
    await expect(skipClarifyRequest('session-a')).resolves.toBe(false)
    expect(fake.respond).not.toHaveBeenCalled()
  })

  it('still reports the skip when the respond frame cannot be sent', async () => {
    openClarify(fake.gateway, 'req-a', { question: 'question-a', session_id: 'session-a' })
    fake.respond.mockReturnValueOnce(false)

    await expect(skipClarifyRequest('session-a')).resolves.toBe(true)
    expect(fake.respond).toHaveBeenCalledTimes(1)
    expect(hasClarifyRequest('session-a')).toBe(false)
  })
})

describe('batch clarify locks', () => {
  const questions = [
    { qid: 'q0', question: 'Name?' },
    { qid: 'q1', question: 'Colour?', choices: ['red', 'blue'] },
    { qid: 'q2', question: 'Size?' }
  ]

  let fake: ReturnType<typeof fakeGateway>

  beforeEach(() => {
    resetServerRequestsForTest()
    $clarifyRequests.set({})
    fake = fakeGateway()
  })

  afterEach(() => {
    resetServerRequestsForTest()
    $clarifyRequests.set({})
  })

  function parked(params: Record<string, unknown> = {}): ClarifyRequest {
    openClarify(fake.gateway, 'req-batch', { questions, session_id: 'session-a', ...params })
    const request = $clarifyRequests.get()['session-a']

    expect(request?.questions?.map(question => question.qid)).toEqual(['q0', 'q1', 'q2'])

    return request as ClarifyRequest
  }

  // A server double: tracks what is locked and answers with the real `remaining`.
  function lockServer(locked: Record<string, string> = {}) {
    const calls: string[] = []

    const ownerRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push(`${method}:${String(params.question_id)}=${String(params.answer)}`)
      locked[String(params.question_id)] = String(params.answer)

      return { remaining: questions.map(q => q.qid).filter(qid => !(qid in locked)), status: 'ok' }
    }) as unknown as ClarifyOwnerRequest

    return { calls, locked, ownerRequest }
  }

  it('locks a staged answer before any confirm, in stage order', async () => {
    const request = parked()
    const server = lockServer()

    await expect(lockClarifyAnswer(request, 'q1', 'blue', server.ownerRequest)).resolves.toBe('sent')
    await expect(lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)).resolves.toBe('sent')

    expect(server.ownerRequest).toHaveBeenNthCalledWith(1, 'clarify.lock', {
      answer: 'blue',
      question_id: 'q1',
      request_id: 'req-batch'
    })
    expect(server.calls).toEqual(['clarify.lock:q1=blue', 'clarify.lock:q0=Ada'])
    expect(fake.respond).not.toHaveBeenCalled()
    expect($serverRequests.get().map(entry => entry.id)).toEqual(['req-batch'])
  })

  it('never sends the lock that would empty `remaining`, even when stages race', async () => {
    const request = parked()
    const server = lockServer()

    const outcomes = await Promise.all([
      lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest),
      lockClarifyAnswer(request, 'q1', 'blue', server.ownerRequest),
      lockClarifyAnswer(request, 'q2', 'large', server.ownerRequest)
    ])

    expect(outcomes).toEqual(['sent', 'sent', 'kept'])
    expect(Object.keys(server.locked)).toEqual(['q0', 'q1'])
    expect($serverRequests.get().map(entry => entry.id)).toEqual(['req-batch'])
  })

  it('re-locks only when a staged answer changes', async () => {
    const request = parked({ answers: { q2: 'large' } })
    const server = lockServer({ q2: 'large' })

    await expect(lockClarifyAnswer(request, 'q2', 'large', server.ownerRequest)).resolves.toBe('kept')
    await expect(lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)).resolves.toBe('sent')
    await expect(lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)).resolves.toBe('kept')
    await expect(lockClarifyAnswer(request, 'q0', 'Grace', server.ownerRequest)).resolves.toBe('sent')
    // q1 is the last unlocked question: its lock would resolve the request.
    await expect(lockClarifyAnswer(request, 'q1', 'red', server.ownerRequest)).resolves.toBe('kept')

    expect(server.calls).toEqual(['clarify.lock:q0=Ada', 'clarify.lock:q0=Grace'])
  })

  it('keeps staged answers locked server-side when the runtime times the request out', async () => {
    const request = parked()
    const server = lockServer()

    await lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)
    await lockClarifyAnswer(request, 'q1', 'blue', server.ownerRequest)

    // Runtime deadline: it withdraws the request and keeps the locked answers.
    resetServerRequestsForTest()

    expect(server.locked).toEqual({ q0: 'Ada', q1: 'blue' })
    expect($clarifyRequests.get()['session-a']).toBeUndefined()
    expect(fake.respond).not.toHaveBeenCalled()
    // A late stage after the withdrawal sends nothing.
    await expect(lockClarifyAnswer(request, 'q2', 'large', server.ownerRequest)).resolves.toBe('kept')
    expect(server.ownerRequest).toHaveBeenCalledTimes(2)
  })

  it('records nothing for a failed lock, so the next stage retries it', async () => {
    const request = parked()
    const server = lockServer()

    vi.mocked(server.ownerRequest as unknown as (...args: unknown[]) => unknown).mockRejectedValueOnce(
      new Error('socket closed')
    )

    await expect(lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)).rejects.toThrow('socket closed')
    await expect(lockClarifyAnswer(request, 'q0', 'Ada', server.ownerRequest)).resolves.toBe('sent')
  })

  it('sends no lock for a legacy request or without an owner socket', async () => {
    const request = parked()
    const server = lockServer()

    await expect(lockClarifyAnswer(request, 'q0', 'Ada', null)).resolves.toBe('kept')
    await expect(
      lockClarifyAnswer({ ...request, requestId: 'unknown' }, 'q0', 'Ada', server.ownerRequest)
    ).resolves.toBe('kept')
    expect(server.ownerRequest).not.toHaveBeenCalled()
  })

  it('confirms with one result frame only after the in-flight locks land', async () => {
    const request = parked()
    const order: string[] = []

    let release: () => void = () => {}

    const ownerRequest = vi.fn(async () => {
      await new Promise<void>(resolve => (release = resolve))
      order.push('lock')

      return { remaining: ['q1', 'q2'], status: 'ok' }
    }) as unknown as ClarifyOwnerRequest

    fake.respond.mockImplementation(() => {
      order.push('respond')

      return true
    })

    const answers = { q0: 'Ada', q1: 'blue', q2: null }
    void lockClarifyAnswer(request, 'q0', 'Ada', ownerRequest)
    const confirmed = answerClarifyBatch(request, answers)

    await vi.waitFor(() => expect(ownerRequest).toHaveBeenCalled())
    expect(fake.respond).not.toHaveBeenCalled()
    release()

    await expect(confirmed).resolves.toBe(true)
    expect(order).toEqual(['lock', 'respond'])
    expect(fake.respond).toHaveBeenCalledWith('req-batch', { result: { answers } })
    expect($serverRequests.get()).toEqual([])
  })

  it('sends no result frame once a lock reported the wait already ended', async () => {
    const request = parked()
    const ownerRequest = vi.fn(async () => ({ status: 'expired' })) as unknown as ClarifyOwnerRequest

    await expect(lockClarifyAnswer(request, 'q0', 'Ada', ownerRequest)).resolves.toBe('expired')
    await expect(lockClarifyAnswer(request, 'q1', 'blue', ownerRequest)).resolves.toBe('expired')
    await expect(answerClarifyBatch(request, { q0: 'Ada', q1: 'blue', q2: 'large' })).resolves.toBe(false)

    expect(ownerRequest).toHaveBeenCalledTimes(1)
    expect(fake.respond).not.toHaveBeenCalled()
  })

  it('sends only the result frame when nothing was locked', async () => {
    const answers = { q0: 'Ada', q1: 'blue', q2: null }

    await expect(answerClarifyBatch(parked(), answers)).resolves.toBe(true)

    expect(fake.respond).toHaveBeenCalledTimes(1)
    expect(fake.respond).toHaveBeenCalledWith('req-batch', { result: { answers } })
  })
})

describe('normalizeChoices', () => {
  it('returns empty array for null/undefined', () => {
    expect(normalizeChoices(null)).toEqual([])
    expect(normalizeChoices(undefined)).toEqual([])
  })

  it('returns empty array for non-array input', () => {
    expect(normalizeChoices('hello')).toEqual([])
    expect(normalizeChoices(42)).toEqual([])
    expect(normalizeChoices({})).toEqual([])
  })

  it('filters out non-string items', () => {
    expect(normalizeChoices(['a', 42, 'b', null, 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('drops blank and whitespace-only strings', () => {
    expect(normalizeChoices(['a', '', 'b', '   ', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('drops strings with newlines', () => {
    expect(normalizeChoices(['a', 'b\nc', 'd'])).toEqual(['a', 'd'])
  })

  it('drops strings over 200 chars', () => {
    const long = 'x'.repeat(201)
    const ok = 'y'.repeat(200)
    expect(normalizeChoices(['a', long, ok])).toEqual(['a', ok])
  })

  it('drops empty items and keeps valid ones', () => {
    expect(normalizeChoices(['valid', '  ', '', 'also valid'])).toEqual(['valid', 'also valid'])
  })

  it('returns empty array when nothing survives', () => {
    expect(normalizeChoices(['', '  ', null, undefined])).toEqual([])
    expect(normalizeChoices([])).toEqual([])
  })
})

describe('normalizeQuestions', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeQuestions(null)).toEqual([])
    expect(normalizeQuestions('x')).toEqual([])
    expect(normalizeQuestions({})).toEqual([])
  })

  it('normalizes a valid batch and keys by qid', () => {
    const result = normalizeQuestions([
      { choices: ['a', 'b'], qid: 'q0', question: 'One?' },
      { qid: 'q1', question: 'Two?' }
    ])

    expect(result).toEqual([
      { choices: ['a', 'b'], multiSelect: false, qid: 'q0', question: 'One?' },
      { choices: null, multiSelect: false, qid: 'q1', question: 'Two?' }
    ])
  })

  it('drops entries missing qid or question text', () => {
    const result = normalizeQuestions([
      { qid: '', question: 'no qid' },
      { qid: 'q1', question: '   ' },
      'not-an-object',
      { qid: 'q2', question: 'kept' }
    ])

    expect(result.map(q => q.qid)).toEqual(['q2'])
  })

  it('degrades all-blank choices to open-ended per question', () => {
    const result = normalizeQuestions([{ choices: ['', '  '], qid: 'q0', question: 'Q?' }])

    expect(result[0]?.choices).toBeNull()
  })

  it('only honors multi_select when choices survive', () => {
    const result = normalizeQuestions([
      { choices: ['a', 'b'], multi_select: true, qid: 'q0', question: 'A?' },
      { multi_select: true, qid: 'q1', question: 'B?' }
    ])

    expect(result[0]?.multiSelect).toBe(true)
    expect(result[1]?.multiSelect).toBe(false)
  })
})
