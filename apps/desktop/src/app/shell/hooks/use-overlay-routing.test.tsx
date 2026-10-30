/**
 * The overlay return STACK — the behaviour the owner asked for by name:
 * Settings → (Capabilities | Messaging | Artifacts | Scheduled jobs) opens a
 * closable window, and its ✕ returns to Settings AT THE PANE you left
 * (`?tab=` rides the URL), not to whatever came before Settings. One return
 * slot could not express that journey; the stack does.
 */
import { act, renderHook } from '@testing-library/react'
import { type ReactNode } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { expect, test } from 'vitest'

import { useOverlayRouting } from './use-overlay-routing'

function harness(initialPath: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  )

  return renderHook(
    () => {
      const routing = useOverlayRouting()
      const location = useLocation()
      const navigate = useNavigate()

      return { location, navigate, routing }
    },
    { wrapper }
  )
}

function path(result: { current: { location: { pathname: string; search: string } } }) {
  return `${result.current.location.pathname}${result.current.location.search}`
}

test('closing an overlay opened from chat returns to the chat route', () => {
  const { result } = harness('/')

  act(() => result.current.routing.openAgents())
  expect(result.current.routing.agentsOpen).toBe(true)

  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(path(result)).toBe('/')
})

test('settings → another overlay → ✕ lands back on the very settings pane', () => {
  const { result } = harness('/settings?tab=sessions-bots')

  expect(result.current.routing.settingsOpen).toBe(true)

  // The user clicks a cross-link inside settings: an overlay → overlay
  // navigation, the exact journey the stack exists for.
  act(() => result.current.routing.openAgents())
  expect(result.current.routing.agentsOpen).toBe(true)

  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(path(result)).toBe('/settings?tab=sessions-bots')
  expect(result.current.routing.settingsOpen).toBe(true)
})

test('two overlays deep still unwinds in order, then to the base route', () => {
  const { result } = harness('/settings?tab=sessions-bots')

  act(() => result.current.routing.openAgents())
  expect(result.current.routing.agentsOpen).toBe(true)

  act(() => result.current.routing.toggleCommandCenter())
  expect(result.current.routing.commandCenterOpen).toBe(true)

  // ✕ on the command centre → agents
  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(result.current.routing.agentsOpen).toBe(true)

  // ✕ on agents → settings, same pane
  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(path(result)).toBe('/settings?tab=sessions-bots')

  // ✕ on settings → the base (pre-overlay) route
  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(path(result)).toBe('/')
})

test('a settings tab switch never pushes — closing must not walk back through tabs', () => {
  const { result } = harness('/settings?tab=model')

  // Same view, different URL: the guard is view-identity, not path-identity.
  act(() => result.current.routing.openCommandCenterSection('system'))
  expect(result.current.routing.commandCenterOpen).toBe(true)

  // ONE step out, not two, and that is the change front K5 made rather than a
  // regression: Command Center is a Settings TAB now, so this navigation IS
  // the tab switch the test is named for and the stack must not record it.
  // (While Command Center was an overlay of its own, the same call pushed
  // `/settings?tab=model` and the ✕ walked back through it.) The pane-to-pane
  // round trip did not disappear with it — `toggleCommandCenter` keeps its own
  // return (`settingsReturnRef`), which the next test pins.
  act(() => result.current.routing.closeOverlayToPreviousRoute())
  expect(path(result)).toBe('/')
})

test('⌘. inside settings returns to the pane it left, not out of settings', () => {
  const { result } = harness('/settings?tab=model')

  act(() => result.current.routing.toggleCommandCenter())
  expect(path(result)).toBe('/settings?tab=command-center')

  act(() => result.current.routing.toggleCommandCenter())
  expect(path(result)).toBe('/settings?tab=model')
})

test('a moved surface opened at its RETIRED path lands on its pane', () => {
  const { result } = harness('/messaging')

  expect(path(result)).toBe('/settings?tab=messaging')
  expect(result.current.routing.settingsOpen).toBe(true)
})

test('a retired command-center link keeps its ?section=', () => {
  const { result } = harness('/command-center?section=usage')

  expect(path(result)).toBe('/settings?tab=command-center&section=usage')
  expect(result.current.routing.commandCenterOpen).toBe(true)
})

test('the redirect REPLACES, so Back never walks into the retired path', () => {
  const { result } = harness('/')

  act(() => result.current.navigate('/command-center'))
  expect(path(result)).toBe('/settings?tab=command-center')

  // One Back from the pane must leave Settings, not re-enter `/command-center`
  // and bounce forward again.
  act(() => result.current.navigate(-1))
  expect(path(result)).toBe('/')
})

test('a retired path that did NOT move is left alone (it lands on home)', () => {
  const { result } = harness('/profiles')

  expect(path(result)).toBe('/profiles')
  expect(result.current.routing.homeOpen).toBe(true)
})

test('resetOverlayReturnRoute clears the stack too', () => {
  const { result } = harness('/settings?tab=model')

  act(() => result.current.routing.openAgents())
  act(() => result.current.routing.resetOverlayReturnRoute())
  act(() => result.current.routing.closeOverlayToPreviousRoute())

  expect(path(result)).toBe('/')
})

test('resetOverlayReturnRoute keeps home as the return route (U1p2-T3)', () => {
  // Boot order in the app: the route is recorded first, then the gateway's
  // connection switch resets. Closing Settings must land home, not on the
  // Message window.
  const { result } = harness('/home')

  act(() => result.current.routing.resetOverlayReturnRoute())
  act(() => result.current.navigate('/settings'))
  act(() => result.current.routing.closeOverlayToPreviousRoute())

  expect(path(result)).toBe('/home')
})

test('resetOverlayReturnRoute drops a session-bound return route', () => {
  const { result } = harness('/some-session-id')

  act(() => result.current.routing.resetOverlayReturnRoute())
  act(() => result.current.navigate('/settings'))
  act(() => result.current.routing.closeOverlayToPreviousRoute())

  expect(path(result)).toBe('/')
})
