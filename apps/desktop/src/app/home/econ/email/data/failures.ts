/** The email data module's `failures` section — its public names are re-exported by ../email-data.ts. */
import { type AcpFailure, humanizeAcpError } from '../../cli'

// ── failures ────────────────────────────────────────────────────────────────

export interface FailureCopy {
  title: string
  hint: string
  next: 'retry' | 'setup' | null
}

/** A read failure, said plainly, with the one thing to do next. */
export function describeFailure(failure: AcpFailure, subject = 'the mailbox'): FailureCopy {
  switch (failure.kind) {
    case 'not-provisioned':
      return {
        title: 'No mailbox yet',
        hint: 'This agent has no email address yet. Provision it in Setup — it takes one step.',
        next: 'setup'
      }

    case 'reauth':

    case 'reauth-acp':
      return {
        title: 'Sign-in required',
        hint: 'The agent’s Virtuals session has expired. Sign in again from Setup.',
        next: 'setup'
      }

    case 'busy':
      return {
        title: 'The agent is busy',
        hint: 'Another command is running for this iNFT. This retries on its own.',
        next: 'retry'
      }

    case 'timeout':
      return {
        title: 'No answer in time',
        hint: `Reading ${subject} took too long — the first call after a pause can be slow. Try again.`,
        next: 'retry'
      }

    case 'unavailable':
      return { title: 'Engine unavailable', hint: humanizeAcpError(failure.error), next: null }

    default:
      return { title: `Couldn’t read ${subject}`, hint: humanizeAcpError(failure.error), next: 'retry' }
  }
}

/** A few words for the window header's status line. */
export function failureSummary(failure: AcpFailure): string {
  const labels: Record<AcpFailure['kind'], string> = {
    busy: 'agent busy',
    cli: 'mailbox read failed',
    'not-provisioned': 'no mailbox yet',
    parse: 'mailbox read failed',
    reauth: 'sign-in required',
    'reauth-acp': 'sign-in required',
    timeout: 'mailbox timed out',
    unavailable: 'engine unavailable'
  }

  return labels[failure.kind]
}

/** A write failure. A timeout is NOT proof nothing went out — say so. */
export function describeSendFailure(failure: AcpFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return 'No answer from the CLI in time — the message may still have gone out. Check Sent before trying again.'

    case 'busy':
      return 'Another command is running for this agent. Try again in a moment.'

    case 'reauth':
      return 'Sign-in required — sign in again from Setup, then send.'

    case 'not-provisioned':
      return 'This agent has no mailbox yet — provision it in Setup.'

    default:
      return humanizeAcpError(failure.error)
  }
}
