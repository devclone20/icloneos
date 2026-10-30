/**
 * iclone os — reading `card whoami` (pure; no Electron, no I/O).
 *
 * The answer decides whether the wizard offers "send sign-in link", so a
 * misread costs the owner a repeated signup — the pattern that got an
 * AgentCard account blocked. Four real answers exist: a verified profile
 * (ready), a 200 `verified:false` or a 401 `REAUTH:<state>:<email>` (a link
 * is waiting in the agent inbox), a 400 "not set up" (never signed up), and a
 * 403/429 (blocked or rate-limited). Anything else — a timeout, a dead ACP
 * session, a 5xx, a bare 400/404, a 401 without `REAUTH:<state>` — is not an
 * answer about the card and must never be persisted as one.
 */
import { asRecord } from '../src/iclone-shared/guards'

import type { AcpRunResult } from './iclone-acp'
import { envelopeError, parseJsonLoose } from './iclone-acp-output'

export type CardState = 'none' | 'ready' | 'signin-pending' | 'blocked'

interface CardProbe {
  /** False when the probe produced no answer about the card. */
  answered: boolean
  state?: CardState
  /** The pending signup's state id, as the service hands it back. */
  reauthState?: string
  reauthEmail?: string
  /** `nextStep.hint` of a 200 `verified:false`. */
  hint?: string
  httpStatus?: number
}

/** `card whoami` is re-read at most this often unless a card step forces it. */
export const CARD_TTL_MS = 10 * 60_000

/** A pending link is re-read sooner (the owner may click it any moment) but
 *  still cached: an unforced wizard run spawns `card whoami` at most 3 times. */
export const CARD_PENDING_TTL_MS = 3 * 60_000

/** A blocked account is not re-read inside the service's 15-min 403 hold. */
export const CARD_BLOCKED_TTL_MS = 15 * 60_000

