/**
 * Stage rendering prefs — how the 3D iNFT is performed on stage (ported from
 * the mini app's stage preferences). Like the field glow and the aura, these
 * are deliberately NOT persisted: every summon opens at the standard and the
 * controls tune the performance on stage right now.
 */
import { atom } from 'nanostores'

export type StageQuality = 'auto' | 'high' | 'max'

/** Pixel cap: auto reads the device, high pins 2.5×, max pushes 3×. */
export const $quality = atom<StageQuality>('auto')

export function setQuality(next: StageQuality): void {
  $quality.set(next)
}

/** The piece's own life — clip program, acts, breath. Off freezes the figure
 *  (the owner's hand on the camera still works). */
export const $motion = atom<boolean>(true)

export function setMotion(on: boolean): void {
  $motion.set(on)
}
