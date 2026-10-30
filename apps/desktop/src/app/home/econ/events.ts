/**
 * EconomyOS — the job stream of the open Market window (main:
 * electron/iclone-acp-watch.ts). Each event drops exactly the cached reads it
 * makes stale and asks the window for one silent re-read; nothing else moves.
 *
 * Only jobs stream. Mail, wallet, card and Hyperliquid have no event source in
 * the CLI and stay on live.ts's silent change detection.
 *
 * `stream.live` is a (re)connect: `events drain` replays nothing, so whatever
 * happened in the gap is re-read once. While the stream is live the market
 * timer stretches to STREAM_FALLBACK_SECS (live.ts); `stream.down` returns it
 * to the Settings value at once. `stream.up` is main answering a watch of a
 * child that is already connected (a reload, a second window): liveness only.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useRef } from 'react'

import { invalidateAcp } from './cli'
import { $liveEconEnabled } from './prefs'

interface AcpEvent {
  slug: string
  source: 'jobs' | 'stream'
  type: string
  jobId: string | null
  status: string | null
  at: number
}

/** Per slug: true while its listener is connected. */
export const $acpStreamLive = atom<Record<string, boolean>>({})

/** A burst (a reconnect hydrating several rooms) is one re-read. */
export const COALESCE_MS = 150
/** A window behind another app keeps its stream this long, then lets it go. */
export const HIDDEN_STOP_MS = 60_000

const SLUG = /^[a-z0-9-]{1,80}$/
const TYPE = /^[a-z]{1,20}(\.[a-z_]{1,20}){0,2}$/

const JOB_READS: readonly string[][] = [['job'], ['events'], ['offering']]

/** The bridge's payload, or null when it is not one of ours. */
export function parseAcpEvent(payload: unknown): AcpEvent | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const row = payload as Record<string, unknown>
  const { slug, source, type } = row

  if (typeof slug !== 'string' || !SLUG.test(slug) || (source !== 'jobs' && source !== 'stream')) {
    return null
  }

  if (typeof type !== 'string' || !TYPE.test(type)) {
    return null
  }

  return {
    slug,
    source,
    type,
    jobId: typeof row.jobId === 'string' ? row.jobId : null,
    status: typeof row.status === 'string' ? row.status : null,
    at: typeof row.at === 'number' ? row.at : Date.now()
  }
}

/** The cache prefixes (cli.ts argv heads) an event makes stale. `stream.up` missed nothing. */
export function invalidationsFor(type: string): readonly string[][] {
  if (type === 'stream.live') {
    return JOB_READS
  }

  if (!type.startsWith('job.') && !type.startsWith('budget.')) {
    return []
  }

  // Money moved: the balance is stale too.
  return type === 'job.funded' || type === 'job.completed' ? [...JOB_READS, ['wallet']] : JOB_READS
}

function setLive(slug: string, live: boolean): void {
  const map = $acpStreamLive.get()

  if ((map[slug] === true) !== live) {
    $acpStreamLive.set({ ...map, [slug]: live })
  }
}

/** Apply one event: liveness + invalidation. True when the window should re-read. */
export function applyAcpEvent(event: AcpEvent): boolean {
  if (event.source === 'stream') {
    setLive(event.slug, event.type === 'stream.live' || event.type === 'stream.up')
  }

  const stale = invalidationsFor(event.type)

  for (const prefix of stale) {
    invalidateAcp(event.slug, prefix)
  }

  return stale.length > 0
}

const subscribers = new Map<string, Set<() => void>>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
let detach: (() => void) | null = null

function dispatch(payload: unknown): void {
  const event = parseAcpEvent(payload)

  if (event?.source === 'stream' && releases.has(event.slug)) {
    // Main gave the stream up (or reconnected) inside the release gap: a remount must know whether to re-ask.
    if (event.type === 'stream.live' || event.type === 'stream.up') {
      lost.delete(event.slug)
    } else {
      lost.add(event.slug)
    }
  }

  if (!event || !applyAcpEvent(event) || pending.has(event.slug)) {
    return
  }

  pending.set(
    event.slug,
    setTimeout(() => {
      pending.delete(event.slug)

      for (const notify of subscribers.get(event.slug) ?? []) {
        notify()
      }
    }, COALESCE_MS)
  )
}

