/**
 * The seven pet states as pure functions `(t, seed) → PetFrame` (V3-P §1.3).
 *
 * `t` is seconds since the state began, `seed` the pet's own (a hash of its id),
 * so two pets never breathe in step. A frame is a handful of WHOLE-TILE numbers —
 * which yaw, how far each band of rows moves — never a fraction: every step is a
 * jump from one integer to the next, with no tweening and no interpolation. The
 * transforms are the arsenal fragments' (`pets-<legion>.widget.html`), which the
 * owner approved: breath = 6 s sine, top 35 % up to 2 tiles, trunk 1, feet 0;
 * wave = top rows ±1 tile at 4 Hz; run = a foot up 1 tile at 5 Hz; jump =
 * 1-2-3-3-2-1 tiles over 0.6 s. `prefers-reduced-motion` turns every state into
 * the breath alone (`petFrame(…, reduced = true)`).
 *
 * r2 (lead ruling m4): the run also BOBS — everything above the feet rises one
 * tile with the left foot and settles with the right, one bob a stride (5 Hz,
 * in step with the feet), so the busy pose reads at scale 1 and not only as a
 * 1-px foot flicker. While roaming, the pet faces its walk with the sprite's
 * own side views (`facingYaw`): no mirrored front view.
 */

export type PetState = 'failed' | 'idle' | 'jump' | 'review' | 'run' | 'wave' | 'waiting'

export const PET_STATES: readonly PetState[] = ['idle', 'wave', 'run', 'jump', 'waiting', 'review', 'failed']

export interface PetFrame {
  /** Yaw index 0…23 (k · 15°); 0 faces the viewer. */
  yaw: number
  /** Breath lift of the top 35 % of the figure, in tiles (0…2). */
  breathTop: number
  /** Breath lift of the trunk, in tiles (0…1); the feet never move. */
  breathMid: number
  /** Wave: the top rows slip this many tiles sideways (−1, 0, 1). */
  waveDx: number
  /** Run: 0 both feet down, 1 the left foot up one tile, 2 the right one. */
  run: 0 | 1 | 2
  /** Run: everything above the feet up this many tiles (0 or 1), one bob a stride, with the left foot. */
  bob: number
  /** Jump: the whole figure up this many tiles; its shadow stays on the ground. */
  lift: number
  /** Waiting: the whole figure sways this many tiles (−1, 0, 1). */
  swayDx: number
  /** The accent (the eyes) dark: a blink while waiting, always while failed. */
  accentDark: boolean
  /** The plate's paint share: .85 (the arsenal's mix) or 1 (the review pulse). */
  plateMix: number
  /** A broken-pixel glitch event on now (failed), or null. */
  glitch: null | PetGlitch
}

interface PetGlitch {
  /** The event's slot number: with the seed it fixes every band the event moves. */
  slot: number
  /** The event's own seed (the bands, their shifts, the tiles that drop). */
  seed: number
}

export const BREATH_SECONDS = 6
const TURN_PERIOD_SECONDS = 48
/** One idle turn walks the 24 yaws, a quarter second each, and comes back to the front. */
const TURN_STEP_SECONDS = 0.25
const YAWS = 24
export const WAVE_SECONDS = 1
const WAVE_HZ = 4
const RUN_HZ = 5
const JUMP_STEPS: readonly number[] = [1, 2, 3, 3, 2, 1]
const JUMP_SECONDS = 0.6
/** A celebrate holds for a few hops: 0.6 s up and down, then 0.4 s on the ground. */
const JUMP_PERIOD_SECONDS = 1
const SWAY_STEP_SECONDS = 1.5
const SWAY_STEPS: readonly number[] = [0, 1, 0, -1]
const BLINK_PERIOD_SECONDS = 3
const BLINK_SECONDS = 0.15
const PULSE_SECONDS = 1.2
export const PAINT_MIX = 0.85
const GLITCH_SLOT_SECONDS = 2
const GLITCH_MIN_SECONDS = 0.09
const GLITCH_SPAN_SECONDS = 0.06

/** The arsenal's integer hash (`mix`): a seed and a salt → [0, 1). */
export function mix(i: number, salt: number): number {
  let x = Math.imul((i | 0) + 1, 0x9e3779b1) ^ Math.imul((salt | 0) + 1, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)

  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}

/** FNV-1a over the id — the arsenal's `hashStr`, so a pet's seed is the arsenal's. */
export function petSeed(id: string): number {
  let h = 2166136261

  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  }

  return h | 0
}

const floorMod = (a: number, n: number): number => ((a % n) + n) % n
const step = (t: number, seconds: number): number => Math.floor(t / seconds + 1e-9)

const REST: PetFrame = {
  accentDark: false,
  bob: 0,
  breathMid: 0,
  breathTop: 0,
  glitch: null,
  lift: 0,
  plateMix: PAINT_MIX,
  run: 0,
  swayDx: 0,
  waveDx: 0,
  yaw: 0
}

