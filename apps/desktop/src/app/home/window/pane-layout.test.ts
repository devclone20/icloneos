// v0.0.9 F6 gates on the pane rules (P0_DESIGN_SPECS.md «F6 · Janelas e painéis»): two panes fit at 758 pt and fold
// at 757; the divider never leaves a side under 375; a 3rd pane replaces the one WITHOUT focus; never top/bottom.
// Every case fails on the code before F6, where none of these exports existed (one fixed rect for every window).
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setWindowExpanded } from './expanded'
import {
  $paneArea,
  $paneArrangement,
  $panes,
  $settingsBesideMessage,
  arrangePanes,
  canArrange,
  clampRatio,
  closePane,
  focusPane,
  INITIAL_PANES,
  movePane,
  onPaneReplaced,
  openPane,
  PANE_DIVIDER_PX,
  PANE_MIN_PX,
  PANE_SPLIT_MIN_PX,
  type PaneState,
  ratioAt,
  registerPane,
  renamePane,
  resetPanesForTests,
  setPaneCloser,
  setPaneRatio,
  slotFor,
  soloWidth,
  splitWidths,
  unregisterPane
} from './pane-layout'

const two = (left: string, right: string, focused: string): PaneState => ({
  ...INITIAL_PANES,
  open: [left, right],
  focused
})

afterEach(() => {
  resetPanesForTests()
  setWindowExpanded('wallet', false)
  setWindowExpanded('message', false)
})

describe('two panes need 758 pt (2 × 375 + the 8 px divider)', () => {
  it('the threshold is exactly 758', () => {
    expect(PANE_SPLIT_MIN_PX).toBe(758)
    expect(canArrange(758)).toBe(true)
    expect(canArrange(757)).toBe(false)
  })

  it('at 758 the pair stands side by side, 375 + 8 + 375', () => {
    const arrangement = arrangePanes(two('wallet', 'message', 'wallet'), 758)

    expect(arrangement.kind).toBe('split')

    if (arrangement.kind === 'split') {
      expect(arrangement.widths).toEqual({ left: 375, right: 375 })
    }

    expect(slotFor(arrangement, 'wallet', 758)).toEqual({ place: 'left', left: 0, width: 375 })
    expect(slotFor(arrangement, 'message', 758)).toEqual({ place: 'right', left: 383, width: 375 })
  })

  it('at 757 the pair folds into tabs on the focused pane; the other is not drawn', () => {
    const arrangement = arrangePanes(two('wallet', 'message', 'message'), 757)

    expect(arrangement).toEqual({ kind: 'folded', shown: 'message', tabbed: 'wallet', order: ['wallet', 'message'] })
    expect(slotFor(arrangement, 'message', 757)).toEqual({ place: 'full' })
    expect(slotFor(arrangement, 'wallet', 757)).toEqual({ place: 'hidden' })
  })

  it('folded at 600, side by side again as soon as the width is back (nothing to restore by hand)', () => {
    const state = two('wallet', 'message', 'wallet')

    expect(arrangePanes(state, 600).kind).toBe('folded')
    expect(arrangePanes(state, 1344).kind).toBe('split')
  })

  it('plan deviation (lead, 18 Nov): at the minimum windows (504 pt on a 14-inch, 576 pt on a 16-inch) two panes are two tabs', () => {
    for (const width of [504, 576]) {
      const arrangement = arrangePanes(two('wallet', 'message', 'wallet'), width)

      expect(arrangement.kind).toBe('folded')
      expect(canArrange(width)).toBe(false)
    }
  })

  it('a filled (expanded) pane folds the pair even when wide', () => {
    expect(arrangePanes(two('wallet', 'message', 'wallet'), 1344, ['wallet']).kind).toBe('folded')
  })

  it('the store follows the measured width and the expanded windows', () => {
    $panes.set(two('wallet', 'message', 'wallet'))
    $paneArea.set(758)
    expect($paneArrangement.get().kind).toBe('split')

    $paneArea.set(757)
    expect($paneArrangement.get().kind).toBe('folded')

    $paneArea.set(1200)
    setWindowExpanded('message', true)
    expect($paneArrangement.get().kind).toBe('folded')
  })
})

