/**
 * Which IcWindows are expanded right now. An expanded window fills the whole app window, the Dock's lane included
 * (owner decision), so the Dock reads this to tuck itself away and slide back in from the left edge.
 *
 * Each expanded window also leaves its retract here, so the Escape routers (home-view for the econ and Message
 * windows, settings-window for its own) can un-expand a window before they would close it (doc 07 #7, STAGE
 * tester 1 W-1): one Escape retracts, the next closes.
 */
import { atom } from 'nanostores'
import { useCallback, useState } from 'react'

import { $dockWindowSize } from '@/store/dock-window-size'

import type { IcWindowId } from './ic-window'

export const $expandedWindows = atom<readonly string[]>([])

const retracts = new Map<string, () => void>()

export function setWindowExpanded(id: string, expanded: boolean, retract?: () => void): void {
  if (expanded && retract) {
    retracts.set(id, retract)
  } else if (!expanded) {
    retracts.delete(id)
  }

  const current = $expandedWindows.get()
  const has = current.includes(id)

  if (expanded && !has) {
    $expandedWindows.set([...current, id])
  } else if (!expanded && has) {
    $expandedWindows.set(current.filter(item => item !== id))
  }
}

export function isWindowExpanded(id: string): boolean {
  return $expandedWindows.get().includes(id)
}

/** Retracts the window when it is expanded and left a retract; true when it did. */
export function retractWindow(id: string): boolean {
  const retract = retracts.get(id)

  if (!retract || !isWindowExpanded(id)) {
    return false
  }

  retract()

  return true
}

interface OpenState {
  expanded: boolean
  id: IcWindowId
}

/** How a window opens right now: the Settings choice (Machine › Appearance), read at the opening only. */
function opening(id: IcWindowId): OpenState {
  return { expanded: $dockWindowSize.get() === 'maximized', id }
}

/**
 * A Dock window's expanded state — the ONE place that decides how a window opens. An opening (a mount, or another
 * window id in the same chassis: the five econ windows share one) reads the Settings choice; from then on the size
 * is the user's. Bringing the open window to the front, a re-render, or a later change of the choice never resizes
 * it; closing it and opening it again is a new opening, so it follows the choice again.
 */
export function useWindowExpanded(id: IcWindowId): { expanded: boolean; retract: () => void; toggle: () => void } {
  const [state, setState] = useState(() => opening(id))
  let current = state

  // Before paint, in this very render: another window id never shows one frame at the previous window's size.
  if (state.id !== id) {
    current = opening(id)
    setState(current)
  }

  const toggle = useCallback(() => setState(open => ({ ...open, expanded: !open.expanded })), [])
  const retract = useCallback(() => setState(open => (open.expanded ? { ...open, expanded: false } : open)), [])

  return { expanded: current.expanded, retract, toggle }
}