/** The breath at t: 0 → 1 → 0 over 6 s (a sine), held to whole tiles — top round(2a), trunk round(a). */
function breathAt(t: number, seed: number): { top: number; mid: number } {
  const a = (1 - Math.cos(2 * Math.PI * (t / BREATH_SECONDS + mix(seed, 99)))) / 2

  return { mid: Math.min(1, Math.round(a)), top: Math.min(2, Math.round(2 * a)) }
}

function breathing(t: number, seed: number): PetFrame {
  const b = breathAt(t, seed)

  return { ...REST, breathMid: b.mid, breathTop: b.top }
}

/** The idle turn: once every 48 s (at a seeded moment) the pet walks the 24 yaws and faces the front again. */
export function turnYaw(t: number, seed: number): number {
  const local = floorMod(t + mix(seed, 7) * TURN_PERIOD_SECONDS, TURN_PERIOD_SECONDS)
  const k = step(local, TURN_STEP_SECONDS)

  return k < YAWS ? k : 0
}

const idle = (t: number, seed: number): PetFrame => ({ ...breathing(t, seed), yaw: turnYaw(t, seed) })

/** Wave: the top rows slip right, left, right… 1 tile at 4 Hz for one second, then rest. */
const wave = (t: number, seed: number): PetFrame => ({
  ...breathing(t, seed),
  waveDx: t >= 0 && t < WAVE_SECONDS ? (step(t, 1 / (2 * WAVE_HZ)) % 2 ? -1 : 1) : 0
})

/** Run: the feet alternate 1 tile at 5 Hz for as long as the state holds; the body bobs up with the left foot. */
const run = (t: number): PetFrame => {
  const left = floorMod(step(t, 1 / (2 * RUN_HZ)), 2) === 0

  return { ...REST, bob: left ? 1 : 0, run: left ? 1 : 2 }
}

/** Jump: up 1-2-3-3-2-1 tiles over 0.6 s, 0.4 s on the ground, again. */
const jump = (t: number): PetFrame => {
  const local = floorMod(t, JUMP_PERIOD_SECONDS)
  const i = step(local, JUMP_SECONDS / JUMP_STEPS.length)

  return { ...REST, lift: i < JUMP_STEPS.length ? JUMP_STEPS[i]! : 0 }
}

/** Waiting: a slow sway (0, +1, 0, −1 tiles, a step each 1.5 s) and the eyes blink every 3 s. */
const waiting = (t: number, seed: number): PetFrame => {
  const blinkAt = floorMod(t + mix(seed, 3) * BLINK_PERIOD_SECONDS, BLINK_PERIOD_SECONDS)

  return {
    ...breathing(t, seed),
    accentDark: blinkAt < BLINK_SECONDS,
    swayDx: SWAY_STEPS[floorMod(step(t, SWAY_STEP_SECONDS), SWAY_STEPS.length)]!
  }
}

/** Review: the yaw turns to the camera and the plate pulses 85 % → 100 % every 1.2 s. */
const review = (t: number, seed: number): PetFrame => ({
  ...breathing(t, seed),
  plateMix: floorMod(step(t, PULSE_SECONDS / 2), 2) === 0 ? PAINT_MIX : 1,
  yaw: 0
})

/** Slot k's glitch event: its own seed and its window [t0, t1). */
function glitchEvent(k: number, seed: number): { s: number; t0: number; t1: number } {
  const s = seed ^ Math.imul(k + 7, 0x2c1b3c6d)
  const t0 = k * GLITCH_SLOT_SECONDS + GLITCH_SLOT_SECONDS * (0.25 + 0.5 * mix(s, 0))
  const t1 = t0 + GLITCH_MIN_SECONDS + GLITCH_SPAN_SECONDS * mix(s, 1)

  return { s, t0, t1 }
}

/** The arsenal's glitch clock: one event a 2 s slot, starting in its middle half, lasting 90–150 ms. */
export function glitchAt(t: number, seed: number): null | PetGlitch {
  const k0 = Math.floor(t / GLITCH_SLOT_SECONDS)

  for (const k of [k0, k0 - 1]) {
    const { s, t0, t1 } = glitchEvent(k, seed)

    if (t >= t0 && t < t1) {
      return { seed: s, slot: k }
    }
  }

  return null
}

/** Failed: the broken-pixel glitch (bands slip ±1–2 tiles) and the accent dark. */
const failed = (t: number, seed: number): PetFrame => ({
  ...breathing(t, seed),
  accentDark: true,
  glitch: glitchAt(t, seed)
})

const PET_STATE_FRAMES: Readonly<Record<PetState, (t: number, seed: number) => PetFrame>> = {
  failed,
  idle,
  jump,
  review,
  run,
  wave,
  waiting
}

/** The frame of `state` at `t` — or the breath alone when the user asked for reduced motion. */
export function petFrame(state: PetState, t: number, seed: number, reduced = false): PetFrame {
  return reduced ? breathing(t, seed) : PET_STATE_FRAMES[state](t, seed)
}

// ── when the frame changes next (R4-F3: the renderer sleeps until then) ─────────

