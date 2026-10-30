import { atom, computed } from 'nanostores'

import { $serverRequests, answerServerRequest, type PendingServerRequest } from '@/lib/server-requests'
import type { ClarifyLockParams, ClarifyLockResult } from '@/types/runtime-contract.generated'

import { $activeSessionId } from './session'

export interface ClarifyQuestion {
  /** Server-generated wire id (q0..qN) — the clarify result keys answers by it. */
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

export interface ClarifyRequest {
  requestId: string
  question: string
  choices: string[] | null
  multiSelect: boolean
  /** Local receipt time (Unix seconds), used to reject stale resume cleanup. */
  receivedAt?: number
  sessionId: string | null
  /** Batch (multi-question) clarify: present instead of question/choices. */
  questions?: ClarifyQuestion[]
  /** Answers already locked server-side (reconnect replay): qid → answer. */
  lockedAnswers?: Record<string, string>
}

/** The clarify server-request result (`{answers}`): a `null` answer skips that
 *  question; a result without `answers` cancels the whole set. */
export interface ClarifyRequestResult {
  answers?: Record<string, null | string>
}

/** The answer key for a single-question card: a legacy request carries no qid,
 *  and the seam's legacy bridge sends the one answer whatever its key. */
export const SINGLE_QID = 'q0'

/**
 * The backend labels the agent's recommended option by appending this to the
 * first choice (`tools/clarify_tool.py::mark_recommended`). The renderer never
 * writes it — it only styles it, and discounts it when measuring a choice so a
 * long option isn't dropped for length the label added.
 */
export const RECOMMENDED_LABEL = '(Recommended)'

export const bareChoice = (choice: string): string =>
  choice.endsWith(RECOMMENDED_LABEL) ? choice.slice(0, -RECOMMENDED_LABEL.length).trim() : choice

/**
 * Validate and normalize a choices array.
 *
 * Keeps non-blank, newline-free strings of length ≤ 200; drops everything else
 * and returns an empty array when nothing usable survives — the caller then
 * falls back to a free-text answer instead of dead buttons.
 */
export function normalizeChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) {
    return []
  }

  return choices.filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0 && bareChoice(c).length <= 200 && !c.includes('\n')
  )
}

/**
 * Structured warning for a clarify payload that arrived with choices but had
 * them all normalized away — keeps the remaining #69122 "no selectable choices"
 * triggers diagnosable in the field without dead constant fields.
 */
export function warnDroppedChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): void {
  console.warn('[clarify] choices dropped after normalization', {
    choices_count: Array.isArray(rawChoices) ? rawChoices.length : 0,
    question_length: question.length,
    source
  })
}

/**
 * Validate and normalize a batch clarify payload's `questions` array.
 *
 * Keeps entries with a non-blank string `qid` and `question`; per-question
 * choices go through `normalizeChoices` (all-blank → open-ended) and
 * multi_select is only honored alongside surviving choices. Returns an empty
 * array when nothing usable remains — the caller treats that as "not a
 * batch" instead of rendering an unanswerable form.
 */
export function normalizeQuestions(questions: unknown): ClarifyQuestion[] {
  if (!Array.isArray(questions)) {
    return []
  }

  const normalized: ClarifyQuestion[] = []

  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const row = entry as Record<string, unknown>
    const qid = typeof row.qid === 'string' ? row.qid.trim() : ''
    const question = typeof row.question === 'string' ? row.question.trim() : ''

    if (!qid || !question) {
      continue
    }

    const choices = normalizeChoices(row.choices)

    normalized.push({
      choices: choices.length > 0 ? choices : null,
      multiSelect: row.multi_select === true && choices.length > 0,
      qid,
      question
    })
  }

  return normalized
}

// Pending clarify requests keyed by the runtime session id that raised them.
// Storing per-session (instead of one shared slot) lets a *background* session
// park its clarify request while the user is looking at a different chat, then
// resolve it once they switch over — without a second concurrent clarify
// clobbering the first. A request with no session id lands under the empty key.
const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $clarifyRequests = atom<Record<string, ClarifyRequest>>({})

/**
 * The card view of one open `clarify` server request, either protocol: the
 * live runtime sends `questions` (qid-keyed, one or many) plus any `answers`
 * it already locked; a legacy runtime sends a top-level `question`/`choices`
 * instead. Null when nothing answerable survives normalization.
 */
