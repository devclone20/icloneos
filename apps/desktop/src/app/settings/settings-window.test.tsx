import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { HOME_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { setDockWindowSize } from '@/store/dock-window-size'

import {
  $dockWindowHost,
  $settingsOpenedInApp,
  DOCK_REPEAT_MS,
  nextDockWindow,
  publishDockWindowHost,
  settingsDockItem,
  useDockWindows,
  useSettingsWindowRoute
} from './settings-dock'
import {
  DEFAULT_SETTINGS_TAB,
  focusCurrentRailRowAfterPalette,
  focusSettingsDockTile,
  settingsReloadPending,
  SettingsShell,
  settingsTabSearch
} from './settings-window'

const windowKind = vi.hoisted(() => ({ auxiliary: false }))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAuxiliaryWindow: () => windowKind.auxiliary
}))

function renderShell() {
  const onClose = vi.fn()
  const at: { path?: string } = {}

  function Where() {
    at.path = useLocation().pathname

    return null
  }

  const view = render(
    <MemoryRouter initialEntries={[HOME_ROUTE, SETTINGS_ROUTE]}>
      <Where />
      <SettingsShell
        closeLabel="Close settings"
        onClose={onClose}
        search={<button type="button">Search settings</button>}
        title="Settings"
      >
        <button type="button">Pane row</button>
      </SettingsShell>
    </MemoryRouter>
  )

  return { ...view, at, onClose }
}

function mountHost(): HTMLElement {
  const host = window.document.createElement('div')

  host.className = 'ihome'
  window.document.body.append(host)
  act(() => publishDockWindowHost(host))

  return host
}

function settingsWindow(host: ParentNode): HTMLElement {
  const element = host.querySelector<HTMLElement>('[data-ic-window="settings"]')

  if (!element) {
    throw new Error('settings window not rendered')
  }

  return element
}

// These cases start from the window on its frame: the Settings choice "normal size". The default (maximized) is
// pinned by its own cases below and in window/expanded.test.tsx.
beforeEach(() => {
  $settingsOpenedInApp.set(true)
  setDockWindowSize('normal')
})

afterEach(() => {
  cleanup()
  setDockWindowSize('maximized')
  $dockWindowHost.set(null)
  window.document.body.replaceChildren()
})

