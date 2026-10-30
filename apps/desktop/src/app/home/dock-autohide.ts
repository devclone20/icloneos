/**
 * The Dock tucks itself away while a window is expanded (an expanded window fills the whole app, the Dock's lane
 * included) and slides back in when the pointer touches the left edge — the macOS auto-hide Dock. It hides again
 * once the pointer moves well clear of the rail. Keyboard focus inside the rail keeps it shown (dock.css). The
 * mechanism is the shared edge auto-hide (window/edge-autohide.ts); the window control column uses it on the right.
 */
import { useStore } from '@nanostores/react'
import { type RefObject } from 'react'

import { EDGE_HIDE_MARGIN_PX, EDGE_REVEAL_PX, nextEdgeReveal, useEdgeAutoHide } from './window/edge-autohide'
import { $expandedWindows } from './window/expanded'

/** The pointer within this many px of the app's left edge brings the Dock back. */
export const DOCK_REVEAL_EDGE_PX = EDGE_REVEAL_PX
/** Past the rail's right edge by this many px, a revealed Dock tucks away again. */
export const DOCK_HIDE_MARGIN_PX = EDGE_HIDE_MARGIN_PX

export function nextDockReveal(revealed: boolean, x: number, railRight: number): boolean {
  return nextEdgeReveal(revealed, { x, y: 0 }, { edge: 'left', edgeX: 0, innerX: railRight })
}

export function useDockAutoHide(railRef: RefObject<HTMLElement | null>): { autoHide: boolean; revealed: boolean } {
  const autoHide = useStore($expandedWindows).length > 0
  const revealed = useEdgeAutoHide({ active: autoHide, edge: 'left', targetRef: railRef })

  return { autoHide, revealed }
}
