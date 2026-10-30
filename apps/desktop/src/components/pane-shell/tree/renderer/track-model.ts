/**
 * The TRACK MODEL — how a layout node resolves its size along a split axis.
 *
 * A node is a FIXED track when it resolves to a CSS length (sidebars keep
 * their declared size) and a FLEX track when it doesn't (weight-shared
 * leftover). Everything here is pure geometry over the layout tree + the
 * live pane contributions; the React split renderer reads it per render.
 */

import type * as React from 'react'

import type { MenuKit } from '@/components/ui/actions-menu'
import type { Contribution } from '@/contrib/types'

import type { LayoutNode } from '../model'
import { allPaneIds } from '../model'

import type { FloatingAnchor } from './floating-rect'

/** Optional CSS sizing a pane contributes (`data.width` / `data.minWidth`…).
 *  Applied to the pane's GROUP along the axis of the split that contains it —
 *  the same semantics as the app's `Pane width/minWidth/maxWidth` props:
 *  a `width`/`height` makes the zone a FIXED track (sidebar-style — it keeps
 *  its size and the weighted zones absorb the rest); without one the zone
 *  shares leftover space by weight. */
interface PaneSizing {
  width?: string
  height?: string
  minWidth?: string
  maxWidth?: string
  minHeight?: string
  maxHeight?: string
}

/** Chrome behavior flags a pane contributes. Read via `paneChrome`. */
interface PaneChrome extends PaneSizing {
  /** Tiling role in the tree, or `'floating'` — the one NON-tiling placement:
   *  the pane is excluded from the tree entirely. A floating pane takes no
   *  space from any zone, has no tab, and can't be docked or split. */
  placement?: string
  /** Spawn corner for `placement: 'floating'` (default `'top-right'`). The
   *  pane also TRACKS that corner's edges when the window resizes. */
  anchor?: FloatingAnchor
  /** Keep this pane mounted when hidden even after the zone's bounded hot
   *  cache fills. Reserved for stateful resources whose lifetime must not track
   *  tab visibility (for example terminal PTYs). */
  lifecycleKeepAlive?: boolean
  /** No Close in the tab menu — the one surface the app can't lose (the
   *  main workspace). Session tiles share `placement: 'main'` but close. */
  uncloseable?: boolean
  /** Standing chrome tab (sessions / Bots) with NO close verb at all: no ✕,
   *  no middle / ⌘-click, no Close menu rows. It is shown/hidden instead (the
   *  zone menu's Show/Hide rows and a ⌘K toggle, via `setStripTabHidden`).
   *  Close was too destructive for these: an accidental ✕ removed Bot Mode
   *  until the next launch. The ✕ follows the verb (see `PaneTab.onClose`),
   *  so dropping the verb here is what takes the chip off the tab. */
  hideOnly?: boolean
  /** Wrap this pane's TAB (e.g. in a domain context menu — a session tile's
   *  pin/branch/rename/archive/delete). The wrapper must render `tab` as its
   *  interactive child; the zone's own strip menu still owns non-tab space. */
  tabWrap?: (tab: React.ReactElement) => React.ReactNode
  /** Extra rows at the top of the zone tab menu. Called when the menu opens
   *  against the right-clicked pane — a Browser tab's Open-in-external, without
   *  replacing Reload / Close / the strip. */
  tabMenuPrefix?: (kit: MenuKit) => React.ReactNode
  /** Override this pane's TAB drag (a session tab drags like a sidebar row —
   *  stack / split / composer-link — not the generic pane move). Given the
   *  tab's tap (activate) so that gesture survives. Returns whether it took the
   *  drag; `false` (or absent) means no tab drag at all — e.g. the workspace
   *  tab on a fresh draft, nothing to link. */
  tabDrag?: (event: React.PointerEvent<HTMLElement>, onTap: () => void) => boolean
  /** Suppress the zone header while THIS pane is active — full-page views
   *  (artifacts/skills/plugin pages) are not tab-able surfaces. The flag is
   *  live: the workspace contribution re-registers it on route changes. */
  headerVeto?: boolean
  /** A lead NODE for this pane's TAB, rendered before the label. A session
   *  pane (main workspace + tiles) passes its live `SessionStatusDot` here so
   *  the tab and the sidebar row render status/color from the ONE primitive
   *  (self-subscribing — it updates without the strip re-registering). */
  tabLead?: () => React.ReactNode
  /** Mint another tab of THIS pane's kind — the strip's "+" while this pane is
   *  active. A Browser tab makes another Browser tab; a pane that is one of a
   *  kind (a file peek) leaves it absent and the strip falls back to the chat
   *  "+" if the zone holds session tabs. */
  newTab?: () => void
  /** This pane's TAB LABEL, when it changes faster than the contribution
   *  should. A session pane whose draft is being typed renames on every
   *  debounce beat; re-registering `title` that often would re-render the
   *  whole panes area, so the label subscribes for itself instead. Absent, or
   *  returning nothing, falls back to `title`. */
  tabTitle?: () => React.ReactNode
}

const paneChrome = (c: Contribution | undefined) => (c?.data ?? {}) as PaneChrome

/**
 * In an all-fixed split, the last uncapped track may absorb leftover space
 * (terminal/logs stacked at 38vh with nothing else to fill the column). A
 * CAPPED track must never be the absorber: review/files declare maxWidth
 * 20rem, and promoting them to grow-1 + dropping the clamp made ⌘G / ⌘J open
 * a half-window rail and ignore sash-remembered sizes (flex-basis alone
 * can't hold against grow).
 *
 * Returns the child index to absorb, or -1 when every fixed track is capped
 * (leave dead space — better than a ballooned sidebar).
 */
export function allFixedAbsorberIndex(
  growable: readonly number[],
  maxAlongAxis: (index: number) => string | undefined
): number {
  if (growable.length === 0) {
    return -1
  }

  for (let i = growable.length - 1; i >= 0; i--) {
    const index = growable[i]

    if (!maxAlongAxis(index)) {
      return index
    }
  }

  return -1
}

/**
 * Which chrome toggle owns a root-row child — SEMANTIC, not positional:
 * ⌘B is the sessions/nav column (any `placement: 'left'` pane) wherever a
 * flip or drag puts it; ⌘J is every other side column. `null` = contains
 * the main zone, never side-collapsed. This is what keeps the titlebar
 * toggles and reveals 100% main-compatible through ⌘\ flips.
 */
export function rootChildSide(
  child: LayoutNode,
  paneFor: (id: string) => Contribution | undefined
): 'left' | 'right' | null {
  const placements = allPaneIds(child).map(id => paneChrome(paneFor(id)).placement)

  if (placements.includes('main')) {
    return null
  }

  return placements.includes('left') ? 'left' : 'right'
}
