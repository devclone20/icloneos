/**
 * K100 — the home's Dock windows, out of the Settings chunk. HomeView needs these helpers at boot (the Dock tile, the
 * one-window rule, the host the Settings window portals into); importing them from `settings-window` put the whole
 * Settings window chunk (about 1 MB) in the boot preload. Settings itself stays lazy and imports them from here.
 */
import { atom } from 'nanostores'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import type { DockItem } from '@/app/home/dock'
import { IcSettings } from '@/app/home/iclone-icons'
import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { SETTINGS_ROUTE } from '@/app/routes'

/** The home layer's root while HomeView is mounted; null in auxiliary windows. */
export const $dockWindowHost = atom<HTMLElement | null>(null)

/** HomeView's root ref: the Settings window portals into that layer. */
export function publishDockWindowHost(element: HTMLElement | null) {
  $dockWindowHost.set(element)
}

/**
 * Whether Settings was opened by a navigation in this renderer's lifetime. The overlay routing remembers where to
 * return only in memory, so a Settings restored by a reload (or a cold start on a deep link) closes to home itself.
 */
export const $settingsOpenedInApp = atom(false)

/**
 * The econ window open in this renderer, kept across a reload only: sessionStorage dies with the window, so a
 * relaunch still lands on the empty home. Storage denied → nothing remembered.
 */
function recallDockWindow<K extends string>(isKind: (value: string) => value is K): K | null {
  try {
    const stored = window.sessionStorage.getItem(ICLONE_STORAGE.dockWindow.key)

    return stored !== null && isKind(stored) ? stored : null
  } catch {
    return null
  }
}

function rememberDockWindow(kind: string | null) {
  try {
    if (kind === null) {
      window.sessionStorage.removeItem(ICLONE_STORAGE.dockWindow.key)
    } else {
      window.sessionStorage.setItem(ICLONE_STORAGE.dockWindow.key, kind)
    }
  } catch {
    // Storage denied: the window simply does not survive a reload.
  }
}

/** A second release on the same Dock tile inside this window is the tail of a double-click, not a close. */
export const DOCK_REPEAT_MS = 500

interface DockOpenStamp {
  at: number
  kind: string
}

/**
 * The econ half of the one-Dock-window rule: a tile toggles its window, except that the second click of a
 * double-click keeps open what the first one opened (the macOS Dock, and the Message tile, never toggle on it).
 */
export function nextDockWindow<K extends string>(
  current: K | null,
  kind: K,
  lastOpen: DockOpenStamp | null,
  now: number
): K | null {
  if (current !== kind) {
    return kind
  }

  return lastOpen?.kind === kind && now - lastOpen.at < DOCK_REPEAT_MS ? kind : null
}

/**
 * Settings' half of the home's one-Dock-window-at-a-time rule: whether the route has Settings open, and the econ
 * window closed in the same render when Settings opens from anywhere (its tile, an econ app's "Open Setup", a deep
 * link). Call it from HomeView, which owns the econ state.
 */
export function useSettingsWindowRoute(closeEcon: () => void): boolean {
  const open = useLocation().pathname === SETTINGS_ROUTE
  const [wasOpen, setWasOpen] = useState(open)

  if (open !== wasOpen) {
    setWasOpen(open)

    if (open) {
      $settingsOpenedInApp.set(true)
      closeEcon()
    }
  }

  return open
}

/**
 * The home's Dock windows, one at a time: the econ window HomeView shows (its tile toggles it, double-click safe,
 * back after a renderer reload) and the Settings route, which closes the econ window whenever it opens.
 */
export function useDockWindows<K extends string>(isKind: (value: string) => value is K) {
  const [econ, setEcon] = useState<K | null>(() => recallDockWindow(isKind))
  const lastOpen = useRef<DockOpenStamp | null>(null)
  // Stable: it is the econ window context's `close`; an inline arrow re-rendered every consumer on each home tick.
  const closeEcon = useCallback(() => setEcon(null), [])
  const settingsOpen = useSettingsWindowRoute(closeEcon)

  useEffect(() => rememberDockWindow(econ), [econ])

  const toggleEcon = useCallback(
    (kind: K) => {
      const now = performance.now()
      const next = nextDockWindow(econ, kind, lastOpen.current, now)

      if (next === kind && econ !== kind) {
        lastOpen.current = { at: now, kind }
      }

      setEcon(next)
    },
    [econ]
  )

  return { closeEcon, econ, settingsOpen, toggleEcon }
}

/**
 * The Dock's Settings tile, lit while the Settings window is open. Selecting the
 * lit tile keeps the open window where it is (its tab and sub-view), so
 * `onSelect` only ever opens Settings. The caller names it from its own
 * catalogue (`label`), as it names the econ tiles: one source per word.
 */
export function settingsDockItem({
  active,
  hint,
  onSelect
}: Pick<DockItem, 'active' | 'hint' | 'onSelect'>): Omit<DockItem, 'label'> {
  return {
    id: 'settings',
    icon: <IcSettings size={22} />,
    tone: 'system',
    active,
    hint,
    onSelect: () => {
      if (!active) {
        onSelect()
      }
    }
  }
}
