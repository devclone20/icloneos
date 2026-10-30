/**
 * How a pet is drawn — the arsenal's `present()` look WITHOUT its field.
 *
 * Two layers, so the maths is testable without a canvas:
 *  - `petPixels(sprite, frame, seed)` — PURE: the frame composed tile by tile
 *    (breath, wave, run, sway, glitch) and coloured, one RGBA pixel per tile. A
 *    tile is opaque; everything else is alpha 0 — no background, no field.
 *  - `paintPet(…)` — the canvas half: each tile becomes `D = scale × DPR` device
 *    px (nearest neighbour), the arsenal's 12 % gaps once a tile is ≥ 4 device
 *    px, and the blurred contact shadow (alpha .32, blur .32 tile, drop .4 tile)
 *    that stays on the ground while the tiles jump.
 *
 * THE INK CONSTANT. The arsenal paints ink as the field × 0.2 at that row, on the
 * Robinhood green gradient #4b8249 → #3b7237. With no field, the pet uses the
 * gradient's middle, #437a40 = (67, 122, 64): ink = round(× 0.2) = (13, 24, 13)
 * = #0d180d on every row, and a painted hole = 85 % class colour + 15 % of that
 * same #437a40 — so the pet reads exactly as it did on the arsenal's field, and
 * sits on any surface.
 *
 * THE RIM LIGHT. On the app's dark surfaces that ink is the surface's own colour, so the figure would read as
 * floating paint. Every transparent tile OUTSIDE the silhouette (reachable from the canvas edge through
 * transparent tiles) that touches a figure tile orthogonally — never only diagonally, so it stays pixel-honest —
 * takes the pet's own plate colour at `PET_RIM_ALPHA`: a 1-tile ring. It is computed per frame from the composed,
 * lifted figure (pure in t, it moves with every state), drawn with the tiles above the shadow, clipped to the pet's
 * own canvas (the ground line and the canvas edge get none: the 63 × 69 box is the contract's). Enclosed holes
 * stay see-through. Ink, paint, grain and shadow do not change.
 */

import { TILE_INK, TILE_NONE, TILE_PAINT_C, TILE_PAINT_M, TILE_PAINT_P, TILE_PLATE_INK } from './pet-codec'
import { mix, PAINT_MIX, type PetFrame } from './pet-states'

/** The Robinhood green the arsenal paints on: its gradient's ends and the middle the pet takes. */
export const ROBINHOOD_GREEN_TOP: readonly number[] = [0x4b, 0x82, 0x49]
export const ROBINHOOD_GREEN_BOTTOM: readonly number[] = [0x3b, 0x72, 0x37]
export const ROBINHOOD_GREEN: readonly number[] = ROBINHOOD_GREEN_TOP.map(
  (v, i) => (v + ROBINHOOD_GREEN_BOTTOM[i]!) / 2
)
const INK_K = 0.2
/** #0d180d — the ink tile, a constant (see the header). */
export const PET_INK: readonly number[] = ROBINHOOD_GREEN.map(v => Math.round(v * INK_K))
const PLATE_INK_SHADE = 0.85
const GRAIN_SLOPE = 0.07
const GRAIN_JITTER = 0.13
const SHADOW = { alpha: 0.32, blur: 0.32, drop: 0.4 } as const
/**
 * The rim light's strength: the plate colour at this alpha (the lead's band .45–.7). .7 keeps EVERY
 * pet's rim at ≥ 3:1 WCAG contrast against #121212 (SC 1.4.11, non-text; the purple plate #9c7ccd sits lowest at
 * 3.3:1, .6 left it at 2.7:1), and on #f2f1ec it stays a soft halo (mean 1.7:1 against the surface, ≥ 7:1 against the
 * ink), an edge and not a sticker. Measured on the canvas by gate P14.
 */
