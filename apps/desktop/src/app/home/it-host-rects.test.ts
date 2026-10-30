import { describe, expect, it } from 'vitest'

import { IT_MIN_PANE_PX, leafSize, measureSlots, readSlotsIn, sameSlots, slotsBounds, splitFits } from './it-host-rects'

const node = (id: null | string, r: { left: number; top: number; width: number; height: number }) => ({
  getAttribute: () => id,
  getBoundingClientRect: () => ({ ...r, bottom: r.top + r.height, right: r.left + r.width })
})

describe('iT slot rects', () => {
  it('measures relative to the origin with floor/ceil edges', () => {
    const out = measureSlots([node('a', { left: 110.4, top: 50.6, width: 100.2, height: 40.1 })], {
      left: 100,
      top: 40
    })

    expect(out.a).toEqual({ left: 10, top: 10, width: 101, height: 41 })
  })

  it('ignores zero-size and unnamed slots', () => {
    const out = measureSlots([
      node('a', { left: 0, top: 0, width: 0, height: 10 }),
      node(null, { left: 0, top: 0, width: 5, height: 5 })
    ])

    expect(out).toEqual({})
  })

  it('reads only the slots inside its root', () => {
    document.body.innerHTML = '<div id="w"><div data-it-slot="in"></div></div><div data-it-slot="out"></div>'

    for (const el of document.querySelectorAll<HTMLElement>('[data-it-slot]')) {
      el.getBoundingClientRect = () => ({
        bottom: 10,
        height: 10,
        left: 0,
        right: 10,
        top: 0,
        width: 10,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    }

    expect(Object.keys(readSlotsIn(document.getElementById('w')!))).toEqual(['in'])
  })

  it('compares slot maps by value', () => {
    const a = { x: { left: 1, top: 2, width: 3, height: 4 } }

    expect(sameSlots(a, { x: { ...a.x } })).toBe(true)
    expect(sameSlots(a, { x: { ...a.x, top: 9 } })).toBe(false)
    expect(sameSlots(a, {})).toBe(false)
  })
})

describe('pane geometry for the split floor', () => {
  const leaf = (terminalId: string) => ({ terminalId, type: 'leaf' as const })
  const tree = { a: leaf('a'), b: leaf('b'), dir: 'h' as const, ratio: 0.5, type: 'split' as const }

  it('bounds the slots of a workspace', () => {
    expect(slotsBounds({})).toBeNull()
    expect(
      slotsBounds({
        a: { height: 100, left: 10, top: 20, width: 50 },
        b: { height: 100, left: 61, top: 20, width: 49 }
      })
    ).toEqual({ height: 100, width: 100 })
  })

  it('sizes a leaf by the ratios and finds nothing for a stranger', () => {
    expect(leafSize(tree, 'b', { height: 100, width: 201 })).toEqual({ height: 100, width: 100 })
    expect(leafSize(tree, 'zz', { height: 100, width: 201 })).toBeNull()
  })

  it('fits a split only when both halves keep the floor', () => {
    const body = { height: IT_MIN_PANE_PX.height * 2 + 4, width: IT_MIN_PANE_PX.width * 4 + 8 }

    expect(splitFits(tree, 'a', 'h', body)).toBe(true)
    expect(splitFits(tree, 'a', 'v', body)).toBe(true)
    expect(splitFits(tree, 'a', 'h', { ...body, width: IT_MIN_PANE_PX.width * 3 })).toBe(false)
    expect(splitFits(tree, 'a', 'v', { ...body, height: IT_MIN_PANE_PX.height * 2 })).toBe(false)
  })
})
