import { describe, expect, it } from 'vitest'

import { enEngine } from '@/i18n/en'

import { announceOnce, bindFallbackSession, freshFallback } from './engine-fallback-banner'

describe('engine fallback banner (U1-p2-04)', () => {
  it('binds a fallback to the conversation on stage when it first arrives, and to none on an empty one', () => {
    let stored: { at: number; sessionId: null | string } | null = null
    const read = () => stored

    const write = (b: { at: number; sessionId: null | string }) => {
      stored = b
    }

    expect(bindFallbackSession(10, 'chat-a', read, write)).toBe('chat-a')
    // The same fallback seen from another conversation stays bound to the first.
    expect(bindFallbackSession(10, 'chat-b', read, write)).toBe('chat-a')
    expect(bindFallbackSession(10, null, read, write)).toBe('chat-a')
    // A new fallback arriving on a brand-new empty conversation binds to nobody.
    expect(bindFallbackSession(11, null, read, write)).toBeNull()
  })

  it('is fresh only once per fallback', () => {
    expect(freshFallback({ at: 100, reason: 'x', text: 'y' }, 0, 200)).not.toBeNull()
    expect(freshFallback({ at: 100, reason: 'x', text: 'y' }, 100, 200)).toBeNull()
  })

  it('K54: announced once per conversation and reason, never after every answer', () => {
    let announced: readonly string[] = []
    const shown: boolean[] = []

    // Nous not signed in: every Claude Code turn in chat-a falls back for the same reason.
    for (const [session, reason] of [
      ['chat-a', 'binary_missing'],
      ['chat-a', 'binary_missing'],
      ['chat-a', 'binary_missing'],
      ['chat-a', 'rate_limited'],
      ['chat-a', 'binary_missing'],
      ['chat-b', 'binary_missing']
    ] as const) {
      const next = announceOnce(session, reason, announced)

      shown.push(next !== null)
      announced = next ?? announced
    }

    expect(shown).toEqual([true, false, false, true, false, true])
  })

  it('K54: the announced list stays bounded and keeps the newest', () => {
    let announced: readonly string[] = []

    for (let i = 0; i < 60; i += 1) {
      announced = announceOnce(`chat-${i}`, 'r', announced) ?? announced
    }

    expect(announced).toHaveLength(50)
    expect(announced.at(-1)).toBe('chat-59|r')
    expect(announceOnce('chat-59', 'r', announced)).toBeNull()
  })

  it('speaks in plain words: no engine internals, one "Why?" door', () => {
    expect(enEngine.fallback).toBe('Your agent answered with a different provider this time.')
    expect(enEngine.fallback).not.toMatch(/Claude Code|logged in/)
    expect(enEngine.fix).toBe('Why?')
  })
})
