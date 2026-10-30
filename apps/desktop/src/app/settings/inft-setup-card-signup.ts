/**
 * iclone os — the card signup as a pure state machine (no React, no I/O).
 *
 * One signup per state token, never a second one by accident: the AgentCard
 * account of the owner was blocked by repeated signups. The service itself is
 * the resume source (`card whoami` hands back `REAUTH:<state>:<email>` while a
 * link waits); the persisted copy only adds what the service cannot say
 * (when it was sent, how many polls this attempt already spent). Polls back
 * off 5 → 10 → 20 → 40 → 60 s and stop after 15 min (≤ 18 polls); the inbox
 * is searched for the link at most 3 times per attempt.
 */
import { asFiniteNumber, asRecord, asString } from '@/iclone-shared/guards'

import type { AcpRunResult, InftAcpStatus } from '../home/acp-setup'
import { type AcpLimit, BLOCKED_COOLDOWN_MS, classifyAcpError, humanizeAcpError, parseCliJson } from '../home/econ/cli'

/** `unconfirmed`: a signup got no clear answer (timeout, 5xx, no state) — it may have reached the service. */
type SignupPhase = 'idle' | 'polling' | 'done' | 'expired' | 'cooldown' | 'unconfirmed'

/**
 * Why a card call failed, as a code the wizard copy turns into a sentence in the person's locale.
 * `failed` carries the service's own words in `detail`; `held` carries the hold end in `at`.
 */
export type CardErrorCode =
  | 'blocked'
  | 'busy'
  | 'failed'
  | 'held'
  | 'link-waiting'
  | 'no-state'
  | 'not-ready'
  | 'rate-limited'
  | 'resend-wait'
  | 'sent-unanswered'
  | 'timeout'

export interface CardErrorInfo {
  code: CardErrorCode
  /** The service's own answer (code `failed` only), already humanised and capped — never the CLI's or the process's words. */
  detail?: string
  limit?: AcpLimit
  cooldownMs?: number
  httpStatus?: number
  /** A signup answered this way may still have reached the service: never treat it as "nothing sent". */
  unconfirmed?: boolean
  /** Main refused the signup inside its 403/429 hold: nothing was sent, and no signup before this. */
  heldUntil?: number
  /** Main refused the signup inside the one-minute wait after the last link: nothing was sent before this. */
  resendAt?: number
  /** A REAUTH answer's state token and e-mail (a link is waiting for exactly this signup). */
  reauthState?: string
  reauthEmail?: string
}

export interface CardSignupState {
  phase: SignupPhase
  /** The service's state token for this signup. */
  state?: string
  email?: string
  sentAt?: number
  /** Polling attempts spent on this token (each a fresh 15-min budget, started by a click or a resume). */
  attempt: number
  pollStartedAt?: number
  polls: number
  /** Inbox searches for the sign-in link in this attempt. */
  fetches: number
  nextPollAt?: number
  cooldownUntil?: number
  lastError?: CardErrorInfo
  linkUrl?: string
  /** The link was opened once for this token (never automatically again). */
  linkOpened?: boolean
  source?: 'server' | 'local'
}

const POLL_TOTAL_CAP_MS = 15 * 60_000
export const MAX_POLLS = 18
/** Inbox searches land after these polls (≤ 3 per attempt). */
const LINK_FETCH_POLLS = [2, 4, 8]
const MAX_LINK_FETCHES = LINK_FETCH_POLLS.length

const SCHEDULE_MS = [5_000, 10_000, 20_000, 40_000]
const LATE_MS = 60_000

export const IDLE_SIGNUP: CardSignupState = { phase: 'idle', attempt: 0, polls: 0, fetches: 0 }

/** One sign-in link a minute per iNFT, whoever clicks (main refuses inside it too: CARD_RESEND_WAIT_MS in
 *  electron/iclone-acp-signup.ts). It counts from the last send this iNFT recorded, confirmed or not. */
export const RESEND_WAIT_MS = 60_000

/** Delay before poll number `polls + 1`. */
export function nextDelayMs(polls: number): number {
  return SCHEDULE_MS[polls] ?? LATE_MS
}

/** Strict: the CLI itself reads `result.done`; anything else is still pending. */
export function isSignupDone(json: unknown): boolean {
  return asRecord(json)?.done === true
}

