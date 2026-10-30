/**
 * EconomyOS — Bank (AgentCard) data layer: one tolerant shaper per `acp card …
 * --json` answer, shaped on the fields the bundled CLI actually prints, and one
 * `readX` per command returning the CLI's own `AcpResult<T>` so the app decides
 * how to render a failure. Every shaper is total (never throws).
 *
 * `card payment-method` is never read here — it STARTS a Stripe setup session.
 */
import { $acpConfigMap, type InftAcpStatus } from '../../acp-setup'
import { defineEconData } from '../app-data'
import { setEconBadge } from '../badges'
import { acpJson, type AcpResult, asRecord, bool, isCardNotSetUp, type Json, listAt, num, str } from '../cli'
import { usd } from '../format'
import { cadenceTtlMs, liveCadenceSecs, parallelPrefetch } from '../live'
import { readSnapshot, type Snapshot } from '../snapshot'

export function centsToUsd(cents: null | number): null | number {
  return cents == null ? null : cents / 100
}

function finiteOr(root: Json | null, key: string): null | number {
  const value = num(root, key, NaN)

  return Number.isFinite(value) ? value : null
}

function firstCents(root: Json | null, keys: readonly string[]): null | number {
  for (const key of keys) {
    const value = finiteOr(root, key)

    if (value !== null) {
      return value
    }
  }

  return null
}

// ── TTLs ─────────────────────────────────────────────────────────────────

/** Card state, limit and profile change only through Setup or the agent's own
 *  terminal (the header's refresh button forces past them); the lists are
 *  what the timer is for. */
export const BANK_TTL_MS = {
  whoami: 10 * 60_000,
  limit: 10 * 60_000,
  list: 30_000,
  get: 60_000,
  threeDs: 20_000,
  profile: 5 * 60_000
} as const

// ── state machine ────────────────────────────────────────────────────────

/** `none` is said ONLY on the card service's own 400 "not set up"; `session-expired` keeps the card
 *  while the iNFT's Virtuals session is signed out; `unknown` = nothing known yet (never "no card"). */
type CardStateKind = 'none' | 'ready' | 'session-expired' | 'signin-pending' | 'unknown'

export interface CardState {
  kind: CardStateKind
  /** The last known state, kept because this read could not answer. */
  stale?: boolean
  /** `signin-pending` only — the token after `REAUTH:` in the CLI's error. */
  reauthState?: string
  /** `signin-pending` only — what the service says is next, when it says. */
  hint?: string
  /** The agent's own inbox address: from `card whoami` on success, or parsed
   *  out of the `REAUTH:<state>:<email>` message while signing in. */
  email?: string
  /** A card was seen `ready` on this agent (on screen, or main's sticky `cardKnown` / legacy `cardReady`):
   *  a waiting link or a lapsed session keeps painting it. Only the authoritative `none` drops it. */
  cardKnown?: boolean
}

const NONE_STATE: CardState = { kind: 'none' }
const UNKNOWN_STATE: CardState = { kind: 'unknown' }

