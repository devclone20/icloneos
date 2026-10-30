/**
 * The pet sprite codec (`pet-ctx-rc/1`). One file holds both directions so the
 * port script (`scripts/port-pets.mjs`, run by Node with its built-in type
 * stripping) and the app decode with the very same model: no second copy of the
 * maths can drift.
 *
 * WHAT IS CODED. An arsenal sprite cell (rows plane 2 bpp ‖ classes plane 2 bpp,
 * see the arsenal's `cell()`) is first reduced to the one thing `present()` ever
 * draws per pixel — a TILE KIND:
 *   0 nothing (outside, or an unpainted hole: the owner's rule makes it transparent)
 *   1 ink
 *   2 plate ink (an ink pixel of the plate class: `shade(plate, .85)`)
 *   3 paint m (the accent)    4 paint p (the plate)    5 paint c (the second accent)
 * so a decoded sprite renders pixel-for-pixel what the arsenal renders. The 24
 * yaws are coded in order, row by row.
 *
 * HOW. An adaptive binary range coder (LZMA's carry-less shape, 12-bit probabilities
 * that learn by a per-context count)
 * over a context of the five already-coded neighbours (W, N, NW, NE, WW). The
 * symbol is binarised as a chain "is it 0? is it 1? … is it 4?" (5 nodes). A pet
 * goes from 9–16 KB (the arsenal's zlib blob) to 2.5–6.3 KB of JSON, so every
 * bundled sprite keeps all 24 yaws under the contract's 8 KB.
 *
 * Erasable TypeScript only (no enums/namespaces) and no imports: Node runs this
 * file as-is.
 */

export const PET_CODEC = 'pet-ctx-rc/1'

/** Tile kinds (see the header). */
export const TILE_NONE = 0
export const TILE_INK = 1
export const TILE_PLATE_INK = 2
export const TILE_PAINT_M = 3
export const TILE_PAINT_P = 4
export const TILE_PAINT_C = 5

const SYMBOLS = 6
const NODES = SYMBOLS - 1
const CONTEXTS = SYMBOLS ** 5
const PROB_BITS = 12
const PROB_INIT = 1 << (PROB_BITS - 1)
const PROB_ONE = 1 << PROB_BITS
const PROB_MIN = 32
const PROB_MAX = PROB_ONE - PROB_MIN
/** A context learns fast while it is young (step 1/2, 1/3, …) and settles at 1/LIMIT. */
const COUNT_LIMIT = 30
const TOP = 0x1000000
const TWO_32 = 0x100000000

function contextAt(cells: Uint8Array, base: number, x: number, y: number, w: number): number {
  const at = (dx: number, dy: number): number => {
    const X = x + dx
    const Y = y + dy

    return X >= 0 && X < w && Y >= 0 ? cells[base + Y * w + X]! : 0
  }

  return (((at(-1, 0) * SYMBOLS + at(0, -1)) * SYMBOLS + at(-1, -1)) * SYMBOLS + at(1, -1)) * SYMBOLS + at(-2, 0)
}

interface Model {
  probs: Uint16Array
  counts: Uint8Array
}

const newModel = (): Model => ({
  counts: new Uint8Array(CONTEXTS * NODES),
  probs: new Uint16Array(CONTEXTS * NODES).fill(PROB_INIT)
})

/** P(bit = 0) moves toward what was seen by 1/(count + 2): integer maths, identical on both sides. */
function learn(model: Model, index: number, value: number): void {
  const p = model.probs[index]!
  const n = model.counts[index]!
  const target = value === 0 ? PROB_ONE : 0
  const next = p + Math.trunc((target - p) / (n + 2))
  model.probs[index] = Math.min(PROB_MAX, Math.max(PROB_MIN, next))

  if (n < COUNT_LIMIT) {
    model.counts[index] = n + 1
  }
}

