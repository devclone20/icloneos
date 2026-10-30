import { createRendererLoopPauseController } from '@/lib/renderer-loop-pause'

/**
 * ONE clock for every pet canvas in a window (the library draws twenty at once), driven by the states' own cadence
 * (R4-F3): a pet's frame is a pure function of time made of whole-tile steps, so each sprite says when its frame can
 * change next, and the clock sleeps until the earliest of those deadlines — one `setTimeout`, then a single
 * `requestAnimationFrame` that draws every sprite that is due (on the display's beat) — and nothing in between. An
 * idle pet wakes about once a second, not sixty times. The clock sleeps with the window when it is hidden, minimised
 * or occluded (`document.visibilityState`) and — unless the sprite animates unfocused (the pop-out) — when the window
 * loses focus; on waking, every sprite that came due meanwhile draws at once. A change of reduced motion or of the
 * display's pixel ratio wakes every sprite. No subscriber, no timer, no frame, no listener.
 */

/** Draw at `now` (repaint only if the frame changed); return when the frame may change next (`performance.now()` ms). */
type Draw = (now: number) => number

interface Subscriber {
  draw: Draw
  animateUnfocused: boolean
  /** The next deadline (`performance.now()` ms); −∞: draw on the next frame; +∞: never on its own. */
  due: number
}

interface PetFrameSubscription {
  /** Draw on the next frame, whatever the deadline (a prop the frame depends on changed). */
  wake: () => void
  dispose: () => void
}

type PauseController = ReturnType<typeof createRendererLoopPauseController>

const subscribers = new Set<Subscriber>()
let timer: ReturnType<typeof setTimeout> | undefined
let timerAt = Infinity
let raf = 0
let pauseFocused: null | PauseController = null
let pauseVisible: null | PauseController = null
let unwatchMedia: null | (() => void) = null

const runs = (s: Subscriber): boolean => !(s.animateUnfocused ? pauseVisible : pauseFocused)?.isPaused()

function frame(rafNow: number): void {
  raf = 0
  // The frame's timestamp can trail the clock a little: never draw a deadline "early".
  const now = Math.max(rafNow, performance.now())

  for (const s of [...subscribers]) {
    if (subscribers.has(s) && runs(s) && s.due <= now) {
      s.due = s.draw(now)
    }
  }

  schedule()
}

/** Arm the one timer at the earliest deadline of the sprites that may run (none: no timer). */
function schedule(): void {
  if (raf !== 0) {
    return // a frame is on its way; it schedules what follows
  }

  let next = Infinity

  for (const s of subscribers) {
    if (s.due < next && runs(s)) {
      next = s.due
    }
  }

  if (next === timerAt && timer !== undefined) {
    return
  }

  clearTimeout(timer)
  timer = undefined
  timerAt = Infinity

  if (next === Infinity) {
    return
  }

  timerAt = next
  timer = setTimeout(
    () => {
      timer = undefined
      timerAt = Infinity
      raf = requestAnimationFrame(frame)
    },
    Math.max(0, Math.ceil(next - performance.now()))
  )
}

function wakeAll(): void {
  for (const s of subscribers) {
    s.due = -Infinity
  }

  schedule()
}

/** Reduced motion flipped, or the window moved to a display with another pixel ratio: every sprite redraws. */
function watchMedia(): () => void {
  if (typeof window.matchMedia !== 'function') {
    return () => {}
  }

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let ratio: MediaQueryList | null = null

  const onRatio = () => {
    ratio?.removeEventListener('change', onRatio)
    ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    ratio.addEventListener('change', onRatio)
    wakeAll()
  }

  motion.addEventListener('change', wakeAll)
  ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  ratio.addEventListener('change', onRatio)

  return () => {
    motion.removeEventListener('change', wakeAll)
    ratio?.removeEventListener('change', onRatio)
  }
}

/**
 * Ride the shared clock until `dispose`: `draw` runs at its own deadlines (the one it returns, and `due`, the one the
 * caller's first, synchronous draw returned), on an animation frame.
 */
export function onPetFrame(
  draw: Draw,
  { animateUnfocused = false, due = -Infinity }: { animateUnfocused?: boolean; due?: number } = {}
): PetFrameSubscription {
  if (subscribers.size === 0) {
    pauseFocused = createRendererLoopPauseController(schedule, { pauseWhenUnfocused: true })
    pauseVisible = createRendererLoopPauseController(schedule, { pauseWhenUnfocused: false })
    unwatchMedia = watchMedia()
  }

  const sub: Subscriber = { animateUnfocused, draw, due }
  subscribers.add(sub)
  schedule()

  return {
    dispose: () => {
      if (!subscribers.delete(sub)) {
        return
      }

      if (subscribers.size > 0) {
        schedule()

        return
      }

      clearTimeout(timer)
      timer = undefined
      timerAt = Infinity
      cancelAnimationFrame(raf)
      raf = 0
      pauseFocused?.dispose()
      pauseVisible?.dispose()
      unwatchMedia?.()
      pauseFocused = null
      pauseVisible = null
      unwatchMedia = null
    },
    wake: () => {
      if (subscribers.has(sub)) {
        sub.due = -Infinity
        schedule()
      }
    }
  }
}
