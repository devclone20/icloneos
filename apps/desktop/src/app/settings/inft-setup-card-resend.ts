/**
 * iclone os — the one fresh sign-in link for a card account whose link is still unopened.
 *
 * `card whoami` only reads: a 200 `verified:false` or a 401 `REAUTH:<state>` reports a link sent EARLIER (the
 * service's own hint: "Magic link sent but not clicked yet"). Only `card signup --email` sends one. So opening a
 * window sends nothing; this runs on the owner's click and nowhere else — the Bank's Resend and the Setup
 * wizard's card step both call it, and both ask `resendGate` first, so they always give the same answer.
 *
 * Guards, outermost first: one signup in flight per iNFT for the whole renderer (`claimSignup`); the 403/429
 * hold and the one-minute wait read back from the iNFT's `card-signup` record (both survive a re-mount and a
 * window reopen); a pre-send marker on disk; and main's own single-flight, hold and minute, which refuse even a
 * caller that skipped all of this. The answer is recorded once in the record, so the wizard resumes from it.
 * "Sent" is the moment the CLI confirmed the send with a state token — never the click, never an unanswered call.
 */
import { type AcpRunResult, inftKvGet, inftKvSet, runAcp } from '../home/acp-setup'

import { claimSignup, recordLateAnswer, releaseSignup, signupAnswer } from './inft-setup-card-flight'
import {
  type CardErrorInfo,
  type CardSignupState,
  IDLE_SIGNUP,
  parsePersistedSignup,
  resendGate,
  sendingMarker,
  serializeSignup
} from './inft-setup-card-signup'

export type SignInLinkSend =
  | { kind: 'sent'; at: number }
  | { kind: 'busy' }
  /** The service's 403/429 hold. */
  | { kind: 'held'; until: number }
  /** The minute after the last link. */
  | { kind: 'wait'; until: number }
  | { kind: 'not-recorded' }
  | { kind: 'failed'; info: CardErrorInfo }

interface SignInLinkDeps {
  run: (inftId: string, argv: string[], timeoutMs?: number) => Promise<AcpRunResult>
  now: () => number
}

const SIGNUP_TIMEOUT_MS = 90_000

const DEFAULT_DEPS: SignInLinkDeps = { run: runAcp, now: () => Date.now() }

/** The persisted signup, or idle when there is none (or it cannot be read). */
async function persistedSignup(inftId: string): Promise<CardSignupState> {
  const stored = await inftKvGet(inftId, 'card-signup').catch(() => null)

  return (stored?.ok ? parsePersistedSignup(stored.value) : null) ?? IDLE_SIGNUP
}

/** When the persisted record says a link was CONFIRMED sent: a state token from our own signup's answer. An
 *  unconfirmed marker, a server-adopted token or a record without a time says nothing about when. */
export function confirmedSentAt(s: CardSignupState | null): null | number {
  if (!s || s.phase === 'unconfirmed' || s.source !== 'local' || !s.state || s.sentAt === undefined) {
    return null
  }

  return s.sentAt
}

export interface SignInRecord {
  /** The last confirmed send (null = none on record). */
  confirmedAt: null | number
  /** When a click may send again (0 = now): the hold or the minute, as `resendGate` reads them. */
  readyAt: number
}

/** What the iNFT's `card-signup` record says about its sign-in link, for a window that just (re)opened. */
export async function readSignInRecord(inftId: string, now: number = Date.now()): Promise<SignInRecord> {
  const s = await persistedSignup(inftId)
  const gate = resendGate(s, now)

  const readyAt =
    gate.reason === 'cooling' ? (s.cooldownUntil ?? 0) : gate.reason === 'resend-wait' ? (gate.at ?? 0) : 0

  return { confirmedAt: confirmedSentAt(s), readyAt }
}

/** Sends one fresh sign-in link to `email` on the owner's click. */
export async function sendSignInLink(
  inftId: string,
  email: string,
  deps: SignInLinkDeps = DEFAULT_DEPS
): Promise<SignInLinkSend> {
  if (!claimSignup(inftId)) {
    return { kind: 'busy' }
  }

  try {
    const sentFrom = await persistedSignup(inftId)
    const startedAt = deps.now()
    const gate = resendGate(sentFrom, startedAt)

    if (gate.reason === 'cooling') {
      return { kind: 'held', until: sentFrom.cooldownUntil ?? startedAt }
    }

    if (gate.reason === 'resend-wait') {
      return { kind: 'wait', until: gate.at ?? startedAt }
    }

    // On disk before the call leaves: a crash mid-flight reads back "unconfirmed", never "nothing sent".
    const marked = await inftKvSet(
      inftId,
      'card-signup',
      serializeSignup(sendingMarker(sentFrom, email, startedAt))
    ).catch(() => null)

    if (!marked?.ok) {
      return { kind: 'not-recorded' }
    }

    const result = await deps.run(inftId, ['card', 'signup', '--email', email, '--json'], SIGNUP_TIMEOUT_MS)
    const event = signupAnswer(result, email, deps.now())

    await recordLateAnswer(inftId, event, sentFrom, startedAt)

    if (event.type === 'sent') {
      return { kind: 'sent', at: event.now }
    }

    // Main's own minute (another window sent first): nothing went out.
    if (event.info.code === 'resend-wait' && event.info.resendAt !== undefined) {
      return { kind: 'wait', until: event.info.resendAt }
    }

    return { kind: 'failed', info: event.info }
  } finally {
    releaseSignup(inftId)
  }
}
