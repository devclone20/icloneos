import { pendingClarifyToolPayload } from '@/app/session/hooks/use-session-actions/restore-pending-clarify'
import { translateNow } from '@/i18n'
import { restorePendingClarifyToolCall, settlePendingClarifyToolCall } from '@/lib/chat-messages'
import type { GatewayEventPayload } from '@/lib/chat-messages'
import { declineServerRequest, type PendingServerRequest } from '@/lib/server-requests'
import {
  $clarifyRequests,
  type ClarifyRequest,
  clarifyRequestFrom,
  clearClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  setClarifyRequest,
  warnDroppedChoices
} from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { setMcpSetupRequest } from '@/store/mcp-setup'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { receiveApprovalRequest, setSecretRequest, setSudoRequest } from '@/store/prompts'
import { requestScrollToBottom } from '@/store/thread-scroll'

import type { GatewayEventDeps } from './types'

/** One blocking-input request, whichever protocol carried it: the server→client
 *  JSON-RPC request (`id = srq-…`) or the legacy `<kind>.request` event (`id` =
 *  its `request_id`). The server-request seam owns routing and the answer; this
 *  module only surfaces the request in the transcript and the prompt stores. */
export interface InputRequest {
  id: string
  method: string
  params: Readonly<Record<string, unknown>>
  sessionId: null | string
}

export interface InputRequestSurfaceContext {
  deps: GatewayEventDeps
  occurredAt: number
}

/** clarify / MCP setup consent / approval / sudo / secret. The agent thread is
 *  blocked until the seam answers, so each request is parked per session and
 *  surfaced. Returns false for a method that is not an input request. */
