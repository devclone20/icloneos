/**
 * EconomyOS prefs — owner-facing definitions in Settings → iNFT. Persisted
 * beside the atoms (local storage) so they survive relaunch. The storage keys
 * predate this file and are kept so nobody's setting resets.
 */
import { atom } from 'nanostores'

import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../lib/storage-keys'

const ENABLED_KEY = ICLONE_STORAGE.economyLiveEnabled.key
const INTERVAL_KEY = ICLONE_STORAGE.economyLiveIntervalSecs.key

export const LIVE_INTERVAL_MIN = 15
export const LIVE_INTERVAL_MAX = 600
const LIVE_INTERVAL_DEFAULT = 60

/** Absent, unreadable and malformed values all read as `fallback`. */
function readStored<T>(key: string, fallback: T): T {
  return readJson<T>(key) ?? fallback
}

/** A corrupted value must never reach `setInterval` — `NaN` there fires
 *  back-to-back and would spawn a CLI process per tick. */
function clampInterval(value: unknown): number {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? value : LIVE_INTERVAL_DEFAULT

  return Math.min(LIVE_INTERVAL_MAX, Math.max(LIVE_INTERVAL_MIN, Math.round(seconds)))
}

export const $liveEconEnabled = atom<boolean>(readStored<unknown>(ENABLED_KEY, true) !== false)
export const $liveEconIntervalSecs = atom<number>(
  clampInterval(readStored<unknown>(INTERVAL_KEY, LIVE_INTERVAL_DEFAULT))
)

// Persistence is convenience only: writeJson is best-effort.
$liveEconEnabled.subscribe(value => writeJson(ENABLED_KEY, value))

$liveEconIntervalSecs.subscribe(value => writeJson(INTERVAL_KEY, value))

export function setLiveEconEnabled(value: boolean): void {
  $liveEconEnabled.set(value)
}

export function setLiveEconIntervalSecs(value: number): void {
  $liveEconIntervalSecs.set(clampInterval(value))
}
