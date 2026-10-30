/**
 * What one Escape on the home surface closes, innermost first: an econ window,
 * then the iNFT island, then the Message window, then the stage itself. An
 * EXPANDED window retracts before it closes (doc 07 #7; STAGE tester 1 W-1):
 * the first Escape brings its frame back, the next one closes it. The Message
 * window yields to a text field (the composer keeps its own Escape: menus, an
 * edit in progress) only once retracted; the econ windows close from anywhere,
 * as they always did. Pure, so the order is pinned by a test and not by a lab.
 */
import { atom } from 'nanostores'
import { useEffect } from 'react'

import { setMsgSidebarOpen } from '@/app/chat/sidebar/msg-sidebar-state'

type HomeEscapeTarget = 'collections' | 'econ' | 'econ-panel' | 'message' | 'retract' | 'stage' | null

/** The close of the inner panel an econ window has open (Wallet aside, Hyperliquid fund form): the first Escape
 *  closes it, the second the window (U3-p2-12-p2b). Null while no panel is open. */
export const $econPanelCloser = atom<(() => void) | null>(null)

export function useEconPanelEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) {
      return
    }

    $econPanelCloser.set(close)

    return () => {
      if ($econPanelCloser.get() === close) {
        $econPanelCloser.set(null)
      }
    }
  }, [close, open])
}

export function homeEscapeTarget(state: {
  collectionsOpen: boolean
  econ: boolean
  editable: boolean
  /** The topmost window (the econ window, else the Message window) fills the app. */
  expanded: boolean
  mode: 'stage' | 'window'
  panel?: boolean
}): HomeEscapeTarget {
  if (state.econ && state.panel) {
    return 'econ-panel'
  }

  if (state.econ) {
    return state.expanded ? 'retract' : 'econ'
  }

  if (state.collectionsOpen) {
    return 'collections'
  }

  if (state.mode === 'window') {
    if (state.expanded) {
      return 'retract'
    }

    return state.editable ? null : 'message'
  }

  return 'stage'
}

/**
 * Closing the Message window is the ONE place its sidebar store is cleared, so
 * every open starts collapsed (owner rule) while a ⌘B sent just before the open
 * survives the mount. Never clear it on unmount: under <StrictMode> the
 * mount→cleanup→mount cycle would wipe the pre-set and the window would open
 * collapsed (UF2B2-r2-C1).
 */
export function closeMessageWindow(onClose: () => void): void {
  setMsgSidebarOpen(false)
  onClose()
}

/**
 * The same clear on the mode TRANSITION (lead, 2026-10-20, UF2B2-r3-C1): the
 * Message window also closes by route change — an econ tile navigates HOME, the
 * Settings tile navigates SETTINGS — and those paths never call
 * closeMessageWindow. Clearing when the home leaves 'window' covers every close
 * path in one place. StrictMode-safe: the mount cycle runs with the store
 * already false, and a ⌘B sent just before an open renders mode 'window' before
 * the effect runs, so the pre-set survives.
 */
export function useMsgSidebarResetOnLeave(mode: 'stage' | 'window'): void {
  useEffect(() => {
    if (mode !== 'window') {
      setMsgSidebarOpen(false)
    }
  }, [mode])
}
