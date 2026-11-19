// v0.0.9 r2 (F6 spec gap, «any pane type, max two»): Message and Settings split like any other pair of Dock panes.
// Before, both were routes, so opening one navigated away from the other: a drop of Settings on the Message window
// (or of Message on Settings) replaced it ("Settings replaces Message"). Now Settings opens as a PANE beside the
// Message window (`$settingsBesideMessage`), and Message opening over the Settings route keeps Settings as a pane.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { setDockWindowSize } from '@/store/dock-window-size'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { HomeView } from './home-view'
import { $privySession } from './privy-session'
import { $dockDrag } from './window/dock-split'
import {
  $paneArea,
  $panes,
  $settingsBesideMessage,
  registerPane,
  resetPanesForTests,
  setPaneCloser
} from './window/pane-layout'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

const copy = en.desktop.home
const settingsName = en.commandCenter.settings
const FRAME = { left: 100, top: 50, width: 1000, height: 700 }
const RIGHT_X = FRAME.left + 800
const LEFT_X = FRAME.left + 200
const MID_Y = FRAME.top + 300

let where = ''

function LocationProbe() {
  const location = useLocation()

  where = `${location.pathname}${location.search}`

  return null
}

beforeAll(() => {
  stubMenuDomApis()
  stubResizeObserver()
})

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetPanesForTests()
  $privySession.set({ status: 'out' })
  const real = Element.prototype.getBoundingClientRect

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('ic-pane-probe')
      ? ({ ...FRAME, x: FRAME.left, y: FRAME.top, right: 1100, bottom: 750, toJSON: () => ({}) } as DOMRect)
      : real.call(this)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $dockDrag.set(null)
  setDockWindowSize('maximized')
})

function renderHome(mode: 'stage' | 'window', at: string) {
  render(
    <MemoryRouter initialEntries={[at]}>
      <LocationProbe />
      <HomeView mode={mode} onClose={() => undefined} />
    </MemoryRouter>
  )
  act(() => $paneArea.set(FRAME.width))
}

function settingsTile() {
  return screen.getByRole('button', { name: settingsName })
}

function drag(tile: HTMLElement, x: number) {
  fireEvent.pointerDown(tile, { button: 0, clientX: 20, clientY: 300, pointerId: 7 })
  fireEvent.pointerMove(tile, { clientX: x, clientY: MID_Y, pointerId: 7 })

  return {
    preview: () => window.document.querySelector<HTMLElement>('[data-ic-split-preview]'),
    release: () => fireEvent.pointerUp(tile, { button: 0, clientX: x, clientY: MID_Y, pointerId: 7 })
  }
}

describe('Message and Settings, side by side like any two panes', () => {
  it('Settings dropped on the Message window opens BESIDE it (no route change), on the side dropped', () => {
    renderHome('window', '/')
    expect($panes.get().open).toEqual(['message'])

    const d = drag(settingsTile(), RIGHT_X)

    expect(d.preview()!.dataset.side).toBe('right')
    expect(d.preview()!.textContent).not.toContain('replaces')
    d.release()

    // The chat route stays (Message is not replaced); Settings is a pane now.
    expect(where).toBe('/')
    expect($settingsBesideMessage.get()).toBe(true)

    // The Settings window registers when it mounts (contrib/wiring.tsx renders it for the flag): placed on the right.
    act(() => registerPane('settings'))
    expect($panes.get().open).toEqual(['message', 'settings'])
  })

  it('a click on the Settings tile with the Message window up opens Settings beside it too', () => {
    renderHome('window', '/')
    fireEvent.click(settingsTile())

    expect(where).toBe('/')
    expect($settingsBesideMessage.get()).toBe(true)
    act(() => registerPane('settings'))
    expect($panes.get().open).toEqual(['message', 'settings'])
  })

  it('Message dropped on the Settings route keeps Settings as a pane, its tab carried along', () => {
    renderHome('stage', '/settings?tab=billing')
    act(() => registerPane('settings'))

    const d = drag(screen.getByRole('button', { name: copy.message }), LEFT_X)

    expect(d.preview()!.dataset.side).toBe('left')
    d.release()

    expect($settingsBesideMessage.get()).toBe(true)
    // The chat route, with Settings' own query so it stays on Billing.
    expect(where).toBe('/?tab=billing')
    act(() => registerPane('message'))
    expect($panes.get().open).toEqual(['message', 'settings'])
  })

  it('still at most two: a third pane dropped on Settings replaces it, closed by its own close', async () => {
    renderHome('window', '/')
    fireEvent.click(settingsTile())
    act(() => registerPane('settings'))

    const closeSettings = vi.fn(() => $settingsBesideMessage.set(false))

    setPaneCloser('settings', closeSettings)

    const d = drag(screen.getByRole('button', { name: copy.tile.email }), RIGHT_X)

    expect(d.preview()!.textContent).toContain('replaces Settings')
    d.release()
    await act(async () => await Promise.resolve())

    expect(closeSettings).toHaveBeenCalledOnce()
    expect($settingsBesideMessage.get()).toBe(false)
    expect($panes.get().open).toEqual(['message', 'email'])
  })

  it('Message dropped on the Settings route ON Settings replaces it (the route changes, no pane form)', () => {
    renderHome('stage', '/settings')
    act(() => registerPane('settings'))
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    act(() => $paneArea.set(FRAME.width))
    expect($panes.get().open).toEqual(['settings', 'email'])

    drag(screen.getByRole('button', { name: copy.message }), LEFT_X).release()

    expect($settingsBesideMessage.get()).toBe(false)
    expect(where).toBe('/')
  })
})
