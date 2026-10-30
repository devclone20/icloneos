import { atom, computed, type ReadableAtom, type WritableAtom } from 'nanostores'

import { isSessionNotFoundError, resumeStoredRuntimeSession } from '@/app/session/hooks/use-prompt-actions/utils'
import { asString } from '@/iclone-shared/guards'
import { noteSessionLost } from '@/lib/provider-block'
import { $serverRequests, answerServerRequest, type PendingServerRequest } from '@/lib/server-requests'

import { $clarifyRequest, $clarifyRequests } from './clarify'
import { $activeSessionId } from './session'
import { $sessionStates, requestForOwnedSession, storedSessionIdForRuntimeId } from './session-states'

// Blocking interactive prompts the gateway raises mid-turn. Each is a
// server→client request the Python side blocks the agent thread on (a legacy
// runtime's `*.request` event arrives through the same seam); the card answers
// with `answerServerRequest(id, result)`. Without a renderer the agent stalls
// until its timeout and the tool is BLOCKED.
//
// Like clarify, every prompt is parked under the runtime session id that raised
// it (not one shared slot), so a *background* session running concurrently can
// raise an approval/sudo/secret prompt and have it wait — surfaced via the
// sidebar "needs input" badge — until the user switches to that chat. The
// exported $*Request view is scoped to the active session, so a background
// prompt never hijacks the foreground.

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

interface KeyedPrompt {
  sessionId: string | null
}

interface PromptStore<T extends KeyedPrompt> {
  $active: ReadableAtom<null | T>
  $all: ReadableAtom<Record<string, T>>
  clear: (sessionId?: string | null, requestId?: string) => void
  reset: () => void
  set: (request: T) => void
}

interface SeamMirror<T> {
  /** The open server request's card view, or null when it is not answerable. */
  from: (pending: PendingServerRequest) => null | T
  method: string
  /** The server-request id a card answers (absent: not raised by the seam). */
  seamId: (value: T) => string | undefined
}

/**
 * Keep a session-keyed card map in step with the seam's open requests of
 * `mirror.method`. The map stays writable so a turn end or an answer drops a
 * card at once: a seam settle (answer, cancel, timeout) removes what the seam
 * put there, and a card the map dropped (`dismiss`) is not brought back while
 * its request is still open. `restore` re-admits a card set explicitly.
 */
export function mirrorServerRequests<T extends KeyedPrompt>(
  $map: WritableAtom<Record<string, T>>,
  mirror: SeamMirror<T>
): { dismiss: (values: readonly T[]) => void; restore: (value: T) => void } {
  let seamIds = new Set<string>()
  const dismissedIds = new Set<string>()

  $serverRequests.subscribe(pending => {
    const openIds = new Set(pending.map(entry => entry.id))
    const live = new Map<string, T>()

    for (const entry of pending) {
      const view = entry.method === mirror.method && !dismissedIds.has(entry.id) ? mirror.from(entry) : null

      if (view) {
        live.set(entry.id, view)
      }
    }

    for (const id of dismissedIds) {
      if (!openIds.has(id)) {
        dismissedIds.delete(id)
      }
    }

    const next: Record<string, T> = {}
    let changed = false

    for (const [key, value] of Object.entries($map.get())) {
      const id = mirror.seamId(value)

      if (id && seamIds.has(id) && !live.has(id)) {
        changed = true
      } else {
        next[key] = value
      }
    }

    for (const [id, view] of live) {
      const key = keyFor(view.sessionId)
      const current = next[key]

      if (!current || mirror.seamId(current) !== id) {
        next[key] = view
        changed = true
      }
    }

    seamIds = new Set(live.keys())

    if (changed) {
      $map.set(next)
    }
  })

  return {
    dismiss(values) {
      for (const value of values) {
        const id = mirror.seamId(value)

        if (id) {
          dismissedIds.add(id)
        }
      }
    },
    restore(value) {
      const id = mirror.seamId(value)

      if (id) {
        dismissedIds.delete(id)
      }
    }
  }
}

