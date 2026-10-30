import { describe, expect, it } from 'vitest'

import { chooseMove, dwellMs, PAUSE_DWELL, pickStrollTarget, walkStep } from './roam-behavior'
import {
  clampToLedge,
  computeLedges,
  coversComposer,
  homeSpot,
  type Rect,
  snapToTile,
  type Surfaces
} from './roam-geometry'

const surfaces = (composer: null | Rect, width = 1200, height = 800, floorBar: null | Rect = null): Surfaces => ({
  composer,
  floorBar,
  viewport: { height, width }
})

const COMPOSERS: Rect[] = [
  { bottom: 780, left: 300, right: 1100, top: 690 },
  { bottom: 790, left: 0, right: 1200, top: 600 },
  { bottom: 760, left: 420, right: 700, top: 700 },
  { bottom: 640, left: 80, right: 600, top: 420 }
]

describe('where the pet may stand (gate P8)', () => {
  it("on the composer's top edge when there is one; on the floor otherwise (the status bar's top if pinned)", () => {
    expect(computeLedges(surfaces(COMPOSERS[0]!), 43, 69)).toEqual([{ id: 'composer', left: 300, right: 1057, y: 690 }])
    expect(computeLedges(surfaces(null), 43, 69)).toEqual([{ id: 'floor', left: 0, right: 1157, y: 800 }])
    expect(
      computeLedges(surfaces(null, 1200, 800, { bottom: 800, left: 0, right: 1200, top: 776 }), 43, 69)[0]!.y
    ).toBe(776)
    // A composer too narrow for the pet, or with no headroom, is not a ledge.
    expect(computeLedges(surfaces({ bottom: 800, left: 10, right: 40, top: 700 }), 43, 69)[0]!.id).toBe('floor')
    expect(computeLedges(surfaces({ bottom: 800, left: 0, right: 900, top: 30 }), 43, 69)[0]!.id).toBe('floor')
  })

  it('every spot the pet can take: whole tiles, inside the window, in the bottom band, never over the composer', () => {
    let checked = 0

    for (const composer of [...COMPOSERS, null]) {
      for (const scale of [1, 2, 3]) {
        const petW = 43 * scale
        const petH = 69 * scale
        const s = surfaces(composer)
        const ledge = computeLedges(s, petW, petH)[0]!
        const band = composer ? composer.top - petH : s.viewport.height - petH

        for (let x = -50; x <= s.viewport.width + 50; x += 7) {
          const at = clampToLedge(ledge, x, petH, scale)
          const rect = { bottom: at.y + petH, left: at.x, right: at.x + petW, top: at.y }
          expect(at.x % scale).toBe(0)
          expect(at.y % scale).toBe(0)
          expect(rect.left).toBeGreaterThanOrEqual(0)
          expect(rect.right).toBeLessThanOrEqual(s.viewport.width)
          expect(rect.top).toBeGreaterThanOrEqual(band - scale)
          expect(rect.bottom).toBeLessThanOrEqual(composer ? composer.top : s.viewport.height)
          expect(coversComposer(rect, composer)).toBe(false)
          checked++
        }
      }
    }

    expect(checked).toBeGreaterThan(2000)
  })

  it("home is the composer's top-right corner, a few tiles in from the send button", () => {
    const ledge = computeLedges(surfaces(COMPOSERS[0]!), 43, 69)[0]!
    expect(homeSpot(ledge, 69, 1)).toEqual({ x: 1053, y: 621 })
    expect(homeSpot(computeLedges(surfaces(COMPOSERS[0]!), 86, 138)[0]!, 138, 2)).toEqual({ x: 1006, y: 552 })
  })

  it('coversComposer is a real overlap test', () => {
    const c = COMPOSERS[0]!
    expect(coversComposer({ bottom: 700, left: 400, right: 443, top: 631 }, c)).toBe(true)
    expect(coversComposer({ bottom: 690, left: 400, right: 443, top: 621 }, c)).toBe(false)
    expect(snapToTile(10, 3)).toBe(9)
  })
})

describe('the roam rhythm, in whole tiles', () => {
  it('walks exactly one tile a tick and lands on the target', () => {
    let x = 0
    const seen: number[] = []

    while (x !== 12) {
      x = walkStep(x, 12, 3)
      seen.push(x)
    }

    expect(seen).toEqual([3, 6, 9, 12])
    expect(walkStep(10, 4, 2)).toBe(8)
  })

  it('stroll targets are whole tiles inside the ledge and go somewhere', () => {
    const ledge = { id: 'composer' as const, left: 300, right: 1056, y: 690 }

    const rng = (() => {
      let i = 0

      return () => [0.1, 0.9, 0.5, 0.3, 0.7][i++ % 5]!
    })()

    for (let n = 0; n < 50; n++) {
      const from = 300 + 2 * ((n * 37) % 300)
      const to = pickStrollTarget(ledge, from, 2, rng)
      expect(Math.abs((to - from) % 2)).toBe(0)
      expect(to).toBeGreaterThanOrEqual(ledge.left)
      expect(to).toBeLessThanOrEqual(ledge.right)
      expect(Math.abs(to - from)).toBeGreaterThanOrEqual(
        Math.min(48, Math.max(from - ledge.left, ledge.right - from) > 0 ? 2 : 0)
      )
    }
  })

  it('loafs more than it walks, with dwell times clamped', () => {
    expect(chooseMove(() => 0.1)).toBe('rest')
    expect(chooseMove(() => 0.9)).toBe('stroll')
    expect(dwellMs(PAUSE_DWELL, () => 0)).toBe(PAUSE_DWELL.minMs)
    expect(dwellMs(PAUSE_DWELL, () => 0.999999)).toBe(PAUSE_DWELL.maxMs)
  })
})
