import { describe, expect, it, vi } from 'vitest'

import { TILE_NONE, TILE_PAINT_C, TILE_PAINT_M, TILE_PAINT_P } from './pet-codec'
import {
  ACCENT_MIN_TILES,
  accentKindOf,
  composeFigure,
  PET_INK,
  PET_RIM_ALPHA,
  petCanvasTiles,
  petPixels,
  petRimPixels,
  ROBINHOOD_GREEN,
  ROBINHOOD_GREEN_BOTTOM,
  ROBINHOOD_GREEN_TOP
} from './pet-draw'
import { petCssSize } from './pet-sprite'
import { glitchAt, PET_STATES, petFrame } from './pet-states'
import { TEST_PETS, testPet } from './pet-test-pets'

/** FNV-1a over the RGBA bytes: a frame's fingerprint for the snapshot. */
function fingerprint(data: Uint8ClampedArray): string {
  let h = 2166136261

  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i]!, 16777619)
  }

  return (h >>> 0).toString(16).padStart(8, '0')
}

// K105: the sweeps draw 20 pets × every frame; sized from the slowest one's isolated p95 × 3 (measured 2026-10-21 at
// load ≈ 11: 6.5–8.8 s).
vi.setConfig({ testTimeout: 27_000 })

describe('the ink constant', () => {
  it('is the Robinhood green gradient middle × 0.2: #437a40 → #0d180d', () => {
    expect(ROBINHOOD_GREEN_TOP).toEqual([0x4b, 0x82, 0x49])
    expect(ROBINHOOD_GREEN_BOTTOM).toEqual([0x3b, 0x72, 0x37])
    expect(ROBINHOOD_GREEN).toEqual([0x43, 0x7a, 0x40])
    expect(PET_INK).toEqual([13, 24, 13])
  })
})

describe('size (gate P1)', () => {
  it("every one of the 20 pets renders at scale 1 inside the old pets' 63 × 69 box, and scales by whole numbers", () => {
    expect(TEST_PETS).toHaveLength(20)

    for (const pet of TEST_PETS) {
      const css = petCssSize(pet, 1)
      expect(css.width).toBeLessThanOrEqual(63)
      expect(css.height).toBeLessThanOrEqual(69)
      expect(petCssSize(pet, 2)).toEqual({ height: css.height * 2, width: css.width * 2 })
      expect(petCssSize(pet, 2.6)).toEqual(petCssSize(pet, 3))
      expect(petCssSize(pet, 9)).toEqual(petCssSize(pet, 3))
      expect(petCssSize(pet, 0)).toEqual(css)

      for (const state of PET_STATES) {
        const px = petPixels(pet, petFrame(state, 0.3, pet.seed))
        expect([px.W, px.H]).toEqual([css.width, css.height])
        expect(px.data.some((v, i) => i % 4 === 3 && v === 255)).toBe(true)
      }
    }
  })
})

describe('transparency (gate P3)', () => {
  it('alpha is 0 on every non-tile pixel, 255 on every tile, and no pixel is a field colour', () => {
    const field = new Set([ROBINHOOD_GREEN, ROBINHOOD_GREEN_TOP, ROBINHOOD_GREEN_BOTTOM].map(c => c.join(',')))

    for (const pet of TEST_PETS) {
      for (const state of PET_STATES) {
        const frame = petFrame(state, 0.5, pet.seed)
        const F = composeFigure(pet, { ...frame, lift: 0 })
        const px = petPixels(pet, { ...frame, lift: 0 })

        for (let i = 0; i < F.kinds.length; i++) {
          const a = px.data[i * 4 + 3]!
          expect(a === 0 || a === 255).toBe(true)
          expect(a === 255).toBe(F.kinds[i] !== TILE_NONE)

          if (a === 0) {
            expect(px.data[i * 4] + px.data[i * 4 + 1] + px.data[i * 4 + 2]).toBe(0)
          } else {
            expect(field.has(`${px.data[i * 4]},${px.data[i * 4 + 1]},${px.data[i * 4 + 2]}`)).toBe(false)
          }
        }
      }
    }
  })

  it('an unpainted hole inside the figure is see-through (alpha 0 between two tiles of its row)', () => {
    const pet = testPet('n181')
    const px = petPixels(pet, petFrame('idle', 0, pet.seed, true))
    let holes = 0

    for (let y = 0; y < px.H; y++) {
      const row = Array.from({ length: px.W }, (_, x) => px.data[(y * px.W + x) * 4 + 3]!)
      const first = row.indexOf(255)
      const last = row.lastIndexOf(255)

      for (let x = first + 1; x < last; x++) {
        if (row[x] === 0) {
          holes++
        }
      }
    }

    expect(holes).toBeGreaterThan(0)
  })
})

