import type { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as clarifyStore from '@/store/clarify'

const { setClarifyRequestMock, clearClarifyRequestMock } = vi.hoisted(() => ({
  clearClarifyRequestMock: vi.fn(),
  setClarifyRequestMock: vi.fn()
}))

vi.mock('@/store/clarify', async importOriginal => {
  const actual = await importOriginal<typeof clarifyStore>()

  return {
    ...actual,
    clearClarifyRequest: clearClarifyRequestMock,
    setClarifyRequest: setClarifyRequestMock
  }
})

import { replayOpenRequests, resetServerRequestsForTest } from '@/lib/server-requests'
import { $clarifyRequests, skipClarifyRequest } from '@/store/clarify'

import { pendingClarifyToolPayload, restorePendingClarifyFromSnapshot } from './restore-pending-clarify'

const resumeStartedAt = 1_700_000_000

describe('restorePendingClarifyFromSnapshot', () => {
  beforeEach(() => {
    clearClarifyRequestMock.mockClear()
    setClarifyRequestMock.mockClear()
    $clarifyRequests.set({})
  })

  it('restores a batch clarify snapshot (questions, no top-level question)', () => {
    const state = restorePendingClarifyFromSnapshot(
      {
        pending_clarify: {
          request_id: 'rid1',
          questions: [
            { choices: ['Yes', 'No'], multi_select: false, qid: 'q0', question: 'Proceed?' },
            { qid: 'q1', question: 'Which region?' }
          ]
        }
      },
      'sess-1',
      resumeStartedAt
    )

    expect(state.request).not.toBeNull()
    expect(setClarifyRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiSelect: false,
        question: '',
        requestId: 'rid1',
        sessionId: 'sess-1',
        questions: [
          { choices: ['Yes', 'No'], multiSelect: false, qid: 'q0', question: 'Proceed?' },
          { multiSelect: false, qid: 'q1', question: 'Which region?', choices: null }
        ]
      })
    )
  })

  it('carries server-locked answers into the replayed batch card', () => {
    restorePendingClarifyFromSnapshot(
      {
        pending_clarify: {
          answers: { q0: 'Yes', junk: 42 },
          request_id: 'rid2',
          questions: [{ qid: 'q0', question: 'Proceed?' }]
        }
      },
      'sess-2',
      resumeStartedAt
    )

    expect(setClarifyRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ lockedAnswers: { q0: 'Yes' }, requestId: 'rid2' })
    )
  })

  it('still restores the single-question form', () => {
    const state = restorePendingClarifyFromSnapshot(
      {
        pending_clarify: {
          choices: ['A', 'B'],
          multi_select: true,
          question: 'Pick one',
          request_id: 'rid3'
        }
      },
      'sess-3',
      resumeStartedAt
    )

    expect(state.request).not.toBeNull()
    expect(setClarifyRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: ['A', 'B'],
        multiSelect: true,
        question: 'Pick one',
        requestId: 'rid3'
      })
    )
  })

  it('rejects a payload with neither form (no request restored)', () => {
    const state = restorePendingClarifyFromSnapshot(
      { pending_clarify: { request_id: 'rid4' } },
      'sess-4',
      resumeStartedAt
    )

    expect(state.request).toBeNull()
    expect(setClarifyRequestMock).not.toHaveBeenCalled()
  })

  it('rejects a payload with no request id', () => {
    const state = restorePendingClarifyFromSnapshot(
      { pending_clarify: { question: 'Orphaned prompt' } },
      'sess-5',
      resumeStartedAt
    )

    expect(state.request).toBeNull()
    expect(state.authoritativeAbsent).toBe(true)
    expect(setClarifyRequestMock).not.toHaveBeenCalled()
  })

  it('clears a stale local request when the snapshot has none, and leaves a newer in-flight one', () => {
    $clarifyRequests.set({
      'sess-6': {
        choices: null,
        multiSelect: false,
        question: 'Old',
        receivedAt: resumeStartedAt - 10,
        requestId: 'old-rid',
        sessionId: 'sess-6'
      }
    })

    const cleared = restorePendingClarifyFromSnapshot({}, 'sess-6', resumeStartedAt, 'old-rid')

    expect(cleared.authoritativeAbsent).toBe(true)
    expect(cleared.cleared?.requestId).toBe('old-rid')
    expect(clearClarifyRequestMock).toHaveBeenCalledWith('old-rid', 'sess-6')

    $clarifyRequests.set({
      'sess-6': {
        choices: null,
        multiSelect: false,
        question: 'Newer',
        receivedAt: resumeStartedAt + 1,
        requestId: 'new-rid',
        sessionId: 'sess-6'
      }
    })

    const kept = restorePendingClarifyFromSnapshot({}, 'sess-6', resumeStartedAt, 'old-rid')

    expect(kept.cleared).toBeNull()
    expect(kept.request).toBeNull()
    expect(clearClarifyRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe('restorePendingClarifyFromSnapshot with open_requests', () => {
  // Drives the real seam: the snapshot's open requests are replayed through a
  // fake gateway, and an answer must leave as that gateway's respond frame.
  const respond = vi.fn((_id: number | string, _outcome: unknown) => true)

  const unsubscribe = () => () => {}

  const fakeGateway = {
    on: unsubscribe,
    onOpen: unsubscribe,
    onServerRequest: unsubscribe,
    request: vi.fn(async () => ({})),
    respond
  } as unknown as JsonRpcGatewayClient

  const openRequests = [
    {
      id: 'srq-7',
      method: 'clarify',
      params: {
        answers: { q0: 'Yes' },
        questions: [
          { choices: ['Yes', 'No'], qid: 'q0', question: 'Proceed?' },
          { qid: 'q1', question: 'Which region?' }
        ],
        session_id: 'sess-1'
      }
    }
  ]

  beforeEach(() => {
    resetServerRequestsForTest()
    clearClarifyRequestMock.mockClear()
    setClarifyRequestMock.mockClear()
    respond.mockClear()
    $clarifyRequests.set({})
  })

  afterEach(() => {
    resetServerRequestsForTest()
    $clarifyRequests.set({})
  })

  it('reports the card the seam replay already parked, without parking it twice', async () => {
    replayOpenRequests(fakeGateway, openRequests)
    const parked = $clarifyRequests.get()['sess-1']

    expect(parked).toMatchObject({ lockedAnswers: { q0: 'Yes' }, requestId: 'srq-7', sessionId: 'sess-1' })

    const state = restorePendingClarifyFromSnapshot({ open_requests: openRequests }, 'sess-1', resumeStartedAt)

    expect(state).toEqual({ authoritativeAbsent: false, cleared: null, request: parked })
    expect(setClarifyRequestMock).not.toHaveBeenCalled()
    expect(clearClarifyRequestMock).not.toHaveBeenCalled()

    // The restored card answers through the seam: one result frame on the
    // gateway that delivered the request.
    await expect(skipClarifyRequest('sess-1')).resolves.toBe(true)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith('srq-7', { result: { answers: { q0: null, q1: null } } })
  })

  it('parks the open request itself when the seam replay has not landed yet', () => {
    const state = restorePendingClarifyFromSnapshot({ open_requests: openRequests }, 'sess-1', resumeStartedAt)

    expect(state.authoritativeAbsent).toBe(false)
    expect(state.cleared).toBeNull()
    expect(setClarifyRequestMock).toHaveBeenCalledTimes(1)
    expect(setClarifyRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lockedAnswers: { q0: 'Yes' },
        requestId: 'srq-7',
        sessionId: 'sess-1',
        questions: [
          { choices: ['Yes', 'No'], multiSelect: false, qid: 'q0', question: 'Proceed?' },
          { choices: null, multiSelect: false, qid: 'q1', question: 'Which region?' }
        ]
      })
    )
    expect(respond).not.toHaveBeenCalled()
  })

  it('prefers the open request over a legacy pending_clarify in the same snapshot', () => {
    const state = restorePendingClarifyFromSnapshot(
      { open_requests: openRequests, pending_clarify: { question: 'Old?', request_id: 'legacy-1' } },
      'sess-1',
      resumeStartedAt
    )

    expect(state.request?.requestId).toBe('srq-7')
    expect(setClarifyRequestMock).toHaveBeenCalledTimes(1)
    expect(setClarifyRequestMock).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'srq-7' }))
  })

  it('ignores open requests of other methods and falls back to pending_clarify', () => {
    const state = restorePendingClarifyFromSnapshot(
      {
        open_requests: [{ id: 'srq-9', method: 'sudo', params: { session_id: 'sess-1' } }],
        pending_clarify: { question: 'Old?', request_id: 'legacy-1' }
      },
      'sess-1',
      resumeStartedAt
    )

    expect(state.request?.requestId).toBe('legacy-1')
  })
})

describe('pendingClarifyToolPayload', () => {
  it('mirrors the batch wire shape for in-place re-arm', () => {
    expect(
      pendingClarifyToolPayload({
        choices: null,
        multiSelect: false,
        question: '',
        questions: [{ choices: ['Yes', 'No'], multiSelect: false, qid: 'q0', question: 'Proceed?' }],
        requestId: 'rid',
        sessionId: 'sess'
      })
    ).toEqual({
      args: {
        questions: [{ choices: ['Yes', 'No'], question: 'Proceed?' }]
      },
      tool_id: 'rid'
    })
  })
})
