// v0.0.9 F6 gate: the window menu holds exactly 4 options (5 on the 3D iNFT pane), never a top/bottom one, opens on
// hover after 120 ms and closes 200 ms after the pointer leaves, and is fully driven from the keyboard. Before F6 the
// column had a single expand/retract button and no menu at all, so every case here fails on the old code.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { f6Menu } from '@/i18n/en/v009-f6'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { MENU_HOVER_CLOSE_MS, MENU_HOVER_OPEN_MS, WindowMenu } from './window-menu'
import { flatItems, type WindowMenuActions, windowMenuGroups, type WindowMenuState } from './window-menu-model'

const NARROW: WindowMenuState = { filled: false, side: null, arranged: false, wideEnough: false, hasPartner: true }
const WIDE: WindowMenuState = { ...NARROW, wideEnough: true }

function actions(extra: Partial<WindowMenuActions> = {}): WindowMenuActions {
  return { moveLeft: vi.fn(), moveRight: vi.fn(), fill: vi.fn(), arrange: vi.fn(), ...extra }
}

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('what the menu holds', () => {
  it('a Dock pane: exactly Move left · Move right · Fill · Arrange side by side, in two groups', () => {
    const groups = windowMenuGroups(WIDE, actions())

    expect(groups.map(group => group.title)).toEqual([f6Menu.groupMove, f6Menu.groupArrange])
    expect(flatItems(groups).map(item => item.label)).toEqual([
      'Move left',
      'Move right',
      'Fill',
      'Arrange side by side'
    ])
  })

  it('the 3D iNFT pane: the same 4 plus a separated Open in new window — 5', () => {
    const groups = windowMenuGroups(WIDE, actions({ openInNewWindow: vi.fn() }))
    const items = flatItems(groups)

    expect(items).toHaveLength(5)
    expect(items[4].label).toBe('Open in new window')
    expect(groups[2].title).toBeUndefined()
  })

  it('no option ever moves a pane to the top or the bottom', () => {
    for (const state of [NARROW, WIDE, { ...WIDE, filled: true }, { ...WIDE, side: 'left' as const }]) {
      const labels = flatItems(windowMenuGroups(state, actions({ openInNewWindow: vi.fn() }))).map(item => item.label)

      expect(labels.join(' ')).not.toMatch(/top|bottom|above|below|up|down/i)
    }
  })

  it('Arrange side by side is disabled below 758 pt and says why', () => {
    const arrange = flatItems(windowMenuGroups(NARROW, actions())).find(item => item.id === 'arrange')!

    expect(arrange.disabled).toBe(true)
    expect(arrange.reason).toBe('Needs a wider window')
    expect(flatItems(windowMenuGroups(WIDE, actions())).find(item => item.id === 'arrange')!.disabled).toBe(false)
  })

  it('the option that describes the pane is marked active (Fill while filled, the side it is on)', () => {
    const filled = flatItems(windowMenuGroups({ ...WIDE, filled: true }, actions()))
    const onLeft = flatItems(windowMenuGroups({ ...WIDE, side: 'left', arranged: true }, actions()))

    expect(filled.filter(item => item.active).map(item => item.id)).toEqual(['fill'])
    expect(onLeft.filter(item => item.active).map(item => item.id)).toEqual(['move-left', 'arrange'])
  })
})

function renderMenu(state: WindowMenuState = WIDE, extra: Partial<WindowMenuActions> = {}) {
  const handlers = actions(extra)

  render(<WindowMenu groups={windowMenuGroups(state, handlers)} menuLabel="Wallet window" triggerLabel="Options" />)

  return { handlers, trigger: screen.getByRole('button', { name: 'Options' }) }
}