function subscribe(slug: string, notify: () => void): () => void {
  const set = subscribers.get(slug) ?? new Set<() => void>()

  subscribers.set(slug, set.add(notify))

  // One bridge listener per window, however many apps subscribe.
  if (!detach) {
    detach = window.hermesDesktop?.icloneAcp?.onEvent?.(dispatch) ?? null
  }

  return () => {
    set.delete(notify)

    if (set.size === 0) {
      subscribers.delete(slug)
    }

    detachIfUnused()
  }
}

/** A pending let-go still owns the stream: its stream.stopped/down must reach the live flag, so detach only when idle. */
function detachIfUnused(): void {
  if (subscribers.size === 0 && holders.size === 0 && releases.size === 0 && detach) {
    detach()
    detach = null
  }
}

function askWatch(slug: string | null): void {
  void window.hermesDesktop?.icloneAcp?.watch?.(slug)?.catch(() => undefined)
}

/** A remount inside this (StrictMode, HMR) keeps the stream instead of a kill and a CLI cold start. */
export const RELEASE_MS = 1500

/**
 * Per slug: mounted, visible subscribers holding the stream (insertion order =
 * hold order). Main runs one listener at a time and watch(null) is global, so
 * `watched` is the slug this window last asked for; when it is let go while
 * another slug is still held, the most recently held survivor is asked for.
 */
const holders = new Map<string, number>()
/** Per slug: a debounced let-go (its last holder unmounted). */
const releases = new Map<string, ReturnType<typeof setTimeout>>()
/** Slugs whose stream main dropped while their let-go was pending. */
const lost = new Set<string>()
let watched: string | null = null

function ask(slug: string | null): void {
  watched = slug
  askWatch(slug)
}

function holdWatch(slug: string): void {
  const timer = releases.get(slug)

  if (timer) {
    clearTimeout(timer)
    releases.delete(slug)
  }

  holders.set(slug, (holders.get(slug) ?? 0) + 1)

  // Idempotent in main: the same slug never restarts a running listener. A remount after a stream.stopped/down
  // inside the gap re-asks: a stopped run starts again, a backing-off one is left alone.
  if (lost.delete(slug) || watched !== slug) {
    ask(slug)
  }
}

function letGo(slug: string): void {
  releases.delete(slug)
  lost.delete(slug)
  // The only place a stream is really given up here; a debounced unmount never clears the flag.
  setLive(slug, false)

  if (watched !== slug) {
    // Another slug's watch already replaced ours in main.
    return
  }

  const survivor = [...holders.keys()].at(-1) ?? null

  ask(survivor)
}

function letGoAndDetach(slug: string): void {
  letGo(slug)
  detachIfUnused()
}

function dropWatch(slug: string, now: boolean): void {
  const left = (holders.get(slug) ?? 1) - 1

  if (left > 0) {
    holders.set(slug, left)

    return
  }

  holders.delete(slug)

  if (now) {
    letGo(slug)
  } else if (!releases.has(slug)) {
    releases.set(
      slug,
      setTimeout(() => letGoAndDetach(slug), RELEASE_MS)
    )
  }
}

/**
 * The Market window's subscription: starts the stream for `slug` while the
 * live engine is on and the window is visible, stops it on unmount (after
 * RELEASE_MS), engine off or a long hide. `onChange` is the window's silent re-read.
 */
export function useAcpEvents(slug: string, onChange: () => void, enabled = true): void {
  const liveEngine = useStore($liveEconEnabled)
  const onChangeRef = useRef(onChange)
  const on = enabled && liveEngine && SLUG.test(slug)

  onChangeRef.current = onChange

  useEffect(() => {
    if (!on) {
      return
    }

    const unsubscribe = subscribe(slug, () => onChangeRef.current())
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let watching = false

    const start = () => {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }

      if (!watching) {
        watching = true
        holdWatch(slug)
      }
    }

    const stop = (now: boolean) => {
      if (watching) {
        watching = false
        dropWatch(slug, now)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        start()
      } else if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null
          stop(true)
        }, HIDDEN_STOP_MS)
      }
    }

    if (document.visibilityState === 'visible') {
      start()
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)

      if (hideTimer) {
        clearTimeout(hideTimer)
      }

      stop(false)
      unsubscribe()
    }
  }, [slug, on])
}

/** Test seam: forget every subscription and pending re-read. */
export function resetAcpEventsForTests(): void {
  for (const timer of pending.values()) {
    clearTimeout(timer)
  }

  pending.clear()
  subscribers.clear()
  holders.clear()

  for (const timer of releases.values()) {
    clearTimeout(timer)
  }

  releases.clear()
  lost.clear()
  watched = null

  detach?.()
  detach = null
  $acpStreamLive.set({})
}
