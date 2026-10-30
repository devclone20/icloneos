/**
 * iclone os — push for the Market / ACP window: ONE long-lived
 * `acp events listen --json` child for the iNFT whose market window is open.
 *
 * The renderer is the single starter (`iclone:acp-watch`, honouring the live
 * engine switch, document visibility and an open market window); the stage
 * hook and app quit only stop. The child runs beside the per-iNFT queue —
 * never in it — and shares the agent door's streaming registry, so a slug
 * never has two listeners.
 *
 * What the renderer gets is `{ slug, source, type, jobId, status, at }` only:
 * job-room chat lines carry addresses and text, which never leave main.
 *
 * The SDK's SSE stream can die without the child exiting (an `onerror` after
 * open closes the source and nothing is printed), so a child that has said
 * nothing for RECYCLE_MS is recycled; `events drain` replays nothing, so every
 * (re)connect is announced (`stream.live`) and the renderer re-reads once.
 *
 * The CLI answers SIGTERM with an async shutdown that can hang on the SSE
 * close (2026-10-16 lab: a listener alive 6 min after the window closed, its
 * slug held in the streaming registry), so a stop escalates to SIGKILL after
 * KILL_GRACE_MS and the slug is released after one more grace, exited or not.
 */
import { app, ipcMain, type WebContents } from 'electron'

import { lineRedactor } from './iclone-acp-ipc'
import type { IpcSenderEventLike } from './ipc-sender-guard'

export const WATCH_ARGV: readonly string[] = ['events', 'listen', '--json']
const BACKOFF_MIN_MS = 1000
export const BACKOFF_MAX_MS = 60_000
/** A child alive this long resets the backoff. */
export const STABLE_MS = 5 * 60_000
/** A child silent this long is presumed dead and restarted. */
export const RECYCLE_MS = 15 * 60_000
/** The keychain dialog check runs at most once per minute. */
export const KEYCHAIN_CHECK_MS = 60_000
/** SIGTERM → SIGKILL, then SIGKILL → the slug is released whatever the child does. */
export const KILL_GRACE_MS = 5000

const SLUG = /^[a-z0-9-]{1,80}$/
const EVENT_TYPE = /^[a-z]{1,20}(\.[a-z_]{1,20}){0,2}$/
const JOB_ID = /^[0-9A-Za-z_-]{1,80}$/
const STATUS = /^[A-Za-z_ -]{1,40}$/

/** The CLI's `{ error, code, recovery }` codes for an agent that cannot listen until the user acts. */
const FATAL_CODES: ReadonlySet<string> = new Set([
  'NOT_AUTHENTICATED',
  'NO_ACTIVE_AGENT',
  'NO_SIGNER',
  'AGENT_NOT_FOUND'
])

/** The same stops as text (a plain-text stderr, or a JSON error without a code). */
const FATAL_TEXT =
  /not authenticated|session expired|no active agent|no signer configured|re-?auth|unauthori[sz]ed|\b401\b|not[ _-]?provisioned|no agents? found|not logged in|login required/i

const CONNECTED = /\bconnected\b/i
/** A stderr line longer than this is cut before it is classified. */
const STDERR_LINE_MAX = 4096

type AcpWatchSource = 'jobs' | 'stream'

export interface AcpWatchEvent {
  slug: string
  source: AcpWatchSource
  /** `job.*` for a job line (`job.message` for a room chat line); `stream.live` | `stream.up` | `stream.down` | `stream.stopped`. */
  type: string
  jobId: string | null
  status: string | null
  at: number
}

export interface WatchChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  /** The OS pid once known, for the main log. */
  readonly pid?: number | null
  /** SIGTERM by default; `'SIGKILL'` when the child ignored it. */
  kill(signal?: 'SIGKILL'): void
  done: Promise<{ code: number | null; error?: string }>
}

/**
 * A start: the child, or why it did not start. `terminal` (REL-6: the ACP tools are not installed or do not verify)
 * stops the engine instead of retrying: no retry can fix it until the owner installs them.
 */
export type WatchStart = WatchChild | { error: string; terminal?: boolean }

