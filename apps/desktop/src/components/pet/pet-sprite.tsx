import { type CSSProperties, type MouseEventHandler, type PointerEventHandler, useEffect, useRef } from 'react'

import { prefersReducedMotion } from '@/hooks/use-media-query'

import { type DecodedPet, paintPet, petCanvasTiles } from './pet-draw'
import { snapPetScale } from './pet-ids'
import { facingYaw, frameKey, nextFrameChange, petFrame, type PetState } from './pet-states'
import { onPetFrame } from './pet-ticker'

/** The device pixel ratio, held to 1–4 (the arsenal's). */
const devicePixelRatio = () =>
  Math.max(1, Math.min(4, (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1))

/** The pet's CSS size at a scale: its canvas in tiles × the scale. */
export function petCssSize(pet: Pick<DecodedPet, 'h' | 'w'>, scale: number): { width: number; height: number } {
  const { H, W } = petCanvasTiles(pet)
  const s = snapPetScale(scale)

  return { height: H * s, width: W * s }
}

/** A live sprite's wake for a new facing (no-op when it already drew that facing). */
const facingWakers = new WeakMap<HTMLCanvasElement, (facing: number) => unknown>()

interface PetSpriteProps {
  pet: DecodedPet
  state: PetState
  scale: number
  /** Draw exactly this second of the state, still (sheets, thumbnails, tests). Omitted: live. */
  still?: number
  /** Keep animating while the window is unfocused (the pop-out overlay, which lives on the desktop). */
  animateUnfocused?: boolean
  /** Walking: −1 left, 1 right — the pet faces it with its own side view; 0 (default) the state's own yaw. */
  facing?: number
  /** A new value restarts the state's clock (every click waves again, even mid-wave). */
  clockKey?: number | string
  /** The canvas is read back for hit-testing (alpha under the pointer): ask for a CPU-readable backing store. */
  readable?: boolean
  className?: string
  label?: string
  style?: CSSProperties
  onClick?: MouseEventHandler<HTMLCanvasElement>
  onPointerDown?: PointerEventHandler<HTMLCanvasElement>
}

/**
 * One pet on a canvas: no box, no background, no border — the tiles and their shadow only. The state's clock
 * restarts whenever the state (or `clockKey`) changes (every state is a pure function of the seconds since it began);
 * the canvas repaints only when the frame's whole-tile numbers change, and the sprite sleeps until the moment they
 * can (`nextFrameChange`): every live sprite of the window rides ONE shared clock (`pet-ticker`), which sleeps with
 * the window. `prefers-reduced-motion` ⇒ the breath alone.
 */
export function PetSprite({
  pet,
  state,
  scale,
  still,
  animateUnfocused = false,
  facing = 0,
  clockKey,
  readable = false,
  className,
  label,
  style,
  onClick,
  onPointerDown
}: PetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const facingRef = useRef(facing)
  const s = snapPetScale(scale)
  const { height, width } = petCssSize(pet, s)

  facingRef.current = facing

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', readable ? { willReadFrequently: true } : undefined) ?? null

    if (!canvas || !ctx) {
      return
    }

    const since = performance.now()
    let lastKey = ''
    let drawnFacing = facingRef.current

    // Paint the frame at `now` if it changed; answer when it can change next (a still frame: never).
    const draw = (now: number): number => {
      const dpr = devicePixelRatio()
      const D = s * dpr
      const { H, W } = petCanvasTiles(pet)

      if (canvas.width !== W * D || canvas.height !== H * D) {
        canvas.width = W * D
        canvas.height = H * D
        lastKey = ''
      }

      const t = still ?? (now - since) / 1000
      const reduced = prefersReducedMotion()
      drawnFacing = facingRef.current
      const frame = facingYaw(petFrame(state, t, pet.seed, reduced), reduced ? 0 : drawnFacing)
      const key = `${D}|${frameKey(frame)}`

      if (key !== lastKey) {
        lastKey = key
        paintPet(ctx, pet, frame, D)
      }

      // A millisecond past the edge, so the frame drawn there is already the new one.
      return still === undefined ? since + 1000 * nextFrameChange(state, t, pet.seed, reduced) + 1 : Infinity
    }

    const due = draw(performance.now())

    if (still !== undefined) {
      return
    }

    const sub = onPetFrame(draw, { animateUnfocused, due })
    facingWakers.set(canvas, next => next !== drawnFacing && sub.wake())

    return () => {
      facingWakers.delete(canvas)
      sub.dispose()
    }
  }, [pet, state, s, still, animateUnfocused, clockKey, readable])

  // Turning to walk the other way changes the frame without a clock edge: draw it on the next frame.
  useEffect(() => {
    if (canvasRef.current) {
      facingWakers.get(canvasRef.current)?.(facing)
    }
  }, [facing])

  return (
    <canvas
      aria-label={label ?? pet.name}
      className={className}
      data-pet-facing={facing || undefined}
      data-pet-id={pet.id}
      data-pet-scale={s}
      data-pet-state={state}
      onClick={onClick}
      onPointerDown={onPointerDown}
      ref={canvasRef}
      role="img"
      style={{ display: 'block', height, imageRendering: 'pixelated', width, ...style }}
    />
  )
}
