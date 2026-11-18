/**
 * CF8: main's hard-link guard, served to the confinement launcher on its fd 3 (CF8_DESIGN.md "Channel"). The launcher
 * no longer walks a project before each command: it asks here, and main answers with the SAME `checkBeforeStart` a
 * main-spawned command waits on, so acks, the canary barrier, loss flags and the age bound apply unchanged.
 *
 * Framing: one JSON object per line, UTF-8, `\n` terminated, at most GUARD_LINE_MAX_BYTES per line, both ways.
 * - Request (launcher → main): `{"id": <32 hex>, "op": "check", "root": <abs path>, "cls": <class|null>, "phase": "before"|"after"}`.
 * - Progress (main → launcher): `{"id", "progress": {"dirs": n}}` every GUARD_PROGRESS_MS while the check is open. It is
 *   sent for every open check, not only during a first scan: the launcher refuses after 10 s without a frame, and a
 *   plain check may take up to HARDLINK_CHECK_DEADLINE_MS. `dirs` is the root's first-scan count, else the last seen.
 * - Verdict (main → launcher): exactly one per id, `{"id", "ok": true}` or `{"id", "ok": false, "code", "detail"}`.
 *
 * Anything off the shape (not UTF-8, not JSON, an unknown or missing key, a bad id, a line over the bound, an id
 * already used on this channel) closes the channel: the launcher fails closed on EOF. A well-formed request for a
 * root main would not guard for a confined start (guarded() false: the same admission rule as a main-spawned start)
 * is answered `cannot-scan` and never walked, so the launcher cannot make main scan the home, `/`, or a denied folder.
 */
import path from 'node:path'
import type { Duplex } from 'node:stream'

import { ACTIVITY_CLASSES, type ActivityClass } from '../../src/iclone-shared/confinement'
import { registerTeardown } from '../teardown-registry'

import {
  checkBeforeStart,
  HARDLINK_CHECK_DEADLINE_MS,
  type HardlinkCheck,
  hardlinkRefusal,
  type HardlinkStartGuard,
  type HardlinkUnanswered
} from './hardlinks'

export const GUARD_LINE_MAX_BYTES = 64 * 1024
/** A request's root, in UTF-8 bytes: PATH_MAX, the longest spelling the kernel gives the launcher (F_GETPATH). */
export const GUARD_ROOT_MAX_BYTES = 1024
/** Main's unsent bytes on one channel past which the launcher is taken as not reading fd 3: the channel closes. */
export const GUARD_WRITE_BUFFER_MAX_BYTES = 1024 * 1024
/** Progress cadence; the contract's bound is 2 s. */
export const GUARD_PROGRESS_MS = 1_000
/** How long main waits for a FIRST scan before it answers "still being checked". Under the launcher's own cap
 *  (FIRST_SCAN_CAP_S = 180 s) so the owner reads main's sentence, not the launcher's silence refusal. */
export const GUARD_FIRST_SCAN_CAP_MS = 170_000
/** Open checks per channel; past it a request is answered "still being checked" at once (never queued unbounded). */
export const GUARD_MAX_OPEN = 64
/** Ids remembered per channel to refuse a reused one (a fresh nonce per request is the contract). */
const SEEN_IDS_MAX = 65_536

export const GUARD_STILL_CHECKING = 'the project folder is still being checked; try again in a moment'

export type GuardPhase = 'before' | 'after'

export interface GuardRequest {
  id: string
  op: 'check'
  root: string
  cls: string | null
  phase: GuardPhase
}

/** `busy`: only on GUARD_STILL_CHECKING (main ran out of time, nothing was found); the launcher writes no after-run row
 *  for it. Every other verdict omits the key. */
export type GuardVerdict =
  | { id: string; ok: true }
  | { id: string; ok: false; code: string; detail: string; busy?: true }

const stillChecking = (id: string): GuardVerdict => ({
  id,
  ok: false,
  code: 'cannot-scan',
  detail: GUARD_STILL_CHECKING,
  busy: true
})

export type GuardChannelEvent =
  | { kind: 'request'; id: string; root: string; phase: GuardPhase; at: number }
  | { kind: 'progress'; id: string; dirs: number; at: number }
  | { kind: 'verdict'; id: string; ok: boolean; code: string | null; at: number; ms: number }
  | { kind: 'closed'; why: string; at: number }

export interface GuardChannelTimings {
  deadlineMs?: number
  firstScanCapMs?: number
  stallMs?: number
  pollMs?: number
  progressMs?: number
}

export interface GuardChannelDeps {
  guard: HardlinkStartGuard
  /** Whether main guards `root` for a confined start of `cls` (index.ts: the admission a main-spawned start uses). */
  guarded: (root: string, cls: ActivityClass | null) => boolean
  /** Monotonic ms, the guard's clock. */
  now?: () => number
  /** Epoch ms: an after-phase request's exit time is the moment it arrived (the launcher asks after the exit). */
  wallNow?: () => number
  timings?: GuardChannelTimings
  log?: (line: string) => void
  onEvent?: (event: GuardChannelEvent) => void
  /** Called once when the channel closes for any reason (launcher.ts ends that launcher so a restart gets a new fd 3). */
  onClosed?: (why: string) => void
}

