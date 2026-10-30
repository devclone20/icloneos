/**
 * iclone os — one `card signup` per iNFT in main, whatever asks for it.
 *
 * The renderer's own guard lives in module memory: a Force Reload or a crash
 * recovery forgets it while main still waits on the CLI. Main refuses a second
 * signup for the same iNFT until the first one exits (or times out), and after
 * any signup the next status read re-runs `card whoami` instead of serving a
 * cached pre-signup "none" for the rest of its TTL — unless the signup itself
 * answered 403/429/blocked: then that re-read waits out the service's hold.
 * The hold is also written under the iNFT's dir, so an app restart inside it
 * still refuses (and the re-read stays due after it). So is the due mark, and
 * before the send: a quit mid-signup or a signup without an answer still
 * re-reads the card after a restart. One sign-in link a minute per iNFT: main
 * refuses a signup inside the minute after the last one left or answered,
 * whichever window, wizard or remount of them asks (the minute is on disk too).
 */
import type { AcpRunResult } from './iclone-acp'
import { CARD_BLOCKED_TTL_MS, cardStateFrom } from './iclone-acp-card'
import {
  deleteCardDue,
  deleteCardHold,
  deleteCardSent,
  readCardDue,
  readCardHold,
  readCardSent,
  writeCardDue,
  writeCardHold,
  writeCardSent
} from './iclone-acp-store'

export const SIGNUP_RUNNING = 'a signup is still running for this iNFT — not sending another'

/** A 429 from the card service is a short rate limit, not the 15-min block. */
export const CARD_RATE_HOLD_MS = 60_000

/** How much of a signup's own output main keeps to judge the hold on (an error JSON is far smaller). */
export const SIGNUP_ANSWER_CAP = 16_384

/** The renderer reads the hold's end from a refusal through this marker. */
export const HELD_UNTIL_MARK = 'held-until='

/** The wait between two sign-in links for one iNFT (the renderer's RESEND_WAIT_MS is the same minute). */
export const CARD_RESEND_WAIT_MS = 60_000

/** The renderer reads when the next link may go from a refusal through this marker. */
export const RESEND_AT_MARK = 'resend-at='

/** The service's own answer to the last signup: no signup and no `card whoami` until `until`. */
export interface CardSignupHold {
  until: number
  /** 429 (a one-minute rate limit) — otherwise the 15-min block (403 / blocked). */
  rateLimited: boolean
  httpStatus?: number
}

const running = new Set<string>()
const dueSince = new Map<string, number>()
const holds = new Map<string, CardSignupHold>()
/** When each iNFT's last signup left or answered (the later of the two). */
const lastSent = new Map<string, number>()
/** Slugs whose recorded hold this process has already read: from then on memory is the record. */
const loaded = new Set<string>()
let holdRoot: () => string | undefined = () => undefined

/** Where each iNFT's hold is recorded (userData/inft). Without one, holds live in memory only. */
export function persistCardHoldsUnder(root: () => string | undefined): void {
  holdRoot = root
  loaded.clear()
}

function recordRoot(): string | undefined {
  try {
    return holdRoot()
  } catch {
    return undefined
  }
}

/** Reads the recorded hold and due mark back once per process; it never shortens the hold in memory
 *  and never moves the due mark earlier than memory's. */
function loadHold(slug: string, now: number): void {
  if (loaded.has(slug)) {
    return
  }

  loaded.add(slug)
  const root = recordRoot()

  if (!root) {
    return
  }

  const stored = readCardHold(root, slug, now, CARD_BLOCKED_TTL_MS)
  const due = readCardDue(root, slug)
  // A stamp ahead of the clock (set back) counts from now: it may force one more card read, never fewer.
  const recorded = Math.min(now, Math.max(due?.since ?? 0, stored?.endedAt ?? 0))
  const since = Math.max(recorded, dueSince.get(slug) ?? 0)

  if (since > 0) {
    dueSince.set(slug, since)
  }

  // A stamp ahead of the clock (set back) counts from now: one more minute of wait, never an endless one.
  const sent = Math.min(now, readCardSent(root, slug) ?? 0)

  if (sent > (lastSent.get(slug) ?? 0)) {
    lastSent.set(slug, sent)
  }

  if (!stored) {
    return
  }

  if (stored.until > (holds.get(slug)?.until ?? 0)) {
    holds.set(slug, {
      until: stored.until,
      rateLimited: stored.rateLimited,
      ...(stored.httpStatus !== undefined ? { httpStatus: stored.httpStatus } : {})
    })
  }
}

