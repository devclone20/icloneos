/**
 * The palette's data shapes. Rows are DATA, never JSX: the sheet owns every
 * pixel and every keystroke, so a command only describes itself.
 */

import type { IconComponent } from '@/lib/icons'

import type { PalettePageId } from './pages'

/** `state` = a note the row will CHANGE (a toggle's on/off); `muted` = a fact. */
type PaletteDetailTone = 'muted' | 'state'

export interface PaletteItem {
  /** Keybind action id — its live combo renders as a hotkey hint. */
  action?: string
  /** Renders a trailing check: this row IS the current setting (theme, mode). */
  active?: boolean
  /** Static trailing combo hint for a modifier-variant select (e.g. `mod+enter`). */
  comboHint?: string
  /** Short note beside the label — state the row acts on (a version, a count). */
  detail?: string
  detailVariant?: PaletteDetailTone
  icon: IconComponent
  /** Unique within one render of the list; the sheet keys its rows by it. */
  id: string
  /** Keep the palette open after running (live-preview pickers like theme/mode). */
  keepOpen?: boolean
  keywords?: string[]
  label: string
  /** Label shown while ⌘/⌃ is held — previews the modifier-variant action. */
  modLabel?: string
  /** Second line under the label (a session's preview, a theme's publisher). */
  note?: string
  /**
   * Runs when the row becomes the highlight (arrows or hover). A row without
   * one clears the live preview when it takes the highlight.
   */
  onHighlight?: () => void
  /** Action to run when selected. Mutually exclusive with `to`. */
  run?: () => void
  /**
   * When set, ⌘/⌃-select (or ⌘-Enter) opens a new tab and ⇧⌘-select pops a
   * window — matching sidebar session rows. Plain select stays in-place.
   */
  runWithEvent?: (event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void
  /** Trailing state chip (the Marketplace rows: install / installing / installed). */
  trailing?: PaletteItemTrailing
  /** Open a nested palette page (VS Code-style "choose X → options"). */
  to?: PalettePageId
}

interface PaletteItemTrailing {
  icon: IconComponent
  label: string
  /** The icon spins (a row doing work). */
  spin?: boolean
  tone?: 'accent' | 'muted' | 'success'
}

export interface PaletteGroup {
  /** Optional: a headingless group renders as a bare action row (e.g. the
   *  "Install theme…" entry pinned atop the theme picker). */
  heading?: string
  items: PaletteItem[]
}

/** A nested page reachable from a root item via `to`. */
export interface PalettePage {
  groups: PaletteGroup[]
  placeholder: string
  title: string
}
