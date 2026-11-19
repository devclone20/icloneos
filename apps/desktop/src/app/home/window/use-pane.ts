/**
 * v0.0.9 F6 — the glue between one IcWindow and the pane store (pane-layout.ts): it registers the window as a pane
 * while it is mounted, hands the store its close (for the 3rd-pane replace), and reads back where it draws and what
 * its window menu says.
 */
import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { retractWindow } from './expanded'
import {
  $paneArea,
  $paneArrangement,
  $panes,
  arrangeRegisteredPanes,
  canArrange,
  focusRegisteredPane,
  moveRegisteredPane,
  registerPane,
  renameRegisteredPane,
  setPaneCloser,
  sideOf,
  slotFor,
  unregisterPane
} from './pane-layout'
import type { PaneGeometry } from './rect'
import { type WindowMenuGroup, windowMenuGroups } from './window-menu-model'

/**
 * The window is a pane from its first layout to its unmount. Another id in the same chassis (the five EconomyOS
 * windows share one) is the same pane renamed: it keeps its side. Layout effects, so the first paint already has the
 * pane's slot.
 */
export function usePaneRegistration(id: string, onClose: () => void): void {
  const registered = useRef<null | string>(null)

  useLayoutEffect(() => {
    if (registered.current === null) {
      registerPane(id)
    } else if (registered.current !== id) {
      renameRegisteredPane(registered.current, id)
    }

    registered.current = id
  }, [id])

  useLayoutEffect(
    () => () => {
      if (registered.current !== null) {
        unregisterPane(registered.current)
        registered.current = null
      }
    },
    []
  )

  useEffect(() => {
    setPaneCloser(id, onClose)

    return () => setPaneCloser(id, null)
  }, [id, onClose])
}

export interface PanePlacement {
  geometry: PaneGeometry
  /** Folded into a tab behind the focused pane: kept mounted, not drawn. */
  folded: boolean
  /** Two panes side by side, this one of them: they share ONE opacity control (ic-window.tsx). */
  split: boolean
}

export function usePanePlacement(id: string): PanePlacement {
  const arrangement = useStore($paneArrangement)
  const area = useStore($paneArea)
  const slot = slotFor(arrangement, id, area)
  const split = arrangement.kind === 'split' && (slot.place === 'left' || slot.place === 'right')

  return useMemo(() => ({ geometry: { slot, area }, folded: slot.place === 'hidden', split }), [area, slot, split])
}

/** The window menu of one Dock pane: Move left · Move right · Fill · Arrange side by side. */
export function usePaneMenu(id: string, expanded: boolean, onToggleExpanded: () => void): WindowMenuGroup[] {
  const panes = useStore($panes)
  const area = useStore($paneArea)
  const arrangement = useStore($paneArrangement)

  return useMemo(() => {
    const partner = panes.open.find(open => open !== id) ?? null

    const unfill = () => {
      if (expanded) {
        onToggleExpanded()
      }
    }

    return windowMenuGroups(
      {
        filled: expanded,
        side: sideOf(panes, id),
        arranged: arrangement.kind === 'split',
        wideEnough: canArrange(area),
        hasPartner: partner !== null
      },
      {
        moveLeft: () => {
          unfill()
          moveRegisteredPane(id, 'left')
        },
        moveRight: () => {
          unfill()
          moveRegisteredPane(id, 'right')
        },
        // Fill is the expand the column used to carry: it toggles, so choosing it again brings the pane back.
        fill: () => {
          focusRegisteredPane(id)
          onToggleExpanded()
        },
        arrange: () => {
          unfill()

          if (partner !== null) {
            retractWindow(partner)
          }

          arrangeRegisteredPanes()
        }
      }
    )
  }, [area, arrangement.kind, expanded, id, onToggleExpanded, panes])
}
