import { dismissNotification, notify } from '@/store/notifications'
import type { NotificationKind } from '@/store/notifications'

import type { CompactOutcome } from './compact-outcome'
import { compactCopy } from './compact.copy'

const RESULT_TOAST_MS = 5_000

export const compactNoticeId = (sessionId: string): string => `session-compress:${sessionId}`

export function presentCompactionStart(sessionId: string, focusTopic: string): void {
  notify({
    durationMs: 0,
    id: compactNoticeId(sessionId),
    kind: 'info',
    message: focusTopic ? compactCopy.compactingFor(focusTopic) : compactCopy.compactingGeneric
  })
}

/** The runtime's progress line replaces the start notice in place. */
export function presentCompactionProgress(sessionId: string, text: string): void {
  notify({ durationMs: 0, id: compactNoticeId(sessionId), kind: 'info', message: text })
}

const SUMMARY_TOAST_KIND: Partial<Record<CompactOutcome['kind'], NotificationKind>> = {
  aborted: 'error',
  noop: 'info',
  refused: 'warning'
}

/**
 * Transcript record + result toast for one outcome. Every answer the runtime
 * gave leaves a system line in the chat (as `/compress` always did), errors and
 * a held lock included, so no outcome is silent; only `aborted` is toast-only,
 * since nothing changed. `unsupported` is the caller's to handle (legacy
 * slash-worker fallback).
 */
export function presentCompactionOutcome(
  outcome: CompactOutcome,
  noticeId: string,
  render: (text: string) => void
): void {
  const toast = (kind: NotificationKind, message: string) =>
    notify({ durationMs: RESULT_TOAST_MS, id: noticeId, kind, message })

  if (outcome.kind === 'unsupported') {
    dismissNotification(noticeId)

    return
  }

  if (outcome.kind === 'busy' || outcome.kind === 'error') {
    dismissNotification(noticeId)
    render(compactCopy.errorLine(outcome.message ?? compactCopy.error))

    return
  }

  if (outcome.kind === 'lock_held' || outcome.kind === 'host') {
    const message = outcome.message ?? (outcome.kind === 'host' ? compactCopy.host : compactCopy.lockHeld)
    render(message)
    toast(outcome.kind === 'host' ? 'success' : 'warning', message)

    return
  }

  if (outcome.headline) {
    const text = [outcome.headline, outcome.tokenLine, outcome.note].filter(Boolean).join('\n')

    if (outcome.kind !== 'aborted') {
      render(text)
    }

    toast(SUMMARY_TOAST_KIND[outcome.kind] ?? 'success', text)

    return
  }

  if (outcome.kind === 'aborted') {
    toast('error', compactCopy.aborted)

    return
  }

  if (outcome.kind === 'refused') {
    render(compactCopy.wouldGrow)
    toast('warning', compactCopy.wouldGrow)

    return
  }

  const removed = outcome.removed ?? 0

  const message =
    (outcome.kind === 'compacted' || outcome.kind === 'fallback') && removed > 0
      ? compactCopy.compactedMessages(removed)
      : (outcome.message ?? compactCopy.nothingToCompress)

  render(message)
  toast(outcome.kind === 'noop' ? 'info' : 'success', message)
}
