// v0.0.9 F6 · owner addition (18 Nov) on the real HomeView: drag a Dock icon onto the window to split it. Two econ
// apps side by side (they used to share one chassis, so a second one replaced the first), Containers beside another
// pane (its one-window rule closed it), and the drop always side by side even with "open maximized" in Settings.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { setDockWindowSize } from '@/store/dock-window-size'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $containersOpen } from './containers/containers-dock'
import { ECON_APPS } from './econ/registry'
import { HomeView } from './home-view'
import { ICLONE_STORAGE } from './lib/storage-keys'
import { $privySession } from './privy-session'
import { $stagePlace } from './stage3d-window/handover'
import { $dockDrag } from './window/dock-split'
import { $paneArea, $paneArrangement, $panes, resetPanesForTests } from './window/pane-layout'

vi.mock('./stage3d', () => ({
  Stage3D: ({ modelUrl }: { modelUrl: string }) => <div data-model={modelUrl} data-testid="stage3d" />
}))

const copy = en.desktop.home
const FRAME = { left: 100, top: 50, width: 1000, height: 700 }
const RIGHT_X = FRAME.left + 800
const LEFT_X = FRAME.left + 200
const MID_Y = FRAME.top + 300
const ECON_TITLE = { acp: ECON_APPS.acp.title, email: ECON_APPS.email.title }
const win = (id: string) => window.document.querySelector<HTMLElement>(`[data-ic-window="${id}"]`)

beforeAll(() => {
  stubMenuDomApis()
  stubResizeObserver()
})

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetPanesForTests()
  $privySession.set({ status: 'out' })
  // The frame, as the pane probe would measure it in the app.
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
  $containersOpen.set(false)
  $stagePlace.set('docked')
  $dockDrag.set(null)
  setDockWindowSize('maximized')
})

function renderHome() {
  render(
    <MemoryRouter>
      <HomeView mode="stage" onClose={() => undefined} />
    </MemoryRouter>
  )
  act(() => $paneArea.set(FRAME.width))
}

function dragTile(name: string, x: number) {
  const tile = screen.getByRole('button', { name })

  fireEvent.pointerDown(tile, { button: 0, clientX: 20, clientY: 300, pointerId: 7 })
  fireEvent.pointerMove(tile, { clientX: x, clientY: MID_Y, pointerId: 7 })

  return {
    preview: () => window.document.querySelector<HTMLElement>('[data-ic-split-preview]'),
    release: (at = x) => fireEvent.pointerUp(tile, { button: 0, clientX: at, clientY: MID_Y, pointerId: 7 })
  }
}

describe('HomeView — drag a Dock icon onto the window', () => {
  it('Email open (maximized by default), ACP Market dropped on the right: two econ panes half and half', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    expect(win('email')!.dataset.expanded).toBe('true')

    const drag = dragTile(copy.tile.acp, RIGHT_X)

    expect(drag.preview()!.dataset.side).toBe('right')
    drag.release()

    expect(win('email')).not.toBeNull()
    expect(win('acp-market')).not.toBeNull()
    // Side by side means framed: Email came back from Fill, ACP Market opened at its usual size.
    expect(win('email')!.dataset.expanded).toBeUndefined()
    expect(win('acp-market')!.dataset.expanded).toBeUndefined()
    expect(win('email')!.dataset.pane).toBe('left')
    expect(win('acp-market')!.dataset.pane).toBe('right')
    expect($paneArrangement.get()).toMatchObject({ kind: 'split', left: 'email', right: 'acp-market' })
    expect(screen.getAllByRole('slider')).toHaveLength(1)
    expect(drag.preview()).toBeNull()
    // The keyboard is in the pane that was dropped.
    await vi.waitFor(() => expect(win('acp-market')!.contains(window.document.activeElement)).toBe(true))
  })

  it('a third drop replaces the pane on that side; the other one stays, the keyboard in the newcomer', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    dragTile(copy.tile.acp, RIGHT_X).release()

    const drag = dragTile(copy.tile.wallet, LEFT_X)

    expect(drag.preview()!.textContent).toContain('Wallet replaces Email')
    drag.release()
    await act(async () => await Promise.resolve())

    expect(win('email')).toBeNull()
    expect(win('wallet')).not.toBeNull()
    expect(win('acp-market')).not.toBeNull()
    expect($panes.get().open).toEqual(['wallet', 'acp-market'])

    // The replaced pane's close never pulls the keyboard back to its Dock tile: it stays in the newcomer.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(win('wallet')!.contains(window.document.activeElement)).toBe(true)
    expect(window.document.activeElement?.closest('.dock')).toBeNull()
  })

  it('closing one of two hands the keyboard to the other pane (it fills the window), not to a Dock tile', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    dragTile(copy.tile.acp, RIGHT_X).release()

    fireEvent.click(screen.getByRole('button', { name: copy.closeWindow(ECON_TITLE.acp) }))
    expect(win('acp-market')).toBeNull()
    await vi.waitFor(() => expect(win('email')!.contains(window.document.activeElement)).toBe(true))
    expect(win('email')!.dataset.pane).toBe('full')
  })

  it('the second econ pane left alone is the one a reload brings back', () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    dragTile(copy.tile.acp, RIGHT_X).release()
    fireEvent.click(screen.getByRole('button', { name: copy.closeWindow(ECON_TITLE.email) }))

    expect(window.sessionStorage.getItem(ICLONE_STORAGE.dockWindow.key)).toBe('acp')
  })

  it('the keyboard reaches the split too: Shift+Enter on a Dock tile, then "Open on the right"', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))

    const tile = screen.getByRole('button', { name: copy.tile.acp })

    tile.focus()
    fireEvent.keyDown(tile, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open on the right' }))

    expect($paneArrangement.get()).toMatchObject({ kind: 'split', left: 'email', right: 'acp-market' })
    await vi.waitFor(() => expect(win('acp-market')!.contains(window.document.activeElement)).toBe(true))
  })

  it('a drop outside the window cancels: nothing opens', () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))

    const drag = dragTile(copy.tile.acp, RIGHT_X)

    drag.release(FRAME.left - 60)
    expect(win('acp-market')).toBeNull()
    expect($panes.get().open).toEqual(['email'])
  })

  it('Containers dropped beside Email stays beside it (its one-window rule is for clicks)', () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.email }))
    dragTile('Containers', RIGHT_X).release()

    expect($containersOpen.get()).toBe(true)
    expect(win('email')).not.toBeNull()
  })

  it('reference flow: the iNFT in its own window, two panes inside the app', () => {
    $stagePlace.set('away')
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: copy.tile.bank }))
    dragTile(copy.tile.email, RIGHT_X).release()

    expect($stagePlace.get()).toBe('away')
    expect($paneArrangement.get()).toMatchObject({ kind: 'split', left: 'bank-card', right: 'email' })
  })
})
