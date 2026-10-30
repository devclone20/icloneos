/**
 * Composable bar items for the contrib root: core statusbar items with LIVE
 * store-backed labels, registered as DATA contributions
 * (`area: 'statusBar.left' / 'statusBar.right'`, payload = StatusbarItem) —
 * plugins add theirs through the identical call.
 *
 * The upstream right-sidebar panes that used to live here (`FilesPane`,
 * `ReviewPaneContent`) are gone with their cluster (E3c, contract E3 §3): the
 * file browser and the git-review sidebar were upstream Hermes surfaces, not
 * ours, and OUR home stage replaces them.
 */

import { atom } from 'nanostores'

import type { GroupSetter } from '@/app/shell/group-setter'
import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import type { TitlebarTool } from '@/app/shell/titlebar-controls'
import { registry } from '@/contrib/registry'

/** Preview-server restart handler, provided by the wiring (usePreviewRouting).
 *  Atom-bridged: this module can't import contrib-wiring (it imports us). */
export const $restartPreviewServer = atom<((url: string, context?: string) => Promise<string>) | null>(null)

/**
 * Bridge a page's `GroupSetter` extension point (SkillsView, MessagingView,
 * ChatPreviewRail, …) into the registry: each call replaces the group's items
 * as DATA contributions in `<prefix>.<side>`, so page-owned items flow through
 * the same pipe plugins use. Setting an empty list clears the group.
 */
function registryGroupSetter<T>(prefix: string): GroupSetter<T> {
  const disposers = new Map<string, () => void>()

  return (id, items, side = 'right') => {
    const key = `${side}:${id}`

    disposers.get(key)?.()
    disposers.set(
      key,
      registry.registerMany(
        items.map((item, i) => ({
          id: `${id}-${i}`,
          area: `${prefix}.${side}`,
          source: 'core',
          order: 100 + i,
          data: item as object
        }))
      )
    )
  }
}

/** The app's page-facing setters — the same `GroupSetter` shape pages already
 *  take as props, backed by the registry instead of component state. */
export const setStatusbarItemGroup = registryGroupSetter<StatusbarItem>('statusBar')
const setTitlebarToolGroup = registryGroupSetter<TitlebarTool>('titleBar.tools')
