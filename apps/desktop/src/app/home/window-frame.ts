/**
 * The shared window frame — every Dock window (Message and the five EconomyOS
 * windows) opens on the SAME rect as the iNFT 3D stage's card
 * (`.ihome__stage--live`), so each window's edges cover the iNFT's edges for
 * one seamless surface; Settings opens on the same frame too.
 *
 * ONE source of truth: the `--ic-frame-*` custom properties on :root in
 * home.css. CSS consumers use the vars directly; TS consumers name them
 * through `FRAME_VAR` (window/rect.ts resolves them) — never a second copy of
 * the numbers. A copy is how the card and the windows drifted apart before.
 */

export interface WindowFrame {
  top: number
  right: number
  bottom: number
  left: number
}

/** CSS custom properties that define the frame (see home.css). */
export const FRAME_VAR = {
  top: '--ic-frame-top',
  right: '--ic-frame-right',
  bottom: '--ic-frame-bottom',
  left: '--ic-frame-left',
  radius: '--ic-frame-radius'
} as const
