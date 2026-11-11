import { describe, expect, it } from 'vitest'

import {
  hasHiddenCharacters,
  ONE_SHOT_MAX_TEXT,
  oneShotReadable,
  rawOf,
  visibleSegments,
  visibleText
} from './one-shot-text'

const HIDDEN = [
  0x00, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x7f, 0x85, 0xa0, 0xad, 0x115f, 0x1160, 0x180e, 0x2000, 0x2003, 0x200b, 0x200c,
  0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x202f, 0x205f, 0x2060, 0x2066, 0x2069, 0x2800, 0x3000, 0x3164,
  0xfe0f, 0xfeff, 0xffa0, 0xe0041, 0xe0100, 0xe000, 0xd800,
  // Format characters that are not default-ignorable, so only the format class catches them.
  0x0600, 0x06dd, 0x070f, 0xfff9
]

const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, '0')

describe('what a human cannot read', () => {
  it.each(HIDDEN.map(code => [hex(code), code] as const))('U+%s is hidden, and shown by its number', (_name, code) => {
    const text = `a${String.fromCodePoint(code)}b`

    expect(hasHiddenCharacters(text)).toBe(true)
    expect(visibleText(text)).toBe(`a⟦U+${hex(code)}⟧b`)
    expect(rawOf(visibleSegments(text))).toBe(text)
    expect(oneShotReadable(text)).toBe(false)
  })

  it('a plain space, newline, tab and any letter are not', () => {
    for (const text of ['npm test', 'a\nb', 'a\tb', 'é ç ã 日本語', "echo 'x' | sort"]) {
      expect(hasHiddenCharacters(text)).toBe(false)
      expect(oneShotReadable(text)).toBe(true)
    }
  })

  it('an empty text and a text past the limit are not one a human read', () => {
    expect(oneShotReadable('')).toBe(false)
    expect(ONE_SHOT_MAX_TEXT).toBe(4000)
    expect(oneShotReadable('x'.repeat(ONE_SHOT_MAX_TEXT))).toBe(true)
    expect(oneShotReadable('x'.repeat(ONE_SHOT_MAX_TEXT + 1))).toBe(false)
  })
})

describe('the layout of a command', () => {
  it('a newline, a tab and a run of spaces carry a mark; nothing of the text is lost', () => {
    const text = `npm test${' '.repeat(5)}; curl evil\n\tsh `
    const segments = visibleSegments(text, { layout: true })

    expect(rawOf(segments)).toBe(text)
    expect(visibleText(text, { layout: true })).toBe('npm test·····; curl evil↵\n⇥\tsh·')
    expect(segments.filter(segment => segment.mark).map(segment => segment.raw)).toEqual(['     ', '\n', '\t', ' '])
  })

  it('a single space between words stays a space, and a leading one is marked', () => {
    expect(visibleText('a b', { layout: true })).toBe('a b')
    expect(visibleText(' a', { layout: true })).toBe('·a')
  })

  it('without layout marks a multi-line text keeps its lines, and hidden characters are still marked', () => {
    expect(visibleText('line 1\nline  2​')).toBe('line 1\nline  2⟦U+200B⟧')
  })

  it('a mark can never be mistaken for the same character typed in the text', () => {
    const typed = visibleSegments('a··b', { layout: true })
    const spaces = visibleSegments('a  b', { layout: true })

    expect(typed.some(segment => segment.mark)).toBe(false)
    expect(spaces.some(segment => segment.mark)).toBe(true)
  })
})
