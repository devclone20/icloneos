import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useCallback, useMemo } from 'react'

import { errorMessage } from '@/iclone-shared/errors'
import { COMPRESS_COMMAND } from '@/lib/desktop-slash-commands'
import { $activeSessionId } from '@/store/session'
import { $sessionStates, sessionTileDelegate } from '@/store/session-states'

import { $compactions, claimCompaction, type CompactEntry, settleUnclaimedCompaction } from './compact-store'
import { compactCopy } from './compact.copy'

/** The runtime refuses `session.compress` below this many history messages. */
export const MIN_COMPACT_MESSAGES = 4

export interface CompactSessionState {
  /** Why the action is unavailable right now, or null when it can run. */
  disabledReason: null | string
  entry: CompactEntry | null
  running: boolean
  sessionId: null | string
  compact: (focusTopic?: string) => Promise<void>
}

// One primitive per session so a streaming transcript re-renders the button
// only when busy-ness or the countable size actually changes.
function sessionGateSignature(sessionId: null | string) {
  return computed($sessionStates, states => {
    const state = sessionId ? states[sessionId] : undefined

    if (!state) {
      return 'none'
    }

    const counted = state.messages.reduce((total, message) => total + (message.role === 'system' ? 0 : 1), 0)

    return `${state.busy || state.awaitingResponse ? 'busy' : 'idle'}:${Math.min(counted, MIN_COMPACT_MESSAGES)}`
  })
}

function compactDisabledReason(signature: string, entry: CompactEntry | null, sessionId: null | string) {
  if (!sessionId || signature === 'none') {
    return compactCopy.noSession
  }

  if (entry?.phase === 'pending' || entry?.phase === 'running') {
    return compactCopy.running
  }

  const [busy, count] = signature.split(':')

  if (busy === 'busy') {
    return compactCopy.busy
  }

  return Number(count) < MIN_COMPACT_MESSAGES ? compactCopy.tooFew : null
}

/**
 * Compact a session through the Hermes runtime. `compact()` claims the session
 * synchronously (a double click sends one request) and routes through the
 * `/compress` slash path — the same engine, transcript record, toast and
 * stale-runtime recovery for every surface. `sessionId` defaults to the
 * focused chat's runtime id.
 */
export function useCompactSession(sessionId?: null | string): CompactSessionState {
  const activeSessionId = useStore($activeSessionId)
  const target = sessionId === undefined ? activeSessionId : sessionId
  const signature = useStore(useMemo(() => sessionGateSignature(target), [target]))
  const compactions = useStore($compactions)
  const entry = target ? (compactions[target] ?? null) : null
  const disabledReason = compactDisabledReason(signature, entry, target)

  const compact = useCallback(
    async (focusTopic?: string) => {
      if (!target || !claimCompaction(target)) {
        return
      }

      const delegate = sessionTileDelegate()
      const topic = focusTopic?.trim()

      try {
        if (!delegate) {
          throw new Error(compactCopy.sessionUnavailable)
        }

        await delegate.executeSlash(topic ? `${COMPRESS_COMMAND} ${topic}` : COMPRESS_COMMAND, target)
        settleUnclaimedCompaction(target, { kind: 'error', message: compactCopy.sessionUnavailable, sessionId: target })
      } catch (error) {
        settleUnclaimedCompaction(target, {
          kind: 'error',
          message: errorMessage(error, compactCopy.sessionUnavailable),
          sessionId: target
        })
      }
    },
    [target]
  )

  return {
    compact,
    disabledReason,
    entry,
    running: entry?.phase === 'pending' || entry?.phase === 'running',
    sessionId: target
  }
}
