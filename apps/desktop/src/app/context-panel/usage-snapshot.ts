import { atom } from 'nanostores'

import type { UsageStats } from '@/types/hermes'

/**
 * The last usage a stored session reported, by stored id. A restored session
 * has no live runtime until the agent runs, so without this the context door
 * reads "—" over a thread that already has messages (U2-p2-08). Renderer-side
 * and in localStorage: the stored session record does not carry usage.
 */
const KEY = 'iclone.context.usage'
const MAX_ENTRIES = 200

type Snapshots = Record<string, UsageStats>

function load(): Snapshots {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Snapshots) : {}
  } catch {
    return {}
  }
}

export const $usageSnapshots = atom<Snapshots>(load())

export function rememberUsage(storedId: string, usage: UsageStats): void {
  const prev = $usageSnapshots.get()

  if (prev[storedId] === usage) {
    return
  }

  const next: Snapshots = { ...prev, [storedId]: usage }
  const keys = Object.keys(next)

  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
    delete next[stale]
  }

  $usageSnapshots.set(next)

  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: the in-memory atom still serves this run.
  }
}

export function usageSnapshotFor(storedId: null | string): null | UsageStats {
  return storedId ? ($usageSnapshots.get()[storedId] ?? null) : null
}
