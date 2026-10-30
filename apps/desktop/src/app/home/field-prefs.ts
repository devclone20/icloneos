/**
 * Stage field glow — the luminance ceiling applied to the live iNFT's
 * field color (owner rule: from very bright down to almost black, where
 * only the 3D character shows; every SUMMON opens at the standard glow).
 *
 * Deliberately NOT persisted: the standard is the opening state — the
 * slider tunes the performance on stage right now, and the next summon
 * starts standard again.
 */
import { atom } from 'nanostores'

/** The standard opening glow (the toned "gallery wall" the owner approved). */
export const FIELD_CEILING_STANDARD = 0.35
export const FIELD_CEILING_MIN = 0.02
export const FIELD_CEILING_MAX = 0.9

export const $fieldCeiling = atom<number>(FIELD_CEILING_STANDARD)

export function setFieldCeiling(next: number): void {
  $fieldCeiling.set(Math.min(FIELD_CEILING_MAX, Math.max(FIELD_CEILING_MIN, next)))
}

export function resetFieldCeiling(): void {
  $fieldCeiling.set(FIELD_CEILING_STANDARD)
}

/** The field glow — the brightness multiplier on the field's own colour
 *  (the mini app's cos⁴ falloff flattened to a uniform scale on the solid
 *  field). Standard is 1 (the colour exactly as painted); above 1 brightens
 *  the field, below 1 dims it toward black. The ceiling still pins the peak. */
export const FIELD_GLOW_STANDARD = 1
export const FIELD_GLOW_MIN = 0.2
export const FIELD_GLOW_MAX = 1.6

export const $fieldGlow = atom<number>(FIELD_GLOW_STANDARD)

export function setFieldGlow(next: number): void {
  $fieldGlow.set(Math.min(FIELD_GLOW_MAX, Math.max(FIELD_GLOW_MIN, next)))
}

export function resetFieldGlow(): void {
  $fieldGlow.set(FIELD_GLOW_STANDARD)
}
