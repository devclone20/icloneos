/**
 * Settings opens as a Dock window: the same IcWindow chassis as Message and
 * the EconomyOS windows (one fixed frame from the shared frame tokens, one
 * plate, the close · expand/retract · opacity column, no mouse resize), laid
 * over the home stage instead of a full-window scrim.
 *
 * The window is portalled into the home layer so the home's hit rules and
 * stacking apply (the econ rung, the Dock above it). A window without a home
 * layer (the HUD and other auxiliary windows) keeps the OverlayView card.
 * Either way the route stays `/settings?…`, so every deep link is untouched.
 */
import '@/app/home/econ/econ.css'

import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactNode, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { IcWindow, useWindowExpanded } from '@/app/home/window'
import { HOME_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { isAuxiliaryWindow } from '@/store/windows'

import { OverlayView } from '../overlays/overlay-view'
import { OVERLAY_SURFACE_MARKER, useOverlaySurface } from '../overlays/use-overlay-surface'

import { $dockWindowHost, $settingsOpenedInApp } from './settings-dock'
import type { SettingsView } from './types'

export const DEFAULT_SETTINGS_TAB: SettingsView = 'config:model'

/** The sub-view param each Settings tab owns; the other tabs' params never ride along on a tab change. */
const TAB_SUB_VIEW: Partial<Record<SettingsView, string>> = { keys: 'kview', providers: 'pview' }

/** The search string for a Settings tab: `tab` (always written — a bare `/settings` is the landing, so even the
 *  default tab needs its own door, tester U5-p2b-03) plus the sub-view param that tab owns. */
export function settingsTabSearch(search: string, tab: SettingsView): string {
  const params = new URLSearchParams()
  params.set('tab', tab)

  const own = TAB_SUB_VIEW[tab]
  const value = own ? new URLSearchParams(search).get(own) : null

  if (own && value) {
    params.set(own, value)
  }

  const qs = params.toString()

  return qs ? `?${qs}` : ''
}

const BODY_STYLE = { '--titlebar-height': '0px' } as CSSProperties

/** The Dock's Settings tile, the control that opens this window. */
const SETTINGS_DOCK_TILE_SELECTOR = 'button[data-dock="settings"]'
/** The rail row of the current pane (an OverlayNav link). */
const CURRENT_RAIL_ROW_SELECTOR = 'button[data-tour^="nav-"][aria-current="page"]'

// Only when nothing else holds the keyboard: a field a pane focused itself,
// or the control the person is on, is never taken away.
function focusWhenUnheld(selector: string) {
  const active = document.activeElement

  if (active && active !== document.body) {
    return
  }

  document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
}

/** Returns the keyboard to the Dock tile that opened Settings (U1-p2b-11 / U4-p2b-02). */
export function focusSettingsDockTile() {
  focusWhenUnheld(SETTINGS_DOCK_TILE_SELECTOR)
}

/** The command palette's chassis (command-palette/sheet.tsx), in the document until its exit fade ends. */
const COMMAND_PALETTE_ROOT_SELECTOR = '.icp-root'
const PALETTE_EXIT_POLL_MS = 50
const PALETTE_EXIT_MAX_MS = 1500

/**
 * Hands the keyboard to the current rail row once the palette has left the
 * document (U3-p2b-11): the sheet fades before it unmounts, its input holding
 * focus until then, and its own restore yields to whatever holds focus after
 * an action. Returns the cancel (the effect's cleanup).
 */
export function focusCurrentRailRowAfterPalette(): () => void {
  const started = Date.now()

  const timer = window.setInterval(() => {
    if (document.querySelector(COMMAND_PALETTE_ROOT_SELECTOR) && Date.now() - started < PALETTE_EXIT_MAX_MS) {
      return
    }

    window.clearInterval(timer)
    focusWhenUnheld(CURRENT_RAIL_ROW_SELECTOR)
  }, PALETTE_EXIT_POLL_MS)

  return () => window.clearInterval(timer)
}

/** The document URL and kind of a navigation entry (`PerformanceNavigationTiming`). */
interface NavigationEntry {
  name: string
  type: string
}

/**
 * Whether this renderer was reloaded while Settings was open on a pane: the
 * reload keeps the pane's `?tab=` in the hash, and the first Settings mount
 * strips it and paints the landing (U2-p2b-05). A reload on any other route
 * is not that: the next deep link into Settings opens its pane (UF3A-r1-T1).
 * Read from the navigation entry's URL, not the live hash: this module can be
 * evaluated long after the reload, on the deep link itself.
 */
export function settingsReloadPending(entries: readonly NavigationEntry[] = performanceNavigationEntries()): boolean {
  const route = `#${SETTINGS_ROUTE}`

  return entries.some(entry => {
    const at = entry.name.indexOf('#')
    const hash = at < 0 ? '' : entry.name.slice(at)

    return entry.type === 'reload' && (hash === route || hash.startsWith(`${route}?`))
  })
}

function performanceNavigationEntries(): NavigationEntry[] {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return []
  }

  return (performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]).map(({ name, type }) => ({
    name,
    type
  }))
}

