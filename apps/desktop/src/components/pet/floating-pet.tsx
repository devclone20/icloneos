import { useStore } from '@nanostores/react'
import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import {
  $petAtRest,
  $petId,
  $petRoam,
  $petRoamDir,
  $petScale,
  $petState,
  clearPetUnread,
  setPetScale
} from '@/store/pet'
import {
  $petOverlayActive,
  initPetOverlayBridge,
  popOutPet,
  restorePetOverlay,
  setPetOverlayLocale,
  setPetOverlayOpenAppHandler,
  setPetOverlaySubmitHandler
} from '@/store/pet-overlay'
import { $sessions } from '@/store/session'

import { usePet } from './pet-catalog'
import { petPixelHit } from './pet-hit'
import { type PetPromptDeps, sendPetPrompt } from './pet-prompt-send'
import type { PetPromptTarget } from './pet-prompt-target'
import { petCssSize, PetSprite } from './pet-sprite'
import { type PetState, WAVE_SECONDS } from './pet-states'
import { usePetPlacement } from './use-pet-roam'
import { usePetZoomGesture } from './use-pet-zoom-gesture'

interface FloatingPetProps {
  /** Open a session (the unread marker on the popped-out pet opens the most recent one). */
  onOpenSession: (sessionId: string) => void
  /** The composer's own send (the popped-out pet's prompt box sends through it: the session on screen, no attachments). */
  onSubmitText?: PetPromptDeps['submitText']
  /** Where that send goes right now: the session on screen and its busy flag (read at send time). */
  promptTarget?: () => PetPromptTarget
}

/**
 * The in-window pet (V3-P): the chosen pixel robot standing at the composer's corner, reacting to the agent. Click
 * it: it waves (every click, again from the start). Shift-click: it pops out onto the desktop (its own transparent
 * window). Alt+wheel: it grows or shrinks by a whole scale. With roam on it walks the composer's top edge while the
 * agent is at rest, facing where it goes — and stands still under `prefers-reduced-motion`. Only the pet's own
 * pixels take the mouse: its transparent box lets every click through to the app behind it. Renders nothing until a
 * pet is chosen in the library, while it loads, or while it is out in its own window.
 */
export function FloatingPet({ onOpenSession, onSubmitText, promptTarget }: FloatingPetProps) {
  const petId = useStore($petId)

  // The owner's rule: no pet chosen, nothing of the pet exists — no canvas, no loop, no timer, no listener, no IPC.
  return petId ? (
    <PetScene onOpenSession={onOpenSession} onSubmitText={onSubmitText} petId={petId} promptTarget={promptTarget} />
  ) : null
}

/** Where the pet's canvas stands, from the host's own position (written by the placement): no layout read. */
function hostBox(host: HTMLElement, canvas: HTMLCanvasElement) {
  return {
    height: parseFloat(canvas.style.height) || 0,
    left: parseFloat(host.style.left) || 0,
    top: parseFloat(host.style.top) || 0,
    width: parseFloat(canvas.style.width) || 0
  }
}

