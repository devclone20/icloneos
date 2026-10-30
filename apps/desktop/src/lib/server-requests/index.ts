import type { GatewayEvent, JsonRpcGatewayClient } from '@hermes/shared'
import { atom, type ReadableAtom } from 'nanostores'

import { errorMessage } from '@/iclone-shared/errors'
import { asString } from '@/iclone-shared/guards'

import {
  attachLegacyRequests,
  LEGACY_ONLY_KINDS,
  type LegacyRequest,
  type LegacyRequester,
  respondLegacy
} from './legacy'
import {
  declineCodeFor,
  SERVER_REQUEST_METHOD_NOT_FOUND,
  SERVER_REQUEST_POLICY,
  serverRequestTimeoutMs,
  WINDOW_OWNED_METHODS
} from './policy'
import { normalizeOpenRequests, SettledIds } from './replay'

/**
 * The one seam for every "ask the renderer" request (contract P4c §3). Two protocols feed it: the
 * runtime's server→client JSON-RPC requests and, only for a runtime without them, the legacy
 * `*.request` events (legacy.ts). UIs read `$serverRequests` and answer with the server-request
 * RESULT shape through `answerServerRequest`; the protocol is invisible to them.
 * Node-importable: nothing here touches window/document/storage at import time.
 */

export { SERVER_REQUEST_POLICY } from './policy'

export interface PendingServerRequest {
  id: string
  method: string
  sessionId: null | string
  params: Record<string, unknown>
  protocol: 'legacy' | 'request'
  receivedAt: number
}

interface ServerRequestContext {
  /** True when this window shows the session that raised the request (always true when sessionless). */
  showsSession: boolean
}

/** Answers a request without a UI (desktop bridges). Throw an error with a numeric `code` to decline. */
type ServerRequestHandler = (params: Readonly<Record<string, unknown>>, ctx: ServerRequestContext) => Promise<unknown>

interface UnseenCancel {
  at: number
  id: string
  method: null | string
  sessionId: null | string
}

type Reply = (outcome: { error: { code: number; message: string } } | { result: unknown }) => Promise<void>

interface Entry {
  reply: Reply
  request: PendingServerRequest
  timer: ReturnType<typeof setTimeout>
}

const UNSEEN_CANCEL_LIMIT = 20

const $pending = atom<readonly PendingServerRequest[]>([])
const $unseen = atom<readonly UnseenCancel[]>([])

export const $serverRequests: ReadableAtom<readonly PendingServerRequest[]> = $pending

/** `request.cancel` for ids this app never saw: a turn-level warning (the runtime withdrew a question we missed). */
export const $unseenServerRequestCancels: ReadableAtom<readonly UnseenCancel[]> = $unseen

const entries = new Map<string, Entry>()
/** Ids whose answer is on the wire; a `request.cancel` meanwhile removes the id so a failed send is not put back. */
const answering = new Set<string>()
const settled = new SettledIds()
const handlers = new Map<string, ServerRequestHandler>()
const attached = new WeakMap<JsonRpcGatewayClient, () => void>()
let showsSession: (sessionId: null | string) => boolean = () => true

/** Fire-and-forget reply: a closed socket on a decline/timeout is the same "unanswered" for the runtime. */
const fire = (reply: Promise<void> | undefined) => void reply?.catch(() => undefined)

function publish(): void {
  $pending.set([...entries.values()].map(entry => entry.request))
}

function settle(id: string): Entry | undefined {
  const entry = entries.get(id)

  settled.add(id)

  if (!entry) {
    return undefined
  }

  clearTimeout(entry.timer)

  entries.delete(id)
  publish()

  return entry
}

/**
 * Arm the backstop, measured from receipt so a put-back entry keeps its original deadline. It only frees the
 * entry: the runtime already withdrew the request with `request.cancel`, or the transport that would carry an
 * answer is gone.
 */
function armBackstop(request: PendingServerRequest): ReturnType<typeof setTimeout> {
  const remaining = request.receivedAt + serverRequestTimeoutMs(request.method) - Date.now()

  return setTimeout(() => void settle(request.id), Math.max(0, remaining))
}

function errorCode(error: unknown, fallback: number): number {
  const code = (error as { code?: unknown } | null)?.code

  return typeof code === 'number' ? code : fallback
}

/** Window bridges and other UI-less requests: answer now, never park in the store. */
function runHandler(handler: ServerRequestHandler, request: PendingServerRequest, reply: Reply): void {
  settled.add(request.id)
  fire(
    handler(request.params, { showsSession: showsSession(request.sessionId) }).then(
      result => reply({ result }),
      error =>
        reply({ error: { code: errorCode(error, declineCodeFor(request.method)), message: errorMessage(error) } })
    )
  )
}

