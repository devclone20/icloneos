/**
 * Our own per-release update log (userData/app-update-log.json): one row per restart that began
 * an install, settled when the install fails while the app still runs, or on the next launch. The only update history the app shows; it starts empty.
 */

import path from 'node:path'

import type { AppUpdateLogEntry, AppUpdateLogResult } from './app-update-ipc'
import { readJsonFileSync, writeJsonAtomicSync } from './lib/fs-json'

const APP_UPDATE_LOG_FILE = 'app-update-log.json'
export const APP_UPDATE_LOG_CAP = 50
const LOG_MAX_BYTES = 256 * 1024
const RESULTS: readonly AppUpdateLogResult[] = ['failed', 'installed', 'installing']

interface AppUpdateLogFile {
  entries: AppUpdateLogEntry[]
  v: 1
}

function isEntry(value: unknown): value is AppUpdateLogEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    typeof row.from === 'string' &&
    typeof row.to === 'string' &&
    typeof row.at === 'number' &&
    Number.isFinite(row.at) &&
    RESULTS.includes(row.result as AppUpdateLogResult) &&
    (row.error === undefined || typeof row.error === 'string')
  )
}

export function appUpdateLogPath(userData: string): string {
  return path.join(userData, APP_UPDATE_LOG_FILE)
}

/** Oldest first, as written; malformed rows are dropped. */
export function readAppUpdateLog(userData: string): AppUpdateLogEntry[] {
  const file = readJsonFileSync<Partial<AppUpdateLogFile>>(appUpdateLogPath(userData), { maxBytes: LOG_MAX_BYTES })

  return Array.isArray(file?.entries) ? file.entries.filter(isEntry) : []
}

function writeLog(userData: string, entries: AppUpdateLogEntry[]): void {
  const file: AppUpdateLogFile = { entries: entries.slice(-APP_UPDATE_LOG_CAP), v: 1 }
  writeJsonAtomicSync(appUpdateLogPath(userData), file, { mode: 0o600 })
}

/**
 * A new row, or the settlement of the pending one: a `failed` row for the release that is still
 * `installing` (Squirrel refused it while the app ran on) replaces that row, keeping one row per restart.
 */
export function appendAppUpdateLog(userData: string, entry: AppUpdateLogEntry): void {
  const entries = readAppUpdateLog(userData)
  const last = entries.at(-1)

  const settles =
    entry.result !== 'installing' && last?.result === 'installing' && last.from === entry.from && last.to === entry.to

  writeLog(userData, settles ? [...entries.slice(0, -1), { ...entry, at: last.at }] : [...entries, entry])
}

/**
 * The launch after a restart-to-update: the `installing` row becomes `installed` when this app
 * runs the version it was installing, `failed` otherwise. A `failed` row whose release is running
 * now installed after all (Squirrel finished after the watchdog gave up). Returns the settled row, or null.
 */
export function settleAppUpdateLog(userData: string, runningVersion: string): AppUpdateLogEntry | null {
  const entries = readAppUpdateLog(userData)
  const last = entries.at(-1)
  const lateInstall = last?.result === 'failed' && last.to === runningVersion && last.from !== runningVersion

  if (!last || (last.result !== 'installing' && !lateInstall)) {
    return null
  }

  const settled: AppUpdateLogEntry =
    last.to === runningVersion
      ? { at: last.at, from: last.from, result: 'installed', to: last.to }
      : { at: last.at, error: `still running ${runningVersion}`, from: last.from, result: 'failed', to: last.to }

  writeLog(userData, [...entries.slice(0, -1), settled])

  return settled
}
