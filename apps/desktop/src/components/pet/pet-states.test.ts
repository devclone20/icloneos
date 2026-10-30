import { describe, expect, it } from 'vitest'

import { TILE_NONE } from './pet-codec'
import { composeFigure, petPixels, petRimPixels } from './pet-draw'
import {
  BREATH_SECONDS,
  facingYaw,
  frameKey,
  glitchAt,
  nextFrameChange,
  PET_STATES,
  petFrame,
  type PetFrame,
  type PetState,
  turnYaw
} from './pet-states'
import { TEST_PETS, testPet } from './pet-test-pets'

const pet = testPet('n2')
const seed = pet.seed

const sample = (from: number, to: number, dt: number) =>
  Array.from({ length: Math.round((to - from) / dt) }, (_, i) => from + i * dt)

const INT_FIELDS: (keyof PetFrame)[] = ['yaw', 'breathTop', 'breathMid', 'waveDx', 'run', 'bob', 'lift', 'swayDx']

describe('the seven states are pure functions of (t, seed) (gate P2)', () => {
  it('7 states × t = 0 / 0.5 / 1: the same frame and the same pixels twice', () => {
    expect(PET_STATES).toEqual(['idle', 'wave', 'run', 'jump', 'waiting', 'review', 'failed'])

    for (const state of PET_STATES) {
      for (const t of [0, 0.5, 1]) {
        const a = petFrame(state, t, seed)
        const b = petFrame(state, t, seed)
        expect(b).toEqual(a)
        expect(petPixels(pet, b).data).toEqual(petPixels(pet, a).data)
        expect(petRimPixels(pet, b).data).toEqual(petRimPixels(pet, a).data)
      }
    }
  })

  it('every displacement is a whole number of tiles, in every state, at every 10 ms of 12 s', () => {
    for (const state of PET_STATES) {
      for (const t of sample(0, 12, 0.01)) {
        const f = petFrame(state, t, seed)

        for (const field of INT_FIELDS) {
          expect(Number.isInteger(f[field]), `${state} ${field} @${t}`).toBe(true)
        }
      }
    }
  })

  it('two pets breathe out of step (the seed is the pet)', () => {
    const other = testPet('n30').seed

    const differs = sample(0, BREATH_SECONDS, 0.25).some(
      t => frameKey(petFrame('idle', t, seed)) !== frameKey(petFrame('idle', t, other))
    )

    expect(differs).toBe(true)
  })
})