// One per-session prompt kind: a map keyed by session (mirroring the seam),
// plus an active-session view for the overlays. `clear` drops one session's
// entry (a request-id mismatch is a no-op so a stale resolve can't wipe a
// newer prompt); with no session hint it drops every entry, optionally
// filtered by request id.
function keyedPromptStore<T extends KeyedPrompt>(mirror: SeamMirror<T>): PromptStore<T> {
  const $all = atom<Record<string, T>>({})
  const idOf = (value: T): string | undefined => (value as { requestId?: string }).requestId
  const seam = mirrorServerRequests($all, mirror)

  const write = (next: Record<string, T>) => {
    const kept = new Set(Object.values(next))

    seam.dismiss(Object.values($all.get()).filter(value => !kept.has(value)))
    $all.set(next)
  }

  return {
    $active: computed([$all, $activeSessionId], (all, activeId) => all[keyFor(activeId)] ?? null),
    $all,
    reset: () => write({}),
    set: request => {
      seam.restore(request)
      $all.set({ ...$all.get(), [keyFor(request.sessionId)]: request })
    },
    clear(sessionId, requestId) {
      const all = $all.get()

      if (sessionId !== undefined) {
        const key = keyFor(sessionId)
        const current = all[key]

        if (current && !(requestId && idOf(current) !== requestId)) {
          const next = { ...all }
          delete next[key]
          write(next)
        }

        return
      }

      const next = Object.fromEntries(Object.entries(all).filter(([, v]) => requestId && idOf(v) !== requestId))

      if (Object.keys(next).length !== Object.keys(all).length) {
        write(next as Record<string, T>)
      }
    }
  }
}

// Approval is queue-backed on the backend: `requestId` is the queue entry's id
// (what `approval.pending` / `approval.received` / `approval.respond` key on).
// A live prompt is also an `approval` server request (`serverRequestId`): the
// card answers that request with an `ApprovalResult`, and falls back to the
// `approval.respond` RPC only for a prompt restored from `approval.pending`.
export interface ApprovalRequest extends KeyedPrompt {
  // false when the backend won't honor a permanent allow (tirith warning) → hide "Always allow".
  allowPermanent?: boolean
  choices?: string[]
  command: string
  description: string
  requestId?: string
  serverRequestId?: string
  smartDenied?: boolean
}

/** The `approval` server-request result. */
interface ApprovalResult {
  all?: boolean
  choice: string
}

/** The result of every one-string prompt (sudo, secret): `''` skips / refuses. */
export interface ValueResult {
  value: string
}

