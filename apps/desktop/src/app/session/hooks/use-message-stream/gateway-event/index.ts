import { registryBackendScopeKey } from '@hermes/shared'
import { useCallback, useEffect, useRef } from 'react'

import type { GatewayEventPayload } from '@/lib/chat-messages'
import {
  approvalReplaySessionId,
  resolveGatewayEventSessionId,
  UNSCOPED_STREAM_EVENT_TYPES
} from '@/lib/gateway-events'
import { $serverRequests, type PendingServerRequest } from '@/lib/server-requests'
import { setSessionCompacting } from '@/store/compaction'
import { $gateway, activeGatewayConnectionId } from '@/store/gateway'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { replayPendingApproval } from '@/store/prompts'
import { setSessionProviderWait } from '@/store/provider-wait'
import { setSessionDraftingTool } from '@/store/tool-drafting'
import type { RpcEvent } from '@/types/hermes'

import { handleDesktopBridgeEvent } from './desktop-bridge'
import { surfaceInputRequest, withdrawInputRequest } from './input-requests'
import { handleLifecycleEvent } from './lifecycle'
import { handleMessageStreamEvent } from './message-stream'
import { handleSessionInfoEvent } from './session-info'
import { handleStatusEvent } from './status'
import { handleToolEvent } from './tools'
import type { GatewayEventContext, GatewayEventDeps, GatewayEventHandler } from './types'

export type { GatewayEventDeps } from './types'

/**
 * Events that retire a "drafting a tool call" claim.
 *
 * `tool.generating` opens the claim and nothing closes it — a draft can be
 * abandoned without ever reaching `tool.start`, so enumerating the ways one
 * *ends* left the label on screen for the rest of the turn. Inverted: the
 * claim only covers what the model is emitting right now, and any other output
 * from the session proves it moved on. Same rule the TUI applies to its
 * transient trail lines (`turnController.pruneTransient`).
 */
const DRAFT_SUPERSEDING_EVENT_TYPES = new Set([
  'error',
  'message.complete',
  'message.delta',
  'message.start',
  'reasoning.delta',
  'thinking.delta',
  'tool.complete',
  'tool.start'
])

const COMPACTION_RESUME_EVENT_TYPES = new Set([
  'message.delta',
  'message.interim',
  'thinking.delta',
  'reasoning.delta',
  'reasoning.available',
  'moa.reference',
  'moa.aggregating',
  'moa.progress',
  'moa.phase',
  'tool.start',
  'tool.generating',
  'tool.complete'
])

const PROVIDER_WAIT_SUPERSEDING_EVENT_TYPES = new Set([
  'error',
  'message.complete',
  'message.delta',
  'message.interim',
  'message.start',
  'reasoning.available',
  'reasoning.delta',
  'tool.complete',
  'tool.generating',
  'tool.start'
])

// Ordered family handlers; each consumes its own event types and reports
// whether it did, so dispatch stops at the first taker.
/** Requests remembered after they leave the seam: its `request.cancel` listener
 *  drops a request before this dispatcher sees the same event. */
const WITHDRAWN_MEMORY = 64

/** The id a runtime withdrawal names: `request.cancel {id}`, legacy `<kind>.expire {request_id}`. */
function withdrawnRequestId(event: RpcEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  const raw =
    event.type === 'request.cancel' ? payload.id : event.type?.endsWith('.expire') ? payload.request_id : undefined

  return typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
}

const HANDLERS: GatewayEventHandler[] = [
  handleLifecycleEvent,
  handleSessionInfoEvent,
  handleMessageStreamEvent,
  handleToolEvent,
  handleDesktopBridgeEvent,
  handleStatusEvent
]

