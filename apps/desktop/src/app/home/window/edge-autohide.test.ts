import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { EDGE_HIDE_MARGIN_PX, EDGE_REVEAL_PX, type EdgeZone, nextEdgeReveal, useEdgeAutoHide } from './edge-autohide'

const WIDTH = 1200
// A right-edge column resting at x 1144..1170, y 52..140 (the Message window's column).
const RIGHT: EdgeZone = { edge: 'right', edgeX: WIDTH, innerX: 1144, band: { top: 52, bottom: 140 } }
const LEFT: EdgeZone = { edge: 'left', edgeX: 0, innerX: 80 }

describe('nextEdgeReveal', () => {
  it('left: the edge strip reveals, up to EDGE_REVEAL_PX in', () => {
    expect(nextEdgeReveal(false, { x: 0, y: 500 }, LEFT)).toBe(true)
    expect(nextEdgeReveal(false, { x: EDGE_REVEAL_PX, y: 500 }, LEFT)).toBe(true)
    expect(nextEdgeReveal(false, { x: EDGE_REVEAL_PX + 1, y: 500 }, LEFT)).toBe(false)
  })

  it('left: between the strip and the hide margin keeps the current state (hysteresis)', () => {
    expect(nextEdgeReveal(true, { x: 80 + EDGE_HIDE_MARGIN_PX, y: 0 }, LEFT)).toBe(true)
    expect(nextEdgeReveal(false, { x: 80 + EDGE_HIDE_MARGIN_PX, y: 0 }, LEFT)).toBe(false)
    expect(nextEdgeReveal(true, { x: 80 + EDGE_HIDE_MARGIN_PX + 1, y: 0 }, LEFT)).toBe(false)
  })

  it('right: the strip mirrors the left one against the far edge', () => {
    expect(nextEdgeReveal(false, { x: WIDTH - 3, y: 96 }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - EDGE_REVEAL_PX, y: 96 }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - EDGE_REVEAL_PX - 1, y: 96 }, RIGHT)).toBe(false)
  })

  it('right: a revealed column stays until the pointer is more than the margin left of its resting left', () => {
    expect(nextEdgeReveal(true, { x: 1144, y: 96 }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(true, { x: 1144 - EDGE_HIDE_MARGIN_PX, y: 96 }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(true, { x: 1144 - EDGE_HIDE_MARGIN_PX - 1, y: 96 }, RIGHT)).toBe(false)
  })

  it('band: the edge is hot only level with the target, give or take the margin', () => {
    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: 52 - EDGE_HIDE_MARGIN_PX }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: 140 + EDGE_HIDE_MARGIN_PX }, RIGHT)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: 52 - EDGE_HIDE_MARGIN_PX - 1 }, RIGHT)).toBe(false)
    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: 140 + EDGE_HIDE_MARGIN_PX + 1 }, RIGHT)).toBe(false)
  })

  it('band: leaving it hides a revealed target even right at the edge', () => {
    expect(nextEdgeReveal(true, { x: WIDTH - 1, y: 140 + 100 }, RIGHT)).toBe(false)
    expect(nextEdgeReveal(true, { x: 1160, y: 0 }, RIGHT)).toBe(false)
  })

  it('no band: the whole height of the edge is hot', () => {
    const zone: EdgeZone = { ...RIGHT, band: undefined }

    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: 5000 }, zone)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - 1, y: -5000 }, zone)).toBe(true)
  })

  it('island offset: the strip starts at the island, not the viewport edge', () => {
    // A 384px island on the right: the column steps left of it, and the hot strip moves with it.
    const zone: EdgeZone = { ...RIGHT, edgeX: WIDTH - 384, innerX: WIDTH - 384 - 52 }

    expect(nextEdgeReveal(false, { x: WIDTH - 384 - EDGE_REVEAL_PX, y: 96 }, zone)).toBe(true)
    expect(nextEdgeReveal(false, { x: WIDTH - 384 - EDGE_REVEAL_PX - 1, y: 96 }, zone)).toBe(false)
    expect(nextEdgeReveal(false, { x: WIDTH - 10, y: 96 }, zone)).toBe(true)
  })

  it('island offset: a column resting under the island (innerX right of edgeX) keeps the hysteresis past the strip', () => {
    const edgeX = WIDTH - 320
    const zone: EdgeZone = { ...RIGHT, edgeX, innerX: WIDTH - 46 }

    expect(nextEdgeReveal(false, { x: edgeX - EDGE_REVEAL_PX, y: 96 }, zone)).toBe(true)
    expect(nextEdgeReveal(true, { x: edgeX - EDGE_HIDE_MARGIN_PX, y: 96 }, zone)).toBe(true)
    expect(nextEdgeReveal(false, { x: edgeX - EDGE_HIDE_MARGIN_PX, y: 96 }, zone)).toBe(false)
    expect(nextEdgeReveal(true, { x: edgeX - EDGE_HIDE_MARGIN_PX - 1, y: 96 }, zone)).toBe(false)
  })

  it('left inset: a target resting inside the inset edge keeps the same hysteresis past the strip', () => {
    const zone: EdgeZone = { edge: 'left', edgeX: 200, innerX: 120 }

    expect(nextEdgeReveal(false, { x: 200 + EDGE_REVEAL_PX, y: 0 }, zone)).toBe(true)
    expect(nextEdgeReveal(true, { x: 200 + EDGE_HIDE_MARGIN_PX, y: 0 }, zone)).toBe(true)
    expect(nextEdgeReveal(true, { x: 200 + EDGE_HIDE_MARGIN_PX + 1, y: 0 }, zone)).toBe(false)
  })
})

