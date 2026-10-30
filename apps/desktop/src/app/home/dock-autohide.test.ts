import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DOCK_HIDE_MARGIN_PX, DOCK_REVEAL_EDGE_PX, nextDockReveal, useDockAutoHide } from './dock-autohide'
import { $expandedWindows, isWindowExpanded, retractWindow, setWindowExpanded } from './window/expanded'

afterEach(() => {
  $expandedWindows.set([])
})

describe('nextDockReveal', () => {
  it('the left edge reveals; clear of the rail hides; in between keeps the current state', () => {
    expect(nextDockReveal(false, DOCK_REVEAL_EDGE_PX, 80)).toBe(true)
    expect(nextDockReveal(false, 40, 80)).toBe(false)
    expect(nextDockReveal(true, 40, 80)).toBe(true)
    expect(nextDockReveal(true, 80 + DOCK_HIDE_MARGIN_PX, 80)).toBe(true)
    expect(nextDockReveal(true, 80 + DOCK_HIDE_MARGIN_PX + 1, 80)).toBe(false)
  })
})

describe('setWindowExpanded', () => {
  it('tracks each window once and drops it when retracted', () => {
    setWindowExpanded('email', true)
    setWindowExpanded('email', true)
    setWindowExpanded('message', true)
    expect($expandedWindows.get()).toEqual(['email', 'message'])
    setWindowExpanded('email', false)
    expect($expandedWindows.get()).toEqual(['message'])
  })
})

describe('retractWindow', () => {
  it('runs the retract an expanded window left, once, and nothing for a retracted or unknown one (W-1)', () => {
    const retract = vi.fn()

    expect(retractWindow('email')).toBe(false)
    setWindowExpanded('email', true, retract)
    expect(isWindowExpanded('email')).toBe(true)
    expect(retractWindow('email')).toBe(true)
    expect(retract).toHaveBeenCalledTimes(1)
    // The owner flips its state on the retract; until then the store still lists it — a second call retracts again.
    setWindowExpanded('email', false)
    expect(isWindowExpanded('email')).toBe(false)
    expect(retractWindow('email')).toBe(false)
    expect(retract).toHaveBeenCalledTimes(1)
  })

  it('an expansion published without a retract (the Dock-only callers) cannot be retracted by Escape', () => {
    setWindowExpanded('message', true)
    expect(retractWindow('message')).toBe(false)
  })
})

describe('useDockAutoHide', () => {
  const move = (clientX: number) => window.dispatchEvent(new PointerEvent('pointermove', { clientX }))

  it('auto-hides only while a window is expanded, and the left edge brings the Dock back', () => {
    const rail = { current: null }
    const { result } = renderHook(() => useDockAutoHide(rail))

    expect(result.current).toEqual({ autoHide: false, revealed: false })
    act(() => setWindowExpanded('email', true))
    expect(result.current).toEqual({ autoHide: true, revealed: false })
    act(() => move(2))
    expect(result.current.revealed).toBe(true)
    act(() => move(400))
    expect(result.current.revealed).toBe(false)
    act(() => move(1))
    act(() => setWindowExpanded('email', false))
    expect(result.current).toEqual({ autoHide: false, revealed: false })
  })
})
