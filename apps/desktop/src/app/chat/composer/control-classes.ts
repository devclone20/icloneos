import { cn } from '@/lib/utils'

// Shared class names for the composer's control row, in a module of their own
// so both the row (`controls.tsx`) and the menus it renders can wear them
// without importing each other in a cycle.

const ICON_BTN = 'size-(--composer-control-size) shrink-0 rounded-md'

export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'text-(--ic-text-2) hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]'
)

// Send/voice-conversation primary: solid foreground-on-background circle
// (reads as black-on-white in light mode, white-on-black in dark mode) to
// match the reference composer's high-contrast CTA. Keeps the pill itself
// neutral and lets the action visually dominate the row.
export const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'bg-[var(--ic-text-1)] text-[color:var(--ic-surface)] hover:bg-[var(--ic-chat-1-90)]',
  'disabled:bg-[var(--ic-chat-1-30)] disabled:text-[color:var(--ic-surface)] disabled:opacity-100'
)

/** A toggle that is currently ON — dictation, spoken replies, the wake word. */
export const ACTIVE_ICON_BTN =
  'bg-[var(--ic-chat-accent-10)] text-[color:var(--ic-accent)] hover:bg-[var(--ic-chat-accent-15)] hover:text-[color:var(--ic-accent)]'
