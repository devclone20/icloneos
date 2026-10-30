/**
 * A wordless vertical drag slider (owner rule: no label, top-right, no
 * conflicts) that fades a window so the 3D iNFT owns the screen.
 *
 * The drag/keyboard/double-click mechanics live here; each window wires its
 * own copy (see `home/window/opacity.tsx`). Dragging to the bottom fades the
 * surface to invisible; the slider itself stays interactive at zero (it lives
 * outside the faded element).
 */
import { useCallback, useRef } from 'react'

import { MIN_INTERACTIVE } from './window/pointer-gate'

interface OpacitySliderProps {
  value: number
  onChange: (value: number) => void
  label: string
}

export function OpacitySlider({ value, onChange, label }: OpacitySliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const valueFromPointer = useCallback((clientY: number) => {
    const track = trackRef.current

    if (!track) {
      return null
    }

    const rect = track.getBoundingClientRect()
    const ratio = 1 - (clientY - rect.top) / rect.height

    return Math.min(1, Math.max(0, ratio))
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      const next = valueFromPointer(event.clientY)

      if (next !== null) {
        onChange(next)
      }
    },
    [onChange, valueFromPointer]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) {
        return
      }

      const next = valueFromPointer(event.clientY)

      if (next !== null) {
        onChange(next)
      }
    },
    [onChange, valueFromPointer]
  )

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false

    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released (a cancel or a lost capture got here first).
    }
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault()
        onChange(Math.min(1, value + 0.1))
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault()
        onChange(Math.max(0, value - 0.1))
      } else if (event.key === 'Home') {
        event.preventDefault()
        onChange(1)
      } else if (event.key === 'End') {
        event.preventDefault()
        // The keyboard floor is the interactive minimum: true zero makes the
        // surface hit-transparent, which is a deliberate DRAG gesture — a
        // single End press must not leave a keyboard user with a surface that
        // ignores the mouse.
        onChange(MIN_INTERACTIVE)
      }
    },
    [onChange, value]
  )

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(value * 100)}
      className="iop"
      onDoubleClick={() => onChange(1)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="slider"
      tabIndex={0}
    >
      <div className="iop__track" ref={trackRef}>
        <div className="iop__fill" style={{ height: `${value * 100}%` }} />
        <div className="iop__thumb" style={{ bottom: `calc(${value * 100}% - 7px)` }} />
      </div>
    </div>
  )
}
