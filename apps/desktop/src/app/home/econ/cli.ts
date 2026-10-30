/**
 * EconomyOS — the one door to the `acp` CLI for every Dock app.
 *
 * Three things every app needs and none should re-implement:
 *
 * 1. A LANE PER iNFT. A write runs alone: parallel CLI processes that change
 *    one config dir corrupt it (main enforces it too, electron/iclone-acp-lanes.ts).
 *    Reads run at most two at a time, and background reads hold only one of
 *    the two slots — so the read an owner waits on (`urgent`) starts at once,
 *    never behind the background queue nor behind a long background read.
 * 2. DEDUPE + CACHE. Two components asking for the same command share one
 *    in-flight call, and a fresh answer is served from memory for `ttlMs` so
 *    switching tabs inside an app never re-spawns the CLI.
 * 3. HONEST ERRORS. The CLI exits 0 with `{"error": "HTTP 401 …REAUTH…"}` or
 *    `{"error": "… Call card signup first."}`. Those are STATES, not failures,
 *    and each app renders them as such — so they are classified once, here.
 */
import { acpToolsRefusal } from '@/iclone-shared/acp-tools'
import { parseCliJson } from '@/iclone-shared/cli-json'
import { asRecord, coerceNumber, coerceString, isFiniteNumber } from '@/iclone-shared/guards'

import { runAcp } from '../acp-setup'

/** `reauth` = the card service wants its own sign-in (REAUTH / 401); `reauth-acp` = the iNFT's Virtuals ACP
 *  session expired ("Not authenticated") — it says nothing about the card or the account behind it. */
export type AcpErrorKind =
  'busy' | 'cli' | 'not-provisioned' | 'parse' | 'reauth' | 'reauth-acp' | 'timeout' | 'unavailable'

/** A service-side throttle, orthogonal to the kind: wait `cooldownMs` before calling again. */
export type AcpLimit = 'blocked' | 'rate-limited'

export interface AcpFailure {
  ok: false
  kind: AcpErrorKind
  error: string
  /** For `reauth`: the token the service put after `REAUTH:` (a state id). */
  reauthState?: string
  limit?: AcpLimit
  /** With `limit`: do not call that service again before this long. */
  cooldownMs?: number
  httpStatus?: number
}

interface AcpSuccess<T> {
  ok: true
  data: T
  /** Epoch ms of the CLI answer this came from (a cache hit keeps the original). */
  at: number
}

export type AcpResult<T> = AcpFailure | AcpSuccess<T>

export interface AcpCallOptions {
  /** Serve a cached answer younger than this; 0 (default) always runs the CLI. */
  ttlMs?: number
  /** Bypass the cache for this call (a manual refresh). Still deduped. */
  force?: boolean
  timeoutMs?: number
  /** The owner is waiting on this read (a thread they opened): it takes the
   *  slot background reads never hold, ahead of every queued background read. */
  urgent?: boolean
  /** A speculative read the owner is likely to open next (a thread body): it
   *  goes ahead of every queued background read (the dock apps' warm-ups), and
   *  while no urgent read runs it may also take the urgent slot — an open of
   *  that thread joins it, an open of another waits for at most one read. */
  ahead?: boolean
}

// ── queue + cache ───────────────────────────────────────────────────────────

const lanes = new Map<string, Lane>()
const inflight = new Map<string, { promise: Promise<AcpResult<unknown>>; started: number; promote: () => void }>()
// `shaped` memoizes each shaper's output on the entry: a cache hit then hands
// back the SAME object graph as last time, so React's useMemo/memo boundaries
// downstream hold — re-running the shaper produced fresh identities that made
// every cached answer look new and re-rendered whole lists for nothing.
const cache = new Map<string, { at: number; value: AcpResult<unknown>; shaped: WeakMap<object, unknown> }>()

function shaped<T>(
  entry: { value: AcpResult<unknown>; shaped: WeakMap<object, unknown> },
  shape: (raw: unknown) => T
): AcpResult<T> {
  if (!entry.value.ok) {
    return entry.value
  }

  let data = entry.shaped.get(shape) as T | undefined

  if (data === undefined) {
    data = shape(entry.value.data)
    entry.shaped.set(shape, data)
  }

  return { ...entry.value, data }
}

