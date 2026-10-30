/**
 * Built-in desktop themes — the iclone os trio.
 *
 * iclone os ships exactly three skins, mirrored 1:1 from the cloneframe.io
 * site's theme button (assets/site.css `[data-theme]` blocks): the 1111 iNFT
 * field is the app, the theme only changes the weather over it.
 *
 *   iclone-natural  tint rgba(13,12,18,.60) · ink #f6f4fa   (dark)
 *   iclone-dark     tint rgba(6,6,9,.74)    · ink #eceaf2   (dark)
 *   iclone-light    tint rgba(248,247,251,.58) · ink #16151c (light)
 *
 * Champagne gold #d7c9a6 is the accent in all three (accent-ink #0c0b10).
 * The frosted 1111 mosaic behind the shell lives in styles.css (scoped to
 * `[data-hermes-theme^="iclone"]`), not here — themes carry only tokens.
 *
 * Upstream (Nous) themes were removed by owner decision; users can
 * still import any VS Code Marketplace theme from Settings ▸ Appearance.
 */

import type { DesktopTheme, DesktopThemeTypography } from './types'

// Color-emoji fonts to append to every stack as a last resort. None of the UI
// text/mono fonts carry emoji glyphs, so without this emoji render as tofu
// boxes on platforms whose default text font lacks them (e.g. Linux/#40364).
// Covers macOS, Windows, Linux, plus the `emoji` generic for anything else.
export const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

const SYSTEM_SANS =
  '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, ' +
  EMOJI_FALLBACK

const SYSTEM_MONO = 'Menlo, Monaco, "SF Mono", "Courier Prime", monospace, ' + EMOJI_FALLBACK

export const DEFAULT_TYPOGRAPHY: DesktopThemeTypography = { fontSans: SYSTEM_SANS, fontMono: SYSTEM_MONO }

const GOLD = '#d7c9a6'
const GOLD_BRIGHT = '#f2e6c8'
const GOLD_DIM = '#8d7f5f'
const ACCENT_INK = '#0c0b10'

// One xterm palette for both dark skins; light gets its own below.
const ICLONE_DARK_TERMINAL = {
  foreground: '#eceadf',
  cursor: GOLD,
  selectionBackground: 'rgba(215, 201, 166, 0.28)',
  black: '#1a191f',
  red: '#e0566b',
  green: '#a3b18a',
  yellow: GOLD,
  blue: '#8f9bc4',
  magenta: '#b8a1c9',
  cyan: '#8fb8b0',
  white: '#e6e4ea',
  brightBlack: '#3a3944',
  brightRed: '#ef7a8a',
  brightGreen: '#b8c9a0',
  brightYellow: GOLD_BRIGHT,
  brightBlue: '#a8b4d9',
  brightMagenta: '#cbb8dc',
  brightCyan: '#a5cdc4',
  brightWhite: '#f6f4fa'
}

export const icloneNaturalTheme: DesktopTheme = {
  name: 'iclone-natural',
  label: 'iclone natural',
  description: 'cloneframe.io natural — the field under evening glass',
  colors: {
    background: '#0d0c12',
    foreground: '#f6f4fa',
    card: '#1a191f',
    cardForeground: '#f6f4fa',
    muted: '#25242a',
    mutedForeground: '#b0afb5',
    popover: '#25242a',
    popoverForeground: '#f6f4fa',
    primary: GOLD,
    primaryForeground: ACCENT_INK,
    secondary: '#211f26',
    secondaryForeground: GOLD_BRIGHT,
    accent: '#2a282f',
    accentForeground: GOLD_BRIGHT,
    border: '#2c2b31',
    input: '#2c2b31',
    ring: GOLD,
    midground: GOLD,
    midgroundForeground: ACCENT_INK,
    composerRing: GOLD,
    destructive: '#e0566b',
    destructiveForeground: '#fdf6f7',
    sidebarBackground: '#0b0a10',
    sidebarBorder: '#232228',
    userBubble: '#26231d',
    userBubbleBorder: '#3a352b'
  },
  terminal: ICLONE_DARK_TERMINAL
}

export const icloneDarkTheme: DesktopTheme = {
  name: 'iclone-dark',
  label: 'iclone dark',
  description: 'cloneframe.io dark — never so dark the field disappears',
  colors: {
    background: '#060609',
    foreground: '#eceaf2',
    card: '#101013',
    cardForeground: '#eceaf2',
    muted: '#19191c',
    mutedForeground: '#98979d',
    popover: '#19191c',
    popoverForeground: '#eceaf2',
    primary: GOLD,
    primaryForeground: ACCENT_INK,
    secondary: '#161619',
    secondaryForeground: GOLD_BRIGHT,
    accent: '#1e1e22',
    accentForeground: GOLD_BRIGHT,
    border: '#26262a',
    input: '#26262a',
    ring: GOLD,
    midground: GOLD,
    midgroundForeground: ACCENT_INK,
    composerRing: GOLD,
    destructive: '#e0566b',
    destructiveForeground: '#fdf6f7',
    sidebarBackground: '#050508',
    sidebarBorder: '#1c1c20',
    userBubble: '#201d18',
    userBubbleBorder: '#332f26'
  },
  terminal: ICLONE_DARK_TERMINAL
}

export const icloneLightTheme: DesktopTheme = {
  name: 'iclone-light',
  label: 'iclone light',
  description: 'cloneframe.io light — lighter glass, not a lid',
  colors: {
    background: '#f8f7fb',
    foreground: '#16151c',
    card: '#ffffff',
    cardForeground: '#16151c',
    muted: '#eceaf2',
    mutedForeground: '#5e5d64',
    popover: '#ffffff',
    popoverForeground: '#16151c',
    primary: GOLD,
    primaryForeground: ACCENT_INK,
    secondary: '#efedf4',
    secondaryForeground: GOLD_DIM,
    accent: '#f2eee2',
    accentForeground: '#5c5136',
    border: '#dedde2',
    input: '#dedde2',
    ring: '#a8935f',
    midground: '#a8935f',
    midgroundForeground: '#ffffff',
    composerRing: '#a8935f',
    destructive: '#c8103a',
    destructiveForeground: '#ffffff',
    sidebarBackground: '#f3f2f7',
    sidebarBorder: '#dedde2',
    userBubble: '#f5f1e4',
    userBubbleBorder: '#e2d9c2'
  },
  terminal: {
    foreground: '#2a2930',
    cursor: '#a8935f',
    selectionBackground: 'rgba(168, 147, 95, 0.25)',
    black: '#f0eff4',
    red: '#c8103a',
    green: '#5d7a45',
    yellow: GOLD_DIM,
    blue: '#4a5a8f',
    magenta: '#7c5f92',
    cyan: '#3f7a70',
    white: '#3a3944',
    brightBlack: '#c9c8cf',
    brightRed: '#e0566b',
    brightGreen: '#7a9a5f',
    brightYellow: '#a8935f',
    brightBlue: '#6a7ab8',
    brightMagenta: '#9a7cb0',
    brightCyan: '#5f9a8f',
    brightWhite: '#16151c'
  }
}

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
  'iclone-natural': icloneNaturalTheme,
  'iclone-dark': icloneDarkTheme,
  'iclone-light': icloneLightTheme
}

export const BUILTIN_THEME_LIST = Object.values(BUILTIN_THEMES)

/** Skin used when nothing is persisted or the persisted name is retired. */
export const DEFAULT_SKIN_NAME = 'iclone-natural'
