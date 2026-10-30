import { type RefObject, useEffect, useRef } from 'react'

import { createRendererLoopPauseController } from '@/lib/renderer-loop-pause'
import { $petMotion, $petRoamDir } from '@/store/pet'

import { chooseMove, dwellMs, PAUSE_DWELL, pickStrollTarget, ROAM_TICK_MS, walkStep } from './roam-behavior'
import { clampToLedge, computeLedges, homeSpot, type Ledge, readSurfaces } from './roam-geometry'

/** While still, re-measure the composer this often (it grows with the draft, moves with the layout). */
const SETTLE_POLL_MS = 250

interface PetPlacementOptions {
  /** The pet is shown in this window. */
  enabled: boolean
  /** Wander (roam on, agent at rest, pet in-window); otherwise stand where it is — at home when roam is off. */
  roam: boolean
  /** Roam is switched on in Settings (a pet that stops to react keeps its spot instead of going home). */
  roamOn: boolean
  containerRef: RefObject<HTMLDivElement | null>
  petW: number
  petH: number
  /** One tile in CSS px (= the scale). */
  tile: number
  /** Called after every placement step, once the host stands at its new spot (the click-through re-test). */
  onPlaced?: () => void
}

/**
 * Place the in-window pet at the composer's corner and, when it roams, walk it along the composer's top edge in
 * whole tiles — a tile a tick, ten ticks a second, the run state's foot cadence. Positions are written to the DOM
 * directly (no re-render per step) and are always multiples of the tile; the pet never overlaps the composer.
 * `$petMotion` / `$petRoamDir` publish the walk, so the sprite shows `run` while it travels.
 */
export function usePetPlacement({
  enabled,
  roam,
  roamOn,
  containerRef,
  petW,
  petH,
  tile,
  onPlaced
}: PetPlacementOptions): void {
  // Read at each step (not an effect dependency): a new callback identity never restarts the walk.
  const onPlacedRef = useRef(onPlaced)
  onPlacedRef.current = onPlaced

  useEffect(() => {
    const el = containerRef.current

    if (!enabled || !el) {
      $petMotion.set(null)
      $petRoamDir.set(0)

      return
    }

    let cur: null | { x: number; y: number } = null
    let phase: 'pause' | 'walk' = 'pause'
    let pauseUntil = performance.now() + dwellMs(PAUSE_DWELL)
    let target = 0
    let timer = 0
    let stopped = false

    const signal = (walking: boolean, dir: -1 | 0 | 1) => {
      $petMotion.set(walking ? 'run' : null)
      $petRoamDir.set(dir)
    }

    const apply = (next: { x: number; y: number }) => {
      // Standing where it stands (the settle poll, a pause): no write, no re-test — the placement did not change.
      if (cur && cur.x === next.x && cur.y === next.y) {
        return
      }

      cur = next
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`
      el.style.visibility = 'visible'
      onPlacedRef.current?.()
    }

    const place = (ledge: Ledge) => {
      if (!roamOn || !cur) {
        apply(homeSpot(ledge, petH, tile))

        return
      }

      apply(clampToLedge(ledge, cur.x, petH, tile))
    }

    const tick = () => {
      timer = 0

      if (stopped || pause.isPaused()) {
        signal(false, 0)

        return
      }

      const ledge = computeLedges(readSurfaces(), petW, petH)[0]!
      const now = performance.now()

      if (!roam) {
        phase = 'pause'
        signal(false, 0)
        place(ledge)
        schedule(SETTLE_POLL_MS)

        return
      }

      place(ledge)

      if (phase === 'pause' && now >= pauseUntil) {
        if (chooseMove() === 'stroll') {
          target = clampToLedge(ledge, pickStrollTarget(ledge, cur!.x, tile), petH, tile).x
          phase = target === cur!.x ? 'pause' : 'walk'
        }

        pauseUntil = now + dwellMs(PAUSE_DWELL)
      }

      if (phase === 'walk') {
        const x = walkStep(cur!.x, target, tile)
        signal(true, x > cur!.x ? 1 : x < cur!.x ? -1 : 0)
        apply({ x, y: cur!.y })

        if (x === target) {
          phase = 'pause'
          pauseUntil = now + dwellMs(PAUSE_DWELL)
          signal(false, 0)
        }

        schedule(ROAM_TICK_MS)

        return
      }

      signal(false, 0)
      schedule(Math.min(SETTLE_POLL_MS, Math.max(ROAM_TICK_MS, pauseUntil - now)))
    }

    function schedule(ms: number) {
      if (!stopped && timer === 0) {
        timer = window.setTimeout(tick, ms)
      }
    }

    // Hidden or minimised: sleep. Merely unfocused: keep tracking the composer (a 4–10 Hz timer, no frames).
    const pause = createRendererLoopPauseController(
      () => {
        if (!pause.isPaused()) {
          schedule(0)
        }
      },
      { pauseWhenUnfocused: false }
    )

    const onResize = () => {
      window.clearTimeout(timer)
      timer = 0
      tick()
    }

    window.addEventListener('resize', onResize)
    tick()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      pause.dispose()
      signal(false, 0)
    }
  }, [enabled, roam, roamOn, containerRef, petW, petH, tile])
}