interface AcpWatchDeps {
  /** Spawn `acp <WATCH_ARGV>` for the slug, exactly like the agent's own run (env, config dir, scratch cwd). */
  start(slug: string, argv: readonly string[]): Promise<WatchStart>
  emit(event: AcpWatchEvent): void
  /** The agent door's registry of slugs with a streaming reader. */
  streaming: Set<string>
  keychainPromptShowing(): boolean
  log(line: string): void
  /**
   * May this engine listen for the slug? Asked before every spawn, a retry included. The market window's engine asks
   * main's WORK supervisor, which alone decides for an iNFT it holds (online or offline); the supervisor's own engines
   * have no gate.
   */
  admit?(slug: string): boolean
}

/** The P7 sender guard for `iclone:acp-watch`. Required: no guard means no window is answered (L9). */
type AcpWatchSenderGuard = (event: IpcSenderEventLike, channel: string) => boolean

type AcpWatchResult = { ok: true; slug: string | null } | { ok: false; error: string }

export interface AcpWatch {
  /** The renderer's ask: watch this slug (null = stop). */
  watch(slug: string | null): AcpWatchResult
  /** The stage moved: a listener for another iNFT stops. */
  stage(slug: string | null): void
  /** The last window that wanted the stream is gone: stop exactly as on watch(null). */
  stop(why: string): void
  /** App quit: SIGKILL at once, no grace (the process is going away). */
  stopAll(): void
  /** The slug with a live child, for tests and logs. */
  current(): string | null
  /** The slug this engine is trying to hold: a live child, one starting, or one waiting out its backoff. */
  watching(): string | null
}

function jobIdOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return JOB_ID.test(value) ? value : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value)

    return JOB_ID.test(text) ? text : null
  }

  return null
}

/** One `events listen --json` line → the renderer's event, or null for anything else. Never throws. */
export function eventFromLine(slug: string, line: string, at: number): AcpWatchEvent | null {
  let data: unknown

  try {
    data = JSON.parse(line)
  } catch {
    return null
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }

  const row = data as Record<string, unknown>
  const jobId = jobIdOf(row.jobId)

  if (jobId === null) {
    return null
  }

  const entry = row.entry && typeof row.entry === 'object' ? (row.entry as Record<string, unknown>) : {}
  const event = entry.event && typeof entry.event === 'object' ? (entry.event as Record<string, unknown>) : null
  const type = typeof event?.type === 'string' ? event.type : 'job.message'

  if (!EVENT_TYPE.test(type) || (!type.startsWith('job.') && !type.startsWith('budget.'))) {
    return null
  }

  const status = typeof row.status === 'string' && STATUS.test(row.status) ? row.status : null

  return { slug, source: 'jobs', type, jobId, status, at }
}

/** One stderr line: does it say the agent cannot listen until the user signs in or sets it up? */
export function isFatalStderrLine(line: string): boolean {
  const text = line.trim().slice(0, STDERR_LINE_MAX)

  if (text.startsWith('{')) {
    let data: unknown = null

    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const { code, error } = data as Record<string, unknown>

      // `recovery` says "re-authenticate" for a non-fatal code too: only code and error decide.
      return (
        (typeof code === 'string' && FATAL_CODES.has(code)) || (typeof error === 'string' && FATAL_TEXT.test(error))
      )
    }
  }

  return FATAL_TEXT.test(text)
}

export function nextBackoff(previousMs: number, aliveMs: number): number {
  if (aliveMs >= STABLE_MS || previousMs <= 0) {
    return BACKOFF_MIN_MS
  }

  return Math.min(previousMs * 2, BACKOFF_MAX_MS)
}

type ExitResult = { code: number | null; error?: string }

/** Whole lines through the agent door's redactor; each line is handled alone, so a throwing one loses nothing. */
function perLine(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  return lineRedactor(text => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()

      if (!trimmed) {
        continue
      }

      try {
        onLine(trimmed)
      } catch {
        // One bad line never takes the stream (or main) down.
      }
    }
  })
}

interface Run {
  slug: string
  child: WatchChild | null
  startedAt: number
  lastLineAt: number
  backoffMs: number
  retry: ReturnType<typeof setTimeout> | null
  idle: ReturnType<typeof setInterval> | null
  /** Ends the live child (escalating); set while one runs. */
  terminate: ((why: string, now?: boolean) => void) | null
  /** The child said it is connected (stream.live was announced). */
  live: boolean
  stopped: boolean
}