export const PET_RIM_ALPHA = 0.7
const GAP = 0.12
const GAP_MIN_DEVICE_PX = 4
/** Margins in tiles: 2 columns each side (wave, sway, glitch), 5 rows above (breath 2, jump 3). */
const MX = 2
const MY = 5
/** The breath's bands, as shares of the figure's height (the arsenal's BREATH): top 35 %, trunk to 60 %, feet from 88 %. */
const BREATH_TOP = 0.35
const BREATH_MID = 0.6
const BREATH_FEET = 0.88

export interface DecodedPet {
  id: string
  name: string
  legion: string
  seed: number
  w: number
  h: number
  yaws: number
  /** Tile kinds, yaw-major (`yaws × h × w`). */
  cells: Uint8Array
  /** The class colours as [r, g, b] (null = the class is not painted). */
  paint: { c: null | readonly number[]; m: null | readonly number[]; p: null | readonly number[] }
  /** Per yaw: the figure's box in sprite tiles. */
  boxes: readonly { x0: number; x1: number; y0: number; y1: number }[]
}

/** The composed figure: a W × H grid of tile kinds plus where each tile came from in the sprite (for the grain). */
interface ComposedFigure {
  W: number
  H: number
  kinds: Uint8Array
  srcX: Int16Array
  srcY: Int16Array
  /** The glitch's bands (rows y0…y1−1 slipped by s tiles); empty off a glitch. */
  bands: { y0: number; y1: number; s: number }[]
}

/** The pet's canvas, in tiles: the sprite inside its margins. */
export function petCanvasTiles(pet: Pick<DecodedPet, 'h' | 'w'>): { W: number; H: number } {
  return { H: pet.h + MY, W: pet.w + 2 * MX }
}

export function boxOf(cells: Uint8Array, offset: number, w: number, h: number) {
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[offset + y * w + x] !== TILE_NONE) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  }

  return y1 < 0 ? { x0: 0, x1: w - 1, y0: 0, y1: h - 1 } : { x0, x1, y0, y1 }
}

/** The most a row may end up displaced by a glitch, whatever bands overlap on it (contract: ±1–2 tiles). */
const GLITCH_MAX_NET_SHIFT = 2

/**
 * The arsenal's glitch on a composed figure: 2–3 bands slip ±1–2 tiles (inside the margin), then 2–3 tiles of one band
 * drop. Bands may overlap; their shifts then add up, so each band's shift is held to what keeps EVERY row it moves
 * within ±GLITCH_MAX_NET_SHIFT of where it stood (a band that has no such room is skipped). The arsenal lets overlaps
 * reach ±3/±4; the contract's ±1–2 is per row, as the eye reads it.
 */