export function clarifyRequestFrom(pending: PendingServerRequest): ClarifyRequest | null {
  const p = pending.params
  const questions = normalizeQuestions(p.questions)
  const question = typeof p.question === 'string' ? p.question : ''

  if (questions.length === 0 && !question) {
    return null
  }

  const choices = questions.length === 0 ? normalizeChoices(p.choices) : []

  if (questions.length === 0 && p.choices != null && choices.length === 0) {
    warnDroppedChoices('gateway', question, p.choices)
  }

  // Multi-select locks arrive JSON-encoded inside a string; a `null` lock is a
  // skipped question and simply stays unstaged.
  const lockedAnswers =
    typeof p.answers === 'object' && p.answers !== null
      ? Object.fromEntries(
          Object.entries(p.answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : undefined

  return {
    choices: choices.length > 0 ? choices : null,
    multiSelect: questions.length === 0 && p.multi_select === true && choices.length > 0,
    question,
    receivedAt: pending.receivedAt / 1000,
    requestId: pending.id,
    sessionId: pending.sessionId,
    ...(lockedAnswers && Object.keys(lockedAnswers).length > 0 ? { lockedAnswers } : {}),
    ...(questions.length > 0 ? { questions } : {})
  }
}

// The map is a view of the seam's open `clarify` requests, kept writable so a
// turn end / Stop / answer can drop a card at once. `seamIds` are the entries
// the seam put here (a seam settle — answer, cancel, timeout — removes them);
// `dismissedIds` stops a locally dropped card from coming back on the next seam
// update while the request is still open server-side.
let seamIds = new Set<string>()
const dismissedIds = new Set<string>()

// Batch-clarify locks per open request: what this window locked, the server's
// last `remaining` list, and the queue that keeps the locks in send order.
interface BatchLocks {
  chain: Promise<unknown>
  expired: boolean
  remaining: string[] | null
  sent: Record<string, string>
}

const batchLocks = new Map<string, BatchLocks>()

function syncFromServerRequests(pending: readonly PendingServerRequest[]): void {
  const openIds = new Set(pending.map(entry => entry.id))
  const live = new Map<string, ClarifyRequest>()

  for (const entry of pending) {
    if (entry.method !== 'clarify' || dismissedIds.has(entry.id)) {
      continue
    }

    const request = clarifyRequestFrom(entry)

    if (request) {
      live.set(entry.id, request)
    }
  }

  for (const id of dismissedIds) {
    if (!openIds.has(id)) {
      dismissedIds.delete(id)
    }
  }

  for (const id of batchLocks.keys()) {
    if (!openIds.has(id)) {
      batchLocks.delete(id)
    }
  }

  const current = $clarifyRequests.get()
  const next: Record<string, ClarifyRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(current)) {
    if (seamIds.has(value.requestId) && !live.has(value.requestId)) {
      changed = true
    } else {
      next[key] = value
    }
  }

  for (const [id, request] of live) {
    const key = keyFor(request.sessionId)

    if (next[key]?.requestId !== id) {
      next[key] = request
      changed = true
    }
  }

  seamIds = new Set(live.keys())

  if (changed) {
    $clarifyRequests.set(next)
  }
}

$serverRequests.subscribe(syncFromServerRequests)

// The clarify request for the currently-viewed session. The inline ClarifyTool
// only ever mounts inside the active session's transcript, so it reads this
// focus-scoped view rather than reaching into the whole map.
export const $clarifyRequest = computed(
  [$clarifyRequests, $activeSessionId],
  (requests, activeId) => requests[keyFor(activeId)] ?? null
)

/** The clarify request for one specific session — the tile counterpart of the
 *  active-session `$clarifyRequest` view (same map, fixed key). */
export const sessionClarifyRequest = (sessionId: string | null) =>
  computed($clarifyRequests, requests => requests[keyFor(sessionId)] ?? null)

export function setClarifyRequest(request: ClarifyRequest): void {
  dismissedIds.delete(request.requestId)
  $clarifyRequests.set({ ...$clarifyRequests.get(), [keyFor(request.sessionId)]: request })
}

export function clearClarifyRequest(requestId?: string, sessionId?: string | null): void {
  const requests = $clarifyRequests.get()

  // Targeted clear when the caller knows the session (the common path from the
  // inline ClarifyTool answering its own request).
  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (requestId && current.requestId !== requestId)) {
      return
    }

    dismissedIds.add(current.requestId)
    const next = { ...requests }
    delete next[key]
    $clarifyRequests.set(next)

    return
  }

  // Fallback with no session hint: drop every entry matching the request id
  // (or clear all when none is given).
  const next: Record<string, ClarifyRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(requests)) {
    if (requestId && value.requestId !== requestId) {
      next[key] = value
    } else {
      dismissedIds.add(value.requestId)
      changed = true
    }
  }

  if (changed) {
    $clarifyRequests.set(next)
  }
}

/** Whether `sessionId` has a clarify parked on it right now (imperative read —
 *  the composer checks this on Enter, not on every render). */
export const hasClarifyRequest = (sessionId: string | null | undefined): boolean =>
  Boolean($clarifyRequests.get()[keyFor(sessionId)])

/** Every question of `request` answered `null` — the "skipped" result (not a
 *  cancel-all, which would tell the agent the user dismissed the whole set). */
function skippedClarifyResult(request: Pick<ClarifyRequest, 'questions'>): ClarifyRequestResult {
  const qids = request.questions?.length ? request.questions.map(question => question.qid) : [SINGLE_QID]

  return { answers: Object.fromEntries(qids.map(qid => [qid, null])) }
}

