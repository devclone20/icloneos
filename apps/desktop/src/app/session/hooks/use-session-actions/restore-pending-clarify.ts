import type { GatewayEventPayload } from '@/lib/chat-messages'
import {
  $clarifyRequests,
  type ClarifyRequest,
  clarifyRequestFrom,
  clearClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  setClarifyRequest
} from '@/store/clarify'
import type { SessionResumeResponse } from '@/types/hermes'
import type { OpenRequestEntry } from '@/types/runtime-contract.generated'

/** A resume/activate snapshot: the live runtime lists every server request
 *  still blocking the session in `open_requests`; a runtime from before
 *  server→client requests carries the one parked clarify as `pending_clarify`. */
export type PendingClarifySnapshot = Pick<SessionResumeResponse, 'pending_clarify'> & {
  open_requests?: readonly OpenRequestEntry[] | null
}

export interface PendingClarifyResumeState {
  authoritativeAbsent: boolean
  cleared: ClarifyRequest | null
  request: ClarifyRequest | null
}

/**
 * Reconcile the parked clarify for `sessionId` against a resume/activate
 * snapshot.
 *
 * An open `clarify` server request is the seam's to re-deliver (dedup by id),
 * which parks the card; this reports it — parking it here too when the replay
 * has not landed yet, so the card never waits on call order. A legacy
 * `pending_clarify` mirrors the old event shape: single-question payloads carry
 * `question`/`choices`/`multi_select`; batch ones carry `questions` (+ answers
 * already locked server-side). Multi-select locks arrive as JSON-encoded arrays
 * inside a string — never a bare array — so `lockedAnswers` keeps string
 * values only.
 *
 * A snapshot with no clarify is authoritative only for requests that already
 * existed when the RPC began. A newer clarify that arrives while the response
 * is in flight is left alone.
 */
export function restorePendingClarifyFromSnapshot(
  response: PendingClarifySnapshot,
  sessionId: string,
  resumeStartedAt: number,
  requestIdAtStart?: string
): PendingClarifyResumeState {
  const open = (response.open_requests ?? []).find(entry => entry.method === 'clarify')

  if (open) {
    const parked = $clarifyRequests.get()[sessionId]

    if (parked?.requestId === open.id) {
      return { authoritativeAbsent: false, cleared: null, request: parked }
    }

    const request = clarifyRequestFrom({
      id: open.id,
      method: open.method,
      params: open.params,
      protocol: 'request',
      receivedAt: Date.now(),
      sessionId
    })

    if (request) {
      setClarifyRequest(request)
    }

    return { authoritativeAbsent: false, cleared: null, request }
  }

  const pending = response.pending_clarify

  if (!pending || typeof pending.request_id !== 'string') {
    const current = $clarifyRequests.get()[sessionId]

    const existedAtStart = Boolean(current && requestIdAtStart && current.requestId === requestIdAtStart)
    const definitelyOlder = Boolean(current?.receivedAt !== undefined && current.receivedAt < resumeStartedAt)
    const legacyWithoutTime = Boolean(current && current.receivedAt === undefined && !requestIdAtStart)

    if (current && (existedAtStart || definitelyOlder || legacyWithoutTime)) {
      clearClarifyRequest(current.requestId, sessionId)

      return { authoritativeAbsent: true, cleared: current, request: null }
    }

    return { authoritativeAbsent: true, cleared: null, request: null }
  }

  const questions = normalizeQuestions(pending.questions)
  const question = typeof pending.question === 'string' ? pending.question : ''

  if (!question && questions.length === 0) {
    return { authoritativeAbsent: false, cleared: null, request: null }
  }

  const choices = normalizeChoices(pending.choices)

  const lockedAnswers =
    typeof pending.answers === 'object' && pending.answers !== null
      ? Object.fromEntries(
          Object.entries(pending.answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : undefined

  const request: ClarifyRequest = {
    choices: choices.length > 0 ? choices : null,
    lockedAnswers,
    multiSelect: pending.multi_select === true,
    question,
    receivedAt: Date.now() / 1000,
    requestId: pending.request_id,
    sessionId,
    ...(questions.length > 0 ? { questions } : {})
  }

  setClarifyRequest(request)

  return { authoritativeAbsent: false, cleared: null, request }
}

export function pendingClarifyToolPayload(request: ClarifyRequest): GatewayEventPayload {
  return {
    args: request.questions?.length
      ? {
          questions: request.questions.map(question => ({
            choices: question.choices ?? undefined,
            multi_select: question.multiSelect || undefined,
            question: question.question
          }))
        }
      : {
          choices: request.choices ?? [],
          ...(request.multiSelect ? { multi_select: true } : {}),
          question: request.question
        },
    tool_id: request.requestId
  }
}