function applyGlitch(F: ComposedFigure, seed: number): void {
  const { W, H, kinds, srcX, srcY } = F
  const net = new Int8Array(H)
  const r = (n: number) => mix(seed, n)
  let y0 = H
  let y1 = -1

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (kinds[y * W + x]) {
        y0 = Math.min(y0, y)
        y1 = y

        break
      }
    }
  }

  if (y1 < 0) {
    return
  }

  const bands = F.bands
  const nb = 2 + (r(3) < 0.5 ? 1 : 0)

  for (let b = 0; b < nb; b++) {
    const bh = 2 + Math.floor(r(10 + b) * 7)
    const by0 = y0 + Math.floor(r(20 + b) * Math.max(1, y1 - y0 + 2 - bh))
    const by1 = Math.min(H, by0 + bh)
    let x0 = W
    let x1 = -1

    for (let y = by0; y < by1; y++) {
      for (let x = 0; x < W; x++) {
        if (kinds[y * W + x]) {
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
        }
      }
    }

    if (x1 < 0) {
      continue
    }

    const want = (1 + Math.floor(r(30 + b) * 2)) * (r(40 + b) < 0.5 ? -1 : 1)
    let lo = -x0
    let hi = W - 1 - x1

    for (let y = by0; y < by1; y++) {
      lo = Math.max(lo, -GLITCH_MAX_NET_SHIFT - net[y]!)
      hi = Math.min(hi, GLITCH_MAX_NET_SHIFT - net[y]!)
    }

    const fit = (s: number) => Math.max(lo, Math.min(hi, s))
    const s = fit(want) || fit(-want)

    if (!s) {
      continue
    }

    for (let y = by0; y < by1; y++) {
      const o = y * W
      const rk = kinds.slice(o, o + W)
      const rx = srcX.slice(o, o + W)
      const ry = srcY.slice(o, o + W)
      kinds.fill(0, o, o + W)
      srcX.fill(-1, o, o + W)
      srcY.fill(-1, o, o + W)

      for (let x = 0; x < W; x++) {
        const X = x + s

        if (X >= 0 && X < W) {
          kinds[o + X] = rk[x]!
          srcX[o + X] = rx[x]!
          srcY[o + X] = ry[x]!
        }
      }
    }

    for (let y = by0; y < by1; y++) {
      net[y] = net[y]! + s
    }

    bands.push({ s, y0: by0, y1: by1 })
  }

  if (!bands.length) {
    return
  }

  const B = bands[Math.floor(r(50) * bands.length)]!
  const n = 2 + Math.floor(r(53) * 2)
  const y = B.y0 + Math.floor(r(51) * (B.y1 - B.y0))
  const row = y * W
  const filled: number[] = []

  for (let x = 0; x < W; x++) {
    if (kinds[row + x]) {
      filled.push(x)
    }
  }

  const start = filled.length ? Math.floor(r(52) * Math.max(1, filled.length - n)) : 0

  for (const x of filled.slice(start, start + n)) {
    kinds[row + x] = TILE_NONE
  }
}

/**
 * The frame composed: the yaw's cell inside its margin, rows lifted by the breath (a row the lift leaves empty
 * repeats the row under it, so the outline stays closed), the top rows shifted by the wave, one foot raised by the
 * run, the whole figure swayed, then the glitch. The jump is NOT here: the painter lifts the tiles and leaves the
 * shadow on the ground.
 */
export function composeFigure(pet: DecodedPet, frame: PetFrame): ComposedFigure {
  const { w, h } = pet
  const { W, H } = petCanvasTiles(pet)
  const yaw = ((frame.yaw % pet.yaws) + pet.yaws) % pet.yaws
  const offset = yaw * w * h
  const b = pet.boxes[yaw]!
  const kinds = new Uint8Array(W * H)
  const srcX = new Int16Array(W * H).fill(-1)
  const srcY = new Int16Array(W * H).fill(-1)
  const fh = Math.max(1, b.y1 - b.y0 + 1)
  const yTop = b.y0 + Math.round(fh * BREATH_TOP)
  const yMid = b.y0 + Math.round(fh * BREATH_MID)
  const yFeet = b.y0 + Math.round(fh * BREATH_FEET)
  // The breath lifts the top and the trunk; the run's bob lifts everything above the feet one more tile.
  const bob = frame.bob | 0
  const lift = (y: number) => (y < yTop ? frame.breathTop : y < yMid ? frame.breathMid : 0) + (y < yFeet ? bob : 0)
  const rowSrc = new Int16Array(H).fill(-1)
  let prev = -1

  for (let y = 0; y < h; y++) {
    const Y = y + MY - lift(y)
    const dx = MX + frame.swayDx + (y < yTop ? frame.waveDx : 0)

    for (let YY = prev < 0 ? Y : prev + 1; YY <= Y; YY++) {
      for (let x = 0; x < w; x++) {
        const X = x + dx

        if (X < 0 || X >= W) {
          continue
        }

        const kind = pet.cells[offset + y * w + x]!

        kinds[YY * W + X] = kind
        srcX[YY * W + X] = kind ? x : -1
        srcY[YY * W + X] = kind ? y : -1
      }

      rowSrc[YY] = y
    }

    prev = Y
  }

  if (frame.run) {
    // The left foot (run 1) or the right one (run 2) rises one tile.
    const cx = MX + frame.swayDx + Math.round((b.x0 + b.x1 + 1) / 2)
    const xa = frame.run === 1 ? 0 : cx
    const xb = frame.run === 1 ? cx : W
    let first = -1

    for (let j = 0; j < H; j++) {
      if (rowSrc[j]! >= yFeet) {
        first = j

        break
      }
    }

    if (first > 0) {
      for (let J = first; J < H; J++) {
        for (let X = xa; X < xb; X++) {
          kinds[(J - 1) * W + X] = kinds[J * W + X]!
          srcX[(J - 1) * W + X] = srcX[J * W + X]!
          srcY[(J - 1) * W + X] = srcY[J * W + X]!
        }
      }

      for (let X = xa; X < xb; X++) {
        kinds[(H - 1) * W + X] = TILE_NONE
        srcX[(H - 1) * W + X] = -1
        srcY[(H - 1) * W + X] = -1
      }
    }
  }

  const F: ComposedFigure = { bands: [], H, W, kinds, srcX, srcY }

  if (frame.glitch) {
    applyGlitch(F, frame.glitch.seed)
  }

  return F
}

