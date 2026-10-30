import { atom, computed } from 'nanostores'

import { answerServerRequest } from '@/lib/server-requests'

import { mirrorServerRequests, type ValueResult } from './prompts'

/**
 * Pending `mcp.setup` requests — the desktop half of the `setup_mcp` tool's
 * blocking bridge (tools/setup_mcp_tool.py). Only a runtime from before
 * server→client requests raises one (the seam's legacy bridge delivers it); the
 * live runtime has no `mcp.setup` request, so there the card never parks.
 * Mirrors the clarify store: keyed by the runtime session id that raised the
 * request so a background session can park its card while the user looks at
 * another chat, and the inline McpSetupTool reads its own session's entry.
 */
interface McpSetupRequest {
  requestId: string
  /** Catalog name (install) or mcp_servers config name (enable/authorize). */
  server: string
  action: 'authorize' | 'enable' | 'install'
  /** Agent-supplied one-liner: why this server helps right now. */
  reason: string
  sessionId: string | null
}

/** The card's answer, sent JSON-encoded as the request's `{value}` result. */
export interface McpSetupOutcome {
  status: 'authorized' | 'declined' | 'enabled' | 'error' | 'installed'
  server: string
  detail?: string
  /** Tool names now available (OAuth flows report them). */
  tools?: string[]
}

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

const $mcpSetupRequests = atom<Record<string, McpSetupRequest>>({})

const ACTIONS: readonly McpSetupRequest['action'][] = ['authorize', 'enable', 'install']

const seam = mirrorServerRequests($mcpSetupRequests, {
  from: ({ id, params: p, sessionId }) => {
    const action = ACTIONS.find(value => value === p.action)
    const server = typeof p.server === 'string' ? p.server : ''

    return action && server
      ? { action, reason: typeof p.reason === 'string' ? p.reason : '', requestId: id, server, sessionId }
      : null
  },
  method: 'mcp.setup',
  seamId: value => value.requestId
})

/** The setup request for one specific session — the transcript card reads
 *  this fixed-key view, same shape as `sessionClarifyRequest`. */
export const sessionMcpSetupRequest = (sessionId: string | null) =>
  computed($mcpSetupRequests, requests => requests[keyFor(sessionId)] ?? null)

export function setMcpSetupRequest(request: McpSetupRequest): void {
  seam.restore(request)
  $mcpSetupRequests.set({ ...$mcpSetupRequests.get(), [keyFor(request.sessionId)]: request })
}

export function clearMcpSetupRequest(requestId?: string, sessionId?: string | null): void {
  const requests = $mcpSetupRequests.get()

  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (requestId && current.requestId !== requestId)) {
      return
    }

    seam.dismiss([current])
    const next = { ...requests }
    delete next[key]
    $mcpSetupRequests.set(next)

    return
  }

  const next: Record<string, McpSetupRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(requests)) {
    if (requestId && value.requestId !== requestId) {
      next[key] = value
    } else {
      seam.dismiss([value])
      changed = true
    }
  }

  if (changed) {
    $mcpSetupRequests.set(next)
  }
}

/** Whether `sessionId` has a setup card pending right now (imperative read —
 *  the composer checks this on Enter, not on every render). */
export const hasMcpSetupRequest = (sessionId: string | null | undefined): boolean =>
  Boolean($mcpSetupRequests.get()[keyFor(sessionId)])

/**
 * Answer `sessionId`'s pending setup card as declined and drop it locally,
 * resolving to whether there was one to skip.
 *
 * The composer uses this when the user types a real message instead of acting
 * on the card: setup_mcp blocks the agent inside its tool batch, so leaving
 * the card unanswered would park the follow-up until the 10-minute timeout —
 * the message looks sent and nothing happens. Typing IS the answer "not now":
 * decline so the tool returns, then route the words normally.
 *
 * Mirrors skipClarifyRequest; answering a request the runtime already timed
 * out is harmless.
 */
export async function skipMcpSetupRequest(sessionId: string | null | undefined): Promise<boolean> {
  const request = $mcpSetupRequests.get()[keyFor(sessionId)]

  if (!request) {
    return false
  }

  // Clear first: the answer is already decided, and an in-flight answer must
  // not leave a live card the user can answer a second time.
  clearMcpSetupRequest(request.requestId, request.sessionId)

  try {
    const outcome: McpSetupOutcome = { server: request.server, status: 'declined' }

    await answerServerRequest(request.requestId, { value: JSON.stringify(outcome) } satisfies ValueResult)
  } catch {
    // The tool times out on its own; a failed skip must never swallow the
    // message the user is actually sending.
  }

  return true
}
