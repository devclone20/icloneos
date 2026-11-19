/**
 * v0.0.9 F6 — what the window menu holds. Pure, so the gate "exactly 4 options (5 on the 3D pane), never top/bottom"
 * is a unit test (window-menu.test.tsx).
 *
 * Two groups, after the owner's two photos of Claude Code's window menu, trimmed to what a home pane can do:
 *   Move           — Move left · Move right
 *   Fill & arrange — Fill · Arrange side by side (disabled below 758 pt: "Needs a wider window")
 * and, on the 3D iNFT pane only, a separator + Open in new window.
 */
import { f6Menu } from '@/i18n/en/v009-f6'

export type WindowMenuItemId = 'arrange' | 'fill' | 'move-left' | 'move-right' | 'new-window'
export type WindowMenuGroupId = 'arrange' | 'detach' | 'move'

export interface WindowMenuItem {
  readonly id: WindowMenuItemId
  readonly group: WindowMenuGroupId
  readonly label: string
  /** The option that describes the pane right now (Fill while filled, the side it is on…). */
  readonly active: boolean
  readonly disabled: boolean
  /** Why it is disabled, shown in a Tip. */
  readonly reason?: string
  readonly onSelect: () => void
}

export interface WindowMenuGroup {
  readonly id: WindowMenuGroupId
  /** Shown above the group; the detach group has none (a separator only). */
  readonly title?: string
  readonly items: readonly WindowMenuItem[]
}

export interface WindowMenuState {
  /** The pane fills the app (today's "expand"). */
  readonly filled: boolean
  /** The side the pane is on, or null when it has the frame to itself. */
  readonly side: 'left' | 'right' | null
  /** Two panes stand side by side right now. */
  readonly arranged: boolean
  /** The usable width holds two panes (≥ 758 pt). */
  readonly wideEnough: boolean
  /** There is a second pane to arrange with. */
  readonly hasPartner: boolean
}

export interface WindowMenuActions {
  readonly moveLeft: () => void
  readonly moveRight: () => void
  readonly fill: () => void
  readonly arrange: () => void
  /** Only the 3D iNFT pane passes this. */
  readonly openInNewWindow?: () => void
}

export function windowMenuGroups(state: WindowMenuState, actions: WindowMenuActions): WindowMenuGroup[] {
  const arrangeReason = !state.wideEnough ? f6Menu.needsWider : !state.hasPartner ? f6Menu.needsSecond : undefined

  const groups: WindowMenuGroup[] = [
    {
      id: 'move',
      title: f6Menu.groupMove,
      items: [
        {
          id: 'move-left',
          group: 'move',
          label: f6Menu.moveLeft,
          active: state.side === 'left' && !state.filled,
          // r4d (design r4 F6-1): an action that would do nothing is disabled, with the reason.
          disabled: state.side === 'left' && !state.filled,
          reason: state.side === 'left' && !state.filled ? f6Menu.alreadyLeft : undefined,
          onSelect: actions.moveLeft
        },
        {
          id: 'move-right',
          group: 'move',
          label: f6Menu.moveRight,
          active: state.side === 'right' && !state.filled,
          disabled: state.side === 'right' && !state.filled,
          reason: state.side === 'right' && !state.filled ? f6Menu.alreadyRight : undefined,
          onSelect: actions.moveRight
        }
      ]
    },
    {
      id: 'arrange',
      title: f6Menu.groupArrange,
      items: [
        { id: 'fill', group: 'arrange', label: f6Menu.fill, active: state.filled, disabled: false, onSelect: actions.fill },
        {
          id: 'arrange',
          group: 'arrange',
          label: f6Menu.arrange,
          active: state.arranged && !state.filled,
          disabled: arrangeReason !== undefined,
          reason: arrangeReason,
          onSelect: actions.arrange
        }
      ]
    }
  ]

  if (actions.openInNewWindow) {
    groups.push({
      id: 'detach',
      items: [
        {
          id: 'new-window',
          group: 'detach',
          label: f6Menu.openInNewWindow,
          active: false,
          disabled: false,
          onSelect: actions.openInNewWindow
        }
      ]
    })
  }

  return groups
}

/** Every option in screen order — the keyboard's roving order. */
export function flatItems(groups: readonly WindowMenuGroup[]): WindowMenuItem[] {
  return groups.flatMap(group => group.items)
}