export type SignupEvent =
  | { type: 'sent'; state: string; email?: string; now: number; source: 'server' | 'local' }
  | { type: 'resume'; now: number }
  | { type: 'poll'; json: unknown; now: number }
  | { type: 'poll-error'; info: CardErrorInfo; now: number }
  | { type: 'fetched'; url?: string }
  | { type: 'opened' }
  | { type: 'tick'; now: number }
  | { type: 'reread'; status: InftAcpStatus | undefined }
  | { type: 'done' }
  | { type: 'reset' }

function startPolling(s: CardSignupState, now: number): CardSignupState {
  return {
    ...s,
    phase: 'polling',
    attempt: s.attempt + 1,
    pollStartedAt: now,
    polls: 0,
    fetches: 0,
    nextPollAt: now + nextDelayMs(0),
    cooldownUntil: undefined,
    lastError: undefined
  }
}

function afterPoll(s: CardSignupState, now: number, lastError?: CardErrorInfo): CardSignupState {
  const polls = s.polls + 1
  const next = now + nextDelayMs(polls)
  const started = s.pollStartedAt ?? now

  if (polls >= MAX_POLLS || next - started > POLL_TOTAL_CAP_MS) {
    return { ...s, polls, phase: 'expired', nextPollAt: undefined, lastError }
  }

  return { ...s, polls, nextPollAt: next, lastError }
}

/** True when a card re-read that STARTED at or after `at` answered (main stamps the probe's start). */
function answeredSince(status: InftAcpStatus | undefined, at: number | undefined): boolean {
  return Boolean(status && !status.cardStale && (status.cardCheckedAt ?? 0) >= (at ?? Number.MAX_SAFE_INTEGER))
}

/** An unconfirmed signup ends only when a card re-read newer than it answers; the service's REAUTH token wins. */
function reconcileUnconfirmed(s: CardSignupState, status: InftAcpStatus | undefined): CardSignupState {
  if (s.phase !== 'unconfirmed' || !answeredSince(status, s.sentAt) || !status) {
    return s
  }

  const keep = s.cooldownUntil !== undefined ? { cooldownUntil: s.cooldownUntil, lastError: s.lastError } : {}

  if (cardStateOf(status) === 'ready') {
    return { ...IDLE_SIGNUP, phase: 'done' }
  }

  if (status.cardState === 'signin-pending' && status.cardReauthState) {
    const server = {
      ...IDLE_SIGNUP,
      state: status.cardReauthState,
      email: status.cardReauthEmail,
      source: 'server' as const
    }

    return { ...server, phase: keep.cooldownUntil ? 'cooldown' : 'expired', sentAt: s.sentAt, ...keep }
  }

  return keep.cooldownUntil ? { ...IDLE_SIGNUP, phase: 'cooldown', ...keep } : IDLE_SIGNUP
}

export function reduceSignup(s: CardSignupState, event: SignupEvent): CardSignupState {
  switch (event.type) {
    case 'sent':
      if (s.state === event.state && s.phase === 'polling') {
        return s
      }

      return startPolling(
        {
          ...IDLE_SIGNUP,
          state: event.state,
          email: event.email,
          sentAt: event.now,
          source: event.source,
          attempt: s.state === event.state ? s.attempt : 0,
          linkOpened: s.state === event.state ? s.linkOpened : false,
          linkUrl: s.state === event.state ? s.linkUrl : undefined
        },
        event.now
      )

    case 'resume':
      return s.state ? startPolling(s, event.now) : s

    case 'poll':
      if (s.phase !== 'polling') {
        return s
      }

      return isSignupDone(event.json)
        ? { ...s, phase: 'done', nextPollAt: undefined, lastError: undefined }
        : afterPoll(s, event.now)
    case 'poll-error': {
      const { info, now } = event

      if (info.cooldownMs) {
        // One cooldown for every card call: it only ever grows, and an unconfirmed signup stays unconfirmed under it.
        const cooldownUntil = Math.max(now + info.cooldownMs, info.heldUntil ?? 0, s.cooldownUntil ?? 0)

        return s.phase === 'unconfirmed'
          ? { ...s, cooldownUntil, lastError: info }
          : { ...s, phase: 'cooldown', cooldownUntil, nextPollAt: undefined, lastError: info }
      }

      if (s.phase === 'polling') {
        return afterPoll(s, now, info)
      }

      // Outside a poll, an error is a signup's answer.
      if (info.reauthState) {
        return reduceSignup(s, {
          type: 'sent',
          state: info.reauthState,
          email: info.reauthEmail,
          now,
          source: 'server'
        })
      }

      return info.unconfirmed
        ? { ...s, phase: 'unconfirmed', sentAt: now, nextPollAt: undefined, lastError: info }
        : { ...s, lastError: info }
    }

    case 'fetched':
      return { ...s, fetches: s.fetches + 1, linkUrl: event.url ?? s.linkUrl }

    case 'opened':
      return { ...s, linkOpened: true }

    case 'tick':
      if (s.phase === 'cooldown' && (s.cooldownUntil ?? 0) <= event.now) {
        return { ...s, phase: s.state ? 'expired' : 'idle', cooldownUntil: undefined }
      }

      if (s.phase === 'unconfirmed' && s.cooldownUntil !== undefined && s.cooldownUntil <= event.now) {
        return { ...s, cooldownUntil: undefined }
      }

      return s

    case 'reread':
      return reconcileUnconfirmed(s, event.status)

    case 'done':
      return { ...s, phase: 'done', nextPollAt: undefined }

    case 'reset':
      return IDLE_SIGNUP
  }
}