/** The arsenal's grain v4.1: a slight slope across the sprite and a 4-level hash jitter, per sprite pixel. */
function grain(si: number, sj: number, w: number, h: number): number {
  let x = (Math.imul(si, 374761393) + Math.imul(sj, 668265263)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  x ^= x >>> 16

  return 1 - GRAIN_SLOPE * ((si + sj) / Math.max(1, w + h - 2)) - (GRAIN_JITTER * ((x >>> 0) % 4)) / 3
}

const shade = (c: readonly number[], k: number) => c.map(v => Math.round(v * k))

const accentByYaw = new WeakMap<DecodedPet, Uint8Array>()

/** A painted class with fewer tiles than this in a view is skipped by the dark beat: a beat that cannot be seen is
 *  not a beat (lead ruling r3; at scale 1 a tile is one CSS px). */
export const ACCENT_MIN_TILES = 4

/**
 * The tile kind that goes dark for the waiting blink and the failed eyes, per yaw: the first of accent (`m`), accent2
 * (`c`), plate (`p`) that is painted and has at least ACCENT_MIN_TILES tiles in the view — so the beat shows on every
 * pet (five have no accent tile in the front view, four more only 1–3). If none is that big, the biggest painted one.
 * TILE_NONE when the view has none of the three painted.
 */
export function accentKindOf(pet: DecodedPet, yaw: number): number {
  let byYaw = accentByYaw.get(pet)

  if (!byYaw) {
    byYaw = new Uint8Array(pet.yaws)
    const n = pet.w * pet.h

    for (let k = 0; k < pet.yaws; k++) {
      const count = new Map<number, number>()

      for (let i = k * n; i < (k + 1) * n; i++) {
        count.set(pet.cells[i]!, (count.get(pet.cells[i]!) ?? 0) + 1)
      }

      const painted = (
        [
          [TILE_PAINT_M, pet.paint.m],
          [TILE_PAINT_C, pet.paint.c],
          [TILE_PAINT_P, pet.paint.p]
        ] as const
      )
        .filter(([kind, paint]) => paint && (count.get(kind) ?? 0) > 0)
        .map(([kind]) => ({ kind, tiles: count.get(kind)! }))

      const seen = painted.find(c => c.tiles >= ACCENT_MIN_TILES)
      const biggest = painted.reduce<null | (typeof painted)[number]>((a, c) => (!a || c.tiles > a.tiles ? c : a), null)

      byYaw[k] = (seen ?? biggest)?.kind ?? TILE_NONE
    }

    accentByYaw.set(pet, byYaw)
  }

  return byYaw[((yaw % pet.yaws) + pet.yaws) % pet.yaws]!
}

/**
 * The frame as RGBA, one pixel per tile (`W × H`), lifted by the jump. Ink = the constant #0d180d; a painted tile =
 * class colour × grain × mix + #437a40 × (1 − mix) (mix .85; the plate's follows the review pulse); a plate's ink tile =
 * shade(plate, .85) painted the same way; while the accent is dark its tiles are ink (`accentKindOf`: the accent, else
 * accent2, else the plate). Everything else: alpha 0.
 */
export function petPixels(pet: DecodedPet, frame: PetFrame): { W: number; H: number; data: Uint8ClampedArray } {
  const F = composeFigure(pet, frame)
  const { W, H } = F
  const data = new Uint8ClampedArray(W * H * 4)
  const plateInk = pet.paint.p ? shade(pet.paint.p, PLATE_INK_SHADE) : null
  const lift = Math.max(0, Math.min(MY, frame.lift | 0))
  const dark = frame.accentDark ? accentKindOf(pet, frame.yaw) : TILE_NONE

  for (let j = 0; j < H; j++) {
    const Y = j - lift

    if (Y < 0) {
      continue
    }

    for (let i = 0; i < W; i++) {
      const k = j * W + i
      const kind = F.kinds[k]!

      if (kind === TILE_NONE) {
        continue
      }

      let colour: null | readonly number[] = null
      let share = PAINT_MIX

      if (kind === dark) {
        colour = null
      } else if (kind === TILE_PLATE_INK) {
        colour = plateInk
        share = frame.plateMix
      } else if (kind === TILE_PAINT_P) {
        colour = pet.paint.p
        share = frame.plateMix
      } else if (kind === TILE_PAINT_M) {
        colour = pet.paint.m
      } else if (kind === TILE_PAINT_C) {
        colour = pet.paint.c
      }

      const o = (Y * W + i) * 4

      if (colour && kind !== TILE_INK) {
        const sx = F.srcX[k]!
        const sy = F.srcY[k]!
        const g = sx < 0 || sy < 0 ? 1 : grain(sx, sy, pet.w, pet.h)

        for (let c = 0; c < 3; c++) {
          data[o + c] = Math.round(colour[c]! * g * share + ROBINHOOD_GREEN[c]! * (1 - share))
        }
      } else {
        data[o] = PET_INK[0]!
        data[o + 1] = PET_INK[1]!
        data[o + 2] = PET_INK[2]!
      }

      data[o + 3] = 255
    }
  }

  return { H, W, data }
}

type PetRGBA = { W: number; H: number; data: Uint8ClampedArray }

/**
 * The rim of a coloured frame (figure tiles at alpha 255, everything else 0): the transparent tiles outside the
 * silhouette — 4-connected to the canvas edge through transparent tiles — with a figure tile up, down, left or
 * right, in `colour` at `PET_RIM_ALPHA`. Everything else alpha 0.
 */
function rimOf(px: PetRGBA, colour: readonly number[]): PetRGBA {
  const { W, H, data } = px
  const out = new Uint8ClampedArray(data.length)
  const solid = (k: number) => data[k * 4 + 3] === 255
  const outside = new Uint8Array(W * H)
  const stack: number[] = []

  const seed = (k: number) => {
    if (!solid(k) && !outside[k]) {
      outside[k] = 1
      stack.push(k)
    }
  }

  for (let i = 0; i < W; i++) {
    seed(i)
    seed((H - 1) * W + i)
  }

  for (let j = 0; j < H; j++) {
    seed(j * W)
    seed(j * W + W - 1)
  }

  while (stack.length) {
    const k = stack.pop()!
    const i = k % W

    if (i > 0) {
      seed(k - 1)
    }

    if (i < W - 1) {
      seed(k + 1)
    }

    if (k >= W) {
      seed(k - W)
    }

    if (k < (H - 1) * W) {
      seed(k + W)
    }
  }

  const a = Math.round(PET_RIM_ALPHA * 255)

  for (let k = 0; k < W * H; k++) {
    if (!outside[k]) {
      continue
    }

    const i = k % W

    const touches =
      (i > 0 && solid(k - 1)) ||
      (i < W - 1 && solid(k + 1)) ||
      (k >= W && solid(k - W)) ||
      (k < (H - 1) * W && solid(k + W))

    if (touches) {
      out[k * 4] = colour[0]!
      out[k * 4 + 1] = colour[1]!
      out[k * 4 + 2] = colour[2]!
      out[k * 4 + 3] = a
    }
  }

  return { H, W, data: out }
}

/** The pet's rim colour: its plate (every bundled pet has one), else its first painted class. */
const rimColour = (pet: DecodedPet): readonly number[] => pet.paint.p ?? pet.paint.c ?? pet.paint.m ?? ROBINHOOD_GREEN

/** The rim light of a frame, one RGBA pixel per tile (`W × H`), lifted with the figure. PURE in (pet, frame). */
export function petRimPixels(pet: DecodedPet, frame: PetFrame): PetRGBA {
  return rimOf(petPixels(pet, frame), rimColour(pet))
}

/** The shadow's mask: the composed figure on the ground (no jump), opaque where a tile is. */
function petShadowMask(pet: DecodedPet, frame: PetFrame): { W: number; H: number; data: Uint8ClampedArray } {
  const ground = petPixels(pet, { ...frame, lift: 0 })
  const data = new Uint8ClampedArray(ground.data.length)

  for (let i = 3; i < data.length; i += 4) {
    data[i] = ground.data[i]! >= 128 ? 255 : 0
  }

  return { H: ground.H, W: ground.W, data }
}

// ── the canvas half ─────────────────────────────────────────────────────────

type Canvas2D = CanvasRenderingContext2D

function scratch(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)

  return c
}