describe('the dark beat (waiting blink, failed eyes) shows on every pet (m1, gate P4)', () => {
  it('the first of accent, accent2, plate with ≥ 4 tiles in the view (else the biggest) — its tiles turn ink — 20 pets', () => {
    const kinds = new Map<number, string[]>()
    const frontTiles: Record<string, number> = {}

    for (const pet of TEST_PETS) {
      for (let yaw = 0; yaw < pet.yaws; yaw++) {
        const view = pet.cells.subarray(yaw * pet.w * pet.h, (yaw + 1) * pet.w * pet.h)
        const tiles = (k: number) => view.filter(c => c === k).length

        const paint: Record<number, unknown> = {
          [TILE_PAINT_C]: pet.paint.c,
          [TILE_PAINT_M]: pet.paint.m,
          [TILE_PAINT_P]: pet.paint.p
        }

        const painted = [TILE_PAINT_M, TILE_PAINT_C, TILE_PAINT_P].filter(k => paint[k] && tiles(k) > 0)

        // A class under ACCENT_MIN_TILES is skipped; none that big: the biggest one (the earlier on a tie).
        const want =
          painted.find(k => tiles(k) >= ACCENT_MIN_TILES) ??
          painted.reduce<number>((a, k) => (a === TILE_NONE || tiles(k) > tiles(a) ? k : a), TILE_NONE)

        expect(accentKindOf(pet, yaw), `${pet.id} yaw ${yaw}`).toBe(want)

        if (yaw === 0) {
          frontTiles[pet.id] = want === TILE_NONE ? 0 : tiles(want)
        }

        if (want === TILE_NONE) {
          continue
        }

        const lit = { ...petFrame('review', 0, pet.seed), plateMix: 0.85, yaw }
        const a = petPixels(pet, lit).data
        const b = petPixels(pet, { ...lit, accentDark: true }).data
        const F = composeFigure(pet, lit)
        let changed = 0

        for (let k = 0; k < F.W * F.H; k++) {
          const same = a.subarray(k * 4, k * 4 + 4).every((v, c) => v === b[k * 4 + c])

          if (F.kinds[k] === want) {
            expect([...b.subarray(k * 4, k * 4 + 4)]).toEqual([...PET_INK, 255])
            changed += same ? 0 : 1
          } else {
            expect(same).toBe(true)
          }
        }

        expect(changed).toBeGreaterThan(0)

        if (yaw === 0) {
          kinds.set(want, [...(kinds.get(want) ?? []), pet.id])
        }
      }
    }

    // The front view (the waiting and failed states face it): every one of the 20 has its beat, at least 4 tiles of
    // it (n4: n2 had 2 accent2 tiles, n16 1 accent, n1007 and n151 3 — now their plate goes dark).
    expect(ACCENT_MIN_TILES).toBe(4)
    expect([...kinds.values()].flat()).toHaveLength(20)
    expect(Object.entries(frontTiles).filter(([, n]) => n < ACCENT_MIN_TILES)).toEqual([])
    expect(kinds.get(TILE_PAINT_C)).toBeUndefined()
    expect([...(kinds.get(TILE_PAINT_P) ?? [])].sort()).toEqual([
      'n1007',
      'n151',
      'n16',
      'n181',
      'n2',
      'n217',
      'n255',
      'n715'
    ])
  })
})