function keyFor(slug: string, argv: string[]): string {
  return `${slug}\u0000${argv.join('\u0001')}`
}

/** Reads one iNFT may run at once; background reads hold at most one of them. */
const PARALLEL_READS = 2

type Start = () => void

interface Lane {
  reads: number
  backgroundReads: number
  writing: boolean
  urgent: Start[]
  ahead: Start[]
  background: Start[]
  writes: Start[]
}

interface Queued<T> {
  promise: Promise<T>
  /** Move a read that has not started yet into the urgent lane. */
  promote: () => void
}

type Mode = 'ahead' | 'background' | 'urgent' | 'write'

/** The next queued task that may start now, taken off its queue. A waiting
 *  write stops new reads (and starts once the running ones end). */
function takeNext(lane: Lane): { start: Start; mode: Mode } | null {
  if (lane.writing) {
    return null
  }

  if (lane.writes.length > 0) {
    const start = lane.reads === 0 ? lane.writes.shift() : undefined

    return start ? { start, mode: 'write' } : null
  }

  if (lane.reads >= PARALLEL_READS) {
    return null
  }

  const urgent = lane.urgent.shift()

  if (urgent) {
    return { start: urgent, mode: 'urgent' }
  }

  // The second slot stays the owner's: speculation only ever takes the background slot (ahead of the warm-ups).
  if (lane.backgroundReads >= PARALLEL_READS - 1) {
    return null
  }

  const background = lane.ahead.shift() ?? lane.background.shift()

  return background ? { start: background, mode: 'background' } : null
}

function pump(slug: string, lane: Lane): void {
  for (let next = takeNext(lane); next; next = takeNext(lane)) {
    next.start()
  }

  const idle = !lane.writing && lane.reads === 0
  const empty = lane.urgent.length + lane.ahead.length + lane.background.length + lane.writes.length === 0

  if (idle && empty && lanes.get(slug) === lane) {
    lanes.delete(slug)
  }
}

/** Run `task` in this slug's lane (see the header, point 1). */
function enqueue<T>(slug: string, task: () => Promise<T>, mode: Mode = 'background'): Queued<T> {
  let lane = lanes.get(slug)

  if (!lane) {
    lane = { reads: 0, backgroundReads: 0, writing: false, urgent: [], ahead: [], background: [], writes: [] }
    lanes.set(slug, lane)
  }

  const owner = lane
  // A promoted read starts (and is counted) as urgent.
  let current = mode
  let start: Start = () => undefined

  const promise = new Promise<T>((resolve, reject) => {
    start = () => {
      const running = current

      if (running === 'write') {
        owner.writing = true
      } else {
        owner.reads += 1
        owner.backgroundReads += Number(running === 'ahead' || running === 'background')
      }

      void Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          if (running === 'write') {
            owner.writing = false
          } else {
            owner.reads -= 1
            owner.backgroundReads -= Number(running === 'ahead' || running === 'background')
          }

          pump(slug, owner)
        })
    }
  })

  const queue = { ahead: owner.ahead, background: owner.background, urgent: owner.urgent, write: owner.writes }[mode]

  queue.push(start)
  pump(slug, owner)

  return {
    promise,
    promote: () => {
      const waiting = current === 'ahead' ? owner.ahead : owner.background
      const index = waiting.indexOf(start)

      if (index >= 0) {
        waiting.splice(index, 1)
        owner.urgent.push(start)
        current = 'urgent'
        pump(slug, owner)
      }
    }
  }
}

/** Forget cached answers for one iNFT — every command, or only those whose
 *  argv starts with `prefix` (e.g. `['email']` after sending a mail). */
export function invalidateAcp(slug: string, prefix?: string[]): void {
  const head = prefix ? `${slug}\u0000${prefix.join('\u0001')}` : `${slug}\u0000`

  for (const key of cache.keys()) {
    if (key.startsWith(head)) {
      cache.delete(key)
    }
  }
}

// ── parsing + classification ────────────────────────────────────────────────

export { parseCliJson }