function PetScene({ onOpenSession, onSubmitText, petId, promptTarget }: FloatingPetProps & { petId: string }) {
  const { t, locale } = useI18n()
  const scale = useStore($petScale)
  const roamOn = useStore($petRoam)
  const atRest = useStore($petAtRest)
  const live = useStore($petState)
  const roamDir = useStore($petRoamDir)
  const overlayActive = useStore($petOverlayActive)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const pet = usePet(petId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pokedAt, setPokedAt] = useState<null | number>(null)
  const shown = Boolean(pet) && !overlayActive
  const size = pet ? petCssSize(pet, scale) : { height: 0, width: 0 }

  // The overlay's bubble speaks the app's language; the bridge (control channel) and the restore run here, once.
  useEffect(() => setPetOverlayLocale(() => locale), [locale])
  useEffect(() => initPetOverlayBridge(), [])
  useEffect(() => {
    setPetOverlayOpenAppHandler(() => {
      const recent = $sessions.get()[0]

      if (recent?.id) {
        onOpenSession(recent.id)
      }
    })

    return () => setPetOverlayOpenAppHandler(null)
  }, [onOpenSession])
  useEffect(() => {
    if (pet) {
      restorePetOverlay()
    }
  }, [pet])

  // The overlay's prompt box sends through the pet's own sender (a normal message to the session on screen, queued
  // while it is busy, never a command), which answers sent / queued / refused. Registered once through refs that
  // track the latest callbacks: re-registering on identity churn would leave a gap that drops a message.
  const promptRef = useRef<PetPromptDeps>({})
  promptRef.current = { submitText: onSubmitText, target: promptTarget }
  useEffect(() => {
    setPetOverlaySubmitHandler((text, handOff) => sendPetPrompt(text, { ...promptRef.current, handOff }))

    return () => setPetOverlaySubmitHandler(null)
  }, [])

  // Coming back to the app clears the unread marker: you have seen it now.
  useEffect(() => {
    const onFocus = () => clearPetUnread()
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // A click's wave lasts its one second, then the live state shows again.
  useEffect(() => {
    if (pokedAt === null) {
      return
    }

    const id = window.setTimeout(() => setPokedAt(null), WAVE_SECONDS * 1000)

    return () => window.clearTimeout(id)
  }, [pokedAt])

  // Click-through: the host never takes the mouse; the canvas does only while the pointer is on an opaque pixel of
  // the pet (alpha hit-test against where the host stands — no layout read), so its transparent box never eats a
  // click meant for the transcript or Settings behind it. Re-run at the last pointer position on every placement
  // step too: a pet that walks under a still pointer must not keep the hit state of where it stood.
  const pointerRef = useRef<null | { x: number; y: number }>(null)

  const hitTest = useCallback(() => {
    const host = containerRef.current
    const canvas = host?.querySelector('canvas')
    const pointer = pointerRef.current

    if (!host || !canvas || !pointer) {
      return
    }

    const want = petPixelHit(canvas, pointer.x, pointer.y, hostBox(host, canvas)) ? 'auto' : 'none'

    if (canvas.style.pointerEvents !== want) {
      canvas.style.pointerEvents = want
    }
  }, [])

  usePetPlacement({
    containerRef,
    onPlaced: hitTest,
    enabled: shown,
    petH: size.height,
    petW: size.width,
    // Reduced motion: the pet stays where it stands (no gliding along the composer).
    roam: roamOn && atRest && pokedAt === null && !reducedMotion,
    roamOn,
    tile: scale
  })

  const onScale = useCallback((next: number) => setPetScale(next), [])
  usePetZoomGesture(containerRef, onScale, shown)

  const onPointerMove = useCallback(
    (event: globalThis.MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      hitTest()
    },
    [hitTest]
  )

  useEffect(() => {
    if (!shown) {
      return
    }

    window.addEventListener('mousemove', onPointerMove, { passive: true })

    return () => window.removeEventListener('mousemove', onPointerMove)
  }, [shown, onPointerMove])

  const onClick = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    // The pet may have walked away from under a still pointer: a transparent pixel is not the pet.
    const host = containerRef.current

    if (!host || !petPixelHit(event.currentTarget, event.clientX, event.clientY, hostBox(host, event.currentTarget))) {
      return
    }

    if (event.shiftKey) {
      const rect = event.currentTarget.getBoundingClientRect()
      popOutPet({ height: rect.height, width: rect.width, x: rect.left, y: rect.top })

      return
    }

    setPokedAt(performance.now())
  }, [])

  if (!pet || overlayActive) {
    return null
  }

  const state: PetState = pokedAt !== null ? 'wave' : live

  return (
    <div
      data-pet-host="window"
      ref={containerRef}
      style={{ left: 0, pointerEvents: 'none', position: 'fixed', top: 0, visibility: 'hidden', zIndex: 60 }}
    >
      <PetSprite
        clockKey={pokedAt ?? undefined}
        // While it walks (the roam's run), it faces the way it goes; standing, the state's own yaw.
        facing={state === 'run' ? roamDir : 0}
        label={t.commandCenter.pets.label(pet.name)}
        onClick={onClick}
        pet={pet}
        readable
        scale={scale}
        state={state}
        style={{ cursor: 'pointer', pointerEvents: 'none' }}
      />
    </div>
  )
}