function parseReauthEmail(message: string): string | undefined {
  const match = /REAUTH:[0-9a-f-]+:([^\s"',}]+)/i.exec(message)

  return match?.[1]
}

interface CardWhoami {
  email: string
  /** `false` while the magic link is unclicked; `undefined` when unsaid. */
  verified?: boolean
  /** `nextStep.hint` from the service, e.g. "Magic link sent but not clicked". */
  hint?: string
}

export function shapeWhoami(raw: unknown): CardWhoami {
  const root = asRecord(raw)
  const verified = root?.verified
  const nextStep = asRecord(root?.nextStep)

  return {
    email: str(root, 'email'),
    verified: typeof verified === 'boolean' ? verified : undefined,
    hint: str(nextStep, 'hint') || undefined
  }
}

/** What is known without this read: the state already on screen, else the
 *  main process's persisted answer (`status.json`), else nothing. */
function lastKnown(last: CardState | null | undefined, status: InftAcpStatus | undefined): CardState | null {
  if (last && last.kind !== 'unknown') {
    return last
  }

  const hinted = hintFromStatus(status)

  // Main's sticky fact beside a cardState that carries no card (blocked, stale, absent): the card is still KNOWN —
  // a bare 401 or a stale read must keep its visual instead of falling to 'unknown'.
  if (!hinted && statusCardKnown(status)) {
    return { email: status?.email || undefined, kind: 'ready', cardKnown: true }
  }

  return hinted
}

/** Whether a card was already seen ready — on screen, or in main's persisted status. */
function cardKnownFrom(last: CardState | null | undefined, status: InftAcpStatus | undefined): boolean {
  if (last?.kind === 'ready' || last?.cardKnown === true) {
    return true
  }

  // Main's sticky fact holds whatever cardState it wrote beside it (blocked, stale, or none at all).
  if (statusCardKnown(status)) {
    return true
  }

  return hintFromStatus(status)?.kind === 'ready'
}

const knownFlag = (known: boolean): Pick<CardState, 'cardKnown'> => (known ? { cardKnown: true } : {})

/**
 * Total. Only the card service's authoritative 400 "not set up" is `none`; an
 * expired Virtuals session is `session-expired` (the card stays); every other
 * failure keeps the last known state, marked stale, or `unknown`.
 */
export function deriveCardState(
  whoami: AcpResult<CardWhoami>,
  last?: CardState | null,
  status?: InftAcpStatus
): CardState {
  // A signed-up account whose magic link was never clicked answers 200 with
  // `verified: false` — the same waiting state as a 401 REAUTH.
  if (whoami.ok && whoami.data.verified === false) {
    return {
      email: whoami.data.email || undefined,
      hint: whoami.data.hint,
      kind: 'signin-pending',
      ...knownFlag(cardKnownFrom(last, status))
    }
  }

  if (whoami.ok) {
    return { email: whoami.data.email || undefined, kind: 'ready' }
  }

  // A 401 without `REAUTH:<state>` sent no link: not an answer, so the last known state stays (stale).
  if (whoami.kind === 'reauth' && !whoami.reauthState) {
    const known = lastKnown(last, status)

    return known ? { ...known, stale: true } : UNKNOWN_STATE
  }

  if (whoami.kind === 'reauth') {
    return {
      email: parseReauthEmail(whoami.error) ?? lastKnown(last, status)?.email,
      kind: 'signin-pending',
      reauthState: whoami.reauthState,
      ...knownFlag(cardKnownFrom(last, status))
    }
  }

  if (isCardNotSetUp(whoami)) {
    return NONE_STATE
  }

  const known = lastKnown(last, status)

  if (whoami.kind === 'reauth-acp') {
    return {
      ...(known?.email ? { email: known.email } : {}),
      kind: 'session-expired',
      ...knownFlag(cardKnownFrom(last, status))
    }
  }

  return known ? { ...known, stale: true } : UNKNOWN_STATE
}

/** The boot probe (`$acpConfigMap`, zero spawns) as a state. The main process
 *  calls any 200 `ready` without looking at `verified`, so only its two gate
 *  kinds are trusted for a first paint (see `seedBank`). */
export function hintFromStatus(status: InftAcpStatus | undefined): CardState | null {
  // A status written before `cardState` existed carries only `cardReady` — the same rule as the Setup wizard's read.
  switch (status?.cardState ?? (status?.cardReady === true ? 'ready' : undefined)) {
    case 'none':
      return { kind: 'none' }

    case 'signin-pending':
      return { email: status?.email || undefined, kind: 'signin-pending', ...knownFlag(statusCardKnown(status)) }

    case 'ready':
      return { email: status?.email || undefined, kind: 'ready' }

    default:
      return null
  }
}

/** `status.json`'s `cardKnown` (set by main once a card answered ready; cleared only by the authoritative none). */
function statusCardKnown(status: InftAcpStatus | undefined): boolean {
  return status?.cardKnown === true
}

/** Equal content — lets a setter keep the previous object, so a cache hit
 *  re-renders nothing. */
export function sameCardState(a: CardState | null, b: CardState): boolean {
  return (
    a !== null &&
    a.kind === b.kind &&
    a.email === b.email &&
    a.hint === b.hint &&
    a.reauthState === b.reauthState &&
    a.stale === b.stale &&
    a.cardKnown === b.cardKnown
  )
}

export const WHOAMI_ARGV = ['card', 'whoami', '--json']
const LIMIT_ARGV = ['card', 'limit', '--json']
const LIST_ARGV = ['card', 'list', '--json']
const THREE_DS_ARGV = ['card', '3ds', '--json']
const PROFILE_ARGV = ['card', 'profile', '--json']

/** `whoami`'s non-answers (busy/cli/parse/timeout/unavailable, a missing
 *  agent) pass through as `ok: false` — the caller keeps the last known card.
 *  An expired Virtuals session is a state: `session-expired`. */
export async function readCardState(
  inftId: string,
  slug: string,
  force = false,
  last?: CardState | null
): Promise<AcpResult<CardState>> {
  const whoami = await acpJson(inftId, slug, WHOAMI_ARGV, shapeWhoami, { force, ttlMs: BANK_TTL_MS.whoami })

  if (!whoami.ok && whoami.kind !== 'reauth' && whoami.kind !== 'reauth-acp' && !isCardNotSetUp(whoami)) {
    return whoami
  }

  const data = deriveCardState(whoami, last, $acpConfigMap.get()[slug])

  return { at: whoami.ok ? whoami.at : Date.now(), data, ok: true }
}

// ── limit ────────────────────────────────────────────────────────────────

/** `card limit --json` prints `{ spendLimitCents, spentCents, remainingCents }`
 *  (all cents); `null` wherever the service leaves a figure out. */
export interface CardLimit {
  limitCents: null | number
  spentCents: null | number
  remainingCents: null | number
}

/** What the limit's own `not-provisioned` means: no limit set yet. */
export const NO_LIMIT: CardLimit = { limitCents: null, remainingCents: null, spentCents: null }

export function shapeLimit(raw: unknown): CardLimit {
  const root = asRecord(raw)
  const limitCents = firstCents(root, ['spendLimitCents', 'limitCents', 'limit'])
  const spentCents = finiteOr(root, 'spentCents')

  const remainingCents =
    finiteOr(root, 'remainingCents') ??
    (limitCents !== null && spentCents !== null ? Math.max(0, limitCents - spentCents) : null)

  return { limitCents, remainingCents, spentCents }
}

/** "$38.00 of $50.00 left" (or the locale's `format`) — null until both figures are known. */
export function limitLeftLabel(
  limit: CardLimit | undefined,
  format: (left: string, total: string) => string = (left, total) => `${left} of ${total} left`
): null | string {
  if (!limit || limit.limitCents === null || limit.remainingCents === null) {
    return null
  }

  return format(usd(centsToUsd(limit.remainingCents)), usd(centsToUsd(limit.limitCents)))
}

export function sameLimit(a: CardLimit | undefined, b: CardLimit): boolean {
  return (
    a !== undefined &&
    a.limitCents === b.limitCents &&
    a.spentCents === b.spentCents &&
    a.remainingCents === b.remainingCents
  )
}

export function readLimit(inftId: string, slug: string, force = false): Promise<AcpResult<CardLimit>> {
  return acpJson(inftId, slug, LIMIT_ARGV, shapeLimit, { force, ttlMs: BANK_TTL_MS.limit })
}

// ── profile ──────────────────────────────────────────────────────────────

export interface CardProfile {
  name: string
  phone: string
  email: string
  locked: boolean
  paymentMethod: null | { brand: string; last4: string }
}

/** `card profile --json` prints `email, firstName, lastName, phoneNumber,
 *  paymentMethod{brand,last4,expMonth,expYear}, spendLimitCents, locked`; the
 *  bridge strips `cardholderName` and the expiry before it crosses IPC. */
export function shapeProfile(raw: unknown): CardProfile {
  const root = asRecord(raw)
  const method = asRecord(root?.paymentMethod)
  const brand = str(method, 'brand')
  const last4 = str(method, 'last4').slice(-4)

  return {
    email: str(root, 'email'),
    locked: bool(root, 'locked'),
    name: `${str(root, 'firstName')} ${str(root, 'lastName')}`.trim(),
    paymentMethod: brand || last4 ? { brand, last4 } : null,
    phone: str(root, 'phoneNumber')
  }
}

/** "Visa •••• 4242" — null when the service reports no funding method. */
export function paymentMethodLabel(method: CardProfile['paymentMethod']): null | string {
  if (!method) {
    return null
  }

  return [method.brand, method.last4 ? `•••• ${method.last4}` : ''].filter(Boolean).join(' ')
}

export function readProfile(inftId: string, slug: string, force = false): Promise<AcpResult<CardProfile>> {
  return acpJson(inftId, slug, PROFILE_ARGV, shapeProfile, { force, ttlMs: BANK_TTL_MS.profile })
}

// ── spend requests ───────────────────────────────────────────────────────

/** `card list` / `card get` rows: `id, amountCents, status, createdAt,
 *  expiresAt, issuedAt, capturedAmountCents, capturedAt, last4` — no merchant,
 *  no description (the bridge strips PAN, CVV, expiry, ZIP and holder). */
export interface SpendRequest {
  id: string
  amountUsd: null | number
  status: string
  createdAt: string
  expiresAt: string
  issuedAt: string
  capturedAmountUsd: null | number
  capturedAt: string
  /** At most 4 characters — even a misbehaving field never renders more. */
  last4: null | string
}

const TERMINAL_STATUS = /^(approved|cancell?ed|captured|completed|declined|expired|failed|rejected|settled)$/i

/** An unrecognised status counts as open: silently hiding it would be the
 *  dishonest choice. */
export function isOpenStatus(status: string): boolean {
  return !TERMINAL_STATUS.test(status.trim())
}

function pickLast4(root: Json | null): null | string {
  const value = str(root, 'last4').slice(-4)

  return value || null
}

export function shapeSpendRequest(raw: unknown): SpendRequest {
  const root = asRecord(raw)

  return {
    amountUsd: centsToUsd(finiteOr(root, 'amountCents')),
    capturedAmountUsd: centsToUsd(finiteOr(root, 'capturedAmountCents')),
    capturedAt: str(root, 'capturedAt'),
    createdAt: str(root, 'createdAt'),
    expiresAt: str(root, 'expiresAt'),
    id: str(root, 'id'),
    issuedAt: str(root, 'issuedAt'),
    last4: pickLast4(root),
    status: str(root, 'status', 'pending')
  }
}

/** "sr_8f2c41…" — enough to tell rows apart; the detail shows it whole. */
export function shortRequestId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id || '—'
}

// Module-level shapers: cli.ts memoizes the shaped answer per shaper function,
// so a cache hit hands back the same list identity and the rows stay memoized.
function shapeRequests(raw: unknown): SpendRequest[] {
  return listAt(raw, ['requests']).map(shapeSpendRequest)
}

export function readRequests(inftId: string, slug: string, force = false): Promise<AcpResult<SpendRequest[]>> {
  return acpJson(inftId, slug, LIST_ARGV, shapeRequests, {
    force,
    // The list is what the timer is for: its life follows the live period.
    ttlMs: cadenceTtlMs(liveCadenceSecs('bank', slug), BANK_TTL_MS.list)
  })
}

export function readRequestDetail(inftId: string, slug: string, requestId: string): Promise<AcpResult<SpendRequest>> {
  return acpJson(inftId, slug, ['card', 'get', '--request-id', requestId, '--json'], shapeSpendRequest, {
    ttlMs: BANK_TTL_MS.get
  })
}

function createdMs(request: SpendRequest): number {
  const ms = Date.parse(request.createdAt)

  return Number.isFinite(ms) ? ms : 0
}

/** Open first, then newest first; undated rows sink to the end of their
 *  group. Stable, and always a new array. */
export function sortRequests(requests: readonly SpendRequest[]): SpendRequest[] {
  return requests
    .map((request, index) => ({ index, open: isOpenStatus(request.status), request, at: createdMs(request) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at || a.index - b.index)
    .map(entry => entry.request)
}

export function openRequests(requests: readonly SpendRequest[]): SpendRequest[] {
  return requests.filter(request => isOpenStatus(request.status))
}

/** A `card get` answer, tagged with the id it was fetched for. */
export interface RequestDetailEntry {
  forId: string
  request: SpendRequest
}

/** A detail fetched for another id never stands in for the selected row. */
export function pickSelectedRequest(
  detail: null | RequestDetailEntry,
  selectedId: null | string,
  requests: readonly SpendRequest[]
): null | SpendRequest {
  if (!selectedId) {
    return null
  }

  if (detail?.forId === selectedId) {
    return detail.request
  }

  return requests.find(request => request.id === selectedId) ?? null
}

// ── 3DS codes ────────────────────────────────────────────────────────────

/** `card 3ds --json` items: `{ code, amount, receivedAt }` — `amount` is in
 *  dollars (the CLI prints `amount.toFixed(2)`); there is no merchant. */
export interface ThreeDsCode {
  code: string
  amountUsd: null | number
  receivedAt: string
}

/** The service only honours a code for ~5 minutes. */
export const THREE_DS_WINDOW_MS = 5 * 60 * 1000

/** Epoch ms when a code stops being usable; NaN for an unreadable date. */
export function codeExpiresAt(receivedAt: string): number {
  return Date.parse(receivedAt) + THREE_DS_WINDOW_MS
}

export function isCodeActive(receivedAt: string, nowMs: number): boolean {
  const expires = codeExpiresAt(receivedAt)

  return Number.isFinite(expires) && nowMs <= expires
}

export function countActiveCodes(codes: readonly ThreeDsCode[], nowMs: number): number {
  return codes.reduce((count, code) => count + (isCodeActive(code.receivedAt, nowMs) ? 1 : 0), 0)
}

/** The next moment a code expires, or null when none is active. */
export function nextExpiryMs(codes: readonly ThreeDsCode[], nowMs: number): null | number {
  let next: null | number = null

  for (const code of codes) {
    const expires = codeExpiresAt(code.receivedAt)

    if (Number.isFinite(expires) && expires > nowMs && (next === null || expires < next)) {
      next = expires
    }
  }

  return next
}

/** "4:59" — minutes and zero-padded seconds left; never negative. */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000))
  const minutes = Math.floor(seconds / 60)

  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** "USD 12.00" — the CLI's own label, which is what the checkout's 3DS
 *  challenge shows beside the code; `notGiven` is the locale's text for a
 *  code the CLI reported without an amount. */
export function codeAmountLabel(amountUsd: null | number, notGiven: string): string {
  return amountUsd === null ? notGiven : `USD ${amountUsd.toFixed(2)}`
}

export function shape3dsCode(raw: unknown): ThreeDsCode {
  const root = asRecord(raw)

  return {
    amountUsd: finiteOr(root, 'amount'),
    code: str(root, 'code'),
    receivedAt: str(root, 'receivedAt') || str(root, 'createdAt')
  }
}

function shapeCodes(raw: unknown): ThreeDsCode[] {
  return listAt(raw, ['codes']).map(shape3dsCode)
}

export function read3ds(inftId: string, slug: string, force = false): Promise<AcpResult<ThreeDsCode[]>> {
  return acpJson(inftId, slug, THREE_DS_ARGV, shapeCodes, { force, ttlMs: BANK_TTL_MS.threeDs })
}

// ── dock badge ───────────────────────────────────────────────────────────

/** What the dock tile counts: requests still open plus codes still usable. */
export function bankBadgeCount(
  requests: readonly SpendRequest[],
  codes: readonly ThreeDsCode[],
  nowMs: number
): number {
  return openRequests(requests).length + countActiveCodes(codes, nowMs)
}

export function publishBankBadge(
  slug: string,
  requests: readonly SpendRequest[],
  codes: readonly ThreeDsCode[],
  nowMs: number
): void {
  setEconBadge(slug, 'bank', bankBadgeCount(requests, codes, nowMs))
}

// ── snapshot ─────────────────────────────────────────────────────────────

/** Bump when the persisted shape changes — an old snapshot is then ignored. */
export const BANK_SNAPSHOT_VERSION = 2
/** ~300 B a row: 200 rows is ~60 KB, far under SNAPSHOT_MAX_BYTES. */
export const SNAPSHOT_MAX_REQUESTS = 200

export interface BankSnapshot {
  /** Always `ready` — a stale gate would flash the wrong screen right after
   *  Setup finishes, and the gates are one cheap call away. */
  state: Omit<CardState, 'reauthState'>
  /** Absent when the limit had not been read by the time this was written. */
  limit?: CardLimit
  requests: SpendRequest[]
}

/** Never the sign-in token, never 3DS codes (one-time, five-minute life),
 *  never the profile, never a failure. */
export function toBankSnapshot(
  state: CardState,
  limit: CardLimit | undefined,
  requests: readonly SpendRequest[]
): BankSnapshot | null {
  if (state.kind !== 'ready') {
    return null
  }

  const snapshot: BankSnapshot = {
    state: { email: state.email, hint: state.hint, kind: state.kind },
    requests: requests.slice(0, SNAPSHOT_MAX_REQUESTS)
  }

  if (limit !== undefined) {
    snapshot.limit = limit
  }

  return snapshot
}

// localStorage is only version-checked by snapshot.ts, so every persisted row
// is re-read field by field here: a hand-edited or half-written entry must
// never throw inside a render-time initializer.
function restoreRequest(raw: unknown): null | SpendRequest {
  const root = asRecord(raw)

  if (typeof root?.id !== 'string' || typeof root.status !== 'string') {
    return null
  }

  return {
    amountUsd: finiteOr(root, 'amountUsd'),
    capturedAmountUsd: finiteOr(root, 'capturedAmountUsd'),
    capturedAt: str(root, 'capturedAt'),
    createdAt: str(root, 'createdAt'),
    expiresAt: str(root, 'expiresAt'),
    id: root.id,
    issuedAt: str(root, 'issuedAt'),
    last4: pickLast4(root),
    status: root.status
  }
}

function restoreLimit(raw: unknown): CardLimit | undefined {
  const root = asRecord(raw)

  return root
    ? {
        limitCents: finiteOr(root, 'limitCents'),
        remainingCents: finiteOr(root, 'remainingCents'),
        spentCents: finiteOr(root, 'spentCents')
      }
    : undefined
}

export function readBankSnapshot(slug: string): null | Snapshot<BankSnapshot> {
  const snapshot = readSnapshot<unknown>('bank', slug, BANK_SNAPSHOT_VERSION)
  const data = asRecord(snapshot?.data)
  const state = asRecord(data?.state)

  if (!snapshot || !data || state?.kind !== 'ready' || !Array.isArray(data.requests)) {
    return null
  }

  const requests = data.requests
    .map(restoreRequest)
    .filter((row): row is SpendRequest => row !== null)
    .slice(0, SNAPSHOT_MAX_REQUESTS)

  const restored: BankSnapshot = {
    requests,
    state: { email: str(state, 'email') || undefined, hint: str(state, 'hint') || undefined, kind: 'ready' }
  }

  const limit = restoreLimit(data.limit)

  if (limit) {
    restored.limit = limit
  }

  return { at: snapshot.at, data: restored }
}

/** What the app paints before its first CLI answer. */
interface BankSeed {
  /** The snapshot the first paint used, or null when it was not trusted. */
  snapshot: null | Snapshot<BankSnapshot>
  state: CardState | null
}

/**
 * A probe `ready` is never trusted (it ignores `verified`, so an unverified
 * account would paint the hero and then flip to the gate): without a
 * snapshot the first frame is a skeleton, never a wrong hero. A probe GATE
 * that is fresher than the snapshot beats it — a lapsed session never paints
 * yesterday's card.
 */
export function seedBank(slug: string): BankSeed {
  const status = $acpConfigMap.get()[slug]
  const hint = hintFromStatus(status)
  const gate = hint && hint.kind !== 'ready' ? hint : null
  const snapshot = readBankSnapshot(slug)

  if (snapshot && gate && status && !status.stale && status.checkedAt > snapshot.at) {
    return { snapshot: null, state: gate }
  }

  return { snapshot, state: snapshot?.data.state ?? gate }
}

// ── prefetch ─────────────────────────────────────────────────────────────

/**
 * `card whoami` only — byte-identical argv and TTL to the window's own read,
 * so a mount inside five minutes is a cache hit. The badge is published from
 * what is known: zero (and no snapshot) for a card that is not ready, the
 * last snapshot's open requests for one that is.
 */
const econData = defineEconData({
  kind: 'bank',
  last: slug => readBankSnapshot(slug)?.data.requests ?? [],
  badge: (slug, requests) => publishBankBadge(slug, requests, [], Date.now()),
  badgeWhen: 'after-ready',
  async warm(inftId, slug) {
    const state = await readCardState(inftId, slug)

    if (!state.ok) {
      return
    }

    if (state.data.kind === 'ready') {
      return 'ready'
    }

    // An expired session or a waiting link on a known card is not "unprovisioned": the card exists.
    const gone = state.data.kind === 'none' || (state.data.kind === 'signin-pending' && !state.data.cardKnown)

    return gone ? 'unprovisioned' : undefined
  }
})

/** Returns at once: the reads queue behind nobody's awaits (live.ts). */
export const prefetch = parallelPrefetch('bank', econData.prefetch)
