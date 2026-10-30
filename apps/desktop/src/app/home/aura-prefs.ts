/**
 * Stage aura — the light the artist baked around God Mode pieces: a stack of
 * nested, translucent, emissive shells ("an avatar frozen in a core of ice").
 *
 * The GLB ships those shells at the opacity that makes them a solid white
 * blowout (60 shells at ~0.10 accumulate to ~1.0). The stage tames them so the
 * whole stack accumulates to THIS value along a ray: 0 = no aura at all (the
 * piece as a figure in flat colour); the standard (0.45) reads the ice as ice
 * while the figure keeps ~55% contrast through it. The figure's own lights and
 * metal stay put — only the ice stack moves.
 *
 * Like the field glow, deliberately NOT persisted: every summon opens at the
 * standard aura and the slider tunes the performance on stage right now.
 */
import { atom } from 'nanostores'

/** The standard opening aura (the "ice reads as ice" the owner approved). */
export const AURA_STANDARD = 0.45
export const AURA_MIN = 0
export const AURA_MAX = 0.8

export const $aura = atom<number>(AURA_STANDARD)

export function setAura(next: number): void {
  $aura.set(Math.min(AURA_MAX, Math.max(AURA_MIN, next)))
}

export function resetAura(): void {
  $aura.set(AURA_STANDARD)
}
