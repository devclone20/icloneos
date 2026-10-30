import { onGatewayEvent } from '@/contrib/events'
import { sleep } from '@/iclone-shared/async'
import { asFiniteNumber, asNonEmptyString, isRecord } from '@/iclone-shared/guards'
import { toChatMessages } from '@/lib/chat-messages'
import { $currentUsage, setCurrentUsage, setSessions } from '@/store/session'
import type { UsageStats } from '@/types/hermes'

import type { ClientSessionState } from '../../types'
import { type GatewayRequest, withSessionNotFoundResume } from '../hooks/use-prompt-actions/utils'

import {
  CHANGED_KINDS,
  classifyCompactError,
  classifyCompactResult,
  type CompactOutcome,
  type ContextSnapshot,
  type SessionCompressResult
} from './compact-outcome'
import { finishCompaction, setCompactionProgress, startCompaction } from './compact-store'

// Manual compression is LLM-bound and routinely outlives the desktop's 30s
// default WS request timeout on large sessions — give it the TUI client's
// 120s RPC budget (HERMES_TUI_RPC_TIMEOUT_MS default) instead.
export const SESSION_COMPRESS_TIMEOUT_MS = 120_000
// The before-snapshot is a fallback for results without `before_tokens`
// (compute-host sessions); it must never hold the compaction back.
export const CONTEXT_SNAPSHOT_DEADLINE_MS = 800
// The after-read only refreshes the header; nothing waits on it.
const CONTEXT_REFRESH_TIMEOUT_MS = 5_000
// `compressing` = manual compaction, `compacting` = the agent's auto-compaction.
const PROGRESS_KINDS: ReadonlySet<unknown> = new Set(['compacting', 'compressing'])

export interface CompactionDeps {
  isActiveSession: (sessionId: string) => boolean
  onProgress?: (text: string) => void
  /** A stale runtime id was resumed: move per-session claims onto `recoveredId`. */
  onRecovered?: (initialSessionId: string, recoveredId: string) => void
  requestGateway: GatewayRequest
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: null | string
  ) => ClientSessionState
}

export interface CompactionRequest {
  focusTopic?: string
  sessionId: string
  storedSessionId: null | string
}

type ContextPatch = Pick<UsageStats, 'context_max' | 'context_percent' | 'context_used'>

async function readContext(
  requestGateway: GatewayRequest,
  sessionId: string,
  timeoutMs: number
): Promise<ContextPatch | null> {
  try {
    const breakdown = await requestGateway<unknown>('session.context_breakdown', { session_id: sessionId }, timeoutMs)
    const contextUsed = isRecord(breakdown) ? asFiniteNumber(breakdown.context_used) : undefined

    if (!isRecord(breakdown) || contextUsed === undefined) {
      return null
    }

    const patch: ContextPatch = { context_used: contextUsed }
    const contextMax = asFiniteNumber(breakdown.context_max)
    const contextPercent = asFiniteNumber(breakdown.context_percent)

    if (contextMax !== undefined) {
      patch.context_max = contextMax
    }

    if (contextPercent !== undefined) {
      patch.context_percent = contextPercent
    }

    return patch
  } catch {
    return null
  }
}

async function snapshotBefore(deps: CompactionDeps, sessionId: string): Promise<ContextSnapshot | null> {
  const known = deps.isActiveSession(sessionId) ? asFiniteNumber($currentUsage.get().context_used) : undefined

  if (known !== undefined) {
    return { contextUsed: known }
  }

  const abort = new AbortController()

  const deadline = sleep(CONTEXT_SNAPSHOT_DEADLINE_MS, { signal: abort.signal }).then(
    () => null,
    () => null
  )

  try {
    const patch = await Promise.race([
      readContext(deps.requestGateway, sessionId, CONTEXT_SNAPSHOT_DEADLINE_MS),
      deadline
    ])

    return patch ? { contextUsed: patch.context_used } : null
  } finally {
    abort.abort()
  }
}

