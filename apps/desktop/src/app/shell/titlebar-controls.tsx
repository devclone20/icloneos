import type { MouseEvent, ReactNode } from 'react'

// The titlebar clusters are gone (E3a: OUR frame owns the window chrome). The
// tool shape stays: plugins and panes still describe their tools with it, and
// the plugin SDK re-exports it.
export interface TitlebarTool {
  id: string
  label: string
  active?: boolean
  className?: string
  disabled?: boolean
  /** A toggle in flight: the button stays enabled (and keeps focus) and ignores clicks until the state lands. */
  busy?: boolean
  hidden?: boolean
  href?: string
  icon: ReactNode
  onSelect?: (event?: MouseEvent) => void
  /** Keybind action id — when set, the tooltip shows the label + keybind hint. */
  actionId?: string
  /** Overlay count on the glyph (unread sessions). Hidden when 0/undefined. */
  badge?: number
  title?: string
  to?: string
}