export interface GuardChannel {
  close(why?: string): void
  closed(): boolean
  open(): number
}

const ID_RE = /^[0-9a-f]{32}$/
const REQUEST_KEYS = ['cls', 'id', 'op', 'phase', 'root']
const decoder = new TextDecoder('utf-8', { fatal: true })

/** The request on one line, or null for anything off the contract's shape. */
export function parseGuardRequest(line: Buffer): GuardRequest | null {
  let value: unknown

  try {
    value = JSON.parse(decoder.decode(line))
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>

  if (Object.keys(record).sort().join(',') !== REQUEST_KEYS.join(',')) {
    return null
  }

  const { id, op, root, cls, phase } = record

  if (typeof id !== 'string' || !ID_RE.test(id) || op !== 'check') {
    return null
  }

  // L1.2/L4.2: bounded and already normal, so admission does bounded work (no per-component recursion on 32 000 levels).
  if (
    typeof root !== 'string' ||
    !root.startsWith('/') ||
    root.includes('\0') ||
    Buffer.byteLength(root) > GUARD_ROOT_MAX_BYTES ||
    path.posix.normalize(root) !== root
  ) {
    return null
  }

  if ((cls !== null && typeof cls !== 'string') || (phase !== 'before' && phase !== 'after')) {
    return null
  }

  return { id, op, root, cls, phase }
}

const isClass = (cls: string): cls is ActivityClass => (ACTIVITY_CLASSES as readonly string[]).includes(cls)

/** The verdict for one answered check; `phase` "after" refuses only for what appeared during the run. */
export function guardVerdict(
  id: string,
  phase: GuardPhase,
  result: HardlinkCheck | HardlinkUnanswered
): GuardVerdict {
  if (result.ok) {
    return { id, ok: true }
  }

  if ('unanswered' in result) {
    return result.unanswered === 'timeout'
      ? stillChecking(id)
      : { id, ok: false, code: 'cannot-scan', detail: `the hard-link check failed (${result.detail})` }
  }

  const block = phase === 'after' ? (result.appeared ?? null) : result.block

  return block ? { id, ok: false, code: block.kind, detail: hardlinkRefusal(block) } : { id, ok: true }
}

/** The frame as one line within the bound: a refusal's detail is shortened, never dropped. */
export function guardLine(frame: GuardVerdict | { id: string; progress: { dirs: number } }): string {
  let line = `${JSON.stringify(frame)}\n`

  if (Buffer.byteLength(line) <= GUARD_LINE_MAX_BYTES || !('detail' in frame)) {
    return line
  }

  let detail = frame.detail

  while (Buffer.byteLength(line) > GUARD_LINE_MAX_BYTES) {
    detail = detail.slice(0, Math.floor(detail.length * 0.9))
    line = `${JSON.stringify({ ...frame, detail: `${detail}…` })}\n`
  }

  return line
}

/** Every progress ticker still armed, on every channel (one per open check). Each is cleared by its owner (the answer,
 *  a thrown serve, the channel's close); quit clears every one still armed, so a check still walking at quit sends no
 *  more progress into a launcher being stopped. Only the tickers: the channel itself, its open checks and their
 *  answers are left to the launcher's own stop (closing the channel here would ask launcher.ts to end the launcher). */
const progressTickers = new Set<ReturnType<typeof setInterval>>()

registerTeardown('guard channel progress tickers', () => {
  ;[...progressTickers].forEach(ticker => clearInterval(ticker))
  progressTickers.clear()
})

const stopTicker = (ticker: ReturnType<typeof setInterval> | undefined) => {
  if (ticker !== undefined) {
    clearInterval(ticker)
    progressTickers.delete(ticker)
  }
}

export function serveGuardChannel(stream: Duplex, deps: GuardChannelDeps): GuardChannel {
  const now = deps.now ?? (() => performance.now())
  const wallNow = deps.wallNow ?? Date.now
  const timings = deps.timings ?? {}
  const progressMs = timings.progressMs ?? GUARD_PROGRESS_MS
  const open = new Map<string, ReturnType<typeof setInterval>>()
  const seen = new Set<string>()
  let chunks: Buffer[] = []
  let buffered = 0
  let isClosed = false

  const emit = (event: GuardChannelEvent) => deps.onEvent?.(event)

  const close = (why = 'closed by main') => {
    if (isClosed) {
      return
    }

    isClosed = true

    for (const timer of open.values()) {
      stopTicker(timer)
    }

    open.clear()
    chunks = []
    stream.destroy()
    deps.log?.(`[confinement] guard channel closed: ${why}`)
    emit({ kind: 'closed', why, at: now() })
    deps.onClosed?.(why)
  }

  const send = (frame: GuardVerdict | { id: string; progress: { dirs: number } }) => {
    if (isClosed) {
      return
    }

    stream.write(guardLine(frame))

    // L4.5: a launcher that writes but never reads would grow this buffer for as long as checks stay open.
    if (stream.writableLength > GUARD_WRITE_BUFFER_MAX_BYTES) {
      close('the launcher stopped reading its answers')
    }
  }

  const verdictSent = (verdict: GuardVerdict, began: number) => {
    send(verdict)
    emit({ kind: 'verdict', id: verdict.id, ok: verdict.ok, code: verdict.ok ? null : verdict.code, at: now(), ms: now() - began })
  }

  const answer = (verdict: GuardVerdict, began: number) => {
    const timer = open.get(verdict.id)

    if (timer === undefined) {
      return
    }

    stopTicker(timer)
    open.delete(verdict.id)
    verdictSent(verdict, began)
  }

  const admitted = (root: string, cls: ActivityClass | null): boolean => {
    try {
      return deps.guarded(root, cls)
    } catch (error) {
      deps.log?.(`[confinement] guard channel: admission of ${root} threw (${(error as Error).message}); refused`)

      return false
    }
  }

  // L1.2/L4.2: every refusal that never walks is answered before a progress timer exists, so nothing is left armed if
  // admission throws; the walk's own promise is caught, so an id is always answered.
  const serve = (request: GuardRequest) => {
    const began = now()
    let dirs = 0

    emit({ kind: 'request', id: request.id, root: request.root, phase: request.phase, at: began })

    const refuse = (detail: string) => verdictSent({ id: request.id, ok: false, code: 'cannot-scan', detail }, began)

    if (open.size >= GUARD_MAX_OPEN) {
      verdictSent(stillChecking(request.id), began)

      return
    }

    if (request.cls !== null && !isClass(request.cls)) {
      refuse(`the confined class "${request.cls.slice(0, 64)}" is unknown, so ${request.root} was not checked`)

      return
    }

    const cls = request.cls

    if (!admitted(request.root, cls)) {
      refuse(`${request.root} is not a folder main guards for a confined command, so it was not checked`)

      return
    }

    const ticker = setInterval(() => {
      dirs = deps.guard.firstScanDirs?.(request.root) ?? dirs
      send({ id: request.id, progress: { dirs } })
      emit({ kind: 'progress', id: request.id, dirs, at: now() })
    }, progressMs)

    progressTickers.add(ticker)
    open.set(request.id, ticker)

    const exitedAtMs = request.phase === 'after' ? wallNow() : undefined

    void checkBeforeStart(deps.guard, request.root, cls ?? undefined, timings.deadlineMs ?? HARDLINK_CHECK_DEADLINE_MS, {
      firstScanDeadlineMs: timings.firstScanCapMs ?? GUARD_FIRST_SCAN_CAP_MS,
      stallMs: timings.stallMs,
      pollMs: timings.pollMs,
      now,
      exitedAtMs
    }).then(
      result => answer(guardVerdict(request.id, request.phase, result), began),
      (error: unknown) =>
        answer(
          {
            id: request.id,
            ok: false,
            code: 'cannot-scan',
            detail: `main could not check ${request.root} (${error instanceof Error ? error.message : String(error)})`
          },
          began
        )
    )
  }

  const line = (bytes: Buffer) => {
    const request = parseGuardRequest(bytes)

    if (!request) {
      close('a request line off the contract')

      return
    }

    if (seen.has(request.id)) {
      close('a request id used twice')

      return
    }

    seen.add(request.id)

    for (const oldest of seen) {
      if (seen.size <= SEEN_IDS_MAX) {
        break
      }

      seen.delete(oldest)
    }

    try {
      serve(request)
    } catch (error) {
      // Never out of the 'data' listener (uncaught in Electron main): that id is answered and nothing stays armed.
      const timer = open.get(request.id)

      stopTicker(timer)
      open.delete(request.id)
      send({ id: request.id, ok: false, code: 'cannot-scan', detail: `main could not check ${request.root} (${(error as Error).message})` })
    }
  }

  stream.on('data', (chunk: Buffer | string) => {
    let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let newline = rest.indexOf(0x0a)

    while (!isClosed && newline >= 0) {
      const whole = Buffer.concat([...chunks, rest.subarray(0, newline)])

      chunks = []
      buffered = 0

      // L4.3: the bound counts the newline, as guardLine does in the other direction.
      if (whole.length + 1 > GUARD_LINE_MAX_BYTES) {
        close('a request line over 64 KiB')

        return
      }

      line(whole)
      rest = rest.subarray(newline + 1)
      newline = rest.indexOf(0x0a)
    }

    if (isClosed || rest.length === 0) {
      return
    }

    chunks.push(rest)
    buffered += rest.length

    if (buffered >= GUARD_LINE_MAX_BYTES) {
      close('a request line over 64 KiB')
    }
  })
  stream.on('end', () => close('the launcher closed its end'))
  stream.on('close', () => close('the channel closed'))
  stream.on('error', (error: Error) => close(`channel error: ${error.message}`))

  return {
    close,
    closed: () => isClosed,
    open: () => open.size
  }
}
