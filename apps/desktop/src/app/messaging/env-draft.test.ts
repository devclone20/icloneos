import { afterEach, describe, expect, it } from 'vitest'

import {
  clearEnvDraft,
  draftKey,
  ENV_DRAFTS_KEY,
  type EnvDraftMap,
  MAX_AGE_MS,
  MAX_DRAFTS,
  parseEnvDraftMap,
  persistableFields,
  pruneEnvDraftMap,
  readEnvDrafts,
  readEnvDraftSnapshot,
  secretKeysDropped,
  writeEnvDraft
} from './env-draft'

afterEach(() => globalThis.localStorage.clear())

const NOW = 1_800_000_000_000

const SECRETS = new Set(['TELEGRAM_BOT_TOKEN'])

const stored = () => JSON.parse(globalThis.localStorage.getItem(ENV_DRAFTS_KEY) ?? 'null')

describe('parseEnvDraftMap', () => {
  it('keeps well-formed rows and drops everything else', () => {
    const parsed = parseEnvDraftMap({
      telegram: { at: NOW, fields: { TELEGRAM_USER_ID: '42' } },
      '': { at: NOW, fields: {} },
      noAt: { fields: {} },
      noFields: { at: NOW },
      numberField: { at: NOW, fields: { X: 7 } },
      nested: { at: NOW, fields: { X: { y: 1 } } },
      marker: { at: NOW, droppedSecrets: ['TELEGRAM_BOT_TOKEN'], fields: {} },
      droppedNotArray: { at: NOW, droppedSecrets: 'TELEGRAM_BOT_TOKEN', fields: {} },
      droppedNotStrings: { at: NOW, droppedSecrets: [7], fields: {} }
    })

    expect(Object.keys(parsed)).toEqual(['telegram', 'marker'])
    expect(parsed.telegram.fields).toEqual({ TELEGRAM_USER_ID: '42' })
    expect(parsed.marker.droppedSecrets).toEqual(['TELEGRAM_BOT_TOKEN'])
  })

  it('reads a malformed store as nothing to restore', () => {
    expect(parseEnvDraftMap(null)).toEqual({})
    expect(parseEnvDraftMap('{')).toEqual({})
    expect(parseEnvDraftMap([1, 2])).toEqual({})
  })

  it('copies the fields instead of aliasing the stored object', () => {
    const source = { telegram: { at: NOW, fields: { A: '1' } } }
    const parsed = parseEnvDraftMap(source)

    parsed.telegram.fields.A = 'mutated'
    expect(source.telegram.fields.A).toBe('1')
  })
})

describe('pruneEnvDraftMap', () => {
  it('drops rows older than the age cap and rows dated in the future', () => {
    const map: EnvDraftMap = {
      fresh: { at: NOW - 1000, fields: { A: '1' } },
      stale: { at: NOW - MAX_AGE_MS - 1, fields: { A: '1' } },
      ahead: { at: NOW + 60_000, fields: { A: '1' } }
    }

    expect(Object.keys(pruneEnvDraftMap(map, NOW))).toEqual(['fresh'])
  })

  it('keeps the newest rows up to the cap', () => {
    const map: EnvDraftMap = {}

    for (let i = 0; i < MAX_DRAFTS + 6; i++) {
      map[`p${i}`] = { at: NOW - i * 1000, fields: { A: String(i) } }
    }

    const kept = Object.keys(pruneEnvDraftMap(map, NOW))

    expect(kept).toHaveLength(MAX_DRAFTS)
    expect(kept[0]).toBe('p0')
    expect(kept).not.toContain(`p${MAX_DRAFTS + 5}`)
  })
})

