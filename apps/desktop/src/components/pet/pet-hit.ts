/**
 * Hit-testing a pet canvas: only the pet's own pixels take the mouse. A canvas pixel this opaque or more is the pet
 * (tiles 255, rim .7 × 255); the blurred shadow (.32 at most) and every transparent pixel let the click through to
 * whatever is behind — in the app (the in-window pet) as on the desktop (the pop-out).
 */
const PET_ALPHA_HIT = 128

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Whether the point (client px) lies on an opaque pixel of `canvas`. `box` is where the canvas is on screen when the
 * caller already knows it (no layout read); otherwise its bounding rect. Any failure reads as a miss (click-through).
 */
export function petPixelHit(canvas: HTMLCanvasElement, clientX: number, clientY: number, box?: Box): boolean {
  const rect = box ?? canvas.getBoundingClientRect()

  if (!(rect.width > 0 && rect.height > 0)) {
    return false
  }

  const fx = (clientX - rect.left) / rect.width
  const fy = (clientY - rect.top) / rect.height

  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) {
    return false
  }

  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const px = Math.floor(fx * canvas.width)
    const py = Math.floor(fy * canvas.height)

    return Boolean(ctx) && ctx!.getImageData(px, py, 1, 1).data[3]! >= PET_ALPHA_HIT
  } catch {
    return false
  }
}
