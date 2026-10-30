import { type RefObject, useEffect } from 'react'

import { $petScale, nextPetScaleFromWheel } from '@/store/pet'

/**
 * Alt/Option + wheel over the pet resizes it — up to grow, down to shrink — one WHOLE scale a notch (1 → 2 → 3),
 * never a fraction: the pet is drawn 1 tile = scale CSS px. Alt is required so a plain scroll over the pet still
 * scrolls what is underneath (we only preventDefault while Alt is held). Native and non-passive so the
 * preventDefault takes and Electron does not read it as a page zoom.
 */
export function usePetZoomGesture<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onScale: (scale: number) => void,
  ready: boolean
): void {
  useEffect(() => {
    const el = ref.current

    if (!el || !ready) {
      return
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.altKey) {
        return
      }

      event.preventDefault()
      const base = $petScale.get()
      const next = nextPetScaleFromWheel(base, event.deltaY)

      if (next !== base) {
        onScale(next)
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })

    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, onScale, ready])
}