function receive(request: PendingServerRequest, reply: Reply): void {
  if (entries.has(request.id) || settled.has(request.id)) {
    return
  }

  const policy =
    request.protocol === 'legacy' && LEGACY_ONLY_KINDS.has(request.method)
      ? 'handled'
      : SERVER_REQUEST_POLICY[request.method]

  if (policy !== 'handled') {
    settled.add(request.id)
    const code = policy === 'declineOk' ? declineCodeFor(request.method) : SERVER_REQUEST_METHOD_NOT_FOUND
    fire(reply({ error: { code, message: `${request.method} is not answered by this app` } }))

    return
  }

  if (WINDOW_OWNED_METHODS.has(request.method)) {
    const handler = handlers.get(request.method)

    if (handler) {
      runHandler(handler, request, reply)
    } else {
      settled.add(request.id)
      fire(reply({ error: { code: declineCodeFor(request.method), message: `${request.method} has no handler here` } }))
    }

    return
  }

  entries.set(request.id, { reply, request, timer: armBackstop(request) })
  publish()
}

function cancel(id: string, method: null | string, sessionId: null | string): void {
  answering.delete(id)

  if (entries.has(id)) {
    settle(id)

    return
  }

  if (settled.has(id)) {
    return
  }

  settled.add(id)
  $unseen.set([...$unseen.get(), { at: Date.now(), id, method, sessionId }].slice(-UNSEEN_CANCEL_LIMIT))
  console.warn(`[server-requests] request.cancel for an unseen request ${method ?? ''} ${id}`.trim())
}

function requestReply(gateway: JsonRpcGatewayClient, id: number | string): Reply {
  return async outcome => {
    if (!gateway.respond(id, outcome)) {
      throw new Error('gateway not connected')
    }
  }
}

function legacyReply(gateway: JsonRpcGatewayClient, request: LegacyRequest): Reply {
  return outcome => respondLegacy(gateway, request, 'result' in outcome ? outcome.result : null)
}

function toPending(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
  protocol: PendingServerRequest['protocol']
): PendingServerRequest {
  return {
    id: String(id),
    method,
    params,
    protocol,
    receivedAt: Date.now(),
    sessionId: (asString(params.session_id) ?? '') || null
  }
}

function advertise(gateway: JsonRpcGatewayClient, state: { legacyOff: (() => void) | null }): void {
  gateway.request('client.capabilities', { server_requests: true }).then(
    () => {
      state.legacyOff?.()
      state.legacyOff = null
    },
    error => {
      // Method presence, never a version string: a runtime without the method predates
      // server→client requests and still speaks `*.request` / `*.respond`.
      if (errorCode(error, 0) !== SERVER_REQUEST_METHOD_NOT_FOUND || state.legacyOff) {
        return
      }

      state.legacyOff = attachLegacyRequests(gateway, {
        cancel: id => cancel(id, null, null),
        receive: request =>
          receive(toPending(request.id, request.kind, request.params, 'legacy'), legacyReply(gateway, request))
      })
    }
  )
}

/**
 * Install the server-request handler on `gateway`, then advertise the capability once per opened
 * socket (handler first: advertising without one makes the runtime wait out its deadline).
 * Idempotent per gateway; returns the detach.
 */
export function attachServerRequests(gateway: JsonRpcGatewayClient): () => void {
  const existing = attached.get(gateway)

  if (existing) {
    return existing
  }

  const state: { legacyOff: (() => void) | null } = { legacyOff: null }

  const offRequest = gateway.onServerRequest(request =>
    receive(toPending(request.id, request.method, request.params, 'request'), requestReply(gateway, request.id))
  )

  const offCancel = gateway.on('request.cancel', (event: GatewayEvent) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const id = (asString(payload.id) ?? '') || (typeof payload.id === 'number' ? String(payload.id) : '')

    if (id) {
      cancel(id, (asString(payload.method) ?? '') || null, (asString(event.session_id) ?? '') || null)
    }
  })

  const offOpen = gateway.onOpen(() => advertise(gateway, state))

  const detach = () => {
    offOpen()
    offCancel()
    offRequest()
    state.legacyOff?.()
    state.legacyOff = null
    attached.delete(gateway)
  }

  attached.set(gateway, detach)

  return detach
}

/** Re-deliver `open_requests` from a resume/activate snapshot through the same path (dedup by id). */
export function replayOpenRequests(gateway: JsonRpcGatewayClient | null | undefined, openRequests: unknown): void {
  if (!gateway) {
    return
  }

  attachServerRequests(gateway)

  for (const entry of normalizeOpenRequests(openRequests)) {
    receive(toPending(entry.id, entry.method, entry.params, 'request'), requestReply(gateway, entry.id))
  }
}

