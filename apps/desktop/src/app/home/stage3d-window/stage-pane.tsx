/**
 * v0.0.9 F6 — the 3D iNFT as a pane on the home stage: its window menu (the same Move · Fill & arrange menu as every
 * Dock pane, plus Open in new window — on this pane only), its placement on the frame, and the calm plate the main
 * window shows while the iNFT performs in its own window.
 *
 * Placement: the frame (default), Fill (the whole app), or one half (Move left / right, ≥ 375). Arrange side by side
 * puts the stage on one half and the one open Dock pane on the other (pane-layout.ts); it needs ≥ 758 pt and a pane.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type CSSProperties, useMemo } from 'react'

import { f6Menu, f6Stage } from '@/i18n/en/v009-f6'

import { $paneArea, $panes, canArrange, moveRegisteredPane, soloWidth } from '../window/pane-layout'
import { windowRectStyle } from '../window/rect'
import { WindowMenu } from '../window/window-menu'
import { windowMenuGroups } from '../window/window-menu-model'

import { $stagePlace, stageHandover, type StageInft } from './handover'

export type StagePlacement = 'fill' | 'frame' | 'left' | 'right'

export const $stagePlacement = atom<StagePlacement>('frame')

/** A new iNFT always opens on the frame (the owner's "standard" rule for the stage). */
export function resetStagePlacement(): void {
  $stagePlacement.set('frame')
}

/** The stage card's rect for its placement, as inline insets over `.ihome__stage--live` (home.css). */
export function stagePlacementStyle(placement: StagePlacement, area: number): CSSProperties | undefined {
  if (placement === 'frame') {
    return undefined
  }

  if (placement === 'fill') {
    return windowRectStyle(true)
  }

  // Too narrow for a half: the frame (a half below 758 pt would leave the home a sliver).
  if (!canArrange(area)) {
    return undefined
  }

  const width = soloWidth(area)

  return windowRectStyle(false, {
    area,
    slot: placement === 'left' ? { place: 'left', left: 0, width } : { place: 'right', left: area - width, width }
  })
}

export function useStagePlacementStyle(): CSSProperties | undefined {
  const placement = useStore($stagePlacement)
  const area = useStore($paneArea)

  return useMemo(() => stagePlacementStyle(placement, area), [area, placement])
}

/** The 3D pane's window menu: 5 options, the last one only when the preload has the stage window door. */
export function StagePaneMenu({ field, inft }: { field: null | string; inft: StageInft }) {
  const placement = useStore($stagePlacement)
  const area = useStore($paneArea)
  const panes = useStore($panes)
  const place = useStore($stagePlace)

  const groups = useMemo(() => {
    const partner = panes.open.length === 1 ? panes.open[0] : null
    const toggle = (next: StagePlacement) => $stagePlacement.set(placement === next ? 'frame' : next)

    return windowMenuGroups(
      {
        filled: placement === 'fill',
        side: placement === 'left' || placement === 'right' ? placement : null,
        arranged: placement !== 'fill' && placement !== 'frame' && partner !== null,
        wideEnough: canArrange(area),
        hasPartner: partner !== null
      },
      {
        moveLeft: () => toggle('left'),
        moveRight: () => toggle('right'),
        fill: () => toggle('fill'),
        arrange: () => {
          if (partner === null) {
            return
          }

          // The stage keeps the side it is on (left by default); the Dock pane takes the other half.
          const side = placement === 'right' ? 'right' : 'left'

          $stagePlacement.set(side)
          moveRegisteredPane(partner, side === 'left' ? 'right' : 'left')
        },
        openInNewWindow:
          stageHandover.available() && place === 'docked'
            ? () => {
                void stageHandover.detach(inft, field)
              }
            : undefined
      }
    )
  }, [area, field, inft, panes.open, place, placement])

  return (
    <WindowMenu
      className="ihome__stage-menu"
      groups={groups}
      menuLabel={f6Menu.label(f6Stage.name)}
      triggerLabel={f6Menu.trigger(f6Stage.name)}
    />
  )
}

/** What the main window shows where the stage was, while the iNFT performs in its own window. */
export function StageAwayPlate() {
  const place = useStore($stagePlace)

  return (
    <div className="istage-away" role="status">
      <p className="istage-away__line">{f6Stage.away}</p>
      <button
        className="istage-away__back"
        disabled={place !== 'away'}
        onClick={() => void stageHandover.bringBack()}
        type="button"
      >
        {f6Stage.bringBack}
      </button>
    </div>
  )
}