/** The next step boundary of `step(t + phase, period)` strictly after t. */
const nextStep = (t: number, period: number, phase = 0): number => (step(t + phase, period) + 1) * period - phase

/**
 * The breath's whole-tile numbers change where a = (1 − cos 2πu) / 2 crosses ¼ (top 0↔1), ½ (trunk 0↔1) and ¾
 * (top 1↔2): at these phases u of its 6 s cycle.
 */
const BREATH_EDGES: readonly number[] = [1 / 6, 1 / 4, 1 / 3, 2 / 3, 3 / 4, 5 / 6, 1 + 1 / 6]

function nextBreath(t: number, seed: number): number {
  const u = t / BREATH_SECONDS + mix(seed, 99)
  const f = u - Math.floor(u)
  const edge = BREATH_EDGES.find(e => e > f)!

  return t + (edge - f) * BREATH_SECONDS
}

/** The turn steps a yaw every quarter second for 6 s, back to the front, then rests until the next 48 s turn. */
function nextTurn(t: number, seed: number): number {
  const local = floorMod(t + mix(seed, 7) * TURN_PERIOD_SECONDS, TURN_PERIOD_SECONDS)
  const k = step(local, TURN_STEP_SECONDS)

  return t + (k < YAWS ? (k + 1) * TURN_STEP_SECONDS - local : TURN_PERIOD_SECONDS - local + TURN_STEP_SECONDS)
}

function nextJump(t: number): number {
  const local = floorMod(t, JUMP_PERIOD_SECONDS)
  const i = step(local, JUMP_SECONDS / JUMP_STEPS.length)

  return t + (i < JUMP_STEPS.length ? ((i + 1) * JUMP_SECONDS) / JUMP_STEPS.length : JUMP_PERIOD_SECONDS) - local
}

function nextBlink(t: number, seed: number): number {
  const at = floorMod(t + mix(seed, 3) * BLINK_PERIOD_SECONDS, BLINK_PERIOD_SECONDS)

  return t + (at < BLINK_SECONDS ? BLINK_SECONDS : BLINK_PERIOD_SECONDS) - at
}

/** The next start or end of a glitch event after t (events never overlap: one per 2 s slot, in its middle half). */
function nextGlitch(t: number, seed: number): number {
  const k0 = Math.floor(t / GLITCH_SLOT_SECONDS)
  let next = Infinity

  for (const k of [k0 - 1, k0, k0 + 1]) {
    const { t0, t1 } = glitchEvent(k, seed)

    for (const edge of [t0, t1]) {
      if (edge > t && edge < next) {
        next = edge
      }
    }
  }

  return next
}

const NEXT_CHANGE: Readonly<Record<PetState, (t: number, seed: number) => number>> = {
  failed: (t, seed) => Math.min(nextBreath(t, seed), nextGlitch(t, seed)),
  idle: (t, seed) => Math.min(nextBreath(t, seed), nextTurn(t, seed)),
  jump: nextJump,
  review: (t, seed) => Math.min(nextBreath(t, seed), nextStep(t, PULSE_SECONDS / 2)),
  run: t => nextStep(t, 1 / (2 * RUN_HZ)),
  waiting: (t, seed) => Math.min(nextBreath(t, seed), nextStep(t, SWAY_STEP_SECONDS), nextBlink(t, seed)),
  wave: (t, seed) => Math.min(nextBreath(t, seed), t < WAVE_SECONDS ? nextStep(t, 1 / (2 * WAVE_HZ)) : Infinity)
}

/**
 * The first moment after `t` (seconds into the state) at which `petFrame(state, …)` can give a different frame —
 * never later than the real change, so a renderer that sleeps until then draws every frame the display-rate loop
 * drew, and nothing in between. Each state is a few step clocks (pure in t), so the next edge is computed, not
 * polled. Reduced motion: the breath's edges alone.
 */
export function nextFrameChange(state: PetState, t: number, seed: number, reduced = false): number {
  return reduced ? nextBreath(t, seed) : NEXT_CHANGE[state](t, seed)
}

/** The sprite's side views: yaw 6 (90°) looks to the viewer's right, yaw 18 (270°) to the left. */
const SIDE_YAW_RIGHT = 6
const SIDE_YAW_LEFT = 18

/** While the pet walks it faces where it goes (a side view of its own sprite); standing still, the state's yaw. */
export const facingYaw = (frame: PetFrame, dir: number): PetFrame =>
  dir > 0 ? { ...frame, yaw: SIDE_YAW_RIGHT } : dir < 0 ? { ...frame, yaw: SIDE_YAW_LEFT } : frame

/** A frame's identity: equal keys draw equal pixels (the renderer redraws only on a change). */
export function frameKey(f: PetFrame): string {
  return [
    f.yaw,
    f.breathTop,
    f.breathMid,
    f.waveDx,
    f.run,
    f.bob,
    f.lift,
    f.swayDx,
    f.accentDark ? 1 : 0,
    f.plateMix,
    f.glitch ? f.glitch.slot : '-'
  ].join('|')
}
