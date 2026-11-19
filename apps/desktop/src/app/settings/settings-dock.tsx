/**
 * K100 — the home's Dock windows, out of the Settings chunk. HomeView needs these helpers at boot (the Dock tile, the
 * one-window rule, the host the Settings window portals into); importing them from `settings-window` put the whole
 * Settings window chunk (about 1 MB) in the boot preload. Settings itself stays lazy and imports them from here.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import type { DockItem } from '@/app/home/dock'
import { IcSettings } from '@/app/home/iclone-icons'
import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { $settingsBesideMessage } from '@/app/home/window/pane-layout'
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
 * The econ tile's toggle: a tile toggles its window, except that the second click of a
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
 * Whether the route has Settings open (its tile, an econ app's "Open Setup", a deep link). v0.0.9 F6: Settings no
 * longer closes the econ window when it opens — the two sit side by side as two panes, and the pane layer
 * (home/window/pane-layout.ts) caps the home at two Dock windows, replacing the unfocused one.
 */
export function useSettingsWindowRoute(): boolean {
  const open = useLocation().pathname === SETTINGS_ROUTE
  const [wasOpen, setWasOpen] = useState(open)

  if (open !== wasOpen) {
    setWasOpen(open)

    if (open) {
      $settingsOpenedInApp.set(true)
    }
  }

  return open
}

/**
 * The home's Dock windows: the econ window HomeView shows (its tile toggles it, double-click safe, back after a
 * renderer reload) and the Settings route. v0.0.9 F6: they may sit side by side (two panes at most, pane-layout.ts).
 */
export function useDockWindows<K extends string>(isKind: (value: string) => value is K) {
  const [econ, setEcon] = useState<K | null>(() => recallDockWindow(isKind))
  const lastOpen = useRef<DockOpenStamp | null>(null)
  // Stable: it is the econ window context's `close`; an inline arrow re-rendered every consumer on each home tick.
  const closeEcon = useCallback(() => setEcon(null), [])
  // v0.0.9 r2: Settings is open as its route, or as a pane beside the Message window (pane-layout.ts).
  const settingsRoute = useSettingsWindowRoute()
  const settingsBeside = useStore($settingsBesideMessage)
  const settingsOpen = settingsRoute || settingsBeside

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

  // v0.0.9 F6: a Dock icon dropped on the window opens its econ app (never a toggle: the drop always opens).
  const showEcon = useCallback((kind: K) => setEcon(kind), [])

  return { closeEcon, econ, settingsOpen, settingsRoute, showEcon, toggleEcon }
}

/**
 * v0.0.9 r2 (F6 spec gap): open Settings as a PANE — beside the Message window — instead of navigating to its route
 * (which would replace the chat). Its close (settings-window.tsx `leave` → the shell's onClose) clears it.
 */
export function openSettingsBeside(): void {
  $settingsOpenedInApp.set(true)
  $settingsBesideMessage.set(true)
}

/** Settings' own close while it is a pane (not its route): the pane goes, the route under it stays. */
export function closeSettingsBeside(): void {
  $settingsBesideMessage.set(false)
}

/**
 * The shell's view of Settings as a pane: true while it is open beside (or after) the Message window. The `/settings`
 * route opening (a door that navigates there) takes Settings back as its route: the pane form ends, one Settings.
 */
export function useSettingsPane(settingsRoute: boolean): boolean {
  const beside = useStore($settingsBesideMessage)

  // Runs when the route opens (a change of `settingsRoute` to true) — never when the pane form is set while the route
  // is still up (Message opening over Settings sets it, then leaves the route: that change is to false).
  useEffect(() => {
    if (settingsRoute) {
      closeSettingsBeside()
    }
  }, [settingsRoute])

  return beside
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
