/**
 * The pop-out pet's prompt box (V3-P r2): what it may send. One rule for the three places that check it — the overlay
 * (before it sends), main (before it forwards, the trust boundary) and the main renderer (before it submits).
 *
 * The composer itself has no character cap; its turn reaches the runtime, which keeps at most 64 000 characters of a
 * prompt (tui_gateway `_MAX_PROMPT_CHARS`), and the turn journal keeps 64 KiB of a text part. The pet box is held to
 * the runtime's bound so nothing it sends is ever cut.
 */
export const PET_PROMPT_MAX_CHARS = 64_000

/** The text to send (trimmed), or null: not a string, empty or whitespace only, or over the cap. */
export function petPromptText(value: unknown): null | string {
  if (typeof value !== 'string' || value.length > PET_PROMPT_MAX_CHARS) {
    return null
  }

  const text = value.trim()

  return text ? text : null
}

/**
 * What became of a message from the pet box (V3-P r3), answered by the main renderer and carried back through main to
 * the overlay: `sent` to the current session, `queued` behind its running turn (the composer's own queue), or
 * `refused` with the reason the box shows on its one line — the text stays in the box then.
 *
 * `unknown` (R4-F2) is main's own answer when the main renderer went away (its window closed, a reload, a crash) AFTER
 * it had handed the text on to the session: the message may have been sent, so the box keeps the text and says to
 * check the chat before resending — never "not sent", which would invite a duplicate turn. Gone BEFORE the hand-off:
 * `refused/not-sent`, which is then the truth.
 */
export type PetPromptRefusal = 'command' | 'no-session' | 'not-sent'

export type PetPromptReply =
  { outcome: 'queued' | 'sent' | 'unknown' } | { outcome: 'refused'; reason: PetPromptRefusal }

/** A reply tied to the submit it answers (`id`: the overlay's own counter). */
export type PetPromptResult = PetPromptReply & { id: number }

const REFUSALS: readonly PetPromptRefusal[] = ['command', 'no-session', 'not-sent']

/** A submit's id: a non-negative safe integer, or null. */
export function petPromptId(value: unknown): null | number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** A reply, checked and rebuilt (nothing else rides along), or null when it is not one. */
export function petPromptResult(value: unknown): null | PetPromptResult {
  const r = value as { id?: unknown; outcome?: unknown; reason?: unknown } | null
  const id = petPromptId(r?.id)

  if (!r || typeof r !== 'object' || id === null) {
    return null
  }

  if (r.outcome === 'sent' || r.outcome === 'queued' || r.outcome === 'unknown') {
    return { id, outcome: r.outcome }
  }

  if (r.outcome === 'refused' && REFUSALS.includes(r.reason as PetPromptRefusal)) {
    return { id, outcome: 'refused', reason: r.reason as PetPromptRefusal }
  }

  return null
}
