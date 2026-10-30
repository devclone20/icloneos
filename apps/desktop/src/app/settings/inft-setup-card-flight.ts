/**
 * iclone os — card calls that outlive their wizard.
 *
 * One `card signup` in flight per iNFT for the whole renderer: a remount or an
 * iNFT switch away and back does not forget it (the AgentCard account of the
 * owner was blocked by repeated signups). An answer that lands after the
 * wizard closed or switched is still the service's answer for the iNFT it was
 * sent for: it goes through the pure reducer and is written ONCE to that
 * iNFT's `card-signup` kv — never into a live machine, timer, poll or link.
 * A wizard showing that iNFT re-reads the kv when it hears about the write.
 */
import { type AcpRunResult, inftKvDelete, inftKvGet, inftKvSet } from '../home/acp-setup'

import {
  beforeMarker,
  type CardErrorInfo,
  cardErrorInfo,
  type CardSignupState,
  isSendingMarker,
  parsePersistedSignup,
  reduceSignup,
  serializeSignup,
  type SignupEvent,
  type SignupGate
} from './inft-setup-card-signup'
import { cliJson, pickString } from './inft-setup-runner'

export const SIGNUP_IN_FLIGHT_GATE: SignupGate = { gate: 'refused', reason: 'link-sending' }

const inFlight = new Set<string>()
const recorded = new Map<string, number>()
const writes = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) {
    listener()
  }
}

export function subscribeCardFlight(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export function signupInFlight(inftId: string | null): boolean {
  return inftId !== null && inFlight.has(inftId)
}

/** How many late answers were recorded for this iNFT (a wizard showing it re-reads the kv when this moves). */
export function lateAnswersFor(inftId: string | null): number {
  return inftId === null ? 0 : (recorded.get(inftId) ?? 0)
}

/** Takes the iNFT's one signup slot; false when a signup for it is already running. */
export function claimSignup(inftId: string): boolean {
  if (inFlight.has(inftId)) {
    return false
  }

  inFlight.add(inftId)
  emit()

  return true
}

export function releaseSignup(inftId: string): void {
  if (inFlight.delete(inftId)) {
    emit()
  }
}

export function hasCardError(result: AcpRunResult | null): boolean {
  return !result || !result.ok || typeof cliJson(result)?.error === 'string'
}

/** What a `card signup` answer means for the machine: a state token, or an error the reducer classifies. */
export function signupAnswer(
  result: AcpRunResult | null,
  email: string,
  now: number
): Extract<SignupEvent, { type: 'sent' | 'poll-error' }> {
  const state = hasCardError(result) ? undefined : pickString(cliJson(result), ['state', 'stateToken'])

  return state
    ? { type: 'sent', state, email, now, source: 'local' }
    : { type: 'poll-error', info: cardErrorInfo(result), now }
}

/** True while a signup for the iNFT runs or its persisted 403/429 hold lasts: card calls outside the wizard wait too. */
export async function cardHeld(inftId: string, now = Date.now()): Promise<boolean> {
  if (inFlight.has(inftId)) {
    return true
  }

  try {
    const persisted = await inftKvGet(inftId, 'card-signup')
    const s = persisted.ok ? parsePersistedSignup(persisted.value) : null

    return (s?.cooldownUntil ?? 0) > now
  } catch {
    return false
  }
}

/** A 403/429 of any card call is a hold the iNFT keeps; anything else from a closed wizard is dropped. */
export function lateHold(info: CardErrorInfo, now: number): SignupEvent | null {
  return info.cooldownMs ? { type: 'poll-error', info, now } : null
}

async function writeLate(
  inftId: string,
  event: SignupEvent,
  sentFrom: CardSignupState,
  markerAt?: number
): Promise<boolean> {
  const persisted = await inftKvGet(inftId, 'card-signup').catch(() => null)
  const stored = persisted?.ok ? parsePersistedSignup(persisted.value) : null
  // The pre-send marker is not a state the answer builds on: it is what the answer replaces.
  const marked = markerAt !== undefined && stored !== null && isSendingMarker(stored, markerAt)
  const base = marked && markerAt !== undefined ? beforeMarker(stored, sentFrom, markerAt) : (stored ?? sentFrom)
  const next = reduceSignup(base, event)
  const body = serializeSignup(next)

  if (!marked && JSON.stringify(body) === JSON.stringify(serializeSignup(base))) {
    return false
  }

  const done = next.phase === 'idle' || next.phase === 'done'

  const result = await (done ? inftKvDelete(inftId, 'card-signup') : inftKvSet(inftId, 'card-signup', body)).catch(
    () => null
  )

  return Boolean(result?.ok)
}

/**
 * Records an answer that arrived after its wizard closed (one kv write, serialised per iNFT so two
 * late answers never overwrite each other). `sentFrom` is the machine as it was when the call left;
 * `markerAt` is the `sentAt` of the pre-send marker this answer replaces.
 */
export function recordLateAnswer(
  inftId: string,
  event: SignupEvent,
  sentFrom: CardSignupState,
  markerAt?: number
): Promise<void> {
  const run = (writes.get(inftId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeLate(inftId, event, sentFrom, markerAt))
    .then(wrote => {
      if (wrote) {
        recorded.set(inftId, lateAnswersFor(inftId) + 1)
        emit()
      }
    })

  writes.set(inftId, run)

  return run
}
