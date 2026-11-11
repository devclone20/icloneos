// Proof run, chat window open: "the Containers tile does nothing". The chat window opens maximized, so the Dock is tucked
// past the left edge until the pointer reaches it (dock-autohide.ts); a press at the tile's rect without that never lands.
// The click path itself holds, pinned here; what was really broken is the chord: the focus lives in the composer there.
// The chat layout here is wiring.tsx's rule: the chat route shows the Message window over home.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { HashRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOME_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { stubResizeObserver } from '@/test/jsdom'

import { $containersOpen } from './containers/containers-dock'
import { HomeView } from './home-view'
import { $privySession } from './privy-session'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

vi.mock('@/app/contrib/context', () => ({
  WiredPane: ({ part }: { part: string }) => <div data-test-wired={part} />
}))

function ChatLayout() {
  const { pathname } = useLocation()

  return <HomeView mode={pathname === NEW_CHAT_ROUTE ? 'window' : 'stage'} onClose={() => undefined} />
}

// HashRouter as in main.tsx: it commits a navigation in a transition, after the flag the tile sets.
const mount = (route: string) => {
  window.location.hash = route

  return render(
    <HashRouter>
      <ChatLayout />
    </HashRouter>
  )
}

const pane = () => window.document.querySelector('[data-ic-window="containers"]')
// The pane's own code is the lazy chunk this tile loads on its first open.
const LAZY_LOAD = { timeout: 30_000 }
// What a US keyboard sends for the chord: shift makes the 8 a star, the physical key stays Digit8.
const CHORD_8 = { code: 'Digit8', key: '*', metaKey: true, shiftKey: true }
const tile = (id: string) => window.document.querySelector<HTMLElement>(`.dock__icon[data-dock="${id}"]`)!
const messageWindow = () => window.document.querySelector('[data-test-wired]')

beforeEach(() => {
  stubResizeObserver()
  window.localStorage.clear()
  $privySession.set({ status: 'out' })
  $containersOpen.set(false)
})

afterEach(() => {
  cleanup()
  $containersOpen.set(false)
})

describe('Containers from the Dock while another window is open', { timeout: 60_000 }, () => {
  it('the tile opens the pane with the chat window open, in its place', async () => {
    mount(NEW_CHAT_ROUTE)
    expect(messageWindow()).not.toBeNull()

    fireEvent.click(tile('containers'))

    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)
    expect($containersOpen.get()).toBe(true)
    expect(messageWindow()).toBeNull()
  })

  it('the chord opens it from the composer, where the focus is while the chat window is open', async () => {
    mount(NEW_CHAT_ROUTE)

    const composer = window.document.body.appendChild(window.document.createElement('textarea'))

    composer.focus()
    fireEvent.keyDown(composer, CHORD_8)
    composer.remove()

    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)
  })

  it('the chord twice from the chat returns to the chat, from the landing to the landing', async () => {
    mount(NEW_CHAT_ROUTE)
    expect(messageWindow()).not.toBeNull()

    fireEvent.keyDown(window, CHORD_8)
    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)
    expect(messageWindow()).toBeNull()

    fireEvent.keyDown(window, CHORD_8)
    await waitFor(() => expect(pane()).toBeNull())
    await waitFor(() => expect(messageWindow()).not.toBeNull())
    cleanup()

    mount(HOME_ROUTE)
    fireEvent.keyDown(window, CHORD_8)
    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)
    fireEvent.keyDown(window, CHORD_8)
    await waitFor(() => expect(pane()).toBeNull())
    expect(messageWindow()).toBeNull()
  })

  it('an editor that claims the chord keeps it', async () => {
    mount(NEW_CHAT_ROUTE)

    const composer = window.document.body.appendChild(window.document.createElement('textarea'))

    composer.addEventListener('keydown', event => event.preventDefault())
    fireEvent.keyDown(composer, CHORD_8)
    composer.remove()

    expect($containersOpen.get()).toBe(false)
  })

  it('the tile opens the pane from Settings too', async () => {
    mount(SETTINGS_ROUTE)

    fireEvent.click(tile('containers'))

    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)
  })

  it('still one window at a time: the chat tile closes an open pane', async () => {
    mount(HOME_ROUTE)
    act(() => $containersOpen.set(true))
    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)

    fireEvent.click(tile('chat'))

    await waitFor(() => expect(messageWindow()).not.toBeNull())
    expect($containersOpen.get()).toBe(false)
    expect(pane()).toBeNull()
  })

  it('still one window at a time: an econ tile closes an open pane', async () => {
    mount(HOME_ROUTE)
    act(() => $containersOpen.set(true))
    await waitFor(() => expect(pane()).not.toBeNull(), LAZY_LOAD)

    fireEvent.click(tile('bank'))

    await waitFor(() => expect($containersOpen.get()).toBe(false))
    expect(pane()).toBeNull()
  })
})