/** The gateway-event dispatcher, extracted from useMessageStream. */
export function useGatewayEventHandler(deps: GatewayEventDeps) {
  const { activeSessionIdRef, compactedTurnRef, refreshHermesConfig, sessionStateByRuntimeIdRef } = deps

  const unscopedStreamSessionIdRef = useRef<string | null>(null)

  // session.info arrives in bursts (agent build ready + turn end + title /
  // MCP / compress edges within the same second). Each used to fire its own
  // refreshHermesConfig — two REST calls (config + defaults) per event, per
  // turn, including for BACKGROUND sessions whose values the fetch can't even
  // apply. Coalesce to one trailing fetch per burst; the caller gates on
  // `apply` so background traffic doesn't schedule anything.
  const configRefreshTimerRef = useRef<null | number>(null)

  const surfacedRef = useRef(new Map<string, PendingServerRequest>())
  const withdrawnRef = useRef(new Map<string, PendingServerRequest>())

  // Every blocking-input request reaches the transcript through the seam, whichever
  // protocol carried it; an id is surfaced once per stay in the seam (a put-back
  // after an undelivered answer surfaces it again). Re-subscribing on new deps is
  // cheap: the subscribe replay is deduped by id.
  useEffect(() => {
    const surfaced = surfacedRef.current
    const withdrawn = withdrawnRef.current

    return $serverRequests.subscribe(pending => {
      const open = new Set<string>()

      for (const request of pending) {
        open.add(request.id)

        if (!surfaced.has(request.id)) {
          surfaced.set(request.id, request)
          withdrawn.delete(request.id)
          surfaceInputRequest({ deps, occurredAt: request.receivedAt / 1000 }, request)
        }
      }

      for (const [id, request] of surfaced) {
        if (!open.has(id)) {
          surfaced.delete(id)
          withdrawn.set(id, request)
        }
      }

      for (const id of withdrawn.keys()) {
        if (withdrawn.size <= WITHDRAWN_MEMORY) {
          break
        }

        withdrawn.delete(id)
      }
    })
  }, [deps])

  const scheduleConfigRefresh = useCallback(() => {
    if (configRefreshTimerRef.current !== null) {
      return
    }

    if (typeof window === 'undefined') {
      void refreshHermesConfig()

      return
    }

    configRefreshTimerRef.current = window.setTimeout(() => {
      configRefreshTimerRef.current = null
      void refreshHermesConfig()
    }, 300)
  }, [refreshHermesConfig])

  useEffect(
    () => () => {
      if (configRefreshTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(configRefreshTimerRef.current)
        configRefreshTimerRef.current = null
      }
    },
    []
  )

  return useCallback(
    (event: RpcEvent) => {
      const payload = event.payload as GatewayEventPayload | undefined

      // "From the active profile" must mean "from the active SOURCE": every
      // registered connection exposes a 'default' profile, so a bare profile
      // comparison attributes gateway B's 'default' events to gateway A's
      // 'default'. Compare the composite (connectionId, profile) scope with
      // registryBackendScopeKey — untagged primary events keep the legacy
      // bare-profile behavior byte-identical.
      const fromActiveSource = (): boolean =>
        (!event.profile || normalizeProfileKey(event.profile) === normalizeProfileKey($activeGatewayProfile.get())) &&
        registryBackendScopeKey(event.connectionId ?? null, event.profile ?? null) ===
          registryBackendScopeKey(activeGatewayConnectionId(), event.profile ?? null)

      const occurredAt =
        typeof payload?.timestamp === 'number' && Number.isFinite(payload.timestamp)
          ? payload.timestamp
          : Date.now() / 1000

      const explicitSid = event.session_id || ''

      const withdrawnId = withdrawnRequestId(event)
      const withdrawn = withdrawnId && (surfacedRef.current.get(withdrawnId) ?? withdrawnRef.current.get(withdrawnId))

      if (withdrawn) {
        withdrawnRef.current.delete(withdrawnId)
        withdrawInputRequest({ deps, occurredAt }, withdrawn)
      }

      const route = resolveGatewayEventSessionId({
        activeSessionId: activeSessionIdRef.current,
        eventType: event.type,
        explicitSessionId: explicitSid,
        unscopedStreamSessionId: unscopedStreamSessionIdRef.current
      })

      unscopedStreamSessionIdRef.current = route.nextUnscopedStreamSessionId

      if (route.drop) {
        return
      }

      const sessionId = route.sessionId

      // Late stragglers: an unscoped stream event attributed via the
      // active-session fallback (no pin) to a session that has no live turn
      // belongs to a turn that already ended elsewhere. Dropping it keeps the
      // previous session's tail events (a delayed `thinking.delta` or
      // `status.update`) from landing in a freshly opened chat (#43142 family:
      // busy/streaming UI inherited when switching sessions).
      if (
        sessionId &&
        !explicitSid &&
        !route.pinned &&
        event.type &&
        event.type !== 'message.start' &&
        UNSCOPED_STREAM_EVENT_TYPES.has(event.type)
      ) {
        const state = sessionStateByRuntimeIdRef.current.get(sessionId)

        const hasLiveTurn = Boolean(
          state && (state.awaitingResponse || state.busy || state.streamId || state.sawAssistantPayload)
        )

        if (!hasLiveTurn) {
          return
        }
      }

      const isActiveEvent = !!sessionId && sessionId === activeSessionIdRef.current

      const replaySessionId = approvalReplaySessionId(event.type, activeSessionIdRef.current, sessionId)

      if (replaySessionId) {
        void replayPendingApproval($gateway.get(), replaySessionId).catch(() => undefined)
      }

      // Mid-turn compaction does not emit another message.start. The first
      // model output or tool event proves summarization has finished and the
      // turn has resumed, so retire the phase label without waiting for the
      // whole turn to complete.
      if (sessionId && COMPACTION_RESUME_EVENT_TYPES.has(event.type) && compactedTurnRef.current.has(sessionId)) {
        setSessionCompacting(sessionId, false)
      }

      if (sessionId && DRAFT_SUPERSEDING_EVENT_TYPES.has(event.type)) {
        setSessionDraftingTool(sessionId, '')
      }

      if (sessionId && PROVIDER_WAIT_SUPERSEDING_EVENT_TYPES.has(event.type)) {
        setSessionProviderWait(sessionId, '')
      }

      const ctx: GatewayEventContext = {
        deps,
        event,
        payload,
        sessionId,
        explicitSid,
        isActiveEvent,
        occurredAt,
        fromActiveSource,
        scheduleConfigRefresh
      }

      for (const handler of HANDLERS) {
        if (handler(ctx)) {
          return
        }
      }
    },
    // The deps object is rebuilt by the caller each render, but every field it
    // carries is stable (refs, useCallback-wrapped fns, queryClient), so
    // depending on the individual fields keeps the handler identity stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      deps.appendAssistantDelta,
      deps.appendReasoningDelta,
      deps.activeSessionIdRef,
      deps.activeGatewayProfile,
      deps.compactedTurnRef,
      deps.completeAssistantMessage,
      deps.failAssistantMessage,
      deps.finalizeInterimAssistantMessage,
      deps.flushQueuedDeltas,
      deps.hydrateFromStoredSession,
      deps.lastCwdInfoSessionRef,
      deps.nativeSubagentSessionsRef,
      deps.queryClient,
      scheduleConfigRefresh,
      deps.scheduleSessionsRefresh,
      deps.sessionInterrupted,
      deps.sessionStateByRuntimeIdRef,
      deps.updateSessionState,
      deps.upsertToolCall
    ]
  )
}