describe('opening and closing', () => {
  it('hover opens after 120 ms, not before; leaving closes it 200 ms later', () => {
    vi.useFakeTimers()
    const { trigger } = renderMenu()
    const root = trigger.parentElement!

    fireEvent.pointerEnter(root)
    act(() => vi.advanceTimersByTime(MENU_HOVER_OPEN_MS - 1))
    expect(screen.queryByRole('menu')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(MENU_HOVER_OPEN_MS).toBe(120)

    fireEvent.pointerLeave(root)
    act(() => vi.advanceTimersByTime(MENU_HOVER_CLOSE_MS - 1))
    expect(screen.getByRole('menu')).toBeTruthy()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(MENU_HOVER_CLOSE_MS).toBe(200)
  })

  it('a hover-open menu never takes the focus', () => {
    vi.useFakeTimers()
    const { trigger } = renderMenu()

    fireEvent.pointerEnter(trigger.parentElement!)
    act(() => vi.advanceTimersByTime(MENU_HOVER_OPEN_MS))

    expect(trigger.ownerDocument.activeElement).not.toBe(screen.getAllByRole('menuitem')[0])
  })

  it('a click pins it open (leaving does not close it); a second click closes it', () => {
    vi.useFakeTimers()
    const { trigger } = renderMenu()

    fireEvent.click(trigger, { detail: 1 })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.pointerLeave(trigger.parentElement!)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.click(trigger, { detail: 1 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a press outside closes it', () => {
    const { trigger } = renderMenu()

    fireEvent.click(trigger, { detail: 1 })
    fireEvent.pointerDown(trigger.ownerDocument.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('the keyboard', () => {
  it('Enter opens on the first option; ↓ ↑ move and wrap; Home / End jump', () => {
    const { trigger } = renderMenu()

    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })

    const items = screen.getAllByRole('menuitem')
    const active = () => trigger.ownerDocument.activeElement

    expect(items).toHaveLength(4)
    expect(active()).toBe(items[0])

    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(active()).toBe(items[1])

    fireEvent.keyDown(items[1], { key: 'ArrowUp' })
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(active()).toBe(items[3])

    fireEvent.keyDown(items[3], { key: 'Home' })
    expect(active()).toBe(items[0])

    fireEvent.keyDown(items[0], { key: 'End' })
    expect(active()).toBe(items[3])
  })

  it('Space and ↓ open too; ↑ opens on the last option', () => {
    const { trigger } = renderMenu()

    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const items = screen.getAllByRole('menuitem')

    expect(trigger.ownerDocument.activeElement).toBe(items[items.length - 1])
  })

  it('Enter on an option runs it, closes the menu and gives the focus back to the icon', () => {
    const { handlers, trigger } = renderMenu()

    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getAllByRole('menuitem')[1], { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getAllByRole('menuitem')[2], { key: 'Enter' })

    expect(handlers.fill).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.ownerDocument.activeElement).toBe(trigger)
  })

  it('Escape closes back onto the icon and is consumed (the home router will not also close the window)', () => {
    const { trigger } = renderMenu()
    const router = vi.fn((event: KeyboardEvent) => event.defaultPrevented)

    window.addEventListener('keydown', router)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
    window.removeEventListener('keydown', router)

    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.ownerDocument.activeElement).toBe(trigger)
    expect(router.mock.results.every(result => result.value === true)).toBe(true)
  })

  it('a disabled Arrange is reachable but does nothing', () => {
    const { handlers, trigger } = renderMenu(NARROW)

    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const arrange = screen.getByRole('menuitem', { name: 'Arrange side by side' })

    expect(trigger.ownerDocument.activeElement).toBe(arrange)
    expect(arrange.getAttribute('aria-disabled')).toBe('true')

    fireEvent.keyDown(arrange, { key: 'Enter' })
    fireEvent.click(arrange, { detail: 1 })

    expect(handlers.arrange).not.toHaveBeenCalled()
  })

  it('the 3D pane menu holds 5 options, the last one Open in new window', () => {
    const openInNewWindow = vi.fn()
    const { trigger } = renderMenu(WIDE, { openInNewWindow })

    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const items = screen.getAllByRole('menuitem')

    expect(items).toHaveLength(5)
    expect(screen.getByRole('separator')).toBeTruthy()

    fireEvent.click(items[4], { detail: 1 })
    expect(openInNewWindow).toHaveBeenCalledTimes(1)
  })
})

// v0.0.9 r4d (design r4 F6-1): red on 52cae17554 — the current state painted the same fill as hover, so two rows looked
// selected, and "Move right" was offered on the right pane although it did nothing.
describe('one lit row at most; the current state is a check', () => {
  it('Move left/right on the side the pane is already on is disabled, with the reason', () => {
    const onRight = flatItems(windowMenuGroups({ ...WIDE, side: 'right', arranged: true }, actions()))
    const right = onRight.find(item => item.id === 'move-right')!

    expect(right).toMatchObject({ active: true, disabled: true, reason: f6Menu.alreadyRight })
    expect(onRight.find(item => item.id === 'move-left')!.disabled).toBe(false)
    // A filled pane is on no side: both moves stay offered.
    expect(
      flatItems(windowMenuGroups({ ...WIDE, side: 'right', filled: true }, actions())).filter(item => item.disabled)
    ).toEqual([])
  })

  it('the current rows carry a check and aria-current; a disabled one does nothing', () => {
    const { handlers, trigger } = renderMenu({ ...WIDE, side: 'right', arranged: true })

    fireEvent.click(trigger, { detail: 1 })

    const current = screen.getAllByRole('menuitem').filter(item => item.getAttribute('aria-current') === 'true')

    expect(current.map(item => item.dataset.item)).toEqual(['move-right', 'arrange'])
    expect(current.every(item => item.querySelector('[data-testid="wmenu-check"]'))).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }), { detail: 1 })
    expect(handlers.moveRight).not.toHaveBeenCalled()
  })

  it('the stylesheet paints the fill only on hover and keyboard focus, never on the current state', () => {
    const css = readFileSync(path.join(__dirname, 'ic-window.css'), 'utf8')

    expect(css).not.toMatch(/\.ic-wmenu__item\[data-active\]\s*\{[^}]*background/)
    expect(css).not.toMatch(/\.ic-wmenu__item\[data-active\],?\s*\{/)
    expect(css).toMatch(/\.ic-wmenu__item:hover:not\(\[aria-disabled='true'\]\),\s*\.ic-wmenu__item:focus-visible \{\s*background: var\(--ic-fill-hover\);/)
  })
})