/** Encode `n` cells of `w × h` tile kinds (yaw-major) into the coded bytes. */
export function encodePetCells(cells: Uint8Array, w: number, h: number, n: number): Uint8Array {
  if (cells.length !== w * h * n) {
    throw new Error(`pet codec: ${cells.length} tiles for ${n} cells of ${w}×${h}`)
  }

  const model = newModel()
  const out: number[] = []
  let low = 0
  let range = 0xffffffff
  let cache = 0
  let cacheSize = 1

  const shiftLow = () => {
    if (low < 0xff000000 || low >= TWO_32) {
      const carry = low >= TWO_32 ? 1 : 0
      let temp = cache

      do {
        out.push((temp + carry) & 0xff)
        temp = 0xff
      } while (--cacheSize !== 0)

      cache = Math.floor(low / TOP) & 0xff
    }

    cacheSize++
    low = (low % TOP) * 256
  }

  const bit = (index: number, value: number) => {
    const bound = (range >>> PROB_BITS) * model.probs[index]!

    if (value === 0) {
      range = bound
    } else {
      low += bound
      range -= bound
    }

    learn(model, index, value)

    while (range < TOP) {
      range *= 256
      shiftLow()
    }
  }

  for (let k = 0; k < n; k++) {
    const base = k * w * h

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = cells[base + y * w + x]!

        if (s >= SYMBOLS) {
          throw new Error(`pet codec: tile kind ${s} out of range`)
        }

        const ctx = contextAt(cells, base, x, y, w) * NODES

        for (let t = 0; t < NODES; t++) {
          const hit = s === t ? 1 : 0
          bit(ctx + t, hit)

          if (hit) {
            break
          }
        }
      }
    }
  }

  for (let i = 0; i < 5; i++) {
    shiftLow()
  }

  return Uint8Array.from(out)
}

/** Decode the coded bytes back into `n` cells of `w × h` tile kinds (yaw-major). */
export function decodePetCells(bytes: Uint8Array, w: number, h: number, n: number): Uint8Array {
  const cells = new Uint8Array(w * h * n)
  const model = newModel()
  let pos = 0
  let range = 0xffffffff
  let code = 0

  const next = (): number => (pos < bytes.length ? bytes[pos++]! : 0)

  for (let i = 0; i < 5; i++) {
    code = (code * 256 + next()) % TWO_32
  }

  const bit = (index: number): number => {
    const bound = (range >>> PROB_BITS) * model.probs[index]!
    let value: number

    if (code < bound) {
      range = bound
      value = 0
    } else {
      code -= bound
      range -= bound
      value = 1
    }

    learn(model, index, value)

    while (range < TOP) {
      range *= 256
      code = code * 256 + next()
    }

    return value
  }

  for (let k = 0; k < n; k++) {
    const base = k * w * h

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ctx = contextAt(cells, base, x, y, w) * NODES
        let s = NODES

        for (let t = 0; t < NODES; t++) {
          if (bit(ctx + t)) {
            s = t

            break
          }
        }

        cells[base + y * w + x] = s
      }
    }
  }

  return cells
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 (no DOM, no Buffer: the same code in the app, the tests and Node). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    const v = (a << 16) | (b << 8) | c
    s += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]!
    s += i + 1 < bytes.length ? B64[(v >> 6) & 63]! : '='
    s += i + 2 < bytes.length ? B64[v & 63]! : '='
  }

  return s
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0

  for (let i = 0; i < clean.length; i += 4) {
    const v =
      (B64.indexOf(clean[i]!) << 18) |
      (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      (B64.indexOf(clean[i + 2] ?? 'A') << 6) |
      B64.indexOf(clean[i + 3] ?? 'A')

    if (o < out.length) {
      out[o++] = (v >> 16) & 255
    }

    if (o < out.length) {
      out[o++] = (v >> 8) & 255
    }

    if (o < out.length) {
      out[o++] = v & 255
    }
  }

  return out
}