function bitmap(px: PetRGBA): HTMLCanvasElement | null {
  const c = scratch(px.W, px.H)
  const ctx = c.getContext('2d')

  if (!ctx) {
    return null
  }

  const img = ctx.createImageData(px.W, px.H)
  img.data.set(px.data)
  ctx.putImageData(img, 0, 0)

  return c
}

/**
 * Paint one frame into `ctx` (whose backing store is `W·D × H·D` device px). Clears first: the pet has no
 * background, so whatever is behind the canvas shows through every non-tile pixel.
 */
export function paintPet(ctx: Canvas2D, pet: DecodedPet, frame: PetFrame, D: number): void {
  const figure = petPixels(pet, frame)
  const rim = rimOf(figure, rimColour(pet))
  // Figure and rim never share a tile: one bitmap, so the gaps cut both alike.
  const px: PetRGBA = { H: figure.H, W: figure.W, data: figure.data.slice() }

  for (let o = 3; o < px.data.length; o += 4) {
    if (rim.data[o]) {
      px.data.set(rim.data.subarray(o - 3, o + 1), o - 3)
    }
  }

  const cw = px.W * D
  const ch = px.H * D
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

  const tiles = bitmap(px)
  const mask = bitmap(petShadowMask(pet, frame))

  if (!tiles || !mask) {
    return
  }

  // The shadow: the figure's own silhouette blurred, on the ground, dropped .4 of a tile.
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.filter = `blur(${(D * SHADOW.blur).toFixed(2)}px)`
  ctx.globalAlpha = SHADOW.alpha
  ctx.drawImage(mask, 0, Math.round(D * SHADOW.drop), cw, ch)
  ctx.restore()

  // The tiles and their rim, nearest neighbour, with the 12 % gaps once a tile is ≥ 4 device px.
  const big = scratch(cw, ch)
  const bc = big.getContext('2d')

  if (!bc) {
    return
  }

  bc.imageSmoothingEnabled = false
  bc.drawImage(tiles, 0, 0, cw, ch)

  if (D >= GAP_MIN_DEVICE_PX) {
    const gw = D * GAP
    bc.globalCompositeOperation = 'destination-out'
    bc.fillStyle = '#000'

    for (let i = 0; i <= px.W; i++) {
      bc.fillRect(i * D - gw / 2, 0, gw, ch)
    }

    for (let j = 0; j <= px.H; j++) {
      bc.fillRect(0, j * D - gw / 2, cw, gw)
    }

    bc.globalCompositeOperation = 'source-over'
  }

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(big, 0, 0)
}