function record(slug: string, hold: CardSignupHold, endedAt: number): void {
  const root = recordRoot()

  if (root) {
    writeCardHold(root, slug, { ...hold, endedAt }, endedAt)
  }
}

/** A signup left or answered at `at`: the resend wait counts from it, on disk too. */
function markSent(slug: string, at: number): void {
  lastSent.set(slug, Math.max(at, lastSent.get(slug) ?? 0))
  const root = recordRoot()

  if (root) {
    writeCardSent(root, slug, at, at)
  }
}

/** The card re-read is due from `since` on: on disk too, so a restart keeps it. */
function recordDue(slug: string, since: number): void {
  const root = recordRoot()

  if (root) {
    writeCardDue(root, slug, { since }, since)
  }
}

/** A hold another record of main's reported (the persisted status): adopted when it runs longer than
 *  the one in memory, so every signup path refuses it and the re-read is due once it ends. */
export function adoptCardSignupHold(slug: string, hold: CardSignupHold, now: number = Date.now()): void {
  loadHold(slug, now)

  if (hold.until <= now || hold.until <= (holds.get(slug)?.until ?? 0)) {
    return
  }

  const endedAt = Math.max(1, hold.until - (hold.rateLimited ? CARD_RATE_HOLD_MS : CARD_BLOCKED_TTL_MS))

  holds.set(slug, hold)

  if (!dueSince.has(slug)) {
    dueSince.set(slug, endedAt)
    recordDue(slug, endedAt)
  }

  record(slug, hold, endedAt)
}

/** Detach: the iNFT keeps no local trace, the hold included (its dir, and the record in it, are gone). */
export function forgetCardSignup(slug: string): void {
  holds.delete(slug)
  dueSince.delete(slug)
  lastSent.delete(slug)
  loaded.add(slug)
  const root = recordRoot()

  if (root) {
    deleteCardHold(root, slug)
    deleteCardDue(root, slug)
    deleteCardSent(root, slug)
  }
}

/** `card signup` exactly as the first two words (never `signup-poll`, never a value of another flag). */
export function isCardSignup(args: readonly string[]): boolean {
  return args[0] === 'card' && args[1] === 'signup'
}

export function cardSignupRunning(slug: string): boolean {
  return running.has(slug)
}

function holdFrom(answer: AcpRunResult | undefined, ended: number): CardSignupHold | undefined {
  const probe = answer ? cardStateFrom(answer) : undefined

  if (probe?.state !== 'blocked') {
    return undefined
  }

  const rateLimited = probe.httpStatus === 429

  return {
    until: ended + (rateLimited ? CARD_RATE_HOLD_MS : CARD_BLOCKED_TTL_MS),
    rateLimited,
    ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {})
  }
}

/** How long the service told us to stay away, judged by the signup's own answer (0 = no hold). */
export function signupHoldMs(answer: AcpRunResult | undefined): number {
  return holdFrom(answer, 0)?.until ?? 0
}

/** The refusal a held iNFT's signup gets: it names the answer and when the hold ends. */
export function signupHeldReason(hold: CardSignupHold): string {
  const answer = hold.rateLimited ? 'HTTP 429 (rate limit)' : `HTTP ${hold.httpStatus ?? 403} (blocked)`

  return `the card service answered this iNFT's last signup with ${answer} — not sending another until ${new Date(hold.until).toISOString()} [${HELD_UNTIL_MARK}${hold.until}]`
}

/** When the next sign-in link may go for this iNFT (undefined = now). */
export function cardResendAt(slug: string, now: number = Date.now()): number | undefined {
  loadHold(slug, now)
  const recorded = lastSent.get(slug)

  if (recorded === undefined) {
    return undefined
  }

  // The clock set back while the app runs: a send ahead of now counts from now, so the wait is one more
  // minute at most, never the whole step back.
  const sent = Math.min(recorded, now)

  if (sent < recorded) {
    lastSent.set(slug, sent)
  }

  if (sent + CARD_RESEND_WAIT_MS > now) {
    return sent + CARD_RESEND_WAIT_MS
  }

  lastSent.delete(slug)
  const root = recordRoot()

  // A send already running keeps its own pre-send record.
  if (root && !running.has(slug)) {
    deleteCardSent(root, slug)
  }

  return undefined
}