describe('the divider: 50/50 by default, never a side under 375', () => {
  it('50/50 by default', () => {
    expect(splitWidths(1008, 0.5)).toEqual({ left: 500, right: 500 })
  })

  it.each([
    [0, 375],
    [0.1, 375],
    [0.95, 1000 - PANE_DIVIDER_PX - 375],
    [1, 1000 - PANE_DIVIDER_PX - 375]
  ])('ratio %s at 1000 pt clamps the left pane to %s', (ratio, left) => {
    const widths = splitWidths(1000, ratio)

    expect(widths.left).toBe(left)
    expect(widths.right).toBeGreaterThanOrEqual(PANE_MIN_PX)
    expect(widths.left + widths.right + PANE_DIVIDER_PX).toBe(1000)
  })

  it('a drag far past either edge stops at 375 on that side', () => {
    expect(splitWidths(1000, ratioAt(1000, -400)).left).toBe(PANE_MIN_PX)
    expect(splitWidths(1000, ratioAt(1000, 5000)).right).toBe(PANE_MIN_PX)
  })

  it('at exactly 758 the only ratio is the middle', () => {
    expect(splitWidths(758, clampRatio(758, 0.2))).toEqual({ left: 375, right: 375 })
  })

  it('a pane closing resets the ratio for the next pair', () => {
    const state = closePane({ ...two('wallet', 'message', 'wallet'), ratio: 0.7 }, 'message')

    expect(state.ratio).toBe(0.5)
    expect(state.open).toEqual(['wallet'])
  })
})

describe('a 3rd pane replaces the pane WITHOUT focus (D4)', () => {
  it('the unfocused one goes, the newcomer takes its side and the focus', () => {
    const { replaced, state } = openPane(two('wallet', 'message', 'message'), 'settings')

    expect(replaced).toBe('wallet')
    expect(state.open).toEqual(['settings', 'message'])
    expect(state.focused).toBe('settings')
  })

  it('the other way round, too', () => {
    const { replaced, state } = openPane(two('wallet', 'message', 'wallet'), 'email')

    expect(replaced).toBe('message')
    expect(state.open).toEqual(['wallet', 'email'])
  })

  it('never more than two panes', () => {
    let state = INITIAL_PANES

    for (const id of ['wallet', 'message', 'settings', 'email', 'containers']) {
      state = openPane(state, id).state
      expect(state.open.length).toBeLessThanOrEqual(2)
    }
  })

  it('Message and Settings share one route: one replaces the other whatever the focus', () => {
    const { replaced, state } = openPane(two('wallet', 'message', 'wallet'), 'settings', ['message', 'settings'])

    expect(replaced).toBe('message')
    expect(state.open).toEqual(['wallet', 'settings'])
  })

  it('registering a 3rd closes the replaced pane through its own close, then tells the toast', async () => {
    const closeWallet = vi.fn()
    const toast = vi.fn()

    setPaneCloser('wallet', closeWallet)
    onPaneReplaced(toast)
    registerPane('wallet')
    registerPane('containers')
    registerPane('email')

    await Promise.resolve()

    expect(closeWallet).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('wallet', 'email')
    expect($panes.get().open).toEqual(['email', 'containers'])
  })

  it('re-opening an open pane only focuses it', () => {
    const { replaced, state } = openPane(two('wallet', 'message', 'wallet'), 'message')

    expect(replaced).toBeNull()
    expect(state.open).toEqual(['wallet', 'message'])
    expect(state.focused).toBe('message')
  })
})

describe('Move left / Move right', () => {
  it('two panes swap so the pane is on that side, the divider staying where it was', () => {
    const state = movePane({ ...two('wallet', 'message', 'wallet'), ratio: 0.6 }, 'wallet', 'right')

    expect(state.open).toEqual(['message', 'wallet'])
    expect(state.ratio).toBeCloseTo(0.4)
  })

  it('a lone pane rests on that half (≥ 375) and leaves the rest to home', () => {
    const state = movePane(openPane(INITIAL_PANES, 'wallet').state, 'wallet', 'right')
    const arrangement = arrangePanes(state, 1344)

    expect(arrangement).toEqual({ kind: 'single', id: 'wallet', place: 'right' })
    expect(slotFor(arrangement, 'wallet', 1344)).toEqual({ place: 'right', left: 1344 - 668, width: 668 })
    expect(soloWidth(600)).toBe(PANE_MIN_PX)
  })

  it('a newcomer beside a pane resting on the right takes the left', () => {
    const resting = movePane(openPane(INITIAL_PANES, 'wallet').state, 'wallet', 'right')

    expect(openPane(resting, 'message').state.open).toEqual(['message', 'wallet'])
  })
})