// No bare `no agent`: the service's own "no agents found" (an empty search) is
// an ordinary failure, not "this iNFT has no agent" — that read reset the Bank.
const NOT_PROVISIONED =
  /not set up|call card signup|no active agent|not configured|run `?acp configure|not provisioned/i

// Checked before NOT_PROVISIONED: the CLI's expired-session answer also says "Run `acp configure`".
const ACP_SESSION_EXPIRED = /not authenticated|NOT_AUTHENTICATED|session expired|not logged in|login required/i

/** The card service's own 400 naming the CARD or the AGENT: this agent never signed up. The ONLY failure that means
 *  "no card" — the same anchor as main's (electron/iclone-acp-card.ts CARD_NOT_SET_UP). "wallet / signer policy / inbox
 *  not set up" are other services; a 5xx, a 404 or a message with no status is not an answer about the card. */
const CARD_NOT_SET_UP = /call card signup|\b(?:agent ?card|card|agent) (?:is )?not set up\b/i
const NOT_SET_UP_CODE = /\b(?:CARD_)?NOT_SET_?UP\b/

/** True only for the card service's authoritative "never signed up" (HTTP 400 + card/agent wording, or the NOT_SET_UP
 *  code) — never for a dead session, a missing agent, another service's "not set up", a 5xx or a bare 404. */
export function isCardNotSetUp(failure: Pick<AcpFailure, 'error' | 'kind'>): boolean {
  if (failure.kind !== 'not-provisioned') {
    return false
  }

  const status = Number(/HTTP (\d{3})/.exec(failure.error)?.[1])

  return (status === 400 && CARD_NOT_SET_UP.test(failure.error)) || NOT_SET_UP_CODE.test(failure.error)
}

/** The card service never retries for us: a 429 waits a minute, a 403 (a
 *  blocked or locked account) waits 15 — and is never answered with another signup. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000
export const BLOCKED_COOLDOWN_MS = 15 * 60_000

interface AcpErrorClass {
  kind: AcpErrorKind
  limit?: AcpLimit
  reauthState?: string
  cooldownMs?: number
  httpStatus?: number
}

/** The one classifier of CLI error text — the Dock apps and the setup wizard both read it. */
export function classifyAcpError(message: string): AcpErrorClass {
  const reauth = /REAUTH:([0-9a-f-]+)/i.exec(message)
  const httpStatus = Number(/HTTP (\d{3})/.exec(message)?.[1]) || undefined
  const status = httpStatus ? { httpStatus } : {}

  if (reauth) {
    return { kind: 'reauth', reauthState: reauth[1], ...status }
  }

  const rest = { ...classifyRest(message), ...status }

  if (httpStatus === 429 || /rate[ -]?limit|too many requests/i.test(message)) {
    return { ...rest, limit: 'rate-limited', cooldownMs: RATE_LIMIT_COOLDOWN_MS }
  }

  if (httpStatus === 403 || /\b(blocked|locked|suspended)\b/i.test(message)) {
    return { ...rest, limit: 'blocked', cooldownMs: BLOCKED_COOLDOWN_MS }
  }

  return rest
}

function classifyRest(message: string): { kind: AcpErrorKind } {
  if (ACP_SESSION_EXPIRED.test(message)) {
    return { kind: 'reauth-acp' }
  }

  if (/\b401\b|unauthori[sz]ed/i.test(message) && !/not set up/i.test(message)) {
    return { kind: 'reauth' }
  }

  if (NOT_PROVISIONED.test(message)) {
    return { kind: 'not-provisioned' }
  }

  if (/^busy\b/i.test(message)) {
    return { kind: 'busy' }
  }

  if (/timed out/i.test(message)) {
    return { kind: 'timeout' }
  }

  // REL-6: main's refusal while the ACP tools are not installed, being installed, or do not verify — read from its
  // machine prefix (`[acp-tools:<state>:<reason>]`), never from its English words (critic m4).
  if (acpToolsRefusal(message) || /bridge unavailable|not found|not usable/i.test(message)) {
    return { kind: 'unavailable' }
  }

  return { kind: 'cli' }
}

function failure(message: string): AcpFailure {
  return { ok: false, error: message, ...classifyAcpError(message) }
}

/** The service's HTTP errors arrive as `HTTP 400: {"message":"…"}` — show
 *  the inner message, not the envelope. */
export function humanizeAcpError(message: string): string {
  const inner = /HTTP \d+:\s*(\{.*\})\s*$/s.exec(message)

  if (inner) {
    try {
      const body = JSON.parse(inner[1]) as { message?: unknown }

      if (typeof body.message === 'string' && body.message) {
        return body.message.replace(/^REAUTH:[^\s]+/, 'Sign-in required')
      }
    } catch {
      // Fall through to the raw text.
    }
  }

  return message
}

// ── the calls ───────────────────────────────────────────────────────────────

async function execute(inftId: string, argv: string[], timeoutMs: number | undefined): Promise<AcpResult<unknown>> {
  const result = await runAcp(inftId, argv, timeoutMs)
  const parsed = parseCliJson(result.stdout)

  // The CLI exits 1 on an HTTP error but still prints `{"error": …}` — that
  // JSON is the honest message (and the STATE: a 401 REAUTH means "sign in"),
  // so it wins over the bare exit code.
  const envelope = asRecord(parsed)?.error

  if (typeof envelope === 'string' && envelope) {
    return failure(envelope)
  }

  if (!result.ok) {
    const message = result.error || result.stderr.trim().split('\n').find(Boolean) || 'acp command failed'

    return failure(message)
  }

  if (parsed === undefined) {
    return { ok: false, kind: 'parse', error: 'the CLI returned no JSON' }
  }

  return { ok: true, data: parsed, at: Date.now() }
}

/** A remembered STATE (`reauth`, `reauth-acp`, `not-provisioned`) lives shorter than any
 *  answer: a long-TTL read (whoami, compute, older pages) that caught a
 *  transient 401 heals on the next tick instead of minutes later. */
export const FAILURE_TTL_MS = 30_000

const READ_MARK = 'acp:read'
const READ_MARKS_MAX = 200
let readMarks = 0

/**
 * Every CLI read lands on the page's User Timing timeline (`acp:read`: the
 * DevTools Performance panel, or `performance.getEntriesByName('acp:read')`).
 * The span runs from the moment this lane starts the call to its answer (the
 * IPC hop, main's own read lane and the CLI run) and `detail.queuedMs` is the
 * wait in this lane before it, so a slow open tells the read's time from the
 * page's. The timeline is cleared every READ_MARKS_MAX reads; it never fails a
 * read.
 */
function markRead(argv: string[], mode: Mode, queuedAt: number, runAt: number): void {
  if (typeof performance.measure !== 'function') {
    return
  }

  try {
    readMarks += 1

    if (readMarks > READ_MARKS_MAX) {
      performance.clearMeasures(READ_MARK)
      readMarks = 1
    }

    const thread = argv.indexOf('--thread-id')

    performance.measure(READ_MARK, {
      start: runAt,
      end: performance.now(),
      detail: {
        cmd: argv.slice(0, 2).join(' '),
        mode,
        queuedMs: Math.round(runAt - queuedAt),
        threadId: thread < 0 ? undefined : argv[thread + 1]
      }
    })
  } catch {
    // A runtime without User Timing options: the read's answer matters, not its trace.
  }
}

async function timedExecute(
  inftId: string,
  argv: string[],
  timeoutMs: number | undefined,
  mode: Mode,
  queuedAt: number
): Promise<AcpResult<unknown>> {
  const runAt = performance.now()

  try {
    return await execute(inftId, argv, timeoutMs)
  } finally {
    markRead(argv, mode, queuedAt, runAt)
  }
}

/** How long a remembered failure stands in for the CLI. A service limit
 *  (429/403) waits out its cooldown and never less than the read's own TTL;
 *  a REAUTH carrying a sign-in state is a pending link, not a transient 401. */
function failureLife(value: AcpFailure, ttl: number): number {
  if (value.limit) {
    return Math.max(ttl, value.cooldownMs ?? 0)
  }

  return value.kind === 'reauth' && value.reauthState ? ttl : Math.min(ttl, FAILURE_TTL_MS)
}

/**
 * Run one read-only `acp … --json` command for an iNFT and get its JSON back,
 * typed by the caller's `shape` function (which must be total: it receives the
 * raw value and returns the app's own type, never throws).
 */
export async function acpJson<T>(
  inftId: string,
  slug: string,
  argv: string[],
  shape: (raw: unknown) => T,
  options: AcpCallOptions = {}
): Promise<AcpResult<T>> {
  const key = keyFor(slug, argv)
  const ttl = options.ttlMs ?? 0

  const hit = cache.get(key)

  if (hit) {
    const age = Date.now() - hit.at

    // A service limit is honoured even by a forced or uncached read: the
    // card service never retries for us and a blocked account stays blocked.
    if (!hit.value.ok && hit.value.limit && age < (hit.value.cooldownMs ?? 0)) {
      return shaped(hit, shape)
    }

    if (!options.force && ttl > 0 && age < (hit.value.ok ? ttl : failureLife(hit.value, ttl))) {
      return shaped(hit, shape)
    }
  }

  let pending = inflight.get(key)

  if (!pending) {
    // Stamped when the read is REQUESTED, not when it lands, and once per
    // read — every caller that joins it shares the stamp. A TTL equal to the
    // refresh period must expire by the next tick whatever the CLI's latency,
    // or every other tick silently became a cache hit.
    const started = Date.now()
    const mode = options.urgent ? 'urgent' : options.ahead ? 'ahead' : 'background'
    const queuedAt = performance.now()

    const { promise, promote } = enqueue(
      slug,
      () => timedExecute(inftId, argv, options.timeoutMs, mode, queuedAt),
      mode
    )

    pending = { promise, started, promote }
    inflight.set(key, pending)

    void promise.finally(() => {
      if (inflight.get(key) === pending) {
        inflight.delete(key)
      }
    })
  }

  if (options.urgent) {
    pending.promote()
  }

  const { started } = pending
  const value = await pending.promise

  // Only answers, STATES and service limits are worth remembering; transient
  // failures (busy, timeout, missing bridge) must be retried on the next read.
  if (value.ok || isRememberedState(value.kind) || value.limit) {
    const entry = {
      at: started,
      value: value.ok ? { ...value, at: started } : value,
      shaped: new WeakMap<object, unknown>()
    }

    cache.set(key, entry)

    return shaped(entry, shape)
  }

  // A transient failure: reported, never remembered.
  return value
}

/** A write (compose, reply…): never cached, never deduped, still queued. */
export async function acpWrite(
  inftId: string,
  slug: string,
  argv: string[],
  timeoutMs?: number
): Promise<AcpResult<unknown>> {
  return enqueue(slug, () => execute(inftId, argv, timeoutMs), 'write').promise
}

// ── tolerant readers for the shapes the CLI returns ─────────────────────────

export type Json = Record<string, unknown>

export { asRecord, isFiniteNumber }

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isRememberedState(kind: AcpErrorKind): boolean {
  return kind === 'not-provisioned' || kind === 'reauth' || kind === 'reauth-acp'
}

/** Sign-in or provisioning — a state only Setup resolves, never a retry. */
export function needsSetup(failure: AcpFailure): boolean {
  return isRememberedState(failure.kind)
}

/** The short line an app shows next to "Open Setup" for a setup-only failure:
 *  an expired Virtuals session is a sign-in, never "setup needed". */
export function setupNotice(failure: AcpFailure): string {
  return failure.kind === 'reauth-acp' || failure.kind === 'reauth' ? 'Sign in again' : 'Setup needed'
}

type FieldReader<T> = (source: Json | null | undefined, key: string, fallback?: T) => T

/** One field of a CLI record, read through `read`, else the fallback. */
function fieldReader<T>(read: (value: unknown) => T | undefined, defaultFallback: T): FieldReader<T> {
  return (source, key, fallback = defaultFallback) => read(source?.[key]) ?? fallback
}

/** A string field; a finite number reads as its decimal text. */
export const str = fieldReader(coerceString, '')

/** A numeric field; a non-blank numeric string reads as its number. */
export const num = fieldReader(coerceNumber, 0)

export const bool = fieldReader(value => (typeof value === 'boolean' ? value : undefined), false)

/** The list under the first of `keys` that holds an array, or the root when
 *  the root itself is the array (`acp offering list` returns a bare `[]`). */
export function listAt(raw: unknown, keys: string[]): Json[] {
  if (Array.isArray(raw)) {
    return raw.map(asRecord).filter((item): item is Json => item !== null)
  }

  const root = asRecord(raw)

  for (const key of keys) {
    const value = root?.[key]

    if (Array.isArray(value)) {
      return value.map(asRecord).filter((item): item is Json => item !== null)
    }
  }

  return []
}
