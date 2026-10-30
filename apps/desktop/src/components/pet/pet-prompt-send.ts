import { isTargetSessionBusy } from '@/app/session/hooks/use-prompt-actions/utils'
import { type PetPromptReply, petPromptText } from '@/iclone-shared/pet-prompt'
import { SLASH_COMMAND_RE } from '@/lib/chat-runtime'
import { sanitizeComposerInput } from '@/lib/composer-input-sanitize'
import { hasClarifyRequest } from '@/store/clarify'
import type { ComposerAttachment } from '@/store/composer'
import { enqueueQueuedPrompt } from '@/store/composer-queue'
import { hasBlockingPromptRequest } from '@/store/prompts'
import { $sessions, resolveComposerSessionKey } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import type { PetPromptTarget } from './pet-prompt-target'

export interface PetPromptDeps {
  /** The composer's own send (`usePromptActions().submitText`): resolves true once the prompt reached the session. */
  submitText?: (text: string, options: { attachments: ComposerAttachment[] }) => unknown
  target?: () => PetPromptTarget
  /**
   * Called, and awaited, right before the text leaves for the session (queued or sent): main records the hand-off, so a
   * main window lost after it answers "may have been sent", never "not sent" (R4-F2). It throwing, or answering
   * `false` (main did not record it): nothing is queued or sent, refused not-sent.
   */
  handOff?: () => Promise<unknown>
}

const refused = (reason: Extract<PetPromptReply, { outcome: 'refused' }>['reason']): PetPromptReply => ({
  outcome: 'refused',
  reason
})

/**
 * The pet box's sender (V3-P r3): only a normal message, only to the session on screen.
 *
 * - A slash command is refused (the box says "commands go in the composer"): the pet box never runs a command, a
 *   backend exec, a session switch or a mode change. The test reads the text exactly as the composer's send would
 *   (`sanitizeComposerInput`, trimmed), so nothing that send would treat as a command gets through.
 * - No session on screen (a new-chat draft): refused — sending would start a new session, not message this one.
 * - The session is busy, or parked on a clarify / approval: the message joins the composer's own queue for that
 *   session (`enqueueQueuedPrompt`, the same store and key the composer uses) and runs as the next turn — never dropped.
 * - Otherwise the composer's send, with `attachments: []`: the composer's staged attachments are neither read nor
 *   removed. A send that does not land is refused, so the box keeps the text.
 * - Before queueing or sending, `handOff` tells main the text is about to leave (R4-F2), and is awaited. A throw or a
 *   `false` answer (main did not record the hand-off) is refused not-sent: nothing is queued or sent.
 */
export async function sendPetPrompt(
  raw: string,
  { submitText, target, handOff }: PetPromptDeps
): Promise<PetPromptReply> {
  const text = petPromptText(raw)

  if (text === null || !submitText || !target) {
    return refused('not-sent')
  }

  if (SLASH_COMMAND_RE.test(sanitizeComposerInput(text).trim())) {
    return refused('command')
  }

  const { busy, runtimeId, storedId } = target()

  if (!runtimeId && !storedId) {
    return refused('no-session')
  }

  const parked = Boolean(runtimeId) && (hasClarifyRequest(runtimeId) || hasBlockingPromptRequest(runtimeId))
  const queue = parked || isTargetSessionBusy($sessionStates.get(), runtimeId, busy)

  // Main answers `false` when it did not record the hand-off (the entry was already answered "not sent" because the
  // main window was reloading, was evicted, or the sender is not the one the submit went to): the text must not leave.
  try {
    if ((await handOff?.()) === false) {
      return refused('not-sent')
    }
  } catch {
    return refused('not-sent')
  }

  if (queue) {
    // The composer's queue key for this session: its lineage root when the stored row is known, else the id itself.
    const key = resolveComposerSessionKey(storedId, $sessions.get()) || storedId || runtimeId

    return enqueueQueuedPrompt(key, { attachments: [], text }) ? { outcome: 'queued' } : refused('not-sent')
  }

  try {
    return (await submitText(text, { attachments: [] })) === true ? { outcome: 'sent' } : refused('not-sent')
  } catch {
    return refused('not-sent')
  }
}