describe('the movement contract (V3-P §1.3, gate P4)', () => {
  it('idle: breath top ≤ 2, trunk ≤ 1, both reached; a turn through all 24 yaws once every 48 s', () => {
    const frames = sample(0, 48, 0.05).map(t => petFrame('idle', t, seed))
    expect(Math.max(...frames.map(f => f.breathTop))).toBe(2)
    expect(Math.max(...frames.map(f => f.breathMid))).toBe(1)
    expect(new Set(frames.map(f => f.yaw)).size).toBe(24)
    // Off the turn the pet faces the viewer; the turn takes 6 s of the 48.
    expect(frames.filter(f => f.yaw !== 0).length * 0.05).toBeLessThanOrEqual(6)
    expect(turnYaw(0, seed)).toBe(turnYaw(48, seed))
  })

  it('wave: the top rows slip exactly ±1 tile, flipping every 1/8 s (4 Hz), for 1 s, then rest', () => {
    const dx = sample(0, 1, 0.125).map(t => petFrame('wave', t + 0.01, seed).waveDx)
    expect(dx).toEqual([1, -1, 1, -1, 1, -1, 1, -1])
    expect(petFrame('wave', 1.01, seed).waveDx).toBe(0)

    const still = composeFigure(pet, { ...petFrame('wave', 1.5, seed) })
    const moved = composeFigure(pet, { ...petFrame('wave', 1.5, seed), waveDx: 1 })
    const shifted = rowsShifted(still, moved)
    expect(new Set(shifted.filter(s => s !== 0))).toEqual(new Set([1]))
    // Only the top band moves: the feet rows are identical.
    expect(shifted.slice(-10).every(s => s === 0)).toBe(true)
  })

  it('run: one foot up exactly one tile, alternating every 0.1 s (5 Hz)', () => {
    expect(sample(0, 1, 0.1).map(t => petFrame('run', t + 0.01, seed).run)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2])
    const down = composeFigure(pet, { ...petFrame('run', 0, seed), run: 0 })
    const up = composeFigure(pet, petFrame('run', 0.01, seed))

    const lastRow = (F: typeof down, x0: number, x1: number) => {
      for (let y = F.H - 1; y >= 0; y--) {
        for (let x = x0; x < x1; x++) {
          if (F.kinds[y * F.W + x] !== TILE_NONE) {
            return y
          }
        }
      }

      return -1
    }

    const half = Math.round(down.W / 2)
    expect(lastRow(down, 0, half) - lastRow(up, 0, half)).toBe(1)
    expect(lastRow(down, half, down.W) - lastRow(up, half, up.W)).toBe(0)
  })

  it('jump: 1-2-3-3-2-1 tiles over 0.6 s, the shadow on the ground, 3 tiles at most', () => {
    expect(sample(0, 0.6, 0.1).map(t => petFrame('jump', t + 0.05, seed).lift)).toEqual([1, 2, 3, 3, 2, 1])
    expect(petFrame('jump', 0.65, seed).lift).toBe(0)
    expect(Math.max(...sample(0, 5, 0.01).map(t => petFrame('jump', t, seed).lift))).toBe(3)

    // The pixels go up exactly `lift` rows.
    const ground = petPixels(pet, { ...petFrame('jump', 0.7, seed) })
    const air = petPixels(pet, { ...petFrame('jump', 0.25, seed) })
    expect(topRow(ground) - topRow(air)).toBe(3)
  })

  it('waiting: sways 0 → +1 → 0 → −1 tile, a step every 1.5 s, and the eyes blink 150 ms every 3 s', () => {
    expect(sample(0, 6, 1.5).map(t => petFrame('waiting', t + 0.01, seed).swayDx)).toEqual([0, 1, 0, -1])
    const dark = sample(0, 30, 0.01).filter(t => petFrame('waiting', t, seed).accentDark)
    expect(dark.length).toBeGreaterThanOrEqual(10 * 14)
    expect(dark.length).toBeLessThanOrEqual(10 * 16)
  })

  it('review: faces the camera and the plate pulses .85 → 1 every 1.2 s', () => {
    const frames = sample(0, 2.4, 0.6).map(t => petFrame('review', t + 0.01, seed))
    expect(frames.map(f => f.plateMix)).toEqual([0.85, 1, 0.85, 1])
    expect(frames.every(f => f.yaw === 0)).toBe(true)
  })

  it('failed: one glitch per 2 s slot lasting 90–150 ms, bands slip ±1–2 tiles, the accent dark', () => {
    const on = sample(0, 40, 0.001).map(t => glitchAt(t, seed))
    const events = new Map<number, number>()

    for (const ev of on) {
      if (ev) {
        events.set(ev.slot, (events.get(ev.slot) ?? 0) + 1)
      }
    }

    expect(events.size).toBe(20)

    for (const ms of events.values()) {
      expect(ms).toBeGreaterThanOrEqual(89)
      expect(ms).toBeLessThanOrEqual(151)
    }

    expect(petFrame('failed', 0.3, seed).accentDark).toBe(true)

    const shifts: number[] = []

    for (let k = 0; k < 20; k++) {
      const t = sample(k * 2, k * 2 + 2, 0.001).find(x => glitchAt(x, seed))!
      const f = petFrame('failed', t, seed)
      const plain = composeFigure(pet, { ...f, glitch: null })
      const broken = composeFigure(pet, f)
      expect(broken.bands.length).toBeGreaterThanOrEqual(2)

      // Rebuild the event from the plain figure: each band's rows moved by s tiles, in order. What differs is only
      // the 2–3 tiles that drop out (the broken pixels), never anything else.
      const rebuilt = plain.kinds.slice()

      for (const band of broken.bands) {
        shifts.push(band.s)

        for (let y = band.y0; y < band.y1; y++) {
          const row = rebuilt.slice(y * plain.W, (y + 1) * plain.W)
          rebuilt.fill(TILE_NONE, y * plain.W, (y + 1) * plain.W)
          row.forEach((v, x) => {
            if (x + band.s >= 0 && x + band.s < plain.W) {
              rebuilt[y * plain.W + x + band.s] = v
            }
          })
        }
      }

      const diff = [...rebuilt.keys()].filter(i => rebuilt[i] !== broken.kinds[i])
      expect(diff.length).toBeGreaterThanOrEqual(2)
      expect(diff.length).toBeLessThanOrEqual(3)
      expect(diff.every(i => broken.kinds[i] === TILE_NONE)).toBe(true)
    }

    expect(shifts.every(s => [1, 2, -1, -2].includes(s))).toBe(true)
    expect(new Set(shifts.map(Math.abs))).toEqual(new Set([1, 2]))
  })
})

