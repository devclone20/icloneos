/**
 * v0.0.9 F6 — the words of the home panes: the window menu, the pane divider, the folded tabs, the replace toast and
 * the 3D iNFT in its own window.
 *
 * English only (the app ships English); imported directly by home/window/* and home/stage3d-window/*. Every
 * user-facing string of those surfaces lives here — no literal in their JSX.
 */
import type { IcWindowId } from '@/app/home/window/ic-window'

/** The name a pane goes by in the menu, the folded tabs and the replace toast. */
export const f6PaneNames: Readonly<Record<IcWindowId, string>> = {
  'acp-market': 'ACP Market',
  'bank-card': 'Bank Card',
  containers: 'Containers',
  email: 'Email',
  hyperliquid: 'Hyperliquid',
  message: 'Message',
  settings: 'Settings',
  wallet: 'Wallet'
}

export const f6Menu = {
  /** The trigger's accessible name; `pane` is the window's name. */
  trigger: (pane: string): string => `Window options for ${pane}`,
  label: (pane: string): string => `${pane} window`,
  groupMove: 'Move',
  groupArrange: 'Fill & arrange',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  fill: 'Fill',
  arrange: 'Arrange side by side',
  openInNewWindow: 'Open in new window',
  /** Arrange side by side, disabled: the pair needs 2 × 375 pt + the divider. */
  needsWider: 'Needs a wider window',
  /** Arrange side by side, disabled: there is no second window to sit beside. */
  needsSecond: 'Open a second window from the Dock',
  /** r4d (design r4 F6-1): Move left/right on the side the pane is already on does nothing. */
  alreadyLeft: 'Already on the left',
  alreadyRight: 'Already on the right'
} as const

export const f6Panes = {
  divider: 'Resize the two windows',
  dividerHint: 'Drag to resize · double-click for half and half',
  tabs: 'Open windows',
  /** The toast when a third pane takes the place of the one without focus. */
  replaced: (pane: string): string => `Replaced ${pane} — open it again from the Dock`
} as const

/** Drag a Dock icon onto the window to split it (owner addition, 18 Nov). */
export const f6Split = {
  /** The preview's accessible name while a drag is on. */
  preview: 'Split preview',
  /** The half the dropped pane takes. */
  opensHere: (pane: string): string => `${pane} opens here`,
  /** The half that keeps the pane already open. */
  stays: (pane: string): string => `${pane} stays`,
  /** Two were open: the pane on that side makes room. */
  replaces: (incoming: string, replaced: string): string => `${incoming} replaces ${replaced}`,
  /** Below 758 pt the pair becomes two tabs. */
  asTab: (incoming: string, keep: string): string => `${incoming} opens as a tab beside ${keep}`,
  /** The pane is already open: it moves to that side. */
  moves: (pane: string): string => `Move ${pane} here`,
  /** The one opacity control while two panes sit side by side. */
  opacityBoth: 'Opacity of both windows',
  /** A lone window's control: the opacity is one for every window (owner rule), so it says so. */
  opacityAll: (label: string): string => `${label} · every window`,
  /** The dragged pane is already open and has nowhere to move. */
  alreadyOpen: (pane: string): string => `${pane} is already open`,
  /** Said when the drop lands (the live region). */
  opened: (incoming: string, keep: string): string => `${incoming} opens beside ${keep}`,
  moved: (pane: string, side: 'left' | 'right'): string => `${pane} moved to the ${side}`,
  cancelled: 'Split cancelled',
  /** One of two panes closed; the other has the window. */
  closed: (pane: string, other: string): string => `${pane} closed · ${other} fills the window`,
  /** What the live region says while the drag hovers one side (only when the side or plan changes). */
  side: (side: 'left' | 'right'): string => (side === 'left' ? 'Left' : 'Right'),
  /** The Dock tile's split menu (keyboard: Shift+Enter, Shift+F10, the context-menu key; pointer: right-click). */
  menuLabel: (pane: string): string => `Open ${pane} beside`,
  openLeft: 'Open on the left',
  openRight: 'Open on the right',
  /** A menu item's detail when the side it opens on replaces a pane. */
  replacing: (pane: string): string => `replaces ${pane}`,
  asTabItem: 'Open as a tab',
  tileShortcut: 'Shift+Enter opens it beside the window already open',
  /** The divider's spoken value. */
  dividerValue: (left: string, leftPt: number, right: string, rightPt: number): string =>
    `${left} ${leftPt} points, ${right} ${rightPt} points`,
  dividerKeys: 'Left and Right arrows move it, Home and End go to the limits, Enter resets half and half'
} as const

export const f6Stage = {
  name: 'iNFT',
  /** The calm plate the main window shows while the iNFT performs in its own window. */
  away: 'The iNFT is open in its own window',
  bringBack: 'Bring back',
  windowTitle: (inft: string): string => `${inft} · iclone os`,
  openFailed: 'The iNFT could not open in its own window. It stays here.',
  noInft: 'No iNFT to show. Close this window and summon one from the collection.'
} as const