/**
 * Skip `sessionId`'s pending clarify (every question answered `null`) and drop
 * it locally, resolving to whether there was one to skip.
 *
 * The composer uses this when the user types a real message instead of picking
 * an option: a clarify blocks the agent inside its tool batch, so leaving it
 * unanswered would park the follow-up until the server-side clarify timeout
 * (default 5 min) — the message looks sent and nothing happens. Skipping lets
 * the tool return and the turn carry on with the user's actual words.
 */
export async function skipClarifyRequest(sessionId: string | null | undefined): Promise<boolean> {
  const request = $clarifyRequests.get()[keyFor(sessionId)]

  if (!request) {
    return false
  }

  // Clear first: the answer is already decided, and an in-flight answer must
  // not leave a live card the user can answer a second time.
  clearClarifyRequest(request.requestId, request.sessionId)

  try {
    await answerServerRequest(request.requestId, skippedClarifyResult(request))
  } catch {
    // The tool times out on its own; a failed skip must never swallow the
    // message the user is actually sending. The seam puts an undelivered
    // request back, so drop its card again.
    clearClarifyRequest(request.requestId, request.sessionId)
  }

  return true
}

/** Sends one session-scoped RPC on the clarify owner's socket (see `requestForOwnedSession`). */
export type ClarifyOwnerRequest = <R>(method: string, params: Record<string, unknown>) => Promise<R>

type BatchRequest = Pick<ClarifyRequest, 'lockedAnswers' | 'questions' | 'requestId'>

/** What one stage lock did: `sent`, `kept` (unchanged, would resolve the
 *  request, or no `clarify.lock` on this protocol/socket) or `expired`. */
type ClarifyLockOutcome = 'expired' | 'kept' | 'sent'

function batchLocksFor(requestId: string): BatchLocks {
  let locks = batchLocks.get(requestId)

  if (!locks) {
    locks = { chain: Promise.resolve(), expired: false, remaining: null, sent: {} }
    batchLocks.set(requestId, locks)
  }

  return locks
}

/**
 * Lock one staged batch answer server-side (`clarify.lock`, D7) so it survives
 * a runtime timeout or a reload while the user is still on the other questions.
 *
 * Locks run one at a time per request. A lock is skipped when the server
 * already holds that exact answer, and when it would empty the server's
 * `remaining` list: that lock resolves the request, and only the confirm's
 * result frame may do that. A legacy request has no `clarify.lock`.
 */
export function lockClarifyAnswer(
  request: BatchRequest,
  qid: string,
  answer: string,
  ownerRequest: ClarifyOwnerRequest | null
): Promise<ClarifyLockOutcome> {
  const protocol = $serverRequests.get().find(entry => entry.id === request.requestId)?.protocol

  if (protocol !== 'request' || !ownerRequest) {
    return Promise.resolve('kept')
  }

  const locks = batchLocksFor(request.requestId)

  const run = locks.chain.then(async (): Promise<ClarifyLockOutcome> => {
    const held = { ...request.lockedAnswers, ...locks.sent }

    if (locks.expired) {
      return 'expired'
    }

    if (held[qid] === answer) {
      return 'kept'
    }

    const unlocked = locks.remaining ?? (request.questions ?? []).map(q => q.qid).filter(id => held[id] === undefined)

    if (!unlocked.some(id => id !== qid)) {
      return 'kept'
    }

    // New path only (protocol 'request' exists once the runtime offered server requests): requires `client.capabilities`
    const locked = await ownerRequest<ClarifyLockResult>('clarify.lock', {
      answer,
      question_id: qid,
      request_id: request.requestId
    } satisfies ClarifyLockParams)

    if (locked?.status === 'expired') {
      locks.expired = true

      return 'expired'
    }

    locks.sent[qid] = answer
    locks.remaining = Array.isArray(locked?.remaining) ? locked.remaining : unlocked.filter(id => id !== qid)

    return 'sent'
  })

  // A failed lock stays unrecorded (the next stage retries it) and never
  // stalls the locks queued behind it.
  locks.chain = run.catch(() => undefined)

  return run
}

/**
 * Answer a batch clarify with the whole set as the request's result (a `null`
 * answer skips that question). Answers were locked as the user staged them
 * (`lockClarifyAnswer`); this waits for those locks first so none lands after
 * the result frame, which the server merges over them. A legacy request goes
 * through the seam's legacy bridge. Resolves to false, sending nothing, when a
 * lock reported that the server's wait already ended (`expired`).
 */
export async function answerClarifyBatch(
  request: BatchRequest,
  answers: Record<string, null | string>
): Promise<boolean> {
  const locks = batchLocks.get(request.requestId)

  await locks?.chain

  if (locks?.expired) {
    return false
  }

  await answerServerRequest(request.requestId, { answers } satisfies ClarifyRequestResult)

  return true
}
