/** EconomyOS — the note a Dock app shows for a failed ACP read: what it says and which action it offers. */
import { type AcpFailure, humanizeAcpError, needsSetup, setupNotice } from './cli'

export interface FailureNote {
  action: string
  message: string
  /** The action opens Setup (sign in, provision) instead of retrying. */
  setup: boolean
}

/** A sign-in or setup state opens Setup — an expired Virtuals session asks to
 *  sign in again, never "setup needed"; anything else retries. */
export function failureNote(failure: AcpFailure): FailureNote {
  if (!needsSetup(failure)) {
    return { action: 'Try again', message: humanizeAcpError(failure.error), setup: false }
  }

  const notice = setupNotice(failure)

  return {
    action: notice === 'Sign in again' ? notice : 'Open Setup',
    message:
      failure.kind === 'reauth-acp' ? 'The Virtuals session for this iNFT expired.' : humanizeAcpError(failure.error),
    setup: true
  }
}
