import { describe, expect, it } from 'vitest'

import {
  BUILTIN_THEME_LIST,
  BUILTIN_THEMES,
  DEFAULT_SKIN_NAME,
  DEFAULT_TYPOGRAPHY,
  EMOJI_FALLBACK,
  icloneDarkTheme,
  icloneLightTheme,
  icloneNaturalTheme
} from './presets'

// #40364: none of the UI text/mono fonts carry emoji glyphs, so every font
// stack must end with a color-emoji fallback or emoji render as tofu on
// platforms whose default font lacks them (e.g. Linux).
describe('theme typography emoji fallback (#40364)', () => {
  const stacks: Array<[string, string]> = [
    ['DEFAULT_TYPOGRAPHY.fontSans', DEFAULT_TYPOGRAPHY.fontSans],
    ['DEFAULT_TYPOGRAPHY.fontMono', DEFAULT_TYPOGRAPHY.fontMono],
    // A theme may override only fontMono (fontSans then falls back to the
    // default, which already carries the emoji stack), so skip undefined.
    ...BUILTIN_THEME_LIST.flatMap(theme =>
      (
        [
          [`${theme.name}.fontSans`, theme.typography?.fontSans],
          [`${theme.name}.fontMono`, theme.typography?.fontMono]
        ] as Array<[string, string | undefined]>
      ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  ]

  it.each(stacks)('%s includes a color-emoji font', (_label, stack) => {
    expect(stack).toMatch(/Apple Color Emoji|Segoe UI Emoji|Noto Color Emoji|(^|,\s*)emoji\b/)
  })

  it('EMOJI_FALLBACK lists the major platform emoji fonts', () => {
    expect(EMOJI_FALLBACK).toContain('Apple Color Emoji')
    expect(EMOJI_FALLBACK).toContain('Segoe UI Emoji')
    expect(EMOJI_FALLBACK).toContain('Noto Color Emoji')
  })
})

// iclone os ships exactly three skins (owner decision 2026-08-28, see the
// presets.ts header) — natural and dark share one champagne-gold accent
// across all four seed slots, and light locks those same slots to a darker
// shade of that gold so the accent doesn't wash out on a bright surface.
describe('iclone os trio', () => {
  it('defaults to the natural skin', () => {
    expect(DEFAULT_SKIN_NAME).toBe('iclone-natural')
  })

  it('ships exactly three iclone-* skins', () => {
    expect(BUILTIN_THEME_LIST).toHaveLength(3)

    for (const theme of BUILTIN_THEME_LIST) {
      expect(theme.name).toMatch(/^iclone-/)
    }
  })

  it('registers the natural skin as the iclone-natural built-in', () => {
    expect(icloneNaturalTheme).toBe(BUILTIN_THEMES['iclone-natural'])
  })

  it('seeds both dark skins’ accent family from the champagne gold', () => {
    for (const theme of [icloneNaturalTheme, icloneDarkTheme]) {
      for (const key of ['primary', 'ring', 'midground', 'composerRing'] as const) {
        expect(theme.colors[key], `${theme.name}.${key}`).toBe('#d7c9a6')
      }
    }
  })

  it('locks iclone-light’s ring/midground/composerRing to the darker gold, keeping primary champagne', () => {
    expect(icloneLightTheme.colors.primary).toBe('#d7c9a6')

    for (const key of ['ring', 'midground', 'composerRing'] as const) {
      expect(icloneLightTheme.colors[key], key).toBe('#a8935f')
    }
  })
})
