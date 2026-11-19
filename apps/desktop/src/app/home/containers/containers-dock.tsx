/**
 * K100 — what HomeView needs at boot for the Containers window: its open flag, its Dock tile and a gate that loads the
 * window itself (and its stylesheet) the first time it opens. The window lived in the boot bundle before.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { lazy, Suspense, useEffect, useMemo } from 'react'

import type { DockItem } from '@/app/home/dock'

import { useContainersCopy } from './containers-copy'
import { IcContainer } from './ic-container'

const ContainersWindowBody = lazy(async () => ({ default: (await import('./containers-app')).ContainersWindow }))

export const $containersOpen = atom(false)

/**
 * v0.0.9 F6 (owner addition): Containers dropped beside another pane (or another pane dropped beside it) sits next to
 * it instead of closing — the one-window rule below holds for the Dock's clicks only. Cleared when it closes.
 */
export const $containersBeside = atom(false)

$containersOpen.subscribe(open => {
  if (!open) {
    $containersBeside.set(false)
  }
})

/** The Dock tile; pass a stable `onOpen`. It closes whichever Dock window is open: one window at a time. */
export function useContainersDockItem(hint: string | undefined, onOpen: () => void, onClose?: () => void): DockItem {
  const copy = useContainersCopy()
  const open = useStore($containersOpen)

  return useMemo(
    () => ({
      id: 'containers',
      label: copy.tile,
      hint,
      icon: <IcContainer size={22} />,
      tone: 'system',
      active: open,
      onSelect: () => {
        if (!open) {
          onOpen()
        }

        $containersOpen.set(!open)

        if (open) {
          onClose?.()
        }
      }
    }),
    [copy.tile, hint, onClose, onOpen, open]
  )
}

/** `blocked`: another Dock window took the stage. The window's code loads on its first open, never at boot. */
export function LazyContainersWindow({ blocked: anotherWindow }: { blocked: boolean }) {
  const open = useStore($containersOpen)
  const beside = useStore($containersBeside)
  const blocked = anotherWindow && !beside

  useEffect(() => {
    if (blocked) {
      $containersOpen.set(false)
    }
  }, [blocked])

  return open && !blocked ? (
    <Suspense fallback={null}>
      <ContainersWindowBody blocked={blocked} />
    </Suspense>
  ) : null
}
