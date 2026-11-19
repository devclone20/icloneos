/**
 * v0.0.9 F6 — the window menu's glyphs, drawn for it (not a stock icon set), in the style of the owner's photos of
 * Claude Code's window menu: a thin rounded window outline on an 18 px grid, the part the option acts on filled at
 * low ink, the trigger on a 24 px grid. currentColor only, so both themes and the hover/active ink come from CSS.
 */
import type { JSX, ReactNode, SVGProps } from 'react'

import type { WindowMenuItemId } from './window-menu-model'

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children'>

const STROKE = 1.25

function Frame18({ children, ...props }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      fill="none"
      focusable="false"
      height={18}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={STROKE}
      viewBox="0 0 18 18"
      width={18}
      {...props}
    >
      {children}
    </svg>
  )
}

/** ◧ the left half lit. */
export function GlyphMoveLeft(props: GlyphProps) {
  return (
    <Frame18 {...props}>
      <rect height="12" rx="2.25" width="14" x="2" y="3" />
      <path d="M4.25 4.75h3.5v8.5h-3.5z" fill="currentColor" fillOpacity="0.55" stroke="none" />
      <path d="M9 3.6v10.8" strokeOpacity="0.45" />
    </Frame18>
  )
}

/** ◨ the right half lit. */
export function GlyphMoveRight(props: GlyphProps) {
  return (
    <Frame18 {...props}>
      <rect height="12" rx="2.25" width="14" x="2" y="3" />
      <path d="M10.25 4.75h3.5v8.5h-3.5z" fill="currentColor" fillOpacity="0.55" stroke="none" />
      <path d="M9 3.6v10.8" strokeOpacity="0.45" />
    </Frame18>
  )
}

/** ▭ the whole window lit, corner ticks pointing out. */
export function GlyphFill(props: GlyphProps) {
  return (
    <Frame18 {...props}>
      <rect height="12" rx="2.25" width="14" x="2" y="3" />
      <rect fill="currentColor" fillOpacity="0.55" height="8.5" rx="1" stroke="none" width="10.5" x="3.75" y="4.75" />
    </Frame18>
  )
}

/** ◫ two panes, a seam between them. */
export function GlyphArrange(props: GlyphProps) {
  return (
    <Frame18 {...props}>
      <rect height="12" rx="2.25" width="6.25" x="1.75" y="3" />
      <rect height="12" rx="2.25" width="6.25" x="10" y="3" />
      <path d="M9 6.5v5" strokeDasharray="1 1.6" strokeOpacity="0.6" />
    </Frame18>
  )
}

/** ⧉ a window lifting off another, the arrow out of its corner. */
export function GlyphNewWindow(props: GlyphProps) {
  return (
    <Frame18 {...props}>
      <path d="M5.5 6.25H4.25a2 2 0 0 0-2 2v5.5a2 2 0 0 0 2 2h5.5a2 2 0 0 0 2-2V12.5" strokeOpacity="0.6" />
      <rect height="9.5" rx="2" width="9.5" x="6.25" y="2.25" />
      <path d="M9.5 8.5l3.25-3.25M10.25 5.25h2.5v2.5" />
    </Frame18>
  )
}

/** The trigger (24 px): a window with its two panes, the menu's own sign. */
export function GlyphWindowMenu(props: GlyphProps) {
  return (
    <svg
      aria-hidden
      fill="none"
      focusable="false"
      height={16}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.4}
      viewBox="0 0 24 24"
      width={16}
      {...props}
    >
      <rect height="15" rx="3" width="18" x="3" y="4.5" />
      <path d="M12 4.9v14.2" strokeOpacity="0.5" />
      <path d="M5.75 8h3.5M14.75 8h3.5" strokeOpacity="0.75" />
    </svg>
  )
}

const BY_ID: Record<WindowMenuItemId, (props: GlyphProps) => JSX.Element> = {
  arrange: GlyphArrange,
  fill: GlyphFill,
  'move-left': GlyphMoveLeft,
  'move-right': GlyphMoveRight,
  'new-window': GlyphNewWindow
}

export function WindowMenuGlyph({ id }: { id: WindowMenuItemId }) {
  const Glyph = BY_ID[id]

  return <Glyph />
}
