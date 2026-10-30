import { afterEach, describe, expect, it } from 'vitest'

import {
  clearSoulDraft,
  MAX_AGE_MS,
  MAX_DRAFTS,
  parseDraftMap,
  pruneDraftMap,
  readSoulDraft,
  SOUL_DRAFTS_KEY,
  type SoulDraftMap,
  writeSoulDraft
} from './soul-draft'

afterEach(() => globalThis.localStorage.clear())

const NOW = 1_800_000_000_000

const draft = (at: number, text = 't', base = 'b') => ({ at, base, text })

describe('parseDraftMap', () => {
  it('keeps well-formed rows and drops everything else', () => {
    expect(
      parseDraftMap({
        '': draft(NOW),
        bad: { at: NOW, text: 'x' },
        good: draft(NOW, 'hello', 'file'),
        nested: null,
        wrongType: { at: 'soon', base: '', text: '' }
      })
    ).toEqual({ good: { at: NOW, base: 'file', text: 'hello' } })
  })

  it('reads a non-object (or an array) as no drafts at all', () => {
    expect(parseDraftMap(null)).toEqual({})
    expect(parseDraftMap('{}')).toEqual({})
    expect(parseDraftMap([draft(NOW)])).toEqual({})
  })
})

describe('pruneDraftMap', () => {
  it('drops drafts older than the age cap and any dated in the future', () => {
    const map: SoulDraftMap = {
      fresh: draft(NOW - 1000),
      future: draft(NOW + 60_000),
      stale: draft(NOW - MAX_AGE_MS - 1)
    }

    expect(Object.keys(pruneDraftMap(map, NOW)).sort()).toEqual(['fresh'])
  })

  it('keeps the newest MAX_DRAFTS and no more', () => {
    const map: SoulDraftMap = {}

    for (let i = 0; i < MAX_DRAFTS + 5; i += 1) {
      map[`p${i}`] = draft(NOW - i * 1000)
    }

    const kept = pruneDraftMap(map, NOW)

    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS)
    expect(kept.p0).toBeDefined()
    expect(kept[`p${MAX_DRAFTS + 4}`]).toBeUndefined()
  })

  it('keeps a draft exactly on the age boundary', () => {
    expect(pruneDraftMap({ edge: draft(NOW - MAX_AGE_MS) }, NOW).edge).toBeDefined()
  })
})

describe('read/write/clear', () => {
  it('stores what was typed and reads it back', () => {
    writeSoulDraft('work', 'typed', 'saved', NOW)

    expect(readSoulDraft('work', NOW)).toEqual({ at: NOW, base: 'saved', text: 'typed' })
    expect(readSoulDraft('other', NOW)).toBeNull()
  })

  it('removes the draft when the text returns to the saved file', () => {
    writeSoulDraft('work', 'typed', 'saved', NOW)
    writeSoulDraft('work', 'saved', 'saved', NOW)

    expect(readSoulDraft('work', NOW)).toBeNull()
    // Nothing left to store: the key goes rather than holding an empty map.
    expect(globalThis.localStorage.getItem(SOUL_DRAFTS_KEY)).toBeNull()
  })

  it('writing an unchanged text for a profile with no draft stores nothing', () => {
    writeSoulDraft('work', 'saved', 'saved', NOW)

    expect(globalThis.localStorage.getItem(SOUL_DRAFTS_KEY)).toBeNull()
  })

  it('clear removes one profile and leaves the others', () => {
    writeSoulDraft('work', 'a', 'b', NOW)
    writeSoulDraft('play', 'c', 'd', NOW)
    clearSoulDraft('work', NOW)

    expect(readSoulDraft('work', NOW)).toBeNull()
    expect(readSoulDraft('play', NOW)?.text).toBe('c')
  })

  it('clearing an absent profile does not touch the stored map', () => {
    writeSoulDraft('play', 'c', 'd', NOW)
    const before = globalThis.localStorage.getItem(SOUL_DRAFTS_KEY)

    clearSoulDraft('missing', NOW)

    expect(globalThis.localStorage.getItem(SOUL_DRAFTS_KEY)).toBe(before)
  })

  it('a draft typed against an older file is still restored, with its own base', () => {
    writeSoulDraft('work', 'my text', 'old file', NOW)

    // The caller recomputes dirty against the file as it is now; the draft is
    // never dropped just because the file moved under it.
    expect(readSoulDraft('work', NOW)).toEqual({ at: NOW, base: 'old file', text: 'my text' })
  })

  it('malformed stored JSON reads as no drafts instead of throwing', () => {
    globalThis.localStorage.setItem(SOUL_DRAFTS_KEY, '{not json')

    expect(readSoulDraft('work', NOW)).toBeNull()
  })

  it('a stale draft is pruned by the next write, not resurrected', () => {
    writeSoulDraft('old', 'x', 'y', NOW - MAX_AGE_MS - 1)
    writeSoulDraft('new', 'x', 'y', NOW)

    expect(readSoulDraft('old', NOW)).toBeNull()
    expect(readSoulDraft('new', NOW)?.text).toBe('x')
  })
})