// The runtime's own count after the history swap, so the card header shows the
// new context_used without waiting for the next turn's usage tick. A tick that
// lands while the read is in flight (a turn started right after compaction) is
// newer and wins: every usage write replaces the object, so identity is the
// generation. The identity updater is the cache's documented no-op read.
function refreshContextAfter(deps: CompactionDeps, sessionId: string, storedSessionId: null | string): void {
  const currentAtStart = $currentUsage.get()
  const sessionAtStart = deps.updateSessionState(sessionId, state => state, storedSessionId).usage

  void readContext(deps.requestGateway, sessionId, CONTEXT_REFRESH_TIMEOUT_MS).then(patch => {
    if (!patch) {
      return
    }

    if (deps.isActiveSession(sessionId) && $currentUsage.get() === currentAtStart) {
      setCurrentUsage(current => ({ ...current, ...patch }))
    }

    deps.updateSessionState(
      sessionId,
      state =>
        state.usage && state.usage === sessionAtStart ? { ...state, usage: { ...state.usage, ...patch } } : state,
      storedSessionId
    )
  })
}

// The RPC returns the post-compress `messages` array (same shape
// session.resume returns), so the transcript is replaced from it — otherwise
// the summarized bubbles stay on screen forever (#44462 review).
// `updateSessionState` only publishes for the active runtime, so a late result
// after a session switch refreshes its own cache without clobbering the
// foreground transcript (#53755 review).
function applyCompactResult(
  deps: CompactionDeps,
  sessionId: string,
  storedSessionId: null | string,
  result: SessionCompressResult | null | undefined
): void {
  if (Array.isArray(result?.messages)) {
    const messages = toChatMessages(result.messages)
    deps.updateSessionState(sessionId, state => ({ ...state, messages }), storedSessionId)
  }

  const usage = { ...result?.usage, ...result?.info?.usage }

  if (Object.keys(usage).length && deps.isActiveSession(sessionId)) {
    setCurrentUsage(current => ({ ...current, ...usage }))
  }

  const info = result?.info

  if (info?.title !== undefined) {
    setSessions(prev =>
      prev.map(session => (session.id === sessionId ? { ...session, title: info.title || null } : session))
    )
  }
}

/**
 * THE compaction path for every surface (the `/compress` slash, the Compact
 * button through it, the context card): the gateway's own `session.compress`
 * — the Hermes agent's summariser, whatever the provider — never a provider
 * API. Resolves the classified outcome (also published to `$compactions`), or
 * null when a compaction of this session is already running (coalesced: one
 * RPC however many clicks).
 */
export async function runCompaction(deps: CompactionDeps, request: CompactionRequest): Promise<CompactOutcome | null> {
  const { sessionId: initialSessionId, storedSessionId } = request
  const focusTopic = request.focusTopic?.trim() ?? ''

  if (!startCompaction(initialSessionId)) {
    return null
  }

  let liveSessionId = initialSessionId

  const stopProgress = onGatewayEvent('status.update', event => {
    const payload = event.payload

    if (event.session_id !== liveSessionId || !isRecord(payload) || !PROGRESS_KINDS.has(payload.kind)) {
      return
    }

    const text = asNonEmptyString(payload.text)

    if (text) {
      setCompactionProgress(initialSessionId, text)
      deps.onProgress?.(text)
    }
  })

  let outcome: CompactOutcome

  try {
    const before = await snapshotBefore(deps, initialSessionId)

    // Same stale-runtime recovery as prompt.submit: after sleep/wake a dead id
    // 404s session.compress while plain chat still works. NOT alsoTimeout —
    // compress is legitimately LLM-slow and a timeout here must not be retried
    // as a dead session.
    const { result, sessionId } = await withSessionNotFoundResume(
      initialSessionId,
      storedSessionId,
      liveId =>
        deps.requestGateway<SessionCompressResult>(
          'session.compress',
          { session_id: liveId, ...(focusTopic ? { focus_topic: focusTopic } : {}) },
          SESSION_COMPRESS_TIMEOUT_MS
        ),
      {
        requestGateway: deps.requestGateway,
        onRecovered: recoveredId => {
          liveSessionId = recoveredId
          deps.onRecovered?.(initialSessionId, recoveredId)
        }
      }
    )

    liveSessionId = sessionId
    applyCompactResult(deps, sessionId, storedSessionId, result)
    outcome = classifyCompactResult(result, sessionId, before)

    if (CHANGED_KINDS.has(outcome.kind)) {
      refreshContextAfter(deps, sessionId, storedSessionId)
    }
  } catch (error) {
    outcome = classifyCompactError(error, liveSessionId)
  } finally {
    stopProgress()
  }

  finishCompaction([initialSessionId, liveSessionId], outcome)

  return outcome
}