export function surfaceInputRequest(ctx: InputRequestSurfaceContext, request: InputRequest): boolean {
  const { deps, occurredAt } = ctx
  const { activeSessionIdRef, sessionInterrupted, updateSessionState, upsertToolCall } = deps
  const { method, sessionId } = request
  const payload = request.params as GatewayEventPayload

  if (method === 'clarify') {
    // Surface the clarify tool's overlay. The agent thread is blocked until
    // the seam answers, so without this the tool would hang until timeout.
    //
    // Store the request for whichever session raised it — even a background
    // one. If we dropped it for an unfocused session, that session would stay
    // blocked and re-focusing it could only recover through a replay.
    // Parking it per-session lets the user answer once they switch
    // over; the inline ClarifyTool reads the active session's entry.
    if (sessionId && sessionInterrupted(sessionId)) {
      // A late question from an interrupted turn has no one left to answer it:
      // decline so the runtime's clarify returns instead of waiting out its deadline.
      void declineServerRequest(request.id).catch(() => undefined)

      return true
    }

    const requestId = request.id
    const question = typeof payload?.question === 'string' ? payload.question : ''
    const rawChoices = payload?.choices
    const choices = normalizeChoices(rawChoices)
    const multiSelect = payload?.multi_select === true
    // Batch (multi-question) clarify: `questions` replaces question/choices
    // on the wire. `answers` rides along only on reconnect replay, carrying
    // the per-question locks the server already accepted.
    const questions = normalizeQuestions(payload?.questions)

    const lockedAnswers =
      typeof payload?.answers === 'object' && payload?.answers !== null
        ? Object.fromEntries(
            Object.entries(payload.answers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined

    // Park the request, re-arm its transcript row, notify. A resumed/hydrated
    // transcript may already contain this provider's clarify call while carrying
    // no live streamId: re-arm that exact row (keeping the provider tool id)
    // instead of letting the generic stream mutator append a second card; a row
    // is still seeded when tool.start was genuinely missed.
    const openClarifyRequest = (clarify: ClarifyRequest, body: string) => {
      setClarifyRequest(clarify)

      if (sessionId) {
        updateSessionState(sessionId, state => {
          const projection = restorePendingClarifyToolCall(
            state.messages,
            pendingClarifyToolPayload(clarify),
            occurredAt
          )

          return {
            ...state,
            messages: projection.messages,
            streamId: projection.streamId,
            sawAssistantPayload: true,
            awaitingResponse: false,
            needsInput: true
          }
        })

        if (sessionId === activeSessionIdRef.current) {
          requestScrollToBottom()
        }
      }

      dispatchNativeNotification({
        body,
        kind: 'input',
        sessionId,
        title: translateNow('notifications.native.inputTitle')
      })
    }

    if (requestId && questions.length > 0) {
      const request = {
        choices: null,
        lockedAnswers,
        multiSelect: false,
        question: '',
        questions,
        receivedAt: Date.now() / 1000,
        requestId,
        sessionId: sessionId ?? null
      }

      openClarifyRequest(request, questions.map(q => q.question).join(' · '))
    } else if (requestId && question) {
      if (rawChoices != null && choices.length === 0) {
        warnDroppedChoices('gateway', question, rawChoices)
      }

      const request = {
        requestId,
        question,
        choices: choices.length > 0 ? choices : null,
        multiSelect,
        receivedAt: Date.now() / 1000,
        sessionId: sessionId ?? null
      }

      openClarifyRequest(request, question)
    }

    return true
  }

  if (method === 'mcp.setup') {
    // setup_mcp tool (desktop GUI): the agent proposed an MCP server and
    // the Python side is blocked on mcp.setup.respond. Park the request
    // per-session (like clarify) and upsert a stable pending tool row so
    // the inline consent card has somewhere to render even when the
    // tool.start event was missed (stream reconnect / hydration race).
    const requestId = request.id
    const server = typeof payload?.server === 'string' ? payload.server : ''
    const rawAction = typeof payload?.action === 'string' ? payload.action : 'install'
    const action = rawAction === 'enable' || rawAction === 'authorize' ? rawAction : 'install'
    const reason = typeof payload?.reason === 'string' ? payload.reason : ''

    if (requestId && server) {
      setMcpSetupRequest({ action, reason, requestId, server, sessionId: sessionId ?? null })

      if (sessionId) {
        upsertToolCall(
          sessionId,
          { args: { action, reason, server }, name: 'setup_mcp', tool_id: requestId },
          'running'
        )
        updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
      }

      dispatchNativeNotification({
        body: reason || server,
        kind: 'input',
        sessionId,
        title: translateNow('notifications.native.inputTitle')
      })
    }

    return true
  }

  if (method === 'approval') {
    // Dangerous-command / execute_code approval. The Python side is blocked
    // in _await_gateway_decision() until approval.respond lands; without
    // this the agent stalls until its 5-min timeout and the tool is BLOCKED.
    // Park it per-session (like clarify) so a *background* profile's turn can
    // raise it and wait — the sidebar flags "needs input" and the inline bar
    // surfaces once the user focuses that chat.
    const command = typeof payload?.command === 'string' ? payload.command : ''
    const description = typeof payload?.description === 'string' ? payload.description : 'dangerous command'

    void receiveApprovalRequest($gateway.get(), {
      // false only when a tirith warning forbids it; backend omits the field otherwise.
      allowPermanent: payload?.allow_permanent !== false,
      choices: Array.isArray(payload?.choices)
        ? payload.choices.filter(choice => typeof choice === 'string')
        : undefined,
      command,
      description,
      requestId: request.id,
      sessionId: sessionId ?? null,
      smartDenied: payload?.smart_denied === true
    }).catch(() => undefined)

    if (sessionId) {
      updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
    }

    // V3-F: the notification only brings the app forward; nothing outside the permission sheet decides.
    dispatchNativeNotification({
      body: command || description,
      kind: 'approval',
      sessionId,
      title: translateNow('notifications.native.approvalTitle')
    })

    return true
  }

  if (method === 'sudo') {
    // Sudo password capture (tools/terminal_tool.py). Blocked on
    // sudo.respond {request_id, password}.
    const requestId = request.id

    if (requestId) {
      setSudoRequest({ requestId, sessionId: sessionId ?? null })

      if (sessionId) {
        updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
      }

      dispatchNativeNotification({
        body: translateNow('notifications.native.inputBody'),
        kind: 'input',
        sessionId,
        title: translateNow('notifications.native.inputTitle')
      })
    }

    return true
  }

  if (method === 'secret') {
    // Skill credential capture (tools/skills_tool.py). Blocked on
    // secret.respond {request_id, value}.
    const requestId = request.id

    if (requestId) {
      const envVar = typeof payload?.env_var === 'string' ? payload.env_var : ''
      const promptText = typeof payload?.prompt === 'string' ? payload.prompt : ''

      setSecretRequest({
        requestId,
        envVar,
        prompt: promptText,
        sessionId: sessionId ?? null
      })

      if (sessionId) {
        updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
      }

      dispatchNativeNotification({
        body: promptText || envVar || translateNow('notifications.native.inputBody'),
        kind: 'input',
        sessionId,
        title: translateNow('notifications.native.inputTitle')
      })
    }

    return true
  }

  return false
}

/** The runtime withdrew a request (timeout, interrupt, answered elsewhere —
 *  `request.cancel`, or the legacy `clarify.expire`): settle what was surfaced.
 *  The seam may already have dropped the request from the clarify store, so the
 *  surfaced request itself rebuilds the card it settles. */
export function withdrawInputRequest(ctx: InputRequestSurfaceContext, withdrawn: PendingServerRequest): void {
  const { deps, occurredAt } = ctx
  const { updateSessionState } = deps
  const { id, sessionId } = withdrawn

  if (!sessionId || withdrawn.method !== 'clarify') {
    return
  }

  const stored = $clarifyRequests.get()[sessionId]

  // Expiry is request-correlated: a delayed event from an older prompt must
  // not erase a newer clarify raised by the same session.
  if (stored && stored.requestId !== id) {
    return
  }

  const request = stored ?? clarifyRequestFrom(withdrawn)

  if (!request) {
    return
  }

  clearClarifyRequest(id, sessionId)
  updateSessionState(sessionId, state => {
    const projection = settlePendingClarifyToolCall(
      state.messages,
      pendingClarifyToolPayload(request),
      state.busy,
      occurredAt
    )

    return {
      ...state,
      messages: projection.messages,
      needsInput: false,
      streamId: state.busy ? (projection.streamId ?? state.streamId) : null
    }
  })
}