export function createAcpWatch(deps: AcpWatchDeps): AcpWatch {
  let run: Run | null = null
  let keychainAt = 0
  let keychainSeen = false
  /** Per slug: our own child that still holds the streaming registry (live or dying). */
  const claims = new Map<string, Promise<ExitResult>>()

  const keychain = (): boolean => {
    const now = Date.now()

    if (now - keychainAt >= KEYCHAIN_CHECK_MS) {
      keychainAt = now
      keychainSeen = deps.keychainPromptShowing()
    }

    return keychainSeen
  }

  const say = (slug: string, type: string) =>
    deps.emit({ slug, source: 'stream', type, jobId: null, status: null, at: Date.now() })

  const release = (current: Run) => {
    if (current.retry) {
      clearTimeout(current.retry)
      current.retry = null
    }

    if (current.idle) {
      clearInterval(current.idle)
      current.idle = null
    }
  }

  const stop = (why: string, now = false) => {
    const current = run

    run = null

    if (!current) {
      return
    }

    current.stopped = true
    release(current)
    deps.log(`[iclone-acp-watch] stop ${current.slug} (${why})`)
    current.terminate?.(why, now)
    say(current.slug, 'stream.down')
  }

  const schedule = (current: Run, delayMs: number) => {
    if (current.stopped || run !== current) {
      return
    }

    current.retry = setTimeout(() => {
      current.retry = null
      void spawn(current)
    }, delayMs)
  }

  /** Claim the slug in the shared registry; the claim ends exactly once, on exit or after the kill grace. */
  const claim = (slug: string) => {
    let finish: (result: ExitResult) => void = () => undefined
    let finished = false

    const settled = new Promise<ExitResult>(resolve => {
      finish = result => {
        if (finished) {
          return
        }

        finished = true
        deps.streaming.delete(slug)

        if (claims.get(slug) === settled) {
          claims.delete(slug)
        }

        resolve(result)
      }
    })

    deps.streaming.add(slug)
    claims.set(slug, settled)

    return { settled, finish }
  }

  /** Bound a child to a kill: SIGTERM (or SIGKILL now), SIGKILL after the grace, release after another. */
  const killer = (slug: string, child: WatchChild, settled: Promise<ExitResult>, finish: (r: ExitResult) => void) => {
    let started = false
    let hard: ReturnType<typeof setTimeout> | null = null
    let free: ReturnType<typeof setTimeout> | null = null

    const send = (signal?: 'SIGKILL') => {
      try {
        child.kill(signal)
      } catch (error) {
        deps.log(`[iclone-acp-watch] ${slug} kill failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const sigkill = () => {
      hard = null
      deps.log(`[iclone-acp-watch] ${slug} pid ${child.pid ?? '?'} still alive — SIGKILL`)
      send('SIGKILL')
      free = setTimeout(() => {
        free = null
        deps.log(`[iclone-acp-watch] ${slug} pid ${child.pid ?? '?'} never exited — slug released`)
        finish({ code: null, error: 'killed' })
      }, KILL_GRACE_MS)
    }

    void settled.then(() => {
      if (hard) {
        clearTimeout(hard)
      }

      if (free) {
        clearTimeout(free)
      }
    })

    return (why: string, now = false) => {
      if (started) {
        if (now && hard) {
          clearTimeout(hard)
          sigkill()
        }

        return
      }

      started = true
      deps.log(`[iclone-acp-watch] kill ${slug} pid ${child.pid ?? '?'} (${why})`)

      if (now) {
        sigkill()
      } else {
        send()
        hard = setTimeout(sigkill, KILL_GRACE_MS)
      }
    }
  }

  const spawn = async (current: Run) => {
    // Our own previous child (a stop, a recycle) may still be dying: wait for it, never a second listener.
    for (let prior = claims.get(current.slug); prior; prior = claims.get(current.slug)) {
      await prior
    }

    if (current.stopped || run !== current) {
      return
    }

    if (deps.admit && !deps.admit(current.slug)) {
      stop('not admitted: the WORK supervisor holds this iNFT')

      return
    }

    // The agent door owns the slug's stream: wait our turn.
    if (deps.streaming.has(current.slug)) {
      current.backoffMs = nextBackoff(current.backoffMs, 0)
      schedule(current, current.backoffMs)

      return
    }

    const { settled, finish } = claim(current.slug)
    let started: WatchStart

    try {
      started = await deps.start(current.slug, WATCH_ARGV)
    } catch (error) {
      started = { error: error instanceof Error ? error.message : String(error) }
    }

    if ('error' in started) {
      finish({ code: null, error: started.error })
      deps.log(`[iclone-acp-watch] ${current.slug} did not start: ${started.error}`)

      if (started.terminal === true) {
        deps.log(`[iclone-acp-watch] ${current.slug} stopped: the ACP tools are not installed or do not verify`)
        run = null
        say(current.slug, 'stream.stopped')

        return
      }

      current.backoffMs = nextBackoff(current.backoffMs, 0)
      schedule(current, current.backoffMs)

      return
    }

    const child = started

    child.done.then(finish, (error: unknown) => finish({ code: null, error: String(error) }))

    const terminate = killer(current.slug, child, settled, finish)

    if (current.stopped || run !== current) {
      terminate('stopped while starting')

      return
    }

    current.child = child
    current.terminate = terminate
    current.startedAt = Date.now()
    current.lastLineAt = current.startedAt
    deps.log(`[iclone-acp-watch] spawn ${current.slug} pid ${child.pid ?? '?'}`)

    let fatal = false

    current.live = false

    const out = perLine(line => {
      current.lastLineAt = Date.now()

      const event = eventFromLine(current.slug, line, current.lastLineAt)

      if (event && run === current) {
        deps.emit(event)
      }
    })

    const err = perLine(line => {
      current.lastLineAt = Date.now()

      if (fatal) {
        return
      }

      if (isFatalStderrLine(line)) {
        fatal = true
        terminate('needs sign-in or setup')
      } else if (!current.live && CONNECTED.test(line) && run === current) {
        // A (re)connect: whatever happened in the gap is not replayed.
        current.live = true
        say(current.slug, 'stream.live')
      }
    })

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => out.push(String(chunk)))
    child.stderr?.on('data', (chunk: string | Buffer) => err.push(String(chunk)))

    current.idle = setInterval(() => {
      if (Date.now() - current.lastLineAt >= RECYCLE_MS) {
        deps.log(`[iclone-acp-watch] ${current.slug} silent ${Math.round(RECYCLE_MS / 60_000)} min — recycling`)
        current.backoffMs = 0
        terminate('silent')
      }
    }, 60_000)

    const result = await settled

    out.end()
    err.end()

    if (current.idle) {
      clearInterval(current.idle)
      current.idle = null
    }

    current.child = null
    current.terminate = null
    current.live = false
    deps.log(`[iclone-acp-watch] exit ${current.slug} pid ${child.pid ?? '?'} (${result.code ?? result.error ?? '?'})`)

    if (current.stopped || run !== current) {
      return
    }

    if (fatal) {
      deps.log(`[iclone-acp-watch] ${current.slug} stopped: the agent needs sign-in or setup`)
      run = null
      say(current.slug, 'stream.stopped')

      return
    }

    say(current.slug, 'stream.down')

    const aliveMs = Date.now() - current.startedAt

    current.backoffMs = nextBackoff(current.backoffMs, aliveMs)
    deps.log(`[iclone-acp-watch] ${current.slug} retry in ${current.backoffMs} ms`)
    schedule(current, keychain() ? Math.max(current.backoffMs, KEYCHAIN_CHECK_MS) : current.backoffMs)
  }

  return {
    watch(slug) {
      if (slug !== null && !SLUG.test(slug)) {
        return { ok: false, error: 'not an iNFT slug' }
      }

      deps.log(`[iclone-acp-watch] watch ${slug ?? 'null'}`)

      if (slug === null) {
        stop('watch(null)')

        return { ok: true, slug: null }
      }

      if (deps.admit && !deps.admit(slug)) {
        stop(`watch ${slug} not admitted`)

        return { ok: false, error: 'the WORK supervisor holds this iNFT' }
      }

      if (run && run.slug === slug) {
        // A reloaded or second window: the same child, already connected — liveness only, nothing to re-read.
        if (run.live && run.child) {
          say(slug, 'stream.up')
        }

        return { ok: true, slug }
      }

      stop(`watch ${slug}`)
      run = {
        slug,
        child: null,
        startedAt: 0,
        lastLineAt: 0,
        backoffMs: 0,
        retry: null,
        idle: null,
        terminate: null,
        live: false,
        stopped: false
      }
      void spawn(run)

      return { ok: true, slug }
    },
    stage(slug) {
      if (run && run.slug !== slug) {
        stop(`stage ${slug ?? 'null'}`)
      }
    },
    stop: why => stop(why),
    stopAll: () => stop('quit', true),
    current: () => (run?.child ? run.slug : null),
    watching: () => run?.slug ?? null
  }
}

/**
 * Main-process wiring: the IPC door, the event fan-out (only to windows that asked) and the quit kill.
 * Main owns the window lifecycle: React cleanup never runs when a window is destroyed, crashes or reloads,
 * so the windows that asked for the current slug are tracked here and the run stops when none is left.
 */
export function initAcpWatch(
  deps: Omit<AcpWatchDeps, 'emit'> & { isTrustedSender: AcpWatchSenderGuard | undefined }
): AcpWatch {
  // The app windows that called iclone:acp-watch; a Privy or link-title window never hears the stream.
  const audience = new Set<WebContents>()
  // The windows whose last ask was the slug main currently watches.
  const askers = new Set<WebContents>()
  let asked: string | null = null
  const wired = new WeakSet<WebContents>()

  const watcher = createAcpWatch({
    ...deps,
    emit: event => {
      for (const contents of audience) {
        if (contents.isDestroyed()) {
          audience.delete(contents)
        } else {
          contents.send('iclone:acp-event', event)
        }
      }
    }
  })

  const live = (contents: WebContents) => !contents.isDestroyed()

  const clear = () => {
    askers.clear()
    asked = null
  }

  const forget = (contents: WebContents, why: string) => {
    if (!askers.delete(contents)) {
      return
    }

    if (![...askers].some(live)) {
      clear()
      watcher.stop(why)
    }
  }

  const wire = (sender: WebContents) => {
    if (wired.has(sender)) {
      return
    }

    wired.add(sender)
    sender.once?.('destroyed', () => {
      audience.delete(sender)
      forget(sender, 'window gone')
    })
    sender.on?.('render-process-gone', () => forget(sender, 'window gone'))
    // Only a committed new document replaces the asker (a reload commits too). 'did-start-navigation' fires before
    // will-navigate can cancel it, so a blocked link would kill a live Market. 'did-navigate' is main-frame only, and
    // in-page routing fires 'did-navigate-in-page' instead.
    sender.on?.('did-navigate', () => forget(sender, 'window gone'))
    // A main-frame load that fails commits an error page (chrome-error://chromewebdata) with no 'did-navigate', so the
    // asker is gone but nothing told us. ERR_ABORTED (-3) is a cancelled or blocked navigation: the Market is still there.
    sender.on?.(
      'did-fail-load',
      (_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame && errorCode !== -3) {
          forget(sender, 'window gone')
        }
      }
    )
  }

  ipcMain.handle('iclone:acp-watch', (event: { sender?: WebContents }, raw: unknown) => {
    if (
      typeof deps.isTrustedSender !== 'function' ||
      deps.isTrustedSender(event as IpcSenderEventLike, 'iclone:acp-watch') !== true
    ) {
      return null
    }

    const sender = event?.sender
    const slug = typeof raw === 'string' ? raw : null

    if (sender) {
      audience.add(sender)
      wire(sender)
    }

    if (slug === null) {
      if (sender) {
        askers.delete(sender)
      }

      // Another live window still wants the current slug: keep its listener.
      if ([...askers].some(live)) {
        return { ok: true, slug: null }
      }

      clear()
    }

    const result = watcher.watch(slug)

    if (result.ok && slug !== null) {
      if (asked !== slug) {
        askers.clear()
        asked = slug
      }

      if (sender) {
        askers.add(sender)
      }
    }

    return result
  })
  // Not once: a cancelled quit (the quit confirmation) must leave the kill armed for the real one. stopAll is idempotent.
  // Main's own quit handlers run first and preventDefault() the passes that do not quit ("Keep Running", the deferred
  // teardown), so only an unprevented pass kills the open Market's listener. 'will-quit' fires only when the quit goes
  // through: the backstop that keeps a listener from outliving the app.
  app.on('before-quit', event => {
    if (!event.defaultPrevented) {
      watcher.stopAll()
    }
  })
  app.on('will-quit', () => watcher.stopAll())

  return watcher
}