describe('renderer snapshot per state (deterministic)', () => {
  it('7 states × t = 0 / 0.5 / 1 for #2 and #30', () => {
    const sheet: Record<string, string> = {}

    for (const id of ['n2', 'n30']) {
      const pet = testPet(id)

      for (const state of PET_STATES) {
        for (const t of [0, 0.5, 1]) {
          sheet[`${id} ${state} @${t}`] = fingerprint(petPixels(pet, petFrame(state, t, pet.seed)).data)
        }
      }
    }

    expect(sheet).toMatchSnapshot()
  })

  it('the canvas is the sprite inside its margins: 43 × 69 tiles', () => {
    expect(petCanvasTiles(testPet('n2'))).toEqual({ H: 69, W: 43 })
  })
})

// ── the rim light (gate P14) ────────────────────────────────────────────────

/** The figure's transparent tiles reachable from the canvas edge through transparent tiles, 4-connected. */
function outsideOf(W: number, H: number, solid: (k: number) => boolean): Uint8Array {
  const out = new Uint8Array(W * H)
  const queue: number[] = []

  for (let k = 0; k < W * H; k++) {
    const i = k % W
    const j = Math.floor(k / W)

    if ((i === 0 || j === 0 || i === W - 1 || j === H - 1) && !solid(k)) {
      out[k] = 1
      queue.push(k)
    }
  }

  while (queue.length) {
    const k = queue.shift()!
    const i = k % W
    const j = Math.floor(k / W)

    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as const) {
      const I = i + di
      const J = j + dj
      const K = J * W + I

      if (I >= 0 && I < W && J >= 0 && J < H && !out[K] && !solid(K)) {
        out[K] = 1
        queue.push(K)
      }
    }
  }

  return out
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const linear = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (c: readonly number[]) => 0.2126 * linear(c[0]!) + 0.7152 * linear(c[1]!) + 0.0722 * linear(c[2]!)