describe('secrets never reach the disk', () => {
  it('persistableFields drops secret keys and empty values', () => {
    expect(persistableFields({ TELEGRAM_BOT_TOKEN: 'abc123', TELEGRAM_USER_ID: '42', OTHER: '' }, SECRETS)).toEqual({
      TELEGRAM_USER_ID: '42'
    })
  })

  it('secretKeysDropped names what is deliberately not kept', () => {
    expect(secretKeysDropped({ TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_USER_ID: '42' }, SECRETS)).toEqual([
      'TELEGRAM_BOT_TOKEN'
    ])
    expect(secretKeysDropped({ TELEGRAM_BOT_TOKEN: '' }, SECRETS)).toEqual([])
  })

  it('a token typed into the form is nowhere in the store — its key name is', () => {
    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: 'super-secret-token', TELEGRAM_USER_ID: '42' }, SECRETS, NOW)

    const raw = globalThis.localStorage.getItem(ENV_DRAFTS_KEY) ?? ''

    expect(raw).not.toContain('super-secret-token')
    // The KEY NAME is public platform schema, not a credential, and is kept on
    // purpose so the page can name the field it did not keep (critic r4, M3).
    expect(stored().telegram.droppedSecrets).toEqual(['TELEGRAM_BOT_TOKEN'])
    expect(readEnvDrafts(NOW)).toEqual({ telegram: { TELEGRAM_USER_ID: '42' } })
  })

  it('no secret VALUE is anywhere in the persisted draft, field or marker', () => {
    const secret = 'super-secret-token'

    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: secret, TELEGRAM_USER_ID: '42' }, SECRETS, NOW)
    writeEnvDraft('discord', { TELEGRAM_BOT_TOKEN: secret }, SECRETS, NOW)

    const rows: EnvDraftMap = stored()
    const texts = Object.values(rows).flatMap(row => [...Object.values(row.fields), ...(row.droppedSecrets ?? [])])

    expect(globalThis.localStorage.getItem(ENV_DRAFTS_KEY) ?? '').not.toContain(secret)
    expect(texts.filter(text => text.includes(secret))).toEqual([])
    expect(texts).toContain('TELEGRAM_BOT_TOKEN')
  })

  it('a form holding only a secret keeps the slot by name, never the value', () => {
    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: 'abc' }, SECRETS, NOW)

    expect(stored()).toEqual({ telegram: { at: NOW, droppedSecrets: ['TELEGRAM_BOT_TOKEN'], fields: {} } })
    // Nothing to restore INTO the form: an empty field map would read as work
    // the user typed. The SLOT, though, did come back — that is the notice.
    expect(readEnvDrafts(NOW)).toEqual({})
    expect(readEnvDraftSnapshot(NOW).slots).toEqual(['telegram'])
  })

  it('a marker row ages out and counts against the cap like any other', () => {
    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: 'abc' }, SECRETS, NOW - MAX_AGE_MS - 1)

    expect(readEnvDraftSnapshot(NOW).slots).toEqual([])

    for (let index = 0; index <= MAX_DRAFTS; index++) {
      writeEnvDraft(`p${index}`, { TELEGRAM_BOT_TOKEN: 'abc' }, SECRETS, NOW + index)
    }

    expect(readEnvDraftSnapshot(NOW + MAX_DRAFTS).slots).toHaveLength(MAX_DRAFTS)
  })

  it('emptying a secret-only form removes the marker as well', () => {
    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: 'abc' }, SECRETS, NOW)
    writeEnvDraft('telegram', { TELEGRAM_BOT_TOKEN: '' }, SECRETS, NOW)

    expect(stored()).toBeNull()
  })
})

describe('writeEnvDraft / readEnvDrafts / clearEnvDraft', () => {
  it('round-trips what the user typed', () => {
    writeEnvDraft('telegram', { TELEGRAM_USER_ID: '42' }, SECRETS, NOW)

    expect(readEnvDrafts(NOW)).toEqual({ telegram: { TELEGRAM_USER_ID: '42' } })
  })

  it('emptying the form removes the row instead of storing nothing', () => {
    writeEnvDraft('telegram', { TELEGRAM_USER_ID: '42' }, SECRETS, NOW)
    writeEnvDraft('telegram', { TELEGRAM_USER_ID: '' }, SECRETS, NOW)

    expect(stored()).toBeNull()
  })

  it('a save clears only that platform', () => {
    writeEnvDraft('telegram', { A: '1' }, SECRETS, NOW)
    writeEnvDraft('discord', { B: '2' }, SECRETS, NOW)

    clearEnvDraft('telegram', NOW)

    expect(readEnvDrafts(NOW)).toEqual({ discord: { B: '2' } })
  })

  it('clearing a platform that has no draft touches nothing', () => {
    writeEnvDraft('discord', { B: '2' }, SECRETS, NOW)
    clearEnvDraft('telegram', NOW)

    expect(readEnvDrafts(NOW)).toEqual({ discord: { B: '2' } })
  })

  it('a draft older than the age cap is not restored', () => {
    writeEnvDraft('telegram', { A: '1' }, SECRETS, NOW - MAX_AGE_MS - 1)

    expect(readEnvDrafts(NOW)).toEqual({})
  })
})

describe('draftKey', () => {
  it('separates the same platform across scopes, so a draft never crosses profiles', () => {
    expect(draftKey('work', 'telegram')).not.toBe(draftKey('home', 'telegram'))
    expect(draftKey(null, 'telegram')).toBe(draftKey(undefined, 'telegram'))

    writeEnvDraft(draftKey('work', 'telegram'), { A: 'work' }, SECRETS, NOW)
    writeEnvDraft(draftKey('home', 'telegram'), { A: 'home' }, SECRETS, NOW)

    expect(readEnvDrafts(NOW)[draftKey('work', 'telegram')]).toEqual({ A: 'work' })
    expect(readEnvDrafts(NOW)[draftKey('home', 'telegram')]).toEqual({ A: 'home' })
  })
})