/** Answer a pending request with its RESULT shape. A removed id (cancelled, dropped, answered) is a no-op. */
export async function answerServerRequest(id: string, result: unknown): Promise<void> {
  const entry = settle(id)

  if (!entry) {
    return
  }

  answering.add(id)

  try {
    await entry.reply({ result })
  } catch (error) {
    // Undelivered and still open: put it back (backstop re-armed with the remaining time) so the UI can retry.
    if (answering.has(id)) {
      entries.set(id, { ...entry, timer: armBackstop(entry.request) })
      publish()
    }

    throw error
  } finally {
    answering.delete(id)
  }
}

export interface RoutedServerRequestAnswer {
  id: string
  method: string
  protocol: PendingServerRequest['protocol']
  result: unknown
  sessionId: null | string
}

/** One JSON-RPC call on the connection that raised the request. */
type ServerRequestRoute = (method: string, params: Record<string, unknown>) => Promise<unknown>

/**
 * `expired`: the request was no longer open (the runtime's `request.answer` status, or an id this window already
 * settled) and the answer was dropped. Not an error: the prompt simply ended first.
 */
export interface RoutedServerRequestOutcome {
  status: 'expired' | 'ok'
}

/**
 * Thrown to a PLUGIN when its answer reached a prompt that had already ended (contract P4c grant G2): a plugin that
 * echoes answers elsewhere (a Bot Mode room log) must not record one the runtime never took. `code` and `name` are
 * stable so plain-JS plugins can branch without importing the class.
 */
export class ServerRequestExpiredError extends Error {
  readonly code = 'expired' as const
  readonly id: string
  readonly method: string

  constructor(id: string, method: string) {
    super(`server request ${id} (${method}) had already ended; the answer was dropped`)
    this.name = 'ServerRequestExpiredError'
    this.id = id
    this.method = method
  }
}

/**
 * Answer a request this window may not hold: a Bot Mode room mirrors a member's prompt from the member's own
 * connection snapshot. A request the seam holds is answered here; otherwise the answer goes through `route`
 * (`request.answer` proxies a server→client request; a legacy runtime gets its `*.respond`). Batch clarify
 * qids are the answer keys (a single legacy question ignores `question_id`).
 */
export async function answerRoutedServerRequest(
  answer: RoutedServerRequestAnswer,
  route: ServerRequestRoute
): Promise<RoutedServerRequestOutcome> {
  if (entries.has(answer.id)) {
    await answerServerRequest(answer.id, answer.result)

    return { status: 'ok' }
  }

  if (settled.has(answer.id)) {
    return { status: 'expired' }
  }

  if (answer.protocol === 'request') {
    // New path only (a 'request' protocol entry exists once the runtime offered server requests): requires `client.capabilities`
    const reply = await route('request.answer', { id: answer.id, result: answer.result })

    return { status: (reply as { status?: unknown } | null)?.status === 'expired' ? 'expired' : 'ok' }
  }

  const answers = (answer.result as { answers?: unknown } | null)?.answers
  const qids = answers && typeof answers === 'object' ? Object.keys(answers) : []

  const requester: LegacyRequester = {
    request: <T>(method: string, params?: Record<string, unknown>) => route(method, params ?? {}) as Promise<T>
  }

  await respondLegacy(
    requester,
    {
      id: answer.id,
      kind: answer.method,
      params: { questions: qids.map(qid => ({ qid })), session_id: answer.sessionId },
      sessionId: answer.sessionId,
      synthetic: false
    },
    answer.result
  )

  return { status: 'ok' }
}

/** Decline a pending request (fail closed). Defaults to the policy's code for its method. */
export async function declineServerRequest(id: string, code?: number): Promise<void> {
  const entry = settle(id)

  if (!entry) {
    return
  }

  await entry.reply({
    error: { code: code ?? declineCodeFor(entry.request.method), message: `${entry.request.method} declined` }
  })
}

/** Register the UI-less answerer for a window-owned bridge; returns the unregister. */
export function registerServerRequestHandler(method: string, handler: ServerRequestHandler): () => void {
  handlers.set(method, handler)

  return () => {
    if (handlers.get(method) === handler) {
      handlers.delete(method)
    }
  }
}

/** Which session this window shows (multi-window bystander rule for window-owned bridges). */
export function setServerRequestSessionVisibility(predicate: (sessionId: null | string) => boolean): void {
  showsSession = predicate
}

/** Test seam: forget every pending, settled and unseen request. */
export function resetServerRequestsForTest(): void {
  for (const entry of entries.values()) {
    clearTimeout(entry.timer)
  }

  entries.clear()
  answering.clear()
  settled.clear()
  handlers.clear()
  showsSession = () => true
  $pending.set([])
  $unseen.set([])
}
