/**
 * EconomyOS — Bank: the load sequence, kept apart from React so it can be
 * proven against CLI-shaped answers.
 *
 * Order is the paint order: `card whoami` decides the screen, then list → 3DS
 * → limit → profile, one after another through the per-iNFT queue, each
 * handed to the sink the moment it lands.
 */
import { $acpConfigMap } from '../../acp-setup'
import { setEconBadge } from '../badges'
import { type AcpFailure, type AcpResult, humanizeAcpError, invalidateAcp, needsSetup } from '../cli'

import {
  type BankSnapshot,
  type CardLimit,
  type CardProfile,
  type CardState,
  deriveCardState,
  hintFromStatus,
  NO_LIMIT,
  publishBankBadge,
  read3ds,
  readCardState,
  readLimit,
  readProfile,
  readRequests,
  type SpendRequest,
  type ThreeDsCode,
  toBankSnapshot,
  WHOAMI_ARGV
} from './bank-data'

export interface BankNotice {
  message: string
  /** True when only Setup can fix it; false when trying again might. */
  setup: boolean
}

export function sameNotice(a: BankNotice | null, b: BankNotice | null): boolean {
  return a === b || (a !== null && b !== null && a.message === b.message && a.setup === b.setup)
}

export interface BankSink {
  state: (next: CardState) => void
  requests: (list: SpendRequest[]) => void
  codes: (list: ThreeDsCode[], at: number) => void
  limit: (limit: CardLimit) => void
  profile: (result: AcpResult<CardProfile>) => void
  notice: (notice: BankNotice | null) => void
  /** Forget everything only a ready card shows; `keepLimit` keeps a known
   *  card's last limit for its dimmed face. */
  resetReady: (keepLimit: boolean) => void
  persist: (snapshot: BankSnapshot, at: number) => void
  clearSnapshot: () => void
  /** `null` = the list on screen is fresh; a time = this refresh failed and
   *  the list on screen is the one read then (never replaced by an empty one). */
  listUpdatedAt?: (at: null | number) => void
}

interface BankLoadOptions {
  force: boolean
  /** The limit already on screen: persisted when this load could not re-read it. */
  knownLimit?: CardLimit
  /** The card state already on screen: what a read that cannot answer keeps. */
  knownState?: CardState | null
  /** When the list on screen was read (the snapshot's time on a first load). */
  knownListAt?: number
}

// The probe `checkedAt` each iNFT was last reconciled against: a probe that
// disagrees with the cached whoami costs ONE forced read, never one per tick.
const reconciled = new Map<string, number>()
// When each iNFT's `card list` last answered.
const listReadAt = new Map<string, number>()

function isFailure(result: AcpResult<unknown>): result is AcpFailure {
  return !result.ok
}

type ReauthFailure = AcpFailure & { kind: 'reauth' }

function isReauth(result: AcpResult<unknown>): result is ReauthFailure {
  // A 401 without `REAUTH:<state>` sent no link: a plain failure, not a lapsed sign-in.
  return !result.ok && result.kind === 'reauth' && Boolean(result.reauthState)
}

/** Drop every cached card answer — before handing the owner to Setup, whose
 *  writes never pass through the renderer's cache. */
export function forgetCard(slug: string): void {
  invalidateAcp(slug, ['card'])
}

type SessionFailure = AcpFailure & { kind: 'reauth-acp' }

function isSessionExpired(result: AcpResult<unknown>): result is SessionFailure {
  return !result.ok && result.kind === 'reauth-acp'
}

async function readState(
  inftId: string,
  slug: string,
  force: boolean,
  last: CardState | null
): Promise<AcpResult<CardState>> {
  const first = await readCardState(inftId, slug, force, last)
  const status = $acpConfigMap.get()[slug]

  if (force && status) {
    reconciled.set(slug, status.checkedAt)
  }

  const probe = hintFromStatus(status)

  // An expired session disagrees with every probe and a forced re-read cannot change that.
  if (
    force ||
    !first.ok ||
    !status ||
    !probe ||
    probe.kind === first.data.kind ||
    first.data.kind === 'session-expired'
  ) {
    return first
  }

  if (reconciled.get(slug) === status.checkedAt) {
    return first
  }

  reconciled.set(slug, status.checkedAt)

  const fresh = await readCardState(inftId, slug, true, last)

  return fresh.ok ? fresh : first
}

/** Out of "ready" into a gate: a known card keeps its last limit on screen and
 *  its snapshot on disk for when the sign-in comes back; a card never seen (or
 *  `none`) forgets both. */
function leaveReady(slug: string, state: CardState, sink: BankSink): void {
  const known = state.cardKnown === true

  sink.resetReady(known)
  sink.notice(null)

  if (!known) {
    sink.clearSnapshot()
  }

  setEconBadge(slug, 'bank', 0)
}

