import type { GatewayEvent, JsonRpcGatewayClient } from '@hermes/shared'

import { asString } from '@/iclone-shared/guards'

/**
 * The pre-`ebe8cda8ea` protocol: the runtime raised a `<kind>.request` event and waited for a
 * `<kind>.respond` call. Reached ONLY after `client.capabilities` answered -32601 (contract P4c D2):
 * every `*.respond` below is guardedBy `client.capabilities`. Answers arrive here in the
 * server-request RESULT shape and are mapped to the legacy params.
 */

export interface LegacyRequest {
  id: string
  /** The legacy event family (`<kind>.request`); the seam stores it as the request method. */
  kind: string
  params: Record<string, unknown>
  sessionId: null | string
  /** The legacy event carried no `request_id` (approval on old runtimes): the respond omits it. */
  synthetic: boolean
}

/** Only the call half of a gateway: a Bot Mode room answers through another connection's route. */
export type LegacyRequester = Pick<JsonRpcGatewayClient, 'request'>

interface LegacySink {
  cancel: (id: string) => void
  receive: (request: LegacyRequest) => void
}

/** Kinds the legacy runtime raised as `<kind>.request` and this app answers. */
const LEGACY_KINDS: readonly string[] = [
  'approval',
  'clarify',
  'mcp.setup',
  'preview.act',
  'preview.read',
  'secret',
  'sudo',
  'terminal.read',
  'tour',
  'window.read'
]

/** Legacy kinds the live runtime never sends as a server request, so the D6 policy table omits them. */
export const LEGACY_ONLY_KINDS: ReadonlySet<string> = new Set(['mcp.setup'])

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

let syntheticId = 0

/** Legacy clarify carried one `question`; the seam's views read the batch `questions` shape. */
function legacyParams(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'clarify' || Array.isArray(payload.questions) || !(asString(payload.question) ?? '')) {
    return payload
  }

  return {
    ...payload,
    questions: [{ choices: Array.isArray(payload.choices) ? payload.choices : [], question: payload.question }]
  }
}

/** Subscribe to the legacy request/expire events of one gateway; returns the unsubscribe. */
export function attachLegacyRequests(gateway: JsonRpcGatewayClient, sink: LegacySink): () => void {
  const offs: Array<() => void> = []

  for (const kind of LEGACY_KINDS) {
    offs.push(
      gateway.on(`${kind}.request`, (event: GatewayEvent) => {
        const payload = record(event.payload)
        const sessionId = (asString(event.session_id) ?? '') || (asString(payload.session_id) ?? '') || null
        const requestId = asString(payload.request_id) ?? ''
        const id = requestId || `legacy-${kind}-${++syntheticId}`
        const params = { ...legacyParams(kind, payload), session_id: sessionId }

        const request: LegacyRequest = { id, kind, params, sessionId, synthetic: !requestId }

        sink.receive(request)
      })
    )
    offs.push(
      gateway.on(`${kind}.expire`, (event: GatewayEvent) => {
        const id = asString(record(event.payload).request_id) ?? ''

        if (id) {
          sink.cancel(id)
        }
      })
    )
  }

  return () => offs.forEach(off => off())
}

function clarifyAnswer(result: Record<string, unknown>): string {
  const answers = Object.values(record(result.answers)).filter((v): v is string => typeof v === 'string')

  return answers.join('\n')
}

/** The qids of a batch clarify (`questions` with `qid`); empty for the single-question shape. */
function batchQids(request: LegacyRequest): string[] {
  const questions = Array.isArray(request.params.questions) ? request.params.questions : []

  return questions.map(question => asString(record(question).qid) ?? '').filter(Boolean)
}

/**
 * A batch clarify locks one answer per `clarify.respond` with its `question_id` (a skipped question locks
 * as ''); the runtime resolves when every qid is locked. A decline or a result without `answers` is the
 * cancel-all: one respond without `question_id`.
 */
async function respondClarify(
  gateway: LegacyRequester,
  request: LegacyRequest,
  result: unknown,
  requestId: string | undefined
): Promise<void> {
  const r = record(result)
  const qids = batchQids(request)

  if (!qids.length || result === null || !('answers' in r)) {
    await gateway.request('clarify.respond', {
      answer: result === null ? '' : clarifyAnswer(r),
      request_id: requestId
    })

    return
  }

  const answers = record(r.answers)

  for (const qid of qids) {
    await gateway.request('clarify.respond', {
      answer: asString(answers[qid]) ?? '',
      question_id: qid,
      request_id: requestId
    })
  }
}

/**
 * Answer a legacy request with a server-request result. `null` result = decline: the legacy
 * protocol had no error reply, so clarify is skipped with an empty answer and the rest stay
 * unanswered (the runtime's own deadline settles them).
 */
export async function respondLegacy(gateway: LegacyRequester, request: LegacyRequest, result: unknown): Promise<void> {
  const r = record(result)
  const requestId = request.synthetic ? undefined : request.id

  switch (request.kind) {
    case 'clarify':
      await respondClarify(gateway, request, result, requestId)

      return

    case 'mcp.setup':
      if (result !== null) {
        await gateway.request('mcp.setup.respond', { request_id: requestId, result: asString(r.value) ?? '' })
      }

      return

    case 'sudo':
      if (result !== null) {
        await gateway.request('sudo.respond', { password: asString(r.value) ?? '', request_id: requestId })
      }

      return

    case 'secret':
      if (result !== null) {
        await gateway.request('secret.respond', { request_id: requestId, value: asString(r.value) ?? '' })
      }

      return

    case 'approval':
      if (result !== null) {
        await gateway.request('approval.respond', {
          choice: (asString(r.choice) ?? '') || 'deny',
          request_id: requestId,
          session_id: request.sessionId ?? undefined,
          ...(typeof r.all === 'boolean' ? { all: r.all } : {})
        })
      }

      return

    case 'preview.act':
      if (result !== null) {
        await gateway.request('preview.act.respond', { request_id: requestId, text: asString(r.value) ?? '' })
      }

      return

    case 'preview.read':
      if (result !== null) {
        await gateway.request('preview.read.respond', { request_id: requestId, text: asString(r.value) ?? '' })
      }

      return

    case 'terminal.read':
      if (result !== null) {
        await gateway.request('terminal.read.respond', { request_id: requestId, text: asString(r.value) ?? '' })
      }

      return

    case 'tour':
      if (result !== null) {
        await gateway.request('tour.respond', { request_id: requestId, text: asString(r.value) ?? '' })
      }

      return

    case 'window.read':
      if (result !== null) {
        await gateway.request('window.read.respond', { request_id: requestId, text: asString(r.value) ?? '' })
      }

      return

    default:
      return
  }
}
