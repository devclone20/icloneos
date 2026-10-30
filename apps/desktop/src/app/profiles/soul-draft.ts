/**
 * SOUL.md drafts — a reload must not cost the user what they typed.
 *
 * The editor keeps the text in React state, which a reload (or a crash, or an
 * app update) throws away. Every keystroke therefore also lands in one stored
 * map, and the editor reads it back before it shows the file. The map is
 * pruned, never grown: a draft identical to the saved file is removed, saving
 * clears it, and a draft older than MAX_AGE_MS or beyond MAX_DRAFTS is dropped
 * newest-first, so an abandoned draft cannot become permanent clutter.
 *
 * `base` is the file content the draft was taken from. It is kept so a reader
 * can tell a draft typed against today's file from one typed against a version
 * that has since changed on disk; the draft is restored either way — losing
 * typed text is never the safer choice — and the dirty flag is recomputed
 * against the file as it is NOW.
 *
 * Storage key: `ICLONE_STORAGE.profilesSoulDrafts` — the key string itself is
 * declared once, in `src/app/home/lib/storage-keys.ts`, the one registry.
 */
import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../home/lib/storage-keys'

export const SOUL_DRAFTS_KEY = ICLONE_STORAGE.profilesSoulDrafts.key

/** Beyond this, an untouched draft is clutter, not work in progress. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DRAFTS = 24

interface SoulDraft {
  /** The saved content this draft was typed against. */
  base: string
  /** Epoch ms of the last keystroke. */
  at: number
  text: string
}

export type SoulDraftMap = Record<string, SoulDraft>

function isDraft(value: unknown): value is SoulDraft {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const row = value as Record<string, unknown>

  return typeof row.text === 'string' && typeof row.base === 'string' && typeof row.at === 'number'
}

/** Keeps only well-formed rows — stored JSON is user data, never a contract. */
export function parseDraftMap(raw: unknown): SoulDraftMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }

  const out: SoulDraftMap = {}

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name !== '' && isDraft(value)) {
      out[name] = { at: value.at, base: value.base, text: value.text }
    }
  }

  return out
}

/** Drops stale drafts, then the oldest ones over the cap. Pure. */
export function pruneDraftMap(map: SoulDraftMap, nowMs: number): SoulDraftMap {
  const fresh = Object.entries(map).filter(([, draft]) => nowMs - draft.at <= MAX_AGE_MS && draft.at <= nowMs)
  const kept = fresh.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DRAFTS)

  return Object.fromEntries(kept)
}

function loadMap(nowMs: number): SoulDraftMap {
  return pruneDraftMap(parseDraftMap(readJson<unknown>(SOUL_DRAFTS_KEY)), nowMs)
}

function saveMap(map: SoulDraftMap) {
  if (Object.keys(map).length === 0) {
    writeJson(SOUL_DRAFTS_KEY, null)

    return
  }

  writeJson(SOUL_DRAFTS_KEY, map)
}

/** The stored draft for one profile, or null when there is nothing to restore. */
export function readSoulDraft(profile: string, nowMs: number = Date.now()): null | SoulDraft {
  return loadMap(nowMs)[profile] ?? null
}

/**
 * Records what the user has typed. Text equal to `base` means the user is back
 * at the saved file, so the draft is removed rather than stored empty-handed.
 */
export function writeSoulDraft(profile: string, text: string, base: string, nowMs: number = Date.now()) {
  const map = loadMap(nowMs)

  if (text === base) {
    if (!(profile in map)) {
      return
    }

    delete map[profile]
  } else {
    map[profile] = { at: nowMs, base, text }
  }

  saveMap(pruneDraftMap(map, nowMs))
}

/** Called when the file is saved: the draft has become the file. */
export function clearSoulDraft(profile: string, nowMs: number = Date.now()) {
  const map = loadMap(nowMs)

  if (!(profile in map)) {
    return
  }

  delete map[profile]
  saveMap(map)
}