/** What the pre-send marker says when a reloaded wizard reads it. */
const SENDING_INFO: CardErrorInfo = {
  code: 'sent-unanswered',
  unconfirmed: true
}

/**
 * Persisted BEFORE `card signup` leaves: a reload or crash while it is in flight hydrates
 * `unconfirmed` and refuses until a card read that started after `now`. The answer overwrites it.
 */
export function sendingMarker(s: CardSignupState, email: string, now: number): CardSignupState {
  return { ...s, phase: 'unconfirmed', email, sentAt: now, nextPollAt: undefined, lastError: SENDING_INFO }
}

/** True when `s` is the marker written for the signup sent at `sentAt` (a hold may have landed on it). */
export function isSendingMarker(s: CardSignupState | null, sentAt: number | undefined): boolean {
  return Boolean(s && sentAt !== undefined && s.phase === 'unconfirmed' && s.sentAt === sentAt)
}

/** The machine the signup's answer applies to: as it was when the call left, plus any hold that landed since. */
export function beforeMarker(current: CardSignupState, sentFrom: CardSignupState, sentAt: number): CardSignupState {
  if (!isSendingMarker(current, sentAt)) {
    return current
  }

  const held = (current.cooldownUntil ?? 0) > (sentFrom.cooldownUntil ?? 0)

  return held ? { ...sentFrom, cooldownUntil: current.cooldownUntil, lastError: current.lastError } : sentFrom
}

/** After a poll: search the inbox for the link now? */
export function shouldFetchLink(s: CardSignupState): boolean {
  return s.phase === 'polling' && !s.linkUrl && s.fetches < MAX_LINK_FETCHES && LINK_FETCH_POLLS.includes(s.polls)
}

/**
 * Why the sign-up button is held back (or asks to confirm). The wizard copy owns the sentence for each
 * code; `at` is the moment the sentence names and `error` the last card answer behind a cooldown.
 */
export type CardRefusalCode =
  | 'already-signed-in'
  | 'cooling'
  | 'held-until'
  | 'link-replaces'
  | 'link-sending'
  | 'link-waiting'
  | 'resend-wait'
  | 'service-refused'
  | 'state-unknown'
  | 'unconfirmed'

/** `resend`: the account exists and its link is unopened — a click sends a fresh link (`sendSignInLink`). */
export type SignupGate = {
  gate: 'allowed' | 'confirm' | 'refused' | 'resend'
  reason?: CardRefusalCode
  at?: number
  error?: CardErrorInfo
}

/** A status persisted before card states existed carries only `cardReady`. */
function cardStateOf(status: InftAcpStatus | undefined): InftAcpStatus['cardState'] {
  return status?.cardState ?? (status?.cardReady === true ? 'ready' : undefined)
}

/**
 * A signed-up account whose link is still unopened: may a click send a fresh link now? The Bank and the
 * wizard ask this one question for the same record, so they always agree. A 403/429 hold refuses; so does
 * the minute after the last send (a marker whose answer never came back counts as a send).
 */
export function resendGate(s: CardSignupState, now: number): SignupGate {
  if ((s.cooldownUntil ?? 0) > now) {
    return { gate: 'refused', reason: 'cooling', error: s.lastError }
  }

  // A send ahead of the clock means the clock was set back: the record cannot say how long ago the link went
  // (clamping it to now would roll the minute forward on every read). Main's own minute, clamped once to its
  // clock and kept, decides; the renderer never holds Resend for the step back.
  const waitUntil = s.sentAt === undefined || s.sentAt > now ? 0 : s.sentAt + RESEND_WAIT_MS

  if (waitUntil > now) {
    return { gate: 'refused', reason: 'resend-wait', at: waitUntil }
  }

  return { gate: 'resend' }
}