describe('SettingsShell without a home layer (auxiliary windows)', () => {
  beforeEach(() => {
    windowKind.auxiliary = true
  })

  afterEach(() => {
    windowKind.auxiliary = false
  })

  it('keeps the OverlayView card: scrim root, edge search pill, its own close', () => {
    const { container, onClose } = renderShell()

    expect(window.document.querySelector('[data-ic-window="settings"]')).toBeNull()
    expect(container.querySelector('[role="presentation"][data-overlay-surface]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Search settings' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('SettingsShell as a Dock window', () => {
  it('portals one IcWindow into the home layer, inside the overlay-surface marker', () => {
    const host = mountHost()
    const { container } = renderShell()
    const root = settingsWindow(host)

    expect(container.querySelector('[data-ic-window]')).toBeNull()
    expect(window.document.querySelectorAll('[data-ic-window="settings"]')).toHaveLength(1)
    expect(root.closest('[data-overlay-surface]')).not.toBeNull()
    expect(root.dataset.kind).toBe('settings')
    expect(root.getAttribute('aria-label')).toBe('Settings window')
    expect(window.document.querySelector('[role="presentation"]')).toBeNull()
  })

  it('carries the title and the search pill in the header band and the panes in the body', () => {
    const root = settingsWindow((mountHost(), renderShell(), window.document))
    const head = root.querySelector<HTMLElement>('.ic-win__head')!
    const body = root.querySelector<HTMLElement>('.ic-win__body')!

    expect(within(head).getByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(within(head).getByRole('button', { name: 'Search settings' })).toBeTruthy()
    expect(within(body).getByRole('button', { name: 'Pane row' })).toBeTruthy()
  })

  it('opens maximized with the default choice (Settings › Machine › Appearance), its button reduces it', () => {
    setDockWindowSize('maximized')
    mountHost()
    renderShell()

    expect(settingsWindow(window.document).dataset.expanded).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Retract Settings window' }))
    expect(settingsWindow(window.document).dataset.expanded).toBeUndefined()
  })

  it('has the Dock windows’ control column: close, expand/retract, opacity', () => {
    mountHost()
    const { onClose } = renderShell()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Settings window' }))
    expect(settingsWindow(window.document).dataset.expanded).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Retract Settings window' }))
    expect(settingsWindow(window.document).dataset.expanded).toBeUndefined()

    expect(screen.getByLabelText('Settings opacity')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Escape retracts an expanded Settings window; only the next Escape closes it (doc 07 #7; W-1)', () => {
    mountHost()
    const { onClose } = renderShell()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Settings window' }))
    expect(settingsWindow(window.document).dataset.expanded).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(settingsWindow(window.document).dataset.expanded).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves focus into the window body on open and closes on Escape', () => {
    mountHost()
    const { onClose } = renderShell()
    const body = settingsWindow(window.document).querySelector('.ic-win__body')!

    expect(body.contains(window.document.activeElement)).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('restored by a reload (not opened in this renderer), closes to home by Escape or its close button', () => {
    mountHost()

    for (const closeBy of ['escape', 'button'] as const) {
      act(() => $settingsOpenedInApp.set(false))
      const { at, onClose, unmount } = renderShell()

      if (closeBy === 'escape') {
        fireEvent.keyDown(window, { key: 'Escape' })
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
      }

      expect(at.path).toBe(HOME_ROUTE)
      expect(onClose).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('never closes on a click outside it (Dock windows have no scrim)', () => {
    const host = mountHost()
    const { onClose } = renderShell()

    fireEvent.pointerDown(host)
    fireEvent.click(host)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the fixed Dock frame: no resize handle on any edge or corner, no remembered rect', () => {
    const host = mountHost()
    renderShell()

    const element = settingsWindow(host)

    expect(element.querySelector('[class*="iecon-h"]')).toBeNull()
    expect(element.className).not.toContain('resizing')
    expect(Object.keys(window.localStorage).filter(key => key.startsWith('iclone.settings'))).toEqual([])
  })

  it('in the main window, waits for the home layer instead of flashing the card, then opens in it', () => {
    const { container } = renderShell()

    expect(container.childElementCount).toBe(0)
    expect(window.document.querySelector('[data-overlay-surface]')).toBeNull()

    const host = mountHost()

    expect(settingsWindow(host)).toBeTruthy()
    expect(window.document.querySelector('[role="presentation"]')).toBeNull()
  })
})

describe('useSettingsWindowRoute', () => {
  function renderRoute(path: string) {
    const closeEcon = vi.fn()
    const seen: { open?: boolean; go: (to: string) => void } = { go: () => undefined }

    function Probe() {
      const navigate = useNavigate()

      seen.open = useSettingsWindowRoute(closeEcon)
      seen.go = to => act(() => void navigate(to))

      return null
    }

    render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
      </MemoryRouter>
    )

    return { closeEcon, seen }
  }

  it('is open only on the Settings route and closes the econ window once each time Settings opens', () => {
    const { closeEcon, seen } = renderRoute(HOME_ROUTE)

    expect(seen.open).toBe(false)
    seen.go(`${SETTINGS_ROUTE}?tab=economyos`)
    expect(seen.open).toBe(true)
    seen.go(`${SETTINGS_ROUTE}?tab=hud`)
    expect(closeEcon).toHaveBeenCalledTimes(1)
    seen.go(HOME_ROUTE)
    expect(seen.open).toBe(false)
    seen.go(SETTINGS_ROUTE)
    expect(closeEcon).toHaveBeenCalledTimes(2)
  })

  it('a cold start on /settings is already open and has no econ window to close', () => {
    $settingsOpenedInApp.set(false)
    const { closeEcon, seen } = renderRoute(`${SETTINGS_ROUTE}?tab=inft`)

    expect(seen.open).toBe(true)
    expect(closeEcon).not.toHaveBeenCalled()
    expect($settingsOpenedInApp.get()).toBe(false)
  })

  it('marks Settings as opened in this renderer once a navigation opens it', () => {
    $settingsOpenedInApp.set(false)
    const { seen } = renderRoute(HOME_ROUTE)

    expect($settingsOpenedInApp.get()).toBe(false)
    seen.go(SETTINGS_ROUTE)
    expect($settingsOpenedInApp.get()).toBe(true)
  })
})

const isEconKind = (value: string): value is 'wallet' | 'bank' => value === 'wallet' || value === 'bank'

describe('useDockWindows', () => {
  it('a double-click on an econ tile leaves its window open; a later click, a close or Settings closes it', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)

    const seen: { go: (to: string) => void; dock?: ReturnType<typeof useDockWindows<'wallet' | 'bank'>> } = {
      go: () => undefined
    }

    function Probe() {
      const navigate = useNavigate()

      seen.dock = useDockWindows(isEconKind)
      seen.go = to => act(() => void navigate(to))

      return null
    }

    render(
      <MemoryRouter initialEntries={[HOME_ROUTE]}>
        <Probe />
      </MemoryRouter>
    )
    const toggle = (kind: 'wallet' | 'bank') => act(() => seen.dock!.toggleEcon(kind))

    toggle('wallet')
    now.mockReturnValue(1120)
    toggle('wallet')
    expect(seen.dock!.econ).toBe('wallet')
    now.mockReturnValue(1000 + DOCK_REPEAT_MS + 200)
    toggle('wallet')
    expect(seen.dock!.econ).toBeNull()
    toggle('bank')
    act(() => seen.dock!.closeEcon())
    expect(seen.dock!.econ).toBeNull()
    toggle('bank')
    seen.go(SETTINGS_ROUTE)
    expect(seen.dock!.settingsOpen).toBe(true)
    expect(seen.dock!.econ).toBeNull()
    now.mockRestore()
  })
})

describe('useDockWindows across a renderer reload', () => {
  const key = ICLONE_STORAGE.dockWindow.key

  afterEach(() => {
    cleanup()
    window.sessionStorage.removeItem(key)
  })

  function mount() {
    const seen: { dock?: ReturnType<typeof useDockWindows<'wallet' | 'bank'>> } = {}

    function Probe() {
      seen.dock = useDockWindows(isEconKind)

      return null
    }

    render(
      <MemoryRouter initialEntries={[HOME_ROUTE]}>
        <Probe />
      </MemoryRouter>
    )

    return seen
  }

  it('starts from the window this renderer remembered and forgets it on close', () => {
    window.sessionStorage.setItem(key, 'wallet')
    const seen = mount()

    expect(seen.dock!.econ).toBe('wallet')
    act(() => seen.dock!.closeEcon())
    expect(seen.dock!.econ).toBeNull()
    expect(window.sessionStorage.getItem(key)).toBeNull()
  })

  it('remembers an opened window; starts empty without a key or with a kind it does not know', () => {
    expect(mount().dock!.econ).toBeNull()
    cleanup()
    window.sessionStorage.setItem(key, 'teapot')
    expect(mount().dock!.econ).toBeNull()
    cleanup()
    const seen = mount()

    act(() => seen.dock!.toggleEcon('bank'))
    expect(window.sessionStorage.getItem(key)).toBe('bank')
  })
})

describe('settingsTabSearch', () => {
  it('keeps only the tab and the sub-view param that tab owns', () => {
    expect(settingsTabSearch('?tab=providers&pview=keys', 'inft')).toBe('?tab=inft')
    expect(settingsTabSearch('?tab=inft&kview=mcp', 'providers')).toBe('?tab=providers')
    expect(settingsTabSearch('?tab=providers&pview=keys', 'providers')).toBe('?tab=providers&pview=keys')
    expect(settingsTabSearch('?tab=keys&kview=mcp&pview=keys', 'keys')).toBe('?tab=keys&kview=mcp')
    expect(settingsTabSearch('?tab=inft&pview=keys', DEFAULT_SETTINGS_TAB)).toBe('?tab=config%3Amodel')
  })
})

describe('nextDockWindow', () => {
  it('opens a closed window and closes it on a later single click', () => {
    expect(nextDockWindow(null, 'wallet', null, 0)).toBe('wallet')
    expect(nextDockWindow('bank', 'wallet', { at: 0, kind: 'bank' }, 10)).toBe('wallet')
    expect(nextDockWindow('wallet', 'wallet', { at: 0, kind: 'wallet' }, DOCK_REPEAT_MS + 1)).toBeNull()
    expect(nextDockWindow('wallet', 'wallet', null, 10)).toBeNull()
  })

  it('keeps open what the first click of a double-click opened', () => {
    expect(nextDockWindow('wallet', 'wallet', { at: 1000, kind: 'wallet' }, 1000 + DOCK_REPEAT_MS - 1)).toBe('wallet')
    expect(nextDockWindow('wallet', 'wallet', { at: 1000, kind: 'bank' }, 1100)).toBeNull()
  })
})

describe('settingsDockItem', () => {
  it('is the system-toned Settings tile, lit and named by the caller', () => {
    const onSelect = vi.fn()
    const item = settingsDockItem({ active: true, hint: 'hint', onSelect })

    expect(item).toMatchObject({ active: true, hint: 'hint', id: 'settings', tone: 'system' })
    // One source per word: the home names the tile from its catalogue (UF3A-r1-T3).
    expect('label' in item).toBe(false)
  })

  it('opens Settings from the unlit tile; the lit tile keeps the open window (no navigation)', () => {
    const navigate = vi.fn()

    settingsDockItem({ active: false, hint: 'hint', onSelect: navigate }).onSelect()
    expect(navigate).toHaveBeenCalledTimes(1)

    navigate.mockClear()
    settingsDockItem({ active: true, hint: 'hint', onSelect: navigate }).onSelect()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('wired as the home wires it, a re-click keeps #/settings?tab=hud', () => {
    const seen: { location?: string; select: () => void } = { select: () => undefined }

    function Probe() {
      const navigate = useNavigate()
      const location = useLocation()
      const settingsOpen = useSettingsWindowRoute(() => undefined)
      const tile = settingsDockItem({ active: settingsOpen, hint: 'hint', onSelect: () => navigate(SETTINGS_ROUTE) })

      seen.location = `${location.pathname}${location.search}`
      seen.select = () => act(() => tile.onSelect())

      return null
    }

    render(
      <MemoryRouter initialEntries={[HOME_ROUTE]}>
        <Probe />
      </MemoryRouter>
    )

    seen.select()
    expect(seen.location).toBe(SETTINGS_ROUTE)

    cleanup()
    render(
      <MemoryRouter initialEntries={[`${SETTINGS_ROUTE}?tab=hud`]}>
        <Probe />
      </MemoryRouter>
    )

    seen.select()
    expect(seen.location).toBe(`${SETTINGS_ROUTE}?tab=hud`)
  })
})

describe('focusCurrentRailRowAfterPalette (U3-p2b-11 / UF3A-r1-T2)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    window.document.body.innerHTML = ''
  })

  it('waits for the palette to leave the document, then hands the keyboard to the aria-current rail row', () => {
    window.document.body.innerHTML =
      '<div class="icp-root"><input id="palette" /></div><nav><button data-tour="nav-keys">Keys</button><button data-tour="nav-privacy" aria-current="page">Privacy</button></nav>'
    window.document.getElementById('palette')?.focus()

    const cancel = focusCurrentRailRowAfterPalette()

    vi.advanceTimersByTime(200)
    expect(window.document.activeElement?.id).toBe('palette')

    window.document.querySelector('.icp-root')?.remove()
    vi.advanceTimersByTime(50)
    expect(window.document.activeElement?.getAttribute('data-tour')).toBe('nav-privacy')
    cancel()
  })

  it('never takes the keyboard from a field a pane focused, and stops when cancelled', () => {
    window.document.body.innerHTML =
      '<nav><button data-tour="nav-privacy" aria-current="page">Privacy</button></nav><input id="field" />'
    window.document.getElementById('field')?.focus()

    focusCurrentRailRowAfterPalette()
    vi.advanceTimersByTime(50)
    expect(window.document.activeElement?.id).toBe('field')

    ;(window.document.activeElement as HTMLElement).blur()
    const cancel = focusCurrentRailRowAfterPalette()
    cancel()
    vi.advanceTimersByTime(200)
    expect(window.document.activeElement).toBe(window.document.body)
  })
})

describe('settingsReloadPending (U2-p2b-05 / UF3A-r1-T1)', () => {
  const reload = (hash: string, type = 'reload') => [{ name: `http://127.0.0.1:5174/${hash}`, type }]

  it('is true only for a reload whose document URL was a Settings route', () => {
    expect(settingsReloadPending(reload('#/settings?tab=keys'))).toBe(true)
    expect(settingsReloadPending(reload('#/settings'))).toBe(true)
    // A reload on another route, then a deliberate deep link: the pane opens.
    expect(settingsReloadPending(reload('#/home'))).toBe(false)
    expect(settingsReloadPending(reload('#/settings-x'))).toBe(false)
    expect(settingsReloadPending(reload(''))).toBe(false)
    expect(settingsReloadPending(reload('#/settings?tab=keys', 'navigate'))).toBe(false)
    expect(settingsReloadPending([])).toBe(false)
  })

  it('reads the navigation entries by default, never the live hash (the module may load on the deep link)', () => {
    window.location.hash = '#/settings?tab=keys'

    const entries = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue(reload('#/home') as unknown as PerformanceEntry[])

    expect(settingsReloadPending()).toBe(false)
    entries.mockReturnValue(reload('#/settings?tab=keys') as unknown as PerformanceEntry[])
    expect(settingsReloadPending()).toBe(true)

    entries.mockRestore()
    window.location.hash = ''
  })
})

describe('focusSettingsDockTile (U1-p2b-11 / U4-p2b-02)', () => {
  it('returns the keyboard to the Dock Settings tile only when nothing else holds it', () => {
    window.document.body.innerHTML =
      '<nav><button data-dock="settings">Settings</button><button id="other">x</button></nav>'

    focusSettingsDockTile()
    expect(window.document.activeElement?.getAttribute('data-dock')).toBe('settings')

    window.document.getElementById('other')?.focus()
    focusSettingsDockTile()
    expect(window.document.activeElement?.id).toBe('other')

    window.document.body.innerHTML = ''
  })
})