describe('r2: the movement contract, as the eye reads it (gate P4)', () => {
  it('run (m4): the body bobs one tile in step with the feet — up with the left foot, down with the right — 20 pets', () => {
    const beats = sample(0, 1, 0.1).map(t => petFrame('run', t + 0.01, seed))
    expect(beats.map(f => f.bob)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
    expect(beats.every(f => (f.bob === 1) === (f.run === 1))).toBe(true)

    for (const p of TEST_PETS) {
      const up = petFrame('run', 0.01, p.seed)
      const down = petFrame('run', 0.11, p.seed)
      // Pixels: the head (the figure's top row) is one tile higher on the left-foot beat than on the right-foot one…
      expect(topRow(petPixels(p, down)) - topRow(petPixels(p, up))).toBe(1)
      // …and the bob alone moves the body, never the feet: same frame with and without it, the ground row unchanged.
      const still = petPixels(p, { ...up, bob: 0 })
      const bobbed = petPixels(p, up)
      expect(topRow(still) - topRow(bobbed)).toBe(1)
      expect(bottomRow(bobbed)).toBe(bottomRow(still))
    }
  })

  it('failed (m2): the NET shift of every row stays within ±2 tiles, however the bands overlap — 20 pets × 40 events', () => {
    let rows = 0
    let atTwo = 0

    for (const p of TEST_PETS) {
      for (let k = 0; k < 40; k++) {
        const t = sample(k * 2, k * 2 + 2, 0.002).find(x => glitchAt(x, p.seed))!
        const f = petFrame('failed', t, p.seed)
        const plain = composeFigure(p, { ...f, glitch: null })
        const broken = composeFigure(p, f)

        // Measured from the tiles: in each row, where a sprite column stands now vs. where it stood unbroken.
        for (let y = 0; y < plain.H; y++) {
          const was = new Map<number, number>()

          for (let x = 0; x < plain.W; x++) {
            const sx = plain.srcX[y * plain.W + x]!

            if (sx >= 0) {
              was.set(sx, x)
            }
          }

          for (let x = 0; x < broken.W; x++) {
            const sx = broken.srcX[y * broken.W + x]!

            if (sx >= 0 && was.has(sx)) {
              const shift = x - was.get(sx)!
              expect(Math.abs(shift)).toBeLessThanOrEqual(2)
              rows++
              atTwo += Math.abs(shift) === 2 ? 1 : 0

              break
            }
          }
        }

        // And from the bands: the sum over the bands that cover a row.
        const net = new Array<number>(broken.H).fill(0)

        for (const band of broken.bands) {
          for (let y = band.y0; y < band.y1; y++) {
            net[y] += band.s
          }
        }

        expect(Math.max(...net.map(Math.abs))).toBeLessThanOrEqual(2)
      }
    }

    // The glitch still reaches 2 tiles (clamped, not flattened).
    expect(rows).toBeGreaterThan(1000)
    expect(atTwo).toBeGreaterThan(0)
  })

  it("roaming (m8): the walk faces its direction with the sprite's side views, and the front again when it stops", () => {
    const f = petFrame('run', 0.01, seed)
    expect(facingYaw(f, 1).yaw).toBe(6)
    expect(facingYaw(f, -1).yaw).toBe(18)
    expect(facingYaw(f, 0)).toBe(f)
    expect(facingYaw(f, 0).yaw).toBe(0)

    // A side view is a real yaw of the sprite (not the front mirrored): its pixels differ from the mirrored front.
    for (const p of TEST_PETS) {
      const g = petFrame('run', 0.01, p.seed)
      const right = petPixels(p, facingYaw(g, 1))
      const left = petPixels(p, facingYaw(g, -1))
      const front = petPixels(p, g)
      const mirrored = new Uint8ClampedArray(front.data.length)

      for (let y = 0; y < front.H; y++) {
        for (let x = 0; x < front.W; x++) {
          mirrored.set(
            front.data.subarray((y * front.W + x) * 4, (y * front.W + x) * 4 + 4),
            (y * front.W + front.W - 1 - x) * 4
          )
        }
      }

      expect(right.data).not.toEqual(front.data)
      expect(left.data).not.toEqual(mirrored)
      expect(left.data).not.toEqual(right.data)
    }
  })
})

describe('prefers-reduced-motion (gate P5)', () => {
  it('every state is the breath alone: no turn, no wave, no run, no jump, no sway, no blink, no pulse, no glitch', () => {
    for (const state of PET_STATES) {
      for (const t of sample(0, 12, 0.05)) {
        const f = petFrame(state as PetState, t, seed, true)
        const idle = petFrame('idle', t, seed, true)
        expect(f).toEqual(idle)
        expect([f.yaw, f.waveDx, f.run, f.lift, f.swayDx, f.accentDark, f.plateMix, f.glitch]).toEqual([
          0,
          0,
          0,
          0,
          0,
          false,
          0.85,
          null
        ])
      }
    }
  })
})

/** Per composed row: the horizontal shift that maps row a onto row b (0 = same, NaN = not a pure shift). */
function rowsShifted(a: ReturnType<typeof composeFigure>, b: ReturnType<typeof composeFigure>): number[] {
  const out: number[] = []

  for (let y = 0; y < a.H; y++) {
    const ra = Array.from(a.kinds.subarray(y * a.W, (y + 1) * a.W))
    const rb = Array.from(b.kinds.subarray(y * b.W, (y + 1) * b.W))

    if (ra.every(v => v === TILE_NONE) && rb.every(v => v === TILE_NONE)) {
      continue
    }

    let found = Number.NaN

    for (const s of [0, 1, -1, 2, -2]) {
      if (ra.every((v, x) => (x + s >= 0 && x + s < a.W ? rb[x + s] === v || v === TILE_NONE : v === TILE_NONE))) {
        if (rb.filter(v => v !== TILE_NONE).length >= ra.filter(v => v !== TILE_NONE).length - 3) {
          found = s

          break
        }
      }
    }

    out.push(found)
  }

  return out
}

function bottomRow(px: { W: number; H: number; data: Uint8ClampedArray }): number {
  for (let y = px.H - 1; y >= 0; y--) {
    for (let x = 0; x < px.W; x++) {
      if (px.data[(y * px.W + x) * 4 + 3]) {
        return y
      }
    }
  }

  return -1
}

function topRow(px: { W: number; H: number; data: Uint8ClampedArray }): number {
  for (let y = 0; y < px.H; y++) {
    for (let x = 0; x < px.W; x++) {
      if (px.data[(y * px.W + x) * 4 + 3]) {
        return y
      }
    }
  }

  return -1
}

describe('R4-F3: the renderer sleeps until the frame can change (gate P4)', () => {
  it('7 states × reduced or not × 3 pets × 50 s: waking at each computed edge draws exactly the frames of a 1 ms scan', () => {
    for (const id of ['n2', 'n161', 'n715']) {
      const { seed: s } = testPet(id)

      for (const state of PET_STATES) {
        for (const reduced of [false, true]) {
          const key = (t: number) => frameKey(petFrame(state, t, s, reduced))
          // The scan: every millisecond, as a display-rate loop would see it (and finer).
          const scan: [number, string][] = []

          for (let i = 0; i <= 50_000; i++) {
            const k = key(i / 1000)

            if (k !== scan.at(-1)?.[1]) {
              scan.push([i / 1000, k])
            }
          }

          // The sleeper: wakes 1 ms past each edge it computes, and only then.
          const woke: [number, string][] = []
          let wakes = 0

          for (let t = 0; t <= 50; t = nextFrameChange(state, t, s, reduced) + 0.001) {
            const next = nextFrameChange(state, t, s, reduced)
            expect(next).toBeGreaterThan(t)
            wakes++
            const k = key(t)

            if (k !== woke.at(-1)?.[1]) {
              woke.push([t, k])
            }
          }

          // Two edges of different clocks can fall within the same millisecond (a breath step and a turn step): the
          // in-between frame lasts under 2 ms, which no display shows (a 60 Hz loop drew it or not by chance). Every
          // frame that lasts longer must be drawn, in order.
          const seen = scan.filter(([t], i) => (scan[i + 1]?.[0] ?? Infinity) - t >= 0.002)
          // Compared over the first 49.9 s (the last frames may start past the sleeper's last wake).
          const shown = seen.filter(([t, k], i) => k !== seen[i - 1]?.[1] && t < 49.9)
          const label = `${id} ${state}${reduced ? ' reduced' : ''}`
          expect(
            woke.slice(0, shown.length).map(([, k]) => k),
            label
          ).toEqual(shown.map(([, k]) => k))
          expect(woke[shown.length]?.[0] ?? Infinity, label).toBeGreaterThanOrEqual(49.9)
          // Never late by more than the 1 ms margin (plus the scan's own 1 ms grain and a coalesced edge).
          woke
            .slice(0, shown.length)
            .forEach(([t], i) => expect(Math.abs(t - shown[i]![0]), label).toBeLessThanOrEqual(0.0031))
          // And no idle wakes beyond the jump's held top (3-3): at most a fifth more wakes than changes.
          expect(wakes, label).toBeLessThanOrEqual(Math.ceil(woke.length * 1.2) + 1)
        }
      }
    }
  })

  it('an idle pet changes about once a second outside its turn: 48 s hold ≤ 60 wakes beyond the 24-step turn', () => {
    let wakes = 0

    for (let t = 0; t < 48; t = nextFrameChange('idle', t, seed) + 0.001) {
      wakes++
    }

    expect(wakes).toBeLessThanOrEqual(48 + 25 + 1)
  })
})