describe('useEdgeAutoHide', () => {
  const target = document.createElement('div')
  const child = document.createElement('button')

  target.append(child)
  // jsdom lays nothing out: give the target the Message column's resting box.
  Object.defineProperties(target, {
    offsetLeft: { value: 1144 },
    offsetTop: { value: 52 },
    offsetWidth: { value: 26 },
    offsetHeight: { value: 88 }
  })
  document.body.append(target)

  const pointer = (
    type: string,
    clientX: number,
    clientY: number,
    on: EventTarget = window,
    init: PointerEventInit = {}
  ) => on.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, ...init }))

  const setup = (active = true, band = true) => {
    const ref = { current: target }

    return renderHook(props => useEdgeAutoHide({ active: props.active, band, edge: 'right', targetRef: ref }), {
      initialProps: { active }
    })
  }

  afterEach(() => {
    pointer('pointerup', 0, 0)
  })

  it('stays hidden and ignores the pointer while inactive', () => {
    window.innerWidth = WIDTH
    const { result } = setup(false)

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    expect(result.current).toBe(false)
  })

  it('the right edge level with the column reveals it; clear of it hides it again', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    expect(result.current).toBe(false)
    act(() => void pointer('pointermove', WIDTH - 3, 96))
    expect(result.current).toBe(true)
    act(() => void pointer('pointermove', 1144 - 20, 96))
    expect(result.current).toBe(true)
    act(() => void pointer('pointermove', 1144 - 60, 96))
    expect(result.current).toBe(false)
  })

  it('the right edge below the band never reveals (a scrollbar drag lower down)', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 140 + 100))
    expect(result.current).toBe(false)
  })

  it('without a band the whole edge is hot', () => {
    window.innerWidth = WIDTH
    const { result } = setup(true, false)

    act(() => void pointer('pointermove', WIDTH - 2, 900))
    expect(result.current).toBe(true)
  })

  it('the pointer leaving the app hides it; moving onto another element does not', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    act(() => void pointer('pointerout', WIDTH - 2, 96, child, { relatedTarget: target }))
    expect(result.current).toBe(true)
    act(() => void pointer('pointerout', WIDTH - 2, 96, child))
    expect(result.current).toBe(false)
  })

  it('a press inside holds it revealed through a far drag until release, then settles', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    act(() => void pointer('pointerdown', 1157, 96, child))
    act(() => void pointer('pointermove', 1157 - 200, 96))
    act(() => void pointer('pointerout', 1157 - 200, 96, child))
    expect(result.current).toBe(true)
    act(() => void pointer('pointerup', 1157 - 200, 96))
    expect(result.current).toBe(false)
  })

  it('a cancelled press settles at the last reported position, not at 0,0', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    act(() => void pointer('pointerdown', 1157, 96, child))
    act(() => void pointer('pointermove', 1150, 96))
    act(() => void pointer('pointercancel', 0, 0))
    expect(result.current).toBe(true)
  })

  it('a press outside the target does not hold it', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    act(() => void pointer('pointerdown', 600, 96, document.body))
    act(() => void pointer('pointermove', 600, 96))
    expect(result.current).toBe(false)
  })

  it('a drag that began outside the column never reveals it, even reaching the edge in the band', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointerdown', 600, 96, document.body))
    act(() => void pointer('pointermove', WIDTH - 2, 96, window, { buttons: 1 }))
    expect(result.current).toBe(false)
    act(() => void pointer('pointerup', WIDTH - 2, 96))
    act(() => void pointer('pointermove', WIDTH - 1, 96))
    expect(result.current).toBe(true)
  })

  it('a plain move (no button held) after an outside click still reveals at the edge', () => {
    window.innerWidth = WIDTH
    const { result } = setup()

    act(() => void pointer('pointerdown', 600, 96, document.body))
    act(() => void pointer('pointerup', 600, 96))
    act(() => void pointer('pointermove', WIDTH - 2, 96))
    expect(result.current).toBe(true)
  })

  it('deactivating resets it, and a later activation starts hidden', () => {
    window.innerWidth = WIDTH
    const { rerender, result } = setup()

    act(() => void pointer('pointermove', WIDTH - 2, 96))
    expect(result.current).toBe(true)
    rerender({ active: false })
    expect(result.current).toBe(false)
    rerender({ active: true })
    expect(result.current).toBe(false)
  })
})
