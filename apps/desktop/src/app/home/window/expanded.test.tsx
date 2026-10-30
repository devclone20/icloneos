import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { $dockWindowSize, setDockWindowSize } from '@/store/dock-window-size'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { $expandedWindows, useWindowExpanded } from './expanded'
import { IcWindow, type IcWindowId } from './ic-window'
import { windowRectStyle } from './rect'

const LABELS = { close: 'Close', expand: 'Expand', retract: 'Retract', opacity: 'Opacity' }
const STORAGE_KEY = 'hermes.desktop.dockWindowSize.v1'

/** A Dock window as every consumer wires it: the hook's state straight into the shared chassis. */
function DockWindow({ id }: { id: IcWindowId }) {
  const { expanded, toggle } = useWindowExpanded(id)

  return (
    <IcWindow
      expanded={expanded}
      head={null}
      id={id}
      label={id}
      labels={LABELS}
      onClose={vi.fn()}
      onToggleExpanded={toggle}
      placement="self"
    />
  )
}

const root = () => window.document.querySelector<HTMLElement>('[data-ic-window]')!
const maximized = () => root().dataset.expanded === 'true'

// The rect the chassis paints: the whole app (expanded) or the one fixed window frame.
const paints = (expanded: boolean) => {
  const rect = windowRectStyle(expanded)

  return root().style.top === String(rect.top) && root().style.left === String(rect.left)
}

const toggleButton = () => screen.getByRole('button', { name: maximized() ? LABELS.retract : LABELS.expand })

describe('how a Dock window opens (window/expanded.ts, Settings › Machine › Appearance)', () => {
  beforeAll(() => {
    stubResizeObserver()
    stubMenuDomApis()
  })

  afterEach(() => {
    cleanup()
    setDockWindowSize('maximized')
    window.localStorage.removeItem(STORAGE_KEY)
  })

  it('the default opens it maximized: it fills the app and the Dock tucks away', () => {
    expect($dockWindowSize.get()).toBe('maximized')

    render(<DockWindow id="wallet" />)

    expect(maximized()).toBe(true)
    expect(paints(true)).toBe(true)
    expect($expandedWindows.get()).toEqual(['wallet'])
    expect(screen.getByRole('button', { name: LABELS.retract })).toBeTruthy()
  })

  it('the choice "normal size" opens it on its frame, as before', () => {
    setDockWindowSize('normal')

    render(<DockWindow id="wallet" />)

    expect(maximized()).toBe(false)
    expect(paints(false)).toBe(true)
    expect($expandedWindows.get()).toEqual([])
    expect(screen.getByRole('button', { name: LABELS.expand })).toBeTruthy()
  })

  it.each(['maximized', 'normal'] as const)('the window button still switches it both ways (choice %s)', size => {
    setDockWindowSize(size)
    render(<DockWindow id="wallet" />)

    const opened = maximized()

    fireEvent.click(toggleButton())
    expect(maximized()).toBe(!opened)

    fireEvent.click(toggleButton())
    expect(maximized()).toBe(opened)
  })

  it('bringing the open window to the front keeps the size the user chose in it', () => {
    const { rerender } = render(<DockWindow id="wallet" />)

    fireEvent.click(toggleButton())
    expect(maximized()).toBe(false)

    // The Dock tile of an open window re-renders the same window (same id, same mount).
    rerender(<DockWindow id="wallet" />)
    expect(maximized()).toBe(false)
  })

  it('a change of the choice leaves the open windows alone; the next opening follows it', () => {
    const { unmount } = render(<DockWindow id="wallet" />)

    act(() => setDockWindowSize('normal'))
    expect(maximized()).toBe(true)

    unmount()
    render(<DockWindow id="wallet" />)
    expect(maximized()).toBe(false)
  })

  it('reduced, closed and opened again, it follows the choice (a new opening)', () => {
    const { unmount } = render(<DockWindow id="wallet" />)

    fireEvent.click(toggleButton())
    expect(maximized()).toBe(false)

    unmount()
    render(<DockWindow id="wallet" />)
    expect(maximized()).toBe(true)
  })

  it('another window in the same chassis (the econ windows share one) is a new opening', () => {
    const { rerender } = render(<DockWindow id="wallet" />)

    fireEvent.click(toggleButton())
    expect(maximized()).toBe(false)

    rerender(<DockWindow id="bank-card" />)
    expect(root().dataset.icWindow).toBe('bank-card')
    expect(maximized()).toBe(true)
  })

  it('the choice persists, and only a stored "normal" opts out of the default', async () => {
    setDockWindowSize('normal')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('normal')

    window.localStorage.setItem(STORAGE_KEY, 'tiny')
    vi.resetModules()
    const fresh = await import('@/store/dock-window-size')
    expect(fresh.$dockWindowSize.get()).toBe('maximized')

    window.localStorage.setItem(STORAGE_KEY, 'normal')
    vi.resetModules()
    const stored = await import('@/store/dock-window-size')
    expect(stored.$dockWindowSize.get()).toBe('normal')
  })
})
