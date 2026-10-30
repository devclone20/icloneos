/**
 * HUD preferences — owner-tunable knobs for the floating HUD window,
 * persisted in localStorage (shared across the app and HUD windows, which
 * live on the same origin) and kept live via the cross-window 'storage'
 * event so a change in Settings reaches an OPEN HUD immediately.
 *
 * Read sites: hud-shell.tsx (band hold), click-through.ts (mouse
 * transparency), glass.ts (native frost). Write site: the HUD Settings pane.
 */
import { atom } from 'nanostores'

const HOLD_KEY = 'iclone.hud.holdMs'
const FROST_KEY = 'iclone.hud.frost'
const CLICK_KEY = 'iclone.hud.clickThrough'

const HUD_HOLD_DEFAULT_MS = 1100
export const HUD_HOLD_MIN_MS = 600
export const HUD_HOLD_MAX_MS = 15000

function readHold(): number {
  try {
    const raw = Number(window.localStorage.getItem(HOLD_KEY))

    return Number.isFinite(raw) && raw >= HUD_HOLD_MIN_MS && raw <= HUD_HOLD_MAX_MS ? raw : HUD_HOLD_DEFAULT_MS
  } catch {
    return HUD_HOLD_DEFAULT_MS
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)

    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

export const $hudHoldMs = atom<number>(readHold())
// Default OFF (owner rule: nothing paints below the bar — text only).
export const $hudFrostEnabled = atom<boolean>(readFlag(FROST_KEY, false))
export const $hudClickThroughEnabled = atom<boolean>(readFlag(CLICK_KEY, true))

export function setHudHoldMs(next: number): void {
  const clamped = Math.min(HUD_HOLD_MAX_MS, Math.max(HUD_HOLD_MIN_MS, Math.round(next)))

  $hudHoldMs.set(clamped)

  try {
    window.localStorage.setItem(HOLD_KEY, String(clamped))
  } catch {
    // Session-only is still applied.
  }
}

export function setHudFrostEnabled(next: boolean): void {
  $hudFrostEnabled.set(next)

  try {
    window.localStorage.setItem(FROST_KEY, next ? '1' : '0')
  } catch {
    // Session-only is still applied.
  }
}

export function setHudClickThroughEnabled(next: boolean): void {
  $hudClickThroughEnabled.set(next)

  try {
    window.localStorage.setItem(CLICK_KEY, next ? '1' : '0')
  } catch {
    // Session-only is still applied.
  }
}

/** Imperative reads for the hot paths (mousemove hit-tests, band timers). */
export const hudHoldMs = (): number => $hudHoldMs.get()
export const hudFrostEnabled = (): boolean => $hudFrostEnabled.get()
export const hudClickThroughEnabled = (): boolean => $hudClickThroughEnabled.get()

// A write in another window (Settings ⇄ open HUD) lands here as a storage
// event — fold it back into the atoms so effects re-run live.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === HOLD_KEY) {
      $hudHoldMs.set(readHold())
    } else if (event.key === FROST_KEY) {
      $hudFrostEnabled.set(readFlag(FROST_KEY, false))
    } else if (event.key === CLICK_KEY) {
      $hudClickThroughEnabled.set(readFlag(CLICK_KEY, true))
    }
  })
}
