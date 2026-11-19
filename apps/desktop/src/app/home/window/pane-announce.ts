/**
 * v0.0.9 F6 — what the panes say to a screen reader: the split a drag would make (only when the plan changes, never
 * per pointer move), the drop, the cancel, and a pane closing beside another. One always-mounted polite live region
 * reads it (pane-layer.tsx `PaneAnnouncer`): a region mounted together with its words is not reliably announced.
 */
import { atom } from 'nanostores'

export interface PaneAnnouncement {
  readonly text: string
  /** Bumped on every announcement, so the same words twice are said twice. */
  readonly seq: number
}

export const $paneAnnouncement = atom<PaneAnnouncement>({ text: '', seq: 0 })

export function announcePanes(text: string): void {
  if (text) {
    $paneAnnouncement.set({ text, seq: $paneAnnouncement.get().seq + 1 })
  }
}