interface SettingsShellProps {
  children: ReactNode
  closeLabel: string
  onClose: () => void
  /** The search pill: in the window's header band, or riding the card's top edge. */
  search: ReactNode
  title: string
}

interface SettingsWindowProps extends SettingsShellProps {
  host: HTMLElement
}

function SettingsWindow({ children, closeLabel, host, onClose, search, title }: SettingsWindowProps) {
  const copy = useI18n().t.desktop.home
  const { expanded, retract, toggle: toggleExpanded } = useWindowExpanded('settings')
  // The scope (trap + marker) has no box of its own; focus lands on the body.
  const focusRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const leave = useCallback(() => {
    if ($settingsOpenedInApp.get()) {
      onClose()
    } else {
      navigate(HOME_ROUTE, { replace: true })
    }

    // Settings is a route: by the time the surface's focus restore runs, the
    // Dock tile that opened it has already lost focus, so the restore lands on
    // <body>. After the route commits, put the keyboard back on the tile
    // (testers U1-p2b-11 / U4-p2b-02) unless something else already took it.
    window.setTimeout(focusSettingsDockTile, 0)
  }, [navigate, onClose])

  // Escape retracts an expanded window before it would close it (doc 07 #7; STAGE tester 1 W-1): the first
  // Escape brings the frame back, the next one leaves.
  const scopeRef = useOverlaySurface<HTMLDivElement>(expanded ? retract : leave, { focusRef })

  const close = useCallback(() => {
    triggerHaptic('close')
    leave()
  }, [leave])

  return createPortal(
    <div className="contents" ref={scopeRef} {...OVERLAY_SURFACE_MARKER}>
      <IcWindow
        expanded={expanded}
        head={
          <>
            <h2>{title}</h2>
            <div className="mx-auto">{search}</div>
          </>
        }
        id="settings"
        kind="settings"
        label={copy.windowLabel(title)}
        labels={{
          close: closeLabel,
          expand: copy.expandWindow(title),
          retract: copy.retractWindow(title),
          opacity: copy.windowOpacity(title)
        }}
        onClose={close}
        onToggleExpanded={toggleExpanded}
        placement="self"
      >
        {/* The window's type scale is the econ apps'; the panes keep the app's own. The header band already
            clears the titlebar, so the split layout's titlebar clearance is zero here. */}
        <div
          className="flex min-h-0 flex-1 flex-col text-base text-foreground outline-none"
          ref={focusRef}
          style={BODY_STYLE}
          tabIndex={-1}
        >
          {children}
        </div>
      </IcWindow>
    </div>,
    host
  )
}

export function SettingsShell(props: SettingsShellProps) {
  const host = useStore($dockWindowHost)

  if (host) {
    return <SettingsWindow {...props} host={host} />
  }

  // The main window always mounts the home layer under Settings (contrib/wiring.tsx `showHome`); a cold start straight
  // into /settings waits the few frames for it instead of flashing the card and remounting every pane.
  if (!isAuxiliaryWindow()) {
    return null
  }

  return (
    <OverlayView closeLabel={props.closeLabel} edgeBadge={props.search} onClose={props.onClose}>
      {props.children}
    </OverlayView>
  )
}