interface ApprovalGateway {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

interface PendingApprovalPayload {
  allow_permanent?: boolean
  choices?: unknown
  command?: unknown
  description?: unknown
  request_id?: unknown
  smart_denied?: boolean
}

interface SudoRequest extends KeyedPrompt {
  requestId: string
}

interface SecretRequest extends KeyedPrompt {
  envVar: string
  prompt: string
  requestId: string
}

const approval = keyedPromptStore<ApprovalRequest>({
  from: ({ id, params: p, sessionId }) => ({
    allowPermanent: p.allow_permanent !== false,
    choices: Array.isArray(p.choices)
      ? p.choices.filter((choice): choice is string => typeof choice === 'string')
      : undefined,
    command: asString(p.command) ?? '',
    description: (asString(p.description) ?? '') || 'dangerous command',
    requestId: (asString(p.request_id) ?? '') || undefined,
    serverRequestId: id,
    sessionId,
    smartDenied: p.smart_denied === true
  }),
  method: 'approval',
  seamId: value => value.serverRequestId
})

const sudo = keyedPromptStore<SudoRequest>({
  from: ({ id, sessionId }) => ({ requestId: id, sessionId }),
  method: 'sudo',
  seamId: value => value.requestId
})

const secret = keyedPromptStore<SecretRequest>({
  from: ({ id, params: p, sessionId }) => ({
    envVar: asString(p.env_var) ?? '',
    prompt: asString(p.prompt) ?? '',
    requestId: id,
    sessionId
  }),
  method: 'secret',
  seamId: value => value.requestId
})

// Inline approval anchors, keyed by session: a tile's inline bar mounting must
// not suppress the PRIMARY session's floating fallback (and vice versa).
const $approvalInlineAnchors = atom<Record<string, number>>({})

export const $approvalRequest = approval.$active
export const setApprovalRequest = approval.set
export const clearApprovalRequest = approval.clear

export async function receiveApprovalRequest(gateway: ApprovalGateway | null, request: ApprovalRequest): Promise<void> {
  // A prompt restored from `approval.pending` must not clobber the live server
  // request for the same queue entry (that one knows how to answer).
  const current = approval.$all.get()[keyFor(request.sessionId)]

  if (current?.serverRequestId && !request.serverRequestId && current.requestId === request.requestId) {
    return
  }

  setApprovalRequest(request)
  void relayApprovalToSheet(gateway, request).catch(() => undefined)

  if (gateway && request.requestId && request.sessionId) {
    await gateway.request('approval.received', {
      request_id: request.requestId,
      session_id: request.sessionId
    })
  }
}

const relayed = new Set<string>()

/**
 * V3-F §3: a Hermes approval (dangerous command, plugin escalation) is answered on the permission sheet main owns,
 * never in the window. The window relays it to main and hands Hermes main's answer — `once` or `deny`, nothing wider.
 * Without the desktop bridge (web app) the prompt stays parked; nothing here answers on the user's behalf.
 */
async function relayApprovalToSheet(gateway: ApprovalGateway | null, request: ApprovalRequest): Promise<void> {
  const bridge = window.hermesDesktop?.icloneConsent?.permissions
  const key = `${request.sessionId ?? ''}:${request.requestId ?? request.serverRequestId ?? request.command}`

  if (!bridge || relayed.has(key)) {
    return
  }

  relayed.add(key)

  try {
    const choice = await bridge.hermesApproval({
      command: request.command,
      description: request.description,
      sessionId: request.sessionId
    })

    if (request.serverRequestId) {
      await answerServerRequest(request.serverRequestId, { choice } satisfies ApprovalResult)
    } else if (gateway) {
      // Through the session's owner (tile route → known profile), as the old inline bar did (#91684).
      const ambient = <R>(method: string, params?: Record<string, unknown>) =>
        gateway.request(method, params ?? {}) as Promise<R>

      await requestForOwnedSession(request.sessionId, ambient, 'approval.respond', {
        choice,
        request_id: request.requestId,
        session_id: request.sessionId ?? undefined
      })
    }

    clearApprovalRequest(request.sessionId, request.requestId)
  } finally {
    relayed.delete(key)
  }
}

export async function replayPendingApproval(gateway: ApprovalGateway | null, sessionId: string | null): Promise<void> {
  if (!gateway || !sessionId) {
    return
  }

  const pendingFor = (liveId: string) => gateway.request('approval.pending', { session_id: liveId })
  let liveSessionId = sessionId
  let rawResult: unknown

  try {
    rawResult = await pendingFor(sessionId)
  } catch (error) {
    // A reaped runtime ("not in memory" → 4001): resume the stored session
    // once and ask once more; a second failure means the runtime is lost.
    const storedId = isSessionNotFoundError(error)
      ? ($sessionStates.get()[sessionId]?.storedSessionId ?? storedSessionIdForRuntimeId(sessionId))
      : null

    if (!storedId) {
      throw error
    }

    try {
      const resumedId = await resumeStoredRuntimeSession(storedId, {
        requestGateway: <T>(method: string, params?: Record<string, unknown>) =>
          gateway.request(method, params ?? {}) as Promise<T>
      })

      if (!resumedId) {
        throw error
      }

      rawResult = await pendingFor(resumedId)
      liveSessionId = resumedId
    } catch (retryError) {
      noteSessionLost()

      throw retryError
    }
  }

  const result =
    rawResult && typeof rawResult === 'object' ? (rawResult as { approvals?: PendingApprovalPayload[] }) : {}

  const pending = Array.isArray(result?.approvals) ? result.approvals[0] : undefined

  if (!pending || typeof pending.request_id !== 'string') {
    return
  }

  await receiveApprovalRequest(gateway, {
    allowPermanent: pending.allow_permanent !== false,
    choices: Array.isArray(pending.choices) ? pending.choices.filter(choice => typeof choice === 'string') : undefined,
    command: typeof pending.command === 'string' ? pending.command : '',
    description: typeof pending.description === 'string' ? pending.description : 'dangerous command',
    requestId: pending.request_id,
    sessionId: liveSessionId,
    smartDenied: pending.smart_denied === true
  })
}

/** The prompt request for one specific session — the tile counterpart of the
 *  active-session `$*Request` views (same map, fixed key). */
export const sessionApprovalRequest = (sessionId: string | null) =>
  computed(approval.$all, all => all[keyFor(sessionId)] ?? null)
export const sessionSudoRequest = (sessionId: string | null) =>
  computed(sudo.$all, all => all[keyFor(sessionId)] ?? null)
export const sessionSecretRequest = (sessionId: string | null) =>
  computed(secret.$all, all => all[keyFor(sessionId)] ?? null)

export function registerApprovalInlineAnchor(sessionId: string | null): () => void {
  const key = keyFor(sessionId)

  const bump = (delta: number) => {
    const all = $approvalInlineAnchors.get()
    const next = Math.max(0, (all[key] ?? 0) + delta)
    $approvalInlineAnchors.set({ ...all, [key]: next })
  }

  bump(1)

  return () => bump(-1)
}

/** True when session `sessionId` has an inline approval bar mounted, so its
 *  floating fallback should stand down. Per-session (not global). */
export const sessionApprovalInlineVisible = (sessionId: string | null) =>
  computed($approvalInlineAnchors, anchors => (anchors[keyFor(sessionId)] ?? 0) > 0)

export const $sudoRequest = sudo.$active
export const setSudoRequest = sudo.set
export const clearSudoRequest = sudo.clear

export const $secretRequest = secret.$active
export const setSecretRequest = secret.set
export const clearSecretRequest = secret.clear

// True when the active session is blocked on the user (clarify question or an
// approval / sudo / secret prompt): the turn is paused on you, not working — so callers can
// suppress "thinking" indicators and the Esc-to-interrupt shortcut while you
// decide, instead of treating the wait as an in-flight turn.
export const $activeSessionAwaitingInput = computed(
  [$clarifyRequest, $approvalRequest, $sudoRequest, $secretRequest],
  (clarify, approval, sudo, secret) => Boolean(clarify || approval || sudo || secret)
)

/** True when `sessionId` is parked on a blocking prompt that typing cannot
 *  answer (approval / sudo / secret). Clarify is deliberately excluded: typing
 *  a real message IS an answer to a clarify ("none of these" — the composer
 *  skips it and routes the words), but no message text can approve a command
 *  or supply a password. Imperative read — the composer checks this on Enter,
 *  not on every render. */
export const hasBlockingPromptRequest = (sessionId: string | null | undefined): boolean => {
  const key = keyFor(sessionId)

  return Boolean(approval.$all.get()[key] || sudo.$all.get()[key] || secret.$all.get()[key])
}

/** Reactive twin of `hasBlockingPromptRequest`, for the composer's busy-action
 *  affordance (the primary button must advertise queue, not steer, while the
 *  turn is parked on a prompt Enter can't answer). */
export const sessionBlockingPrompt = (sessionId: string | null) =>
  computed([approval.$all, sudo.$all, secret.$all], (approvals, sudos, secrets) => {
    const key = keyFor(sessionId)

    return Boolean(approvals[key] || sudos[key] || secrets[key])
  })

/** Per-session `awaitingInput` — the tile composer's counterpart of
 *  `$activeSessionAwaitingInput` (same sources, fixed session instead of the
 *  active one). */
export function sessionAwaitingInput(sessionId: string | null) {
  return computed([$clarifyRequests, approval.$all, sudo.$all, secret.$all], (clarify, approvals, sudos, secrets) => {
    const key = keyFor(sessionId)

    return Boolean(clarify[key] || approvals[key] || sudos[key] || secrets[key])
  })
}

// Drop in-flight prompts for `sessionId` (a turn ended) across all three kinds —
// or every parked prompt when no session is given (global reset / tests).
export function clearAllPrompts(sessionId?: string | null): void {
  if (sessionId === undefined) {
    approval.reset()
    sudo.reset()
    secret.reset()
    $approvalInlineAnchors.set({})

    return
  }

  approval.clear(sessionId)
  sudo.clear(sessionId)
  secret.clear(sessionId)
}
