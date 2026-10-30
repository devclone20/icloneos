/**
 * Wiring surfaces — each pane is its own memoized component. Every surface
 * reads the reactive state it renders from at the leaf (its own atom
 * subscriptions) and reaches the controller's callbacks through the stable
 * `actions` bag, so a state change scoped to one surface (or a bare
 * wiring-controller tick) never re-renders another. This is what keeps the
 * layout tree's zones independently rendered — the whole point of the shell.
 */

import { useStore } from '@nanostores/react'
import { type ComponentProps, memo, type ReactNode, Suspense, useMemo } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

import { ChatView } from '../chat'
import { ChatSidebar } from '../chat/sidebar'
import {
  COMMAND_CENTER_ROUTE,
  contributedRoutes,
  MESSAGING_ROUTE,
  NEW_CHAT_ROUTE,
  PROFILES_ROUTE,
  ROUTES_AREA,
  sessionRoute
} from '../routes'
import { ModelMenuPanel } from '../shell/model-menu-panel'

import { latestChatActions, latestSidebarActions } from './latest-actions'
import type { SidebarActions, WiringActions } from './types'

// Same lazy-view split as DesktopController — pages load on demand. The
// full-page views the workspace route table mounts live here; overlay views
// (agents/settings/…) are the controller's and stay in wiring.tsx.

function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}

export const SidebarSurface = memo(function SidebarSurface({
  actions,
  currentView
}: {
  actions: SidebarActions
  currentView: ComponentProps<typeof ChatSidebar>['currentView']
}) {
  const latestActions = useMemo(() => latestSidebarActions(actions), [actions])

  return <ChatSidebar currentView={currentView} {...latestActions} />
})

/** The workspace pane: the real route table (chat + full-page views + plugin
 *  routes). Subscribes to the gateway instance/state and ROUTES_AREA itself;
 *  the voice cap arrives as a prop. ChatView subscribes to its own session
 *  atoms, so streaming never round-trips through the controller. */
export const ChatRoutesSurface = memo(function ChatRoutesSurface({
  actions,
  maxVoiceRecordingSeconds
}: {
  actions: WiringActions
  maxVoiceRecordingSeconds?: number
}) {
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  useContributions(ROUTES_AREA)
  const routeContributions = contributedRoutes()

  const modelMenuContent = useMemo(
    () =>
      gatewayState === 'open' ? (
        <ModelMenuPanel
          gateway={gateway || undefined}
          onSelectModel={actions.selectModel}
          profile={activeGatewayProfile}
          requestGateway={actions.requestGateway}
        />
      ) : null,
    [actions, activeGatewayProfile, gateway, gatewayState]
  )

  const chatActions = useMemo(() => latestChatActions(actions), [actions])

  const chatView = (
    <ChatView
      gateway={gateway}
      maxVoiceRecordingSeconds={maxVoiceRecordingSeconds}
      modelMenuContent={modelMenuContent}
      {...chatActions}
    />
  )

  // FULL-PAGE views (not chat): a page is not a tab-able surface, so the zone's
  // tab strip stands down while one is showing. That is `paneChrome.headerVeto`
  // on the contribution, not a DOM marker — the `data-zone-no-header` attribute
  // that used to ride this wrapper gated a body double-click toggle that no
  // longer exists, and nothing has read it since.
  const page = (view: ReactNode) => (
    <div className="contents">
      <Suspense fallback={null}>{view}</Suspense>
    </div>
  )

  return (
    <Routes>
      <Route element={chatView} index />
      <Route element={chatView} path=":sessionId" />
      {/* skills/messaging/artifacts render as OVERLAYS in wiring.tsx now
          (owner rule: closable windows, never a full-page trap) — the zone
          holds their routes open like settings' so deep links still resolve. */}
      <Route element={null} path="skills" />
      <Route element={null} path="messaging" />
      <Route element={null} path="artifacts" />
      <Route element={null} path="agents" />
      <Route element={null} path="home" />
      {/* Messaging and Command Center MOVED into Settings (front K5), so these
          two paths are answered here for the same reason `profiles` is below:
          nothing declares them any more, `:sessionId` would otherwise match
          them and open a phantom session, and `appViewForPath` resolves a
          REMOVED_ROUTES path to 'home' before this surface ever routes. Their
          panes' addresses are MESSAGING_PANE and COMMAND_CENTER_PANE. */}
      <Route element={null} path={COMMAND_CENTER_ROUTE.slice(1)} />
      <Route element={null} path={MESSAGING_ROUTE.slice(1)} />
      <Route element={null} path="cron" />
      {/* Profiles MOVED into Settings (front K3), so nothing declares this path
          any more. It is answered here exactly like the overlay paths above —
          `:sessionId` would otherwise match it and open a phantom session —
          and the address lands on home, because `appViewForPath` resolves a
          REMOVED_ROUTES path to 'home' before this surface ever routes. A
          <Navigate> here cannot run: r2 shipped one and lab 2 measured
          `#/profiles` landing on home with the Dock, the same 180 characters of
          body text as `#/artifacts` (2026-10-20, CDP 9224). The pane's own
          address is PROFILES_PANE, reached from the rail pill and
          `nav.profiles`. */}
      <Route element={null} path={PROFILES_ROUTE.slice(1)} />
      <Route element={null} path="settings" />
      <Route element={null} path="starmap" />
      <Route element={null} path="webhooks" />
      {/* Registry-contributed pages (core features + plugins) render in the
          workspace pane like any built-in view — behind the same blast wall
          as every other contribution mount. */}
      {routeContributions.map(route => (
        <Route
          element={page(
            <ContribBoundary id={route.key}>
              <ContribRender render={route.render} />
            </ContribBoundary>
          )}
          key={route.key}
          path={route.path.slice(1)}
        />
      ))}
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
      <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
      <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
    </Routes>
  )
})