/** A 401 from any secondary read means the session lapsed under a cached
 *  "ready": the gate replaces the hero now, not in five minutes. */
function demote(slug: string, failure: AcpFailure, previous: CardState, sink: BankSink): void {
  // `previous` was ready: the waiting link keeps it as a known card.
  const pending = deriveCardState(failure, previous)

  forgetCard(slug)
  sink.state(pending.email ? pending : { ...pending, email: previous.email })
  leaveReady(slug, pending, sink)
}

/** The Virtuals session lapsed under a ready card: the card, its limit, its
 *  list and the snapshot all stay — only the sign-in is missing. */
function expire(slug: string, previous: CardState, sink: BankSink): void {
  forgetCard(slug)
  sink.state({ ...(previous.email ? { email: previous.email } : {}), cardKnown: true, kind: 'session-expired' })
  sink.notice(null)
  setEconBadge(slug, 'bank', 0)
}

/** Throws only when `card whoami` itself failed transiently, so the window
 *  header reports it; the sink has already been handed a notice. */
export async function loadBank(inftId: string, slug: string, options: BankLoadOptions, sink: BankSink): Promise<void> {
  const { force } = options

  // Synchronously, before the first await: the detail effect re-reads on the
  // same refresh and must find no cached `card get`.
  if (force) {
    invalidateAcp(slug, ['card', 'get'])
  }

  const known = options.knownState ?? null
  const stateResult = await readState(inftId, slug, force, known)

  if (!stateResult.ok) {
    const message = humanizeAcpError(stateResult.error)

    // Not an answer about the card: keep what is known (stale), never "no card".
    sink.state(deriveCardState(stateResult, known, $acpConfigMap.get()[slug]))
    sink.notice({ message, setup: needsSetup(stateResult) })

    throw new Error(message)
  }

  const state = stateResult.data

  sink.state(state)

  if (state.kind === 'session-expired') {
    sink.notice(null)
    setEconBadge(slug, 'bank', 0)

    return
  }

  if (state.kind !== 'ready') {
    leaveReady(slug, state, sink)

    return
  }

  const listResult = await readRequests(inftId, slug, force)

  if (isReauth(listResult)) {
    return demote(slug, listResult, state, sink)
  }

  if (isSessionExpired(listResult)) {
    return expire(slug, state, sink)
  }

  if (listResult.ok) {
    listReadAt.set(slug, Date.now())
    sink.requests(listResult.data)
    sink.listUpdatedAt?.(null)
  } else {
    sink.listUpdatedAt?.(listReadAt.get(slug) ?? options.knownListAt ?? null)
  }

  const codesResult = await read3ds(inftId, slug, force)

  if (isReauth(codesResult)) {
    return demote(slug, codesResult, state, sink)
  }

  if (isSessionExpired(codesResult)) {
    return expire(slug, state, sink)
  }

  if (codesResult.ok) {
    sink.codes(codesResult.data, codesResult.at)
  }

  const limitResult = await readLimit(inftId, slug, force)

  if (isReauth(limitResult)) {
    return demote(slug, limitResult, state, sink)
  }

  if (isSessionExpired(limitResult)) {
    return expire(slug, state, sink)
  }

  // The limit's own `not-provisioned` is "no limit set", not a failure.
  const limit = limitResult.ok ? limitResult.data : limitResult.kind === 'not-provisioned' ? NO_LIMIT : undefined

  if (limit) {
    sink.limit(limit)
  }

  const profileResult = await readProfile(inftId, slug, force)

  if (isReauth(profileResult)) {
    return demote(slug, profileResult, state, sink)
  }

  if (isSessionExpired(profileResult)) {
    return expire(slug, state, sink)
  }

  sink.profile(profileResult)

  if (listResult.ok) {
    publishBankBadge(slug, listResult.data, codesResult.ok ? codesResult.data : [], Date.now())

    const snapshot = toBankSnapshot(state, limit ?? options.knownLimit, listResult.data)

    if (snapshot) {
      sink.persist(snapshot, stateResult.at)
    }
  }

  const lists = [listResult, codesResult]

  // "Not set up" from a list under a cached "ready" means whoami is stale.
  if (lists.some(result => !result.ok && result.kind === 'not-provisioned')) {
    invalidateAcp(slug, WHOAMI_ARGV)
  }

  const failed =
    lists.find(isFailure) ??
    (isFailure(limitResult) && limitResult.kind !== 'not-provisioned' ? limitResult : undefined)

  sink.notice(failed ? { message: humanizeAcpError(failed.error), setup: failed.kind === 'not-provisioned' } : null)
}
