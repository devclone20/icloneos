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

/** The Dock tile; pass a stable `onOpen`. It closes whichever Dock window is open: one window at a time. */
export function useContainersDockItem(hint: string | undefined, onOpen: () => void): DockItem {
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
      }
    }),
    [copy.tile, hint, onOpen, open]
  )
}

/** `blocked`: another Dock window took the stage. The window's code loads on its first open, never at boot. */
export function LazyContainersWindow({ blocked }: { blocked: boolean }) {
  const open = useStore($containersOpen)

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
