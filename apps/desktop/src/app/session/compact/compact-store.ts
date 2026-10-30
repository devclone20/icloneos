import { atom } from 'nanostores'

import type { CompactOutcome } from './compact-outcome'

/** `pending` = a surface (button) claimed the session and is routing the
 *  request through `/compress`; `running` = the `session.compress` RPC is in
 *  flight; `done` = the last outcome, kept so every surface shows it. */
export type CompactPhase = 'done' | 'pending' | 'running'

export interface CompactEntry {
  outcome: CompactOutcome | null
  phase: CompactPhase
  /** Latest runtime progress line (`status.update` kind compressing/compacting), verbatim. */
  progress: null | string
  progressAt: null | number
  startedAt: number
}

/** Per runtime session id — a tile and the primary chat compact independently. */
export const $compactions = atom<Record<string, CompactEntry>>({})

function write(sessionId: string, entry: CompactEntry | null): void {
  const next = { ...$compactions.get() }

  if (entry) {
    next[sessionId] = entry
  } else {
    delete next[sessionId]
  }

  $compactions.set(next)
}

export function compactionEntry(sessionId: null | string | undefined): CompactEntry | null {
  return sessionId ? ($compactions.get()[sessionId] ?? null) : null
}

function isCompactionActive(sessionId: null | string | undefined): boolean {
  const phase = compactionEntry(sessionId)?.phase

  return phase === 'pending' || phase === 'running'
}

/** Synchronous claim from a UI surface, so a double click can never send two
 *  requests. False when the session is already pending or running. */
export function claimCompaction(sessionId: string, now = Date.now()): boolean {
  if (isCompactionActive(sessionId)) {
    return false
  }

  write(sessionId, { outcome: null, phase: 'pending', progress: null, progressAt: null, startedAt: now })

  return true
}

/** The engine's entry: a pending claim becomes running; an already running
 *  compaction makes this call a no-op (coalesced). */
export function startCompaction(sessionId: string, now = Date.now()): boolean {
  const current = compactionEntry(sessionId)

  if (current?.phase === 'running') {
    return false
  }

  write(sessionId, {
    outcome: null,
    phase: 'running',
    progress: null,
    progressAt: null,
    startedAt: current?.phase === 'pending' ? current.startedAt : now
  })

  return true
}

export function setCompactionProgress(sessionId: string, text: string, now = Date.now()): void {
  const current = compactionEntry(sessionId)

  if (current?.phase !== 'running') {
    return
  }

  write(sessionId, { ...current, progress: text, progressAt: now })
}

/** Record the outcome under every id the run touched (the invocation id and,
 *  after a stale-id resume, the live one). */
export function finishCompaction(sessionIds: readonly string[], outcome: CompactOutcome): void {
  const next = { ...$compactions.get() }

  for (const id of new Set(sessionIds)) {
    const startedAt = next[id]?.startedAt ?? Date.now()
    next[id] = { outcome, phase: 'done', progress: null, progressAt: null, startedAt }
  }

  $compactions.set(next)
}

/** A claim the engine never picked up (no session could be resolved) must
 *  still end in a visible outcome, never a stuck spinner. */
export function settleUnclaimedCompaction(sessionId: string, outcome: CompactOutcome): void {
  if (compactionEntry(sessionId)?.phase === 'pending') {
    finishCompaction([sessionId], outcome)
  }
}