const REAUTH = /REAUTH:([0-9a-f-]{6,80})(?::([^\s"'\\}]+@[^\s"'\\}]+))?/i

// The ACP layer's own failures (expired session, no agent): never the card service's "not set up".
const SESSION_NOT_CARD =
  /not authenticated|session expired|not logged in|login required|no active agent|not configured|run `?acp configure/i

/** The card service's own "never signed up" answer — the one text that may persist `none`. Another noun's
 *  "not set up" (wallet, signer policy, inbox) is a generic 4xx about something else. */
const CARD_NOT_SET_UP = /call card signup|\b(?:agent ?card|card|agent) (?:is )?not set up\b/i

/** Pure: one `card whoami` result → what it says about the card. */
export function cardStateFrom(result: AcpRunResult): CardProbe {
  const json = asRecord(parseJsonLoose(result.stdout))
  const message = envelopeError(json) ?? (result.ok ? undefined : (result.error ?? result.stderr))

  if (result.ok && json && !message) {
    const verified = json.verified ?? asRecord(json.data)?.verified

    // An empty object says nothing about the card.
    if (verified === undefined && Object.keys(json).length === 0) {
      return { answered: false }
    }

    if (verified === false || verified === 'false') {
      const next = asRecord(json.nextStep)
      const hint = typeof next?.hint === 'string' ? next.hint.slice(0, 300) : undefined

      return { answered: true, state: 'signin-pending', ...(hint ? { hint } : {}) }
    }

    return { answered: true, state: 'ready' }
  }

  const text = message ?? ''
  const code = typeof json?.code === 'string' ? json.code : ''
  const httpStatus = Number(/HTTP (\d{3})/.exec(text)?.[1]) || undefined
  const reauth = REAUTH.exec(text)

  if (reauth) {
    return {
      answered: true,
      state: 'signin-pending',
      reauthState: reauth[1],
      ...(reauth[2] ? { reauthEmail: reauth[2] } : {}),
      httpStatus
    }
  }

  // A dead ACP session, a missing agent or a timeout says nothing about the card — whatever HTTP status carries it.
  if (
    /^(TIMEOUT|NOT_AUTHENTICATED|NO_ACTIVE_AGENT)$/.test(code) ||
    SESSION_NOT_CARD.test(text) ||
    (!result.stdout && result.error)
  ) {
    return { answered: false, httpStatus }
  }

  if (httpStatus === 403 || httpStatus === 429 || /\b(blocked|locked|suspended)\b/i.test(text)) {
    return { answered: true, state: 'blocked', httpStatus }
  }

  // Only the service's own 400 (or its code) says "never signed up": a bare 400/404 is a bad request, and a 5xx
  // carrying the same words is a server failure — neither is "no card".
  if ((httpStatus === 400 && CARD_NOT_SET_UP.test(text)) || /^(CARD_)?NOT_SET_?UP$/i.test(code)) {
    return { answered: true, state: 'none', httpStatus }
  }

  return { answered: false, httpStatus }
}

/** The card fields `readStatus` persists in `status.json` after a `card whoami` probe. */
interface CardFields {
  cardState?: CardState
  cardReady: boolean
  cardCheckedAt?: number
  cardReauthState?: string
  cardReauthEmail?: string
  cardHint?: string
  cardHttpStatus?: number
  cardStale?: boolean
  /** A card was seen `ready` on this agent; only the service's authoritative `none` clears it. */
  cardKnown?: boolean
  /** When the card was last seen `ready` (absent for a legacy status that carried only `cardReady`). */
  cardKnownAt?: number
}

/** Whether `last` says a card was seen ready: the sticky field, or a status written before it existed. */
function cardKnownIn(last: Partial<CardFields> | null | undefined): boolean {
  return (
    last?.cardKnown === true ||
    last?.cardState === 'ready' ||
    (last?.cardState === undefined && last?.cardReady === true)
  )
}

/** Pure: the persisted status whose card fields describe this agent's card — `last`, unless another agent
 *  now sits behind the iNFT. An expired session re-signed in is the same agent (agentId kept). */
export function sameCardAgent<T extends { agentId?: string }>(last: T | null | undefined, agentId?: string): T | null {
  return last && (!last.agentId || !agentId || last.agentId === agentId) ? last : null
}

/**
 * Pure: the card fields after one probe. A `ready` answer sets the known-card fact, the authoritative `none`
 * is the only answer that clears it, and a waiting link, a block or a non-answer carry it — so a lapsed
 * AgentCard sign-in never turns the owner's card into "no card". A non-answer keeps the last fields, stale.
 */
export function nextCardFields(last: Partial<CardFields> | null | undefined, probe: CardProbe, at: number): CardFields {
  const known = cardKnownIn(last)
  const knownAt = typeof last?.cardKnownAt === 'number' ? last.cardKnownAt : undefined

  if (!probe.answered || !probe.state) {
    return {
      cardState: last?.cardState,
      cardReady: last?.cardReady === true,
      cardCheckedAt: last?.cardCheckedAt,
      cardReauthState: last?.cardReauthState,
      cardReauthEmail: last?.cardReauthEmail,
      cardHint: last?.cardHint,
      cardHttpStatus: last?.cardHttpStatus,
      cardStale: true,
      cardKnown: known || undefined,
      cardKnownAt: known ? knownAt : undefined
    }
  }

  const ready = probe.state === 'ready'
  const keepsKnown = ready || (known && probe.state !== 'none')

  return {
    cardState: probe.state,
    cardReady: ready,
    cardCheckedAt: at,
    cardReauthState: probe.reauthState,
    cardReauthEmail: probe.reauthEmail,
    cardHint: probe.hint,
    cardHttpStatus: probe.httpStatus,
    cardStale: undefined,
    cardKnown: keepsKnown || undefined,
    cardKnownAt: ready ? at : keepsKnown ? knownAt : undefined
  }
}

interface PersistedCard {
  cardState?: CardState
  cardCheckedAt?: number
  cardStale?: boolean
  stale?: boolean
}

/** Pure: whether a probe stamped `at` is due again (missing, future or older than the TTL). */
export function probeDue(at: unknown, now: number, ttlMs: number = CARD_TTL_MS): boolean {
  return typeof at !== 'number' || !Number.isFinite(at) || at > now || now - at > ttlMs
}

/** Pure: whether `readStatus` must spawn `card whoami` now. A pending link
 *  lives the shorter pending TTL; a card step (`opts.card`) always re-reads it. */
export function cardProbeDue(
  persisted: PersistedCard | null,
  now: number,
  ttlMs: number = CARD_TTL_MS,
  opts: { force?: boolean; card?: boolean } = {}
): boolean {
  if (opts.force || opts.card || !persisted || persisted.stale || persisted.cardStale) {
    return true
  }

  if (!persisted.cardState) {
    return true
  }

  return probeDue(
    persisted.cardCheckedAt,
    now,
    persisted.cardState === 'signin-pending'
      ? Math.min(ttlMs, CARD_PENDING_TTL_MS)
      : persisted.cardState === 'blocked'
        ? Math.max(ttlMs, CARD_BLOCKED_TTL_MS)
        : ttlMs
  )
}
