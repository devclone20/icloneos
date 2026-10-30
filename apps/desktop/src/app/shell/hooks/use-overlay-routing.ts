import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { type CommandCenterSection } from '@/app/command-center'
import {
  AGENTS_ROUTE,
  appViewForPath,
  COMMAND_CENTER_PANE,
  COMMAND_CENTER_PANE_TAB,
  isOverlayView,
  movedRoutePane,
  NEW_CHAT_ROUTE,
  routePathname
} from '@/app/routes'

export function useOverlayRouting() {
  const location = useLocation()
  const navigate = useNavigate()

  const currentView = appViewForPath(location.pathname)
  const settingsOpen = currentView === 'settings'
  const homeOpen = currentView === 'home'
  // Command Center is a Settings TOPIC since front K5, so "open" is read off
  // the rail's own param instead of a view of its own. `toggleCommandCenter`
  // (⌘.) still toggles, and `isOverlayView('command-center')` still answers
  // true for the reserved path, which is what keeps the legacy shell covered.
  const commandCenterOpen = settingsOpen && new URLSearchParams(location.search).get('tab') === COMMAND_CENTER_PANE_TAB
  const agentsOpen = currentView === 'agents'
  const starmapOpen = currentView === 'starmap'
  const cronOpen = currentView === 'cron'
  const webhooksOpen = currentView === 'webhooks'
  const skillsOpen = currentView === 'skills'
  const artifactsOpen = currentView === 'artifacts'
  const chatOpen = currentView === 'chat'
  const overlayOpen = isOverlayView(currentView)

  // A MOVED surface's old address lands on its pane, not on home (front K5
  // r2). `appViewForPath` resolves `/messaging` and `/command-center` to the
  // `home` VIEW — that is what keeps the chat surface from reading them as
  // session ids — but the location itself is rewritten here, with `?section=`
  // carried through, so a bookmark, an external link or a door that still
  // addresses the old path reaches the Settings pane instead of a surface that
  // no longer answers. `replace`, so Back does not walk into the retired path.
  const movedPane = movedRoutePane(`${location.pathname}${location.search}`)

  useEffect(() => {
    if (movedPane) {
      navigate(movedPane, { replace: true })
    }
  }, [movedPane, navigate])

  // Overlay routes stash where to go on close. One slot was not enough:
  // Settings cross-links into Skills/Messaging/Artifacts — overlays themselves
  // now — and closing one of those must return to Settings AT ITS PANE
  // (`/settings?tab=…`; the pane rides the URL), not to whatever came before
  // Settings. So an overlay → different-overlay transition PUSHES the departing
  // overlay's full path and close POPS it; leaving overlays entirely clears the
  // stack and re-bases the plain return path. Same-view URL changes (a Settings
  // tab switch) never push — closing must not walk back through tabs.
  const returnPathRef = useRef(NEW_CHAT_ROUTE)
  const overlayStackRef = useRef<string[]>([])
  const lastLocationRef = useRef<{ fullPath: string; view: ReturnType<typeof appViewForPath> } | null>(null)
  // A close-driven navigation must not itself push: popping settings off the
  // stack and then pushing the overlay we just closed would ping-pong forever
  // (close messaging → settings, close settings → messaging, …).
  const poppingRef = useRef(false)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const fullPath = `${location.pathname}${location.search}${location.hash}`
    const previous = lastLocationRef.current

    if (overlayOpen) {
      if (!poppingRef.current && previous && previous.view !== currentView && isOverlayView(previous.view)) {
        // Cap the stack: a pathological loop (A opens B opens A …) must not
        // grow it without bound. Eight levels is far past any real journey.
        overlayStackRef.current = [...overlayStackRef.current.slice(-7), previous.fullPath]
      }
    } else {
      overlayStackRef.current = []
      returnPathRef.current = fullPath
    }

    poppingRef.current = false
    lastLocationRef.current = { fullPath, view: currentView }
  }, [currentView, location.hash, location.pathname, location.search, overlayOpen])

  // The pane reads `?section=` itself (`useRouteEnumParam` over all four
  // sections), so this only has to put the section on the URL — and it carries
  // ALL four now, where the old overlay's hand-written list of three could
  // never open `maintenance`.
  const openCommandCenterSection = useCallback(
    (section: CommandCenterSection) => navigate(`${COMMAND_CENTER_PANE}&section=${section}`),
    [navigate]
  )

  // A connection switch drops return paths bound to the old connection's
  // sessions. Home is connection-free and must survive it: the reset fires at
  // boot AFTER the first route is recorded, so a launch on /home sent the
  // first Settings close to the Message window (U1p2-T3).
  const resetOverlayReturnRoute = useCallback(() => {
    if (appViewForPath(routePathname(returnPathRef.current)) === 'chat') {
      returnPathRef.current = NEW_CHAT_ROUTE
    }

    overlayStackRef.current = []
  }, [])

  const closeOverlayToPreviousRoute = useCallback(() => {
    const stacked = overlayStackRef.current.pop()

    poppingRef.current = true
    navigate(stacked ?? (returnPathRef.current || NEW_CHAT_ROUTE), { replace: true })
  }, [navigate])

  // Opening the pane from another Settings pane is a same-view navigation, so
  // the overlay stack above cannot record it (by design: a tab switch must not
  // become a step the ✕ walks back through). ⌘. therefore remembers the pane
  // it left by itself — without this, pressing ⌘. twice inside Settings left
  // Settings altogether instead of returning to the pane you were reading.
  const settingsReturnRef = useRef<null | string>(null)

  const toggleCommandCenter = useCallback(() => {
    if (commandCenterOpen) {
      const back = settingsReturnRef.current

      settingsReturnRef.current = null

      if (back) {
        navigate(back, { replace: true })
      } else {
        closeOverlayToPreviousRoute()
      }

      return
    }

    settingsReturnRef.current = settingsOpen ? `${location.pathname}${location.search}` : null
    navigate(COMMAND_CENTER_PANE)
  }, [closeOverlayToPreviousRoute, commandCenterOpen, location.pathname, location.search, navigate, settingsOpen])

  const openAgents = useCallback(() => navigate(AGENTS_ROUTE), [navigate])

  return {
    agentsOpen,
    artifactsOpen,
    chatOpen,
    homeOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    currentView,
    openAgents,
    openCommandCenterSection,
    resetOverlayReturnRoute,
    settingsOpen,
    skillsOpen,
    starmapOpen,
    toggleCommandCenter,
    webhooksOpen
  }
}