const contrast = (a: readonly number[], b: readonly number[]) => {
  const [x, y] = [luminance(a), luminance(b)]

  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** A rim pixel composited over a solid surface (what the eye gets on that surface). */
const over = (rgba: ArrayLike<number>, o: number, surface: readonly number[]) =>
  surface.map((s, c) => Math.round((rgba[o + c]! * rgba[o + 3]!) / 255 + (s * (255 - rgba[o + 3]!)) / 255))

/** Every state at a few seconds, the failed one inside its glitches: the frames the rim must follow. */
function framesOf(seed: number) {
  const glitches: number[] = []

  for (let t = 0; t < 12 && glitches.length < 2; t += 0.005) {
    if (glitchAt(t, seed) && !glitchAt(t - 0.005, seed)) {
      glitches.push(t + 0.01)
    }
  }

  return PET_STATES.flatMap(state =>
    (state === 'failed' ? [0.5, ...glitches] : [0, 0.3, 0.5, 1.6]).map(t => ({
      state,
      t,
      frame: petFrame(state, t, seed)
    }))
  )
}

describe('the rim light (gate P14)', () => {
  it('strength is one constant inside the band .45–.7', () => {
    expect(PET_RIM_ALPHA).toBeGreaterThanOrEqual(0.45)
    expect(PET_RIM_ALPHA).toBeLessThanOrEqual(0.7)
  })

  it('every silhouette edge has its rim tile; no rim inside the figure, in an enclosed hole or on a diagonal only — 20 pets × 7 states', () => {
    const a = Math.round(PET_RIM_ALPHA * 255)

    for (const pet of TEST_PETS) {
      const plate = pet.paint.p!

      for (const { state, t, frame } of framesOf(pet.seed)) {
        const fig = petPixels(pet, frame)
        const rim = petRimPixels(pet, frame)
        const { W, H } = fig
        const solid = (k: number) => fig.data[k * 4 + 3] === 255
        const outside = outsideOf(W, H, solid)
        let edges = 0

        expect([rim.W, rim.H]).toEqual([W, H])

        for (let k = 0; k < W * H; k++) {
          const i = k % W
          const orthogonal = [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W].filter(n => n >= 0 && n < W * H)
          const isRim = rim.data[k * 4 + 3]! > 0
          const want = !solid(k) && outside[k] === 1 && orthogonal.some(solid)
          expect(isRim, `${pet.id} ${state} @${t} tile ${i},${Math.floor(k / W)}`).toBe(want)

          if (isRim) {
            edges++
            expect(rim.data[k * 4 + 3]).toBe(a)
            expect(Array.from(rim.data.subarray(k * 4, k * 4 + 3))).toEqual(plate)
          }
        }

        expect(edges).toBeGreaterThan(0)
      }
    }
  })

  it('an enclosed hole stays see-through: no rim tile in it', () => {
    const pet = testPet('n181')
    const frame = petFrame('idle', 0, pet.seed, true)
    const fig = petPixels(pet, frame)
    const rim = petRimPixels(pet, frame)
    const solid = (k: number) => fig.data[k * 4 + 3] === 255
    const outside = outsideOf(fig.W, fig.H, solid)
    const enclosed = Array.from({ length: fig.W * fig.H }, (_, k) => k).filter(k => !solid(k) && !outside[k])

    expect(enclosed.length).toBeGreaterThan(0)
    expect(enclosed.every(k => rim.data[k * 4 + 3] === 0)).toBe(true)
  })

  it('moves with the figure: the jump lifts every rim tile 3 tiles, and in the air the rim closes under the feet', () => {
    for (const pet of TEST_PETS) {
      const ground = petRimPixels(pet, petFrame('jump', 0.7, pet.seed))
      const air = petRimPixels(pet, petFrame('jump', 0.3, pet.seed))
      const { W, H } = ground
      const on = (px: typeof ground, i: number, j: number) => px.data[(j * W + i) * 4 + 3]! > 0
      let underFeet = 0

      for (let j = 3; j < H; j++) {
        for (let i = 0; i < W; i++) {
          if (on(ground, i, j)) {
            expect(on(air, i, j - 3), `${pet.id} ${i},${j}`).toBe(true)
          }
        }
      }

      // The air frame's lowest figure row has its rim right under it (on the ground the canvas edge clips it).
      const fig = petPixels(pet, petFrame('jump', 0.3, pet.seed))
      let feet = -1

      for (let k = 0; k < W * H; k++) {
        if (fig.data[k * 4 + 3] === 255) {
          feet = Math.floor(k / W)
        }
      }

      for (let i = 0; i < W; i++) {
        underFeet += fig.data[(feet * W + i) * 4 + 3] === 255 && on(air, i, feet + 1) ? 1 : 0
      }

      expect(underFeet, pet.id).toBeGreaterThan(0)
    }
  })

  it('is pure in t: the same rim twice, and the figure under it unchanged', () => {
    for (const pet of [testPet('n2'), testPet('n16'), testPet('n30')]) {
      for (const { frame } of framesOf(pet.seed)) {
        expect(petRimPixels(pet, frame).data).toEqual(petRimPixels(pet, { ...frame }).data)
      }
    }
  })

  it('reads on dark and on light: ≥ 3:1 against #121212 for every pet, a soft halo on #f2f1ec that the ink still cuts', () => {
    const dark = [hex('#121212'), hex('#0b0b0b'), hex('#16161a')]
    const light = hex('#f2f1ec')

    for (const pet of TEST_PETS) {
      const rim = petRimPixels(pet, petFrame('idle', 0, pet.seed, true))
      const o = rim.data.findIndex((v, i) => i % 4 === 3 && v > 0) - 3

      expect(o, pet.id).toBeGreaterThanOrEqual(0)

      for (const surface of dark) {
        expect(contrast(over(rim.data, o, surface), surface), `${pet.id} on dark`).toBeGreaterThanOrEqual(3)
      }

      const onLight = over(rim.data, o, light)
      expect(contrast(onLight, light), `${pet.id} on light`).toBeGreaterThan(1.1)
      expect(contrast(onLight, light), `${pet.id} not a sticker`).toBeLessThan(2.5)
      expect(contrast(onLight, PET_INK), `${pet.id} ink against its rim`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
