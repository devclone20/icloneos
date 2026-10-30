import { describe, expect, it } from 'vitest'

import { dockZoneContains, restDockZone } from './dock'

describe('dock zone (rest rail + hysteresis)', () => {
  // 7 tiles: 7*44 + 6*8 + 2*10 = 376px tall, centred on a 900px viewport.
  const zone = restDockZone(12, 900, 7)

  it('is the undeformed rail, centred where the CSS pins it', () => {
    expect(zone).toEqual({ bottom: 638, left: 12, right: 76, top: 262 })
  })

  it('enters only at the rest edge', () => {
    expect(dockZoneContains(zone, 40, 639, false)).toBe(false)
    expect(dockZoneContains(zone, 40, 638, false)).toBe(true)
  })

  it('once active, holds through the release margin so growth can never flip the decision', () => {
    // Just below the rest edge: a fresh pointer is out, a tracking one stays in.
    expect(dockZoneContains(zone, 40, 645, false)).toBe(false)
    expect(dockZoneContains(zone, 40, 645, true)).toBe(true)
    expect(dockZoneContains(zone, 40, 653, true)).toBe(false)
  })

  it('keeps tracking over a magnified tile popped out to the right', () => {
    expect(dockZoneContains(zone, 100, 450, false)).toBe(false)
    expect(dockZoneContains(zone, 100, 450, true)).toBe(true)
  })
})

describe('magnification curve', () => {
  it('keeps the row growth constant as the pointer crosses icons and gaps (no breathing)', async () => {
    const { totalGrowthForTest } = await import('./dock')
    // Pointer anywhere in the middle of a long row: every sample of the window falls inside the row.
    const samples = Array.from({ length: 53 }, (_, k) => totalGrowthForTest(15, 400 + k))
    const spread = Math.max(...samples) - Math.min(...samples)

    expect(spread).toBeLessThan(0.01)
  })
})