describe('one chassis, five econ windows: a new id is the same pane', () => {
  it('keeps its side and its focus', () => {
    const state = renamePane(two('wallet', 'message', 'wallet'), 'wallet', 'email')

    expect(state.open).toEqual(['email', 'message'])
    expect(state.focused).toBe('email')
  })

  it('focus moves only between open panes', () => {
    const state = two('wallet', 'message', 'wallet')

    expect(focusPane(state, 'settings')).toBe(state)
    expect(focusPane(state, 'message').focused).toBe('message')
  })

  it('unregistering the last pane leaves an empty layout', () => {
    registerPane('wallet')
    unregisterPane('wallet')

    expect($panes.get()).toEqual(INITIAL_PANES)
  })
})

describe('never top / bottom', () => {
  it('no arrangement or slot has a vertical placement', () => {
    const states = [INITIAL_PANES, openPane(INITIAL_PANES, 'wallet').state, two('wallet', 'message', 'wallet')]

    for (const state of states) {
      for (const area of [400, 757, 758, 1344, 2400]) {
        const arrangement = arrangePanes(state, area)
        const text = JSON.stringify([arrangement, ...state.open.map(id => slotFor(arrangement, id, area))])

        expect(text).not.toMatch(/top|bottom/i)
      }
    }
  })
})

describe('v0.0.9 r2: Message and Settings as two panes (F6 spec: any pane type)', () => {
  it('as routes they still replace each other (a route change swaps them, nothing is closed by hand)', async () => {
    const closeMessage = vi.fn()

    registerPane('message')
    setPaneCloser('message', closeMessage)
    registerPane('settings')
    await Promise.resolve()

    expect($panes.get().open).toEqual(['settings'])
    expect(closeMessage).not.toHaveBeenCalled()
  })

  it('with Settings as a pane they sit side by side, either order, at most two', () => {
    $settingsBesideMessage.set(true)
    registerPane('message')
    registerPane('settings')

    expect($panes.get().open).toEqual(['message', 'settings'])

    resetPanesForTests()
    $settingsBesideMessage.set(true)
    registerPane('settings')
    registerPane('message')

    expect($panes.get().open).toEqual(['settings', 'message'])

    // A third replaces the one without focus (the generic rule), never a third column.
    registerPane('wallet')
    expect($panes.get().open).toHaveLength(2)
    expect($panes.get().open).toContain('wallet')
  })

  it('a pane replacing Settings-as-a-pane is closed by Settings own close (not left to a route change)', async () => {
    const closeSettings = vi.fn()

    $settingsBesideMessage.set(true)
    registerPane('message')
    registerPane('settings')
    setPaneCloser('settings', closeSettings)
    $panes.set(focusPane($panes.get(), 'message'))
    registerPane('wallet')
    await Promise.resolve()

    expect(closeSettings).toHaveBeenCalledOnce()
  })

  it('the Message + Settings pair keeps its own divider (per-pair memory) and the 375 pt limits', () => {
    $paneArea.set(1000)
    $settingsBesideMessage.set(true)
    registerPane('message')
    registerPane('settings')
    setPaneRatio(0.7)
    unregisterPane('settings')
    registerPane('settings')

    const arrangement = $paneArrangement.get()

    expect(arrangement.kind).toBe('split')
    expect(arrangement.kind === 'split' ? arrangement.widths.left : 0).toBeGreaterThan(600)

    setPaneRatio(0.99)
    const limited = $paneArrangement.get()

    expect(limited.kind === 'split' ? limited.widths.right : 0).toBeGreaterThanOrEqual(PANE_MIN_PX)
  })
})
