/**
 * Messaging setup drafts — a reload must not cost the user what they typed.
 *
 * The page it replaces kept every env-var edit in React state, so a reload, a
 * crash or an app update threw away a half-filled platform form. Every
 * keystroke now also lands in one stored map, keyed by platform, and the form
 * reads it back before it paints. Same shape and same pruning as
 * `app/profiles/soul-draft.ts`: a row older than MAX_AGE_MS or beyond
 * MAX_DRAFTS is dropped newest-first, saving clears the platform's row, and an
 * emptied form removes it rather than storing nothing.
 *
 * SECRETS ARE NEVER STORED. A bot token, password or API key typed into a
 * password field stays in React state only: this map is plain JSON on disk, so
 * persisting a credential there would trade a lost keystroke for a leaked key.
 * `writeEnvDraft` is given the set of secret keys and drops them, and
 * `secretKeysDropped` tells the page which ones it is NOT keeping — so the UI
 * can be honest instead of silently losing one field out of four.
 *
 * A form where ONLY the secret was typed used to leave no row at all, so the
 * commonest first action on a platform (paste the bot token, then reload) lost
 * it with no word said (critic r4, E3d2-M3). Such a row is now kept as a
 * marker: `fields` empty and `droppedSecrets` holding the dropped secrets' KEY
 * NAMES — a key name is public platform schema, not a credential, so no secret
 * VALUE still reaches disk. The marker ages out and counts against MAX_DRAFTS
 * like any other row, and it restores a slot, never an empty field map.
 *
 * Storage key: `ICLONE_STORAGE.messagingEnvDrafts` — the key string itself is
 * declared once, in `src/app/home/lib/storage-keys.ts`, the one registry.
 */
import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../home/lib/storage-keys'

export const ENV_DRAFTS_KEY = ICLONE_STORAGE.messagingEnvDrafts.key

/** Beyond this, an untouched draft is clutter, not work in progress. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DRAFTS = 24

interface EnvDraft {
  /** Epoch ms of the last keystroke. */
  at: number
  /** KEY NAMES (never values) of the secrets this row refused to keep. */
  droppedSecrets?: string[]
  /** Non-secret env values only — see the module docstring. */
  fields: Record<string, string>
}

export type EnvDraftMap = Record<string, EnvDraft>

function isDraft(value: unknown): value is EnvDraft {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const row = value as Record<string, unknown>

  if (typeof row.at !== 'number' || typeof row.fields !== 'object' || row.fields === null) {
    return false
  }

  if (
    row.droppedSecrets !== undefined &&
    (!Array.isArray(row.droppedSecrets) || row.droppedSecrets.some(entry => typeof entry !== 'string'))
  ) {
    return false
  }

  return Object.values(row.fields as Record<string, unknown>).every(entry => typeof entry === 'string')
}

/** Keeps only well-formed rows — stored JSON is user data, never a contract. */
export function parseEnvDraftMap(raw: unknown): EnvDraftMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }

  const out: EnvDraftMap = {}

  for (const [platform, value] of Object.entries(raw as Record<string, unknown>)) {
    if (platform !== '' && isDraft(value)) {
      const dropped = value.droppedSecrets?.filter(key => key !== '') ?? []

      out[platform] =
        dropped.length > 0
          ? { at: value.at, droppedSecrets: [...dropped], fields: { ...value.fields } }
          : { at: value.at, fields: { ...value.fields } }
    }
  }

  return out
}

/** Drops stale drafts, then the oldest ones over the cap. Pure. */
export function pruneEnvDraftMap(map: EnvDraftMap, nowMs: number): EnvDraftMap {
  const fresh = Object.entries(map).filter(([, draft]) => nowMs - draft.at <= MAX_AGE_MS && draft.at <= nowMs)
  const kept = fresh.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DRAFTS)

  return Object.fromEntries(kept)
}

/** The values worth keeping: non-empty, non-secret. Pure. */
export function persistableFields(fields: Record<string, string>, secretKeys: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== '' && !secretKeys.has(key)))
}

/** The secret keys this map refuses to keep, so the page can say so. Pure. */
export function secretKeysDropped(fields: Record<string, string>, secretKeys: Set<string>): string[] {
  return Object.keys(fields)
    .filter(key => secretKeys.has(key) && fields[key] !== '')
    .sort()
}

function loadMap(nowMs: number): EnvDraftMap {
  return pruneEnvDraftMap(parseEnvDraftMap(readJson<unknown>(ENV_DRAFTS_KEY)), nowMs)
}

function saveMap(map: EnvDraftMap) {
  if (Object.keys(map).length === 0) {
    writeJson(ENV_DRAFTS_KEY, null)

    return
  }

  writeJson(ENV_DRAFTS_KEY, map)
}

/**
 * What came back, read once: the restorable VALUES (never an empty field map —
 * an empty one would put `{}` in the form's state and read as typed work) and
 * every slot that has a row, marker rows included, which is what tells the page
 * a draft was restored at all.
 */
export function readEnvDraftSnapshot(nowMs: number = Date.now()): {
  edits: Record<string, Record<string, string>>
  slots: string[]
} {
  const map = loadMap(nowMs)

  return {
    edits: Object.fromEntries(
      Object.entries(map)
        .filter(([, draft]) => Object.keys(draft.fields).length > 0)
        .map(([platform, draft]) => [platform, draft.fields])
    ),
    slots: Object.keys(map)
  }
}

/** Every platform's restorable edits, or {} when there is nothing to restore. */
export function readEnvDrafts(nowMs: number = Date.now()): Record<string, Record<string, string>> {
  return readEnvDraftSnapshot(nowMs).edits
}

/**
 * Records what the user has typed for one platform. A form with nothing typed
 * removes the row; a form where only secrets were typed keeps a marker row (no
 * values, just the dropped keys' names) so the page can say what was lost.
 */
export function writeEnvDraft(
  platform: string,
  fields: Record<string, string>,
  secretKeys: Set<string>,
  nowMs: number = Date.now()
) {
  const map = loadMap(nowMs)
  const keep = persistableFields(fields, secretKeys)
  const dropped = secretKeysDropped(fields, secretKeys)

  if (Object.keys(keep).length === 0 && dropped.length === 0) {
    if (!(platform in map)) {
      return
    }

    delete map[platform]
  } else {
    map[platform] =
      dropped.length > 0 ? { at: nowMs, droppedSecrets: dropped, fields: keep } : { at: nowMs, fields: keep }
  }

  saveMap(pruneEnvDraftMap(map, nowMs))
}

/** Called when the platform's setup is saved: the draft has become config. */
export function clearEnvDraft(platform: string, nowMs: number = Date.now()) {
  const map = loadMap(nowMs)

  if (!(platform in map)) {
    return
  }

  delete map[platform]
  saveMap(map)
}

/**
 * Drafts are per (scope, platform): a draft typed for one profile's gateway
 * must never be restored into another's form, which is what a bare platform id
 * would do the moment the "Applies to" scope changes.
 */
export const draftKey = (scopeProfile: null | string | undefined, platformId: string) =>
  `${scopeProfile ?? ''}:${platformId}`