/** May a click send a NEW `card signup` now? `confirm` = only after an explicit second click. */
export function signupGate(s: CardSignupState, status: InftAcpStatus | undefined, now: number): SignupGate {
  const card = cardStateOf(status)

  if (card === 'ready') {
    return { gate: 'refused', reason: 'already-signed-in' }
  }

  if (card === 'blocked') {
    return { gate: 'refused', reason: 'service-refused' }
  }

  if ((status?.cardHeldUntil ?? 0) > now) {
    return { gate: 'refused', reason: 'held-until', at: status?.cardHeldUntil }
  }

  // The account exists (one KYC): never a second signup of it, only a fresh link for it, as in the Bank.
  if (card === 'signin-pending') {
    return resendGate(s, now)
  }

  if (s.phase === 'unconfirmed') {
    return { gate: 'refused', reason: 'unconfirmed', at: s.sentAt }
  }

  if ((s.cooldownUntil ?? 0) > now) {
    return { gate: 'refused', reason: 'cooling', error: s.lastError }
  }

  if (!status || !card || status.cardStale) {
    return { gate: 'refused', reason: 'state-unknown' }
  }

  if (s.phase === 'polling' && s.sentAt && now - s.sentAt < POLL_TOTAL_CAP_MS) {
    return { gate: 'refused', reason: 'link-waiting', at: s.sentAt }
  }

  if (s.state) {
    return { gate: 'confirm', reason: 'link-replaces' }
  }

  return { gate: 'allowed' }
}

/** The persisted copy, validated (a malformed file reads as nothing). */
export function parsePersistedSignup(value: unknown): CardSignupState | null {
  const r = asRecord(value)
  const phase = asString(r?.phase)

  // A refused FIRST signup has no token yet, only its cooldown — that must survive a remount.
  const tokenless =
    (phase === 'cooldown' && asFiniteNumber(r?.cooldownUntil) !== undefined) ||
    (phase === 'unconfirmed' && asFiniteNumber(r?.sentAt) !== undefined)

  if (
    !r ||
    !phase ||
    !['polling', 'expired', 'cooldown', 'unconfirmed'].includes(phase) ||
    (!asString(r?.state) && !tokenless)
  ) {
    return null
  }

  return {
    phase: phase as SignupPhase,
    state: asString(r?.state),
    email: asString(r?.email),
    sentAt: asFiniteNumber(r?.sentAt),
    attempt: asFiniteNumber(r?.attempt) ?? 0,
    pollStartedAt: asFiniteNumber(r?.pollStartedAt),
    polls: asFiniteNumber(r?.polls) ?? 0,
    fetches: asFiniteNumber(r?.fetches) ?? 0,
    cooldownUntil: asFiniteNumber(r?.cooldownUntil),
    linkUrl: pickSigninLink({ links: [{ url: asString(r?.linkUrl) }] }),
    linkOpened: r.linkOpened === true,
    source: asString(r?.source) === 'server' ? 'server' : 'local',
    lastError: parseErrorInfo(r.lastError)
  }
}

const LIMITS: readonly AcpLimit[] = ['blocked', 'rate-limited']

const ERROR_CODES: ReadonlySet<string> = new Set<CardErrorCode>([
  'blocked',
  'failed',
  'held',
  'link-waiting',
  'no-state',
  'not-ready',
  'rate-limited',
  'resend-wait',
  'sent-unanswered',
  'timeout'
])

function isCardErrorCode(value: unknown): value is CardErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

