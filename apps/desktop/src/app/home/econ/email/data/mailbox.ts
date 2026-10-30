/** The email data module's `mailbox` section — its public names are re-exported by ../email-data.ts. */
import type { AcpFailure, AcpResult } from '../../cli'

import type { Mailbox } from './types'

// ── the address ─────────────────────────────────────────────────────────────

export const NO_ADDRESS = 'No address yet'

/** Why there is no address to show. */
export function mailboxNoteFor(result: AcpResult<Mailbox | null>): null | string {
  if (result.ok) {
    return result.data ? null : NO_ADDRESS
  }

  const notes: Partial<Record<AcpFailure['kind'], string>> = {
    'not-provisioned': NO_ADDRESS,
    reauth: 'Sign-in required'
  }

  return notes[result.kind] ?? 'Address unavailable right now'
}

/** The address after a `whoami` answer: a transient failure keeps the one
 *  already known (it never changes under an agent). */
export function nextMailbox(
  result: AcpResult<Mailbox | null>,
  known: Mailbox | null
): { mailbox: Mailbox | null; note: null | string } {
  if (result.ok || result.kind === 'not-provisioned' || !known) {
    const mailbox = result.ok ? result.data : null

    return { mailbox, note: mailbox ? null : mailboxNoteFor(result) }
  }

  return { mailbox: known, note: null }
}
