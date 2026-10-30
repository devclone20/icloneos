/**
 * EconomyOS — the last answer, kept on disk, so a window paints at once.
 *
 * Every dock app needs three to five CLI answers before it has anything to
 * show, and the calls for one iNFT run one after another: three to five
 * seconds of skeleton on every open. The remedy is the mail client's oldest
 * trick — show what you knew last time, refresh behind it. An app writes its
 * shaped state here after each successful load and reads it back on mount,
 * before the first CLI answer; the header's "updated … ago" says how old it is.
 *
 * Storage is local storage under one key per (iNFT, app), with a schema
 * version so a shape change never hydrates stale data, and a size cap so a
 * runaway list cannot exhaust the quota. Nothing secret is ever put here:
 * addresses, balances, subjects and previews — never card numbers, never
 * message bodies beyond what the list already shows.
 */
import { useEffect, useRef } from 'react'

import { readJson, readKey, writeKey } from '@/lib/storage'

import { ICLONE_STORAGE } from '../lib/storage-keys'
import { storageKeysWithPrefix } from '../lib/storage-scan'

import type { EconKind } from './types'

const PREFIX = ICLONE_STORAGE.econSnapshot.key
/** Above this an app's snapshot is not written — the quota is shared. */
export const SNAPSHOT_MAX_BYTES = 400 * 1024

export interface Snapshot<T> {
  data: T
  /** Epoch ms of the load this snapshot came from. */
  at: number
}

function keyFor(kind: EconKind, slug: string): string {
  return `${PREFIX}${slug}.${kind}`
}

/** The last persisted state for this iNFT's app, or null when there is none,
 *  it is from another schema version, or storage is unavailable. */
export function readSnapshot<T>(kind: EconKind, slug: string, version: number): Snapshot<T> | null {
  const parsed = readJson<{ v?: unknown; at?: unknown; data?: unknown }>(keyFor(kind, slug))

  if (!parsed || parsed.v !== version || typeof parsed.at !== 'number' || parsed.data === undefined) {
    return null
  }

  return { data: parsed.data as T, at: parsed.at }
}

/** Persist the state. Silent on quota: a snapshot is a convenience, and when
 *  the store is full the oldest snapshots make room once before giving up. */
export function writeSnapshot<T>(kind: EconKind, slug: string, version: number, data: T, at: number): void {
  let serialised: string

  try {
    serialised = JSON.stringify({ v: version, at, data })
  } catch {
    return
  }

  if (serialised.length > SNAPSHOT_MAX_BYTES) {
    return
  }

  const key = keyFor(kind, slug)

  // writeKey swallows quota errors, so a failed write shows as a read-back
  // that differs. Out of room even after eviction: the live data still renders.
  writeKey(key, serialised)

  if (readKey(key) !== serialised) {
    evictSnapshots(key)
    writeKey(key, serialised)
  }
}

export function clearSnapshot(kind: EconKind, slug: string): void {
  writeKey(keyFor(kind, slug), null)
}

/** Drop every econ snapshot except `keep` — the quota-full path. */
function evictSnapshots(keep: string): void {
  storageKeysWithPrefix(PREFIX)
    .filter(key => key !== keep)
    .forEach(key => writeKey(key, null))
}

/**
 * The hook an app uses. On mount (and when the iNFT changes) it hands the
 * app its last snapshot through `hydrate` — the app sets its state from it
 * and renders immediately. `persist(state, at)` is what the app calls after
 * a successful load; it is stable, so it can sit in effect deps.
 *
 * `version` is the app's own schema number: bump it whenever the persisted
 * shape changes, and old snapshots are ignored instead of misread.
 */
export function useSnapshot<T>(
  kind: EconKind,
  slug: string,
  version: number,
  hydrate: (snapshot: Snapshot<T>) => void
): { persist: (data: T, at?: number) => void; clear: () => void } {
  // Read at fire time: the hydrate callback closes over the app's setters,
  // which are stable, but the app may pass a fresh arrow each render.
  const hydrateRef = useRef(hydrate)

  hydrateRef.current = hydrate

  useEffect(() => {
    const snapshot = readSnapshot<T>(kind, slug, version)

    if (snapshot) {
      hydrateRef.current(snapshot)
    }
  }, [kind, slug, version])

  const persistRef = useRef({
    persist: (data: T, at?: number) => writeSnapshot(kind, slug, version, data, at ?? Date.now()),
    clear: () => clearSnapshot(kind, slug)
  })

  // Rebind only when the identity changes — the app keeps one stable object.
  const boundTo = useRef(`${kind}|${slug}|${version}`)

  if (boundTo.current !== `${kind}|${slug}|${version}`) {
    boundTo.current = `${kind}|${slug}|${version}`
    persistRef.current = {
      persist: (data: T, at?: number) => writeSnapshot(kind, slug, version, data, at ?? Date.now()),
      clear: () => clearSnapshot(kind, slug)
    }
  }

  return persistRef.current
}