function parseErrorInfo(value: unknown): CardErrorInfo | undefined {
  const r = asRecord(value)

  // A record written before error codes existed (title/advice prose) is dropped: the cooldown stays.
  if (!isCardErrorCode(r?.code)) {
    return undefined
  }

  const limit = LIMITS.find(item => item === r.limit)
  const detail = typeof r.detail === 'string' ? r.detail.slice(0, 400) : undefined
  const cooldownMs = asFiniteNumber(r.cooldownMs)
  const httpStatus = asFiniteNumber(r.httpStatus)

  return {
    code: r.code,
    ...(detail ? { detail } : {}),
    ...(limit ? { limit } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(r.unconfirmed === true ? { unconfirmed: true } : {})
  }
}

export function serializeSignup(s: CardSignupState): Record<string, unknown> {
  // The sign-in link is a one-time credential: it never reaches the disk (the inbox still has it).
  const { lastError, nextPollAt: _nextPollAt, linkUrl: _linkUrl, ...rest } = s
  // Only a cooldown's or an unconfirmed signup's reason is kept: it is what the gate shows after a remount.
  const reason = s.phase === 'cooldown' || s.phase === 'unconfirmed' ? parseErrorInfo(lastError) : undefined

  return Object.fromEntries(Object.entries({ ...rest, lastError: reason }).filter(([, value]) => value !== undefined))
}

function phaseFor(s: CardSignupState, now: number): CardSignupState {
  if (s.phase === 'cooldown' && (s.cooldownUntil ?? 0) > now) {
    return s
  }

  const started = s.pollStartedAt ?? 0

  if (s.phase === 'polling' && now - started < POLL_TOTAL_CAP_MS && s.polls < MAX_POLLS) {
    return { ...s, nextPollAt: now + nextDelayMs(s.polls) }
  }

  return { ...s, phase: 'expired', nextPollAt: undefined, cooldownUntil: undefined }
}

/** Server first: a REAUTH state from `card whoami` wins over the local copy. */
export function hydrateSignup(persisted: unknown, status: InftAcpStatus | undefined, now: number): CardSignupState {
  const local = parsePersistedSignup(persisted)
  const server = status?.cardState === 'signin-pending' ? status.cardReauthState : undefined

  // A cooldown the service imposed outlives whatever the next probe says.
  const cooling = local?.phase === 'cooldown' && (local.cooldownUntil ?? 0) > now ? local : null

  if (cardStateOf(status) === 'ready') {
    return cooling ?? { ...IDLE_SIGNUP, phase: 'done' }
  }

  if (local?.phase === 'unconfirmed') {
    return reconcileUnconfirmed(
      (local.cooldownUntil ?? 0) > now ? local : { ...local, cooldownUntil: undefined },
      status
    )
  }

  const carry = (s: CardSignupState): CardSignupState =>
    cooling ? { ...s, phase: 'cooldown', cooldownUntil: cooling.cooldownUntil, lastError: cooling.lastError } : s

  // A blocked account is never polled again without a click.
  if (status?.cardState === 'blocked') {
    if (cooling) {
      return cooling
    }

    return local?.state ? { ...local, phase: 'expired', nextPollAt: undefined, cooldownUntil: undefined } : IDLE_SIGNUP
  }

  if (server) {
    return local?.state === server
      ? phaseFor({ ...local, source: 'server' }, now)
      : carry({
          ...IDLE_SIGNUP,
          phase: 'expired',
          state: server,
          email: status?.cardReauthEmail,
          source: 'server',
          // The service's token is older than our last send's answer, but the resend minute counts from our send.
          ...(local?.sentAt !== undefined ? { sentAt: local.sentAt } : {})
        })
  }

  if (cooling) {
    return cooling
  }

  // The service answered "never signed up" AFTER the local signup left: its token is stale. An older
  // "none" says nothing about a signup it never saw (e.g. one answered after its wizard closed).
  if (
    status?.cardState === 'none' &&
    !status.cardStale &&
    (local?.sentAt === undefined || answeredSince(status, local.sentAt))
  ) {
    return IDLE_SIGNUP
  }

  return local ? phaseFor(local, now) : IDLE_SIGNUP
}

// Main's refusal inside a signup hold (electron/iclone-acp-signup.ts signupHeldReason) ends with this mark,
// and its refusal inside the resend minute (signupResendReason) with the second.
const HELD_UNTIL = /\[held-until=(\d{10,})\]$/
const RESEND_AT = /\[resend-at=(\d{10,})\]$/
const REAUTH_EMAIL = /REAUTH:[0-9a-f-]+:([^\s"'\\}]+@[^\s"'\\}]+)/i

/** A time main named in its own refusal shape (nothing ran: no exit code, no CLI output);
 *  the same text inside a CLI answer is that answer's, and the signup may have gone out. */
function mainRefusalTime(result: AcpRunResult | null, mark: RegExp): number | undefined {
  if (!result || result.code !== null || result.stdout.trim() || result.stderr.trim() || !result.error) {
    return undefined
  }

  return Number(mark.exec(result.error)?.[1]) || undefined
}

/** Friendly copy for a failed card call; throttles carry their cooldown. */
export function cardErrorInfo(result: AcpRunResult | null): CardErrorInfo {
  const json = asRecord(parseCliJson(result?.stdout ?? ''))

  const message =
    (typeof json?.error === 'string' ? json.error : undefined) ?? result?.error ?? result?.stderr ?? 'no answer'

  const c = classifyAcpError(message)
  const reauth = c.reauthState ? { reauthState: c.reauthState, reauthEmail: REAUTH_EMAIL.exec(message)?.[1] } : {}
  const heldUntil = mainRefusalTime(result, HELD_UNTIL)
  const resendAt = mainRefusalTime(result, RESEND_AT)

  // Only answers that prove nothing reached the service are "clean"; anything else might have sent a link.
  const clean =
    heldUntil !== undefined ||
    resendAt !== undefined ||
    c.kind === 'busy' ||
    c.kind === 'not-provisioned' ||
    c.httpStatus === 400 ||
    c.httpStatus === 422

  const base = {
    limit: c.limit,
    cooldownMs: c.cooldownMs,
    httpStatus: c.httpStatus,
    ...reauth,
    ...(heldUntil !== undefined ? { heldUntil } : {}),
    ...(clean ? {} : { unconfirmed: true })
  }

  if (heldUntil !== undefined) {
    return {
      ...base,
      // Main always names the service's answer; a hold without one is still a hold.
      cooldownMs: c.cooldownMs ?? BLOCKED_COOLDOWN_MS,
      code: 'held'
    }
  }

  // Not a hold of the service's: nothing to cool down on, just the minute between two links.
  if (resendAt !== undefined) {
    return { code: 'resend-wait', resendAt }
  }

  if (c.limit === 'rate-limited') {
    return { ...base, code: 'rate-limited' }
  }

  if (c.limit === 'blocked') {
    return { ...base, code: 'blocked' }
  }

  if (c.kind === 'reauth') {
    return { ...base, code: 'link-waiting' }
  }

  if (c.kind === 'not-provisioned') {
    return { ...base, code: 'not-ready' }
  }

  if (c.kind === 'timeout') {
    return { ...base, code: 'timeout' }
  }

  if (c.kind === 'busy') {
    return { ...base, code: 'busy' }
  }

  if (result?.ok && json && !message) {
    return { ...base, code: 'no-state' }
  }

  // Only the service's own answer may be quoted to the person: its JSON error, or the message an HTTP body carried.
  // CLI, spawn, pty and stderr text stay out of the sentence (UF3B-r2c-1, S27.1).
  const serviceAnswer =
    typeof json?.error === 'string'
      ? humanizeAcpError(json.error)
      : humanizeAcpError(message) !== message
        ? humanizeAcpError(message)
        : ''

  return { ...base, code: 'failed', ...(serviceAnswer ? { detail: serviceAnswer.slice(0, 300) } : {}) }
}

/** The sign-in link: https on agentcard.ai or a subdomain; link text and category are not trusted. */
export function pickSigninLink(json: unknown): string | undefined {
  const links = asRecord(json)?.links

  for (const item of Array.isArray(links) ? links : []) {
    const raw = asRecord(item)?.url

    if (typeof raw !== 'string' || raw.length > 2_000) {
      continue
    }

    try {
      const url = new URL(raw)

      if (url.protocol === 'https:' && (url.hostname === 'agentcard.ai' || url.hostname.endsWith('.agentcard.ai'))) {
        return url.toString()
      }
    } catch {
      // not a URL
    }
  }

  return undefined
}

/** The newest message id of an `email search` answer. */
export function pickNewestMessageId(json: unknown): string | undefined {
  const record = asRecord(json)
  const list = Array.isArray(json) ? json : (record?.messages ?? record?.results ?? record?.items)

  const at = (m: Record<string, unknown>) =>
    Date.parse(String(m.receivedAt ?? m.createdAt ?? m.date ?? m.sentAt ?? '')) || 0

  const messages = (Array.isArray(list) ? list : [])
    .map(item => asRecord(item))
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof (m?.id ?? m?.messageId) === 'string')
    .sort((a, b) => at(b) - at(a))

  const id = messages[0] ? String(messages[0].id ?? messages[0].messageId) : undefined

  return id && /^[A-Za-z0-9_.:-]{1,120}$/.test(id) ? id : undefined
}
