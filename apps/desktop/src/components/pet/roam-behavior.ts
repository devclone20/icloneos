/**
 * The roam's rhythm (ported from the old `roam-behavior`): when to rest, when to
 * walk and where to — every function takes an injectable `rng`, so it is unit
 * testable. Two ideas carry it: loaf, don't pace (most beats keep resting), and
 * memoryless dwell times (an exponential pause: mostly short, now and then
 * long), so the cadence never reads as a fixed pattern. The pet walks in WHOLE
 * TILES: one tile a tick, a tick each tenth of a second — the run state's foot
 * cadence (5 Hz, a foot change every 0.1 s), so every step lands on a foot.
 */

import type { Ledge } from './roam-geometry'

type Rng = () => number

interface DwellRange {
  meanMs: number
  minMs: number
  maxMs: number
}

export const PAUSE_DWELL: DwellRange = { maxMs: 13000, meanMs: 4200, minMs: 1500 }
const REST_CHANCE = 0.62
/** One tick = one tile of travel = one foot change of the run state (5 Hz → a change every 100 ms). */
export const ROAM_TICK_MS = 100
const STROLL_MIN_FRACTION = 0.45
const STROLL_MIN_TILES = 24
const STROLL_TOWARD_ROOM = 0.85

/** Exponential dwell, clamped to [minMs, maxMs]. */
export function dwellMs({ meanMs, minMs, maxMs }: DwellRange, rng: Rng = Math.random): number {
  const u = 1 - rng()

  return Math.min(maxMs, Math.max(minMs, -Math.log(u) * meanMs))
}

/** Rest (the common case) or stroll. */
export function chooseMove(rng: Rng = Math.random): 'rest' | 'stroll' {
  return rng() < REST_CHANCE ? 'rest' : 'stroll'
}

/** A stroll target on the ledge that goes somewhere: toward the roomier side, at least a good share of it, in whole tiles. */
export function pickStrollTarget(ledge: Ledge, fromX: number, tile: number, rng: Rng = Math.random): number {
  const span = ledge.right - ledge.left

  if (span <= 4 * tile) {
    return fromX
  }

  const roomLeft = fromX - ledge.left
  const roomRight = ledge.right - fromX
  const goRight = rng() < STROLL_TOWARD_ROOM === roomRight >= roomLeft
  const room = Math.max(0, goRight ? roomRight : roomLeft)
  const minDist = Math.min(room, Math.max(span * STROLL_MIN_FRACTION, STROLL_MIN_TILES * tile))
  const dist = Math.floor((minDist + rng() * Math.max(0, room - minDist)) / tile) * tile

  return goRight ? fromX + dist : fromX - dist
}

/** One tick of a walk: exactly one tile toward the target (or onto it). */
export function walkStep(x: number, target: number, tile: number): number {
  const remaining = target - x

  return Math.abs(remaining) <= tile ? target : x + Math.sign(remaining) * tile
}