/** The refusal a signup inside the resend wait gets: nothing was sent, and when the next may go. */
export function signupResendReason(at: number): string {
  return `a sign-in link for this iNFT went out less than a minute ago — not sending another until ${new Date(at).toISOString()} [${RESEND_AT_MARK}${at}]`
}

function asRunResult(result: unknown): AcpRunResult | undefined {
  const record = result as Partial<AcpRunResult> | null

  return record && typeof record === 'object' && typeof record.stdout === 'string'
    ? (record as AcpRunResult)
    : undefined
}

/** Runs `task` as the iNFT's one signup; anything that is not a signup runs untouched.
 *  `answerOf` turns the task's result into the CLI answer the hold is judged on. */
export async function withCardSignupSlot<T>(
  slug: string,
  args: readonly string[],
  task: () => Promise<T>,
  refused: (reason: string) => T,
  answerOf: (result: T) => AcpRunResult | undefined = asRunResult
): Promise<T> {
  if (!isCardSignup(args)) {
    return task()
  }

  if (running.has(slug)) {
    return refused(SIGNUP_RUNNING)
  }

  const held = cardSignupHold(slug)

  if (held) {
    return refused(signupHeldReason(held))
  }

  const resendAt = cardResendAt(slug)

  if (resendAt !== undefined) {
    return refused(signupResendReason(resendAt))
  }

  running.add(slug)
  const startedAt = Date.now()
  // Before the send: if this process never sees the signup end, the next one still re-reads the card
  // and still waits out the minute.
  recordDue(slug, startedAt)
  markSent(slug, startedAt)
  let answer: AcpRunResult | undefined

  try {
    const result = await task()
    answer = answerOf(result)

    return result
  } finally {
    const ended = Date.now()
    const hold = holdFrom(answer, ended)
    const kept = cardSignupHold(slug, ended)

    running.delete(slug)
    dueSince.set(slug, ended)
    recordDue(slug, ended)
    markSent(slug, ended)

    // A hold only ever grows: a signup without a 403/429 answer (a timeout, a crash) never shortens one.
    if (hold && hold.until > (kept?.until ?? 0)) {
      holds.set(slug, hold)
      record(slug, hold, ended)
    }
  }
}

/** The last signup's own 403/429 hold, while it runs (undefined = no hold). */
export function cardSignupHold(slug: string, now: number = Date.now()): CardSignupHold | undefined {
  loadHold(slug, now)
  const hold = holds.get(slug)

  if (hold && now >= hold.until) {
    holds.delete(slug)
    const root = recordRoot()

    if (root) {
      deleteCardHold(root, slug)
    }

    return undefined
  }

  return hold
}

/** Until when the last signup's own 403/429 answer keeps `card whoami` away (undefined = no hold). */
export function cardSignupHeldUntil(slug: string, now: number = Date.now()): number | undefined {
  return cardSignupHold(slug, now)?.until
}

/** When the last signup for the iNFT ended, while no card read that started after it has answered.
 *  Inside the signup's hold it is not due yet; it stays marked and is due on the first read after. */
export function cardDueSince(slug: string, now: number = Date.now()): number | undefined {
  return cardSignupHeldUntil(slug, now) === undefined ? dueSince.get(slug) : undefined
}

/** A card read that started at `checkedAt` answered: it settles every signup that ended before it began. */
export function settleCardDue(slug: string, checkedAt: number | undefined): void {
  loadHold(slug, Date.now())
  const due = dueSince.get(slug)

  if (due === undefined || checkedAt === undefined || checkedAt < due) {
    return
  }

  dueSince.delete(slug)
  const root = recordRoot()

  // A signup sent since has its own pre-send record, which this read does not settle.
  if (root && !running.has(slug)) {
    deleteCardDue(root, slug)
  }
}
