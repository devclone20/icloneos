/**
 * Where the in-window pet may stand (ported from the old `roam-geometry`, cut to
 * the V3-P rule): the BOTTOM BAND of the window, never over the composer. With a
 * composer on screen the pet stands on its top edge — at its corner when still,
 * walking along it when it roams; without one it stands on the window floor (the
 * status bar's top when one is pinned across the bottom). The pure half
 * (`computeLedges`, `homeSpot`, `clampToLedge`, `snapToTile`) is what the tests
 * and gate P8 measure; `readSurfaces` is the only DOM read.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** A walkable line: the feet rest on `y`; the pet's left edge stays in [left, right]. */
export interface Ledge {
  id: 'composer' | 'floor'
  y: number
  left: number
  right: number
}

export interface Surfaces {
  viewport: { width: number; height: number }
  composer: null | Rect
  floorBar: null | Rect
}

const COMPOSER_SELECTOR = '[data-slot="composer-surface"]'
const FLOOR_BAR_SELECTOR = '[data-slot="statusbar"]'
/** Tiles kept between the pet and the composer's right end (the send button lives there). */
const HOME_INSET_TILES = 4

/** Whole tiles: every position the pet takes is a multiple of the tile (1 tile = `scale` CSS px). */
export const snapToTile = (v: number, tile: number): number => Math.round(v / tile) * tile

/** The window floor: the top of a status bar pinned full-width at the bottom, else the window's bottom edge. */
function floorY(s: Surfaces, petH: number): number {
  const bar = s.floorBar

  if (
    bar &&
    bar.right - bar.left >= s.viewport.width * 0.5 &&
    s.viewport.height - bar.bottom < 4 &&
    bar.top - petH >= 0
  ) {
    return bar.top
  }

  return s.viewport.height
}

/** Where the pet may stand right now, for a pet of `petW × petH` CSS px. */
export function computeLedges(s: Surfaces, petW: number, petH: number): Ledge[] {
  const c = s.composer
  const width = s.viewport.width

  if (c && c.right - c.left > petW && c.top - petH >= 0 && c.top < s.viewport.height) {
    return [{ id: 'composer', left: Math.max(0, c.left), right: Math.min(width - petW, c.right - petW), y: c.top }]
  }

  return [{ id: 'floor', left: 0, right: Math.max(0, width - petW), y: floorY(s, petH) }]
}

/** The pet's resting top-left on a ledge, its left edge clamped into the ledge and both snapped to tiles. */
export function clampToLedge(ledge: Ledge, x: number, petH: number, tile: number): { x: number; y: number } {
  const lo = Math.ceil(ledge.left / tile) * tile
  const hi = Math.floor(ledge.right / tile) * tile

  return {
    x: Math.min(Math.max(snapToTile(x, tile), lo), Math.max(lo, hi)),
    y: Math.floor((ledge.y - petH) / tile) * tile
  }
}

/** Home: the composer's top-right corner (a few tiles in from the send button), or the floor's right corner. */
export function homeSpot(ledge: Ledge, petH: number, tile: number): { x: number; y: number } {
  return clampToLedge(ledge, ledge.right - HOME_INSET_TILES * tile, petH, tile)
}

/** True when a pet rect would overlap the composer — the one thing the pet must never do (gate P8). */
export function coversComposer(pet: Rect, composer: null | Rect): boolean {
  return Boolean(
    composer &&
    pet.left < composer.right &&
    pet.right > composer.left &&
    pet.top < composer.bottom &&
    pet.bottom > composer.top
  )
}

const toRect = (r: DOMRect): Rect => ({ bottom: r.bottom, left: r.left, right: r.right, top: r.top })

/** The DOM read: the window, the composer (if on screen) and a pinned status bar. */
export function readSurfaces(): Surfaces {
  const composerEl = document.querySelector(COMPOSER_SELECTOR)
  const barEl = document.querySelector(FLOOR_BAR_SELECTOR)
  const composer = composerEl ? toRect(composerEl.getBoundingClientRect()) : null

  return {
    composer: composer && composer.right > composer.left && composer.bottom > composer.top ? composer : null,
    floorBar: barEl ? toRect(barEl.getBoundingClientRect()) : null,
    viewport: { height: window.innerHeight || 600, width: window.innerWidth || 800 }
  }
}
