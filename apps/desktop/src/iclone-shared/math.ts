/** iCLONE OS — numeric helpers shared by the electron main process and the renderer. */

/**
 * `value` limited to `[min, max]`. When the bounds cross (`min > max`) the
 * result is `min`; NaN stays NaN.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
