import { atom } from 'nanostores'

import { petPromptId, type PetPromptReply, petPromptText } from '@/iclone-shared/pet-prompt'
import { persistBoolean, persistString, storedBoolean, storedString } from '@/lib/storage'
import {
  $petActivity,
  $petEnabled,
  $petId,
  $petLiveActivity,
  $petScale,
  $petUnread,
  clearPetUnread,
  type PetActivity,
  setPetScale
} from '@/store/pet'

/**
 * The pop-out pet (main-renderer side). Shift-clicking the in-window pet moves it into a transparent,
 * always-on-top OS window (electron/pet-overlay.ts) that can leave the app and stays visible while it is
 * minimised. That window carries NO gateway connection: this renderer stays the single source of truth and
 * pushes the pet's state to it over IPC; the overlay answers with a few control messages (pop back in, open the
 * app, it moved, it was zoomed, a message typed into its prompt box).
 */

export interface PetOverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * `screen`: the bounds are already screen coordinates (a remembered spot) rather than this window's viewport.
 * `anchor`: where the pet stands (its feet, bottom-centre) in this window's viewport — main converts it with this
 * window's UI zoom, so the overlay (drawn at zoom 1) puts the pet's feet exactly there (R4-F1).
 */
export interface PetOverlayOpenRequest {
  bounds: PetOverlayBounds
  screen?: boolean
  anchor?: { x: number; y: number }
}

/** Everything the overlay needs to draw the very same pet. */
export interface PetOverlayStatePayload {
  petId: string
  scale: number
  activity: PetActivity
  unread: boolean
  /** The app's language, so the overlay's bubble speaks it (the overlay has no config access). */
  locale: string
}

export type PetOverlayControl =
  | { type: 'bounds'; bounds: PetOverlayBounds }
  | { type: 'open-app' }
  | { type: 'pop-in' }
  | { type: 'ready' }
  | { type: 'scale'; scale: number }
  | { type: 'submit'; id: number; text: string }
  | { type: 'toggle-app' }

export const PET_OVERLAY_STORAGE_KEYS = {
  active: 'hermes.desktop.pet.v3.overlay',
  bounds: 'hermes.desktop.pet.v3.overlay-bounds'
} as const

export const $petOverlayActive = atom(storedBoolean(PET_OVERLAY_STORAGE_KEYS.active, false))

// Persisted on change only (`listen`, not `subscribe`): loading this module on a fresh profile writes nothing.
$petOverlayActive.listen(active => persistBoolean(PET_OVERLAY_STORAGE_KEYS.active, active))

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function isOverlayBounds(value: unknown): value is PetOverlayBounds {
  const b = value as Partial<PetOverlayBounds> | null

  return Boolean(b) && finite(b!.x) && finite(b!.y) && finite(b!.width) && finite(b!.height)
}

function loadSavedBounds(): null | PetOverlayBounds {
  try {
    const parsed: unknown = JSON.parse(storedString(PET_OVERLAY_STORAGE_KEYS.bounds) ?? 'null')

    return isOverlayBounds(parsed) ? parsed : null
  } catch {
    return null
  }
}

const saveBounds = (bounds: PetOverlayBounds) => persistString(PET_OVERLAY_STORAGE_KEYS.bounds, JSON.stringify(bounds))

// The overlay window pads the pet so its bubble or prompt box (above) and the drag margin fit; the rest is
// transparent and click-through. 208 px wide: the prompt box (192) with its margin.
const OVERLAY_PAD_X = 96
const OVERLAY_PAD_Y = 72
const OVERLAY_MIN_W = 208
const OVERLAY_MIN_H = 140
/** The overlay stands the pet this far above its window's bottom edge (a drag margin under its feet). */
export const OVERLAY_PET_PAD_BOTTOM = 12

/** The overlay window's size for a pet of `petW × petH` CSS px: the single source for the pop-out and the zoom. */
export function overlayWindowSize(petW: number, petH: number): { width: number; height: number } {
  return {
    height: Math.max(OVERLAY_MIN_H, Math.round(petH + OVERLAY_PAD_Y)),
    width: Math.max(OVERLAY_MIN_W, Math.round(petW + OVERLAY_PAD_X))
  }
}

let localeOf: () => string = () => 'en'
let stateUnsubs: (() => void)[] = []
let controlUnsub: (() => void) | null = null
let openAppHandler: (() => void) | null = null
let submitHandler: PetPromptHandler | null = null

export function currentOverlayPayload(): PetOverlayStatePayload {
  return {
    activity: {
      ...$petActivity.get(),
      awaitingInput: $petLiveActivity.get().awaitingInput,
      busy: $petLiveActivity.get().busy
    },
    locale: localeOf(),
    petId: $petId.get() ?? '',
    scale: $petScale.get(),
    unread: $petUnread.get()
  }
}

const pushNow = () => window.hermesDesktop?.petOverlay?.pushState(currentOverlayPayload())

function openOverlay(request: PetOverlayOpenRequest): void {
  const api = window.hermesDesktop?.petOverlay

  if (!api || stateUnsubs.length) {
    return
  }

  $petOverlayActive.set(true)
  void api.open(request).then(
    res => {
      if (!res?.ok) {
        // It did not open (it failed, or the remembered spot is off every display): the pet comes back into the
        // window, and the spot main reset onto the primary display (if any) is the one remembered from now on.
        fallBackIn(res?.bounds)

        return
      }

      if (res.bounds && isOverlayBounds(res.bounds)) {
        saveBounds(res.bounds)
      }

      pushNow()
    },
    () => fallBackIn(null)
  )

  // subscribe() fires at once, so the overlay gets a first frame the moment it says it is ready.
  stateUnsubs = [$petLiveActivity, $petActivity, $petId, $petScale, $petUnread, $petEnabled].map(store =>
    store.subscribe(() => {
      if (!$petEnabled.get()) {
        popInPet()

        return
      }

      pushNow()
    })
  )
}

/** The pop-out did not open: stop mirroring, show the in-window pet again, and fix (or forget) the remembered spot. */
function fallBackIn(reset: unknown): void {
  for (const off of stateUnsubs) {
    off()
  }

  stateUnsubs = []
  $petOverlayActive.set(false)

  if (isOverlayBounds(reset)) {
    saveBounds(reset)
  } else if (loadSavedBounds()) {
    persistString(PET_OVERLAY_STORAGE_KEYS.bounds, null)
  }
}

/**
 * Pop the pet out of the window. `petRect` is the in-window pet's viewport rect: the window is hung so the pet's feet
 * (bottom-centre) stay where they were — centred on it, the pet `OVERLAY_PET_PAD_BOTTOM` above the window's edge; main
 * converts viewport → screen with this window's zoom — or reopened where the user last left it.
 */
export function popOutPet(petRect: PetOverlayBounds): void {
  if ($petOverlayActive.get() || stateUnsubs.length || !$petEnabled.get() || !window.hermesDesktop?.petOverlay) {
    return
  }

  const saved = loadSavedBounds()

  if (saved) {
    openOverlay({ bounds: saved, screen: true })

    return
  }

  const { width, height } = overlayWindowSize(petRect.width, petRect.height)
  const anchor = { x: petRect.x + petRect.width / 2, y: petRect.y + petRect.height }

  openOverlay({
    anchor,
    bounds: {
      height,
      width,
      x: anchor.x - width / 2,
      y: anchor.y + OVERLAY_PET_PAD_BOTTOM - height
    },
    screen: false
  })
}

/** Reopen the overlay on boot if the pet was out when the app closed (needs a remembered spot). */
export function restorePetOverlay(): void {
  if (!window.hermesDesktop?.petOverlay || !$petOverlayActive.get() || stateUnsubs.length) {
    return
  }

  if (!$petEnabled.get()) {
    $petOverlayActive.set(false)

    return
  }

  const saved = loadSavedBounds()

  if (!saved) {
    $petOverlayActive.set(false)

    return
  }

  openOverlay({ bounds: saved, screen: true })
}

/** Pop the pet back into the window (closes the overlay window). A no-op when nothing is out: no IPC at all. */
export function popInPet(): void {
  if (!stateUnsubs.length && !$petOverlayActive.get()) {
    return
  }

  for (const off of stateUnsubs) {
    off()
  }

  stateUnsubs = []
  $petOverlayActive.set(false)
  void window.hermesDesktop?.petOverlay?.close()
}

export function setPetOverlayOpenAppHandler(fn: (() => void) | null): void {
  openAppHandler = fn
}

/** Sends a message typed into the overlay's prompt box and says what became of it (the pet's sender). */
/** Sends a prompt-box message; calls `handOff` (and awaits it) right before the text leaves for the session. */
type PetPromptHandler = (text: string, handOff: () => Promise<unknown>) => PetPromptReply | Promise<PetPromptReply>

/** Register the handler that sends a message typed into the overlay's prompt box. */
export function setPetOverlaySubmitHandler(fn: null | PetPromptHandler): void {
  submitHandler = fn
}

const NOT_SENT: PetPromptReply = { outcome: 'refused', reason: 'not-sent' }

/** Answer the overlay's submit `id` (through main, which checks it again). */
function replyToOverlay(id: number, reply: PetPromptReply): void {
  window.hermesDesktop?.petOverlay?.sendPromptResult({ ...reply, id })
}

export function setPetOverlayLocale(fn: () => string): void {
  localeOf = fn
}

/** Apply one control message from the overlay. Exported for the tests; the bridge below routes IPC here. */
export function handleOverlayControl(payload: unknown): void {
  const message = payload as Partial<PetOverlayControl> | null

  switch (message?.type) {
    case 'pop-in':
      popInPet()

      break

    case 'ready':
      pushNow()

      break

    case 'bounds':
      if (isOverlayBounds((message as { bounds?: unknown }).bounds)) {
        saveBounds((message as { bounds: PetOverlayBounds }).bounds)
      }

      break

    case 'scale':
      if (finite((message as { scale?: unknown }).scale)) {
        setPetScale((message as { scale: number }).scale)
      }

      break

    case 'open-app':
      clearPetUnread()
      openAppHandler?.()

      break
    case 'submit': {
      // Checked again on this side of the boundary: only with a pet, only a non-blank message within the cap. Every
      // submit with an id is answered — sent, queued, or refused — so the overlay never guesses and never drops text.
      const id = petPromptId((message as { id?: unknown }).id)
      const text = petPromptText((message as { text?: unknown }).text)
      const handler = submitHandler

      if (id === null) {
        break
      }

      if (text === null || !$petEnabled.get() || !handler) {
        replyToOverlay(id, NOT_SENT)

        break
      }

      let reply: Promise<PetPromptReply>
      // Main records the hand-off before the text leaves: a renderer lost after it is answered "may have been sent".
      const handOff = async () => window.hermesDesktop?.petOverlay?.promptHandoff?.(id)

      try {
        reply = Promise.resolve(handler(text, handOff))
      } catch {
        reply = Promise.resolve(NOT_SENT)
      }

      void reply.then(
        r => replyToOverlay(id, r),
        () => replyToOverlay(id, NOT_SENT)
      )

      break
    }

    default:
      break
  }
}

/** Wire the overlay → renderer control channel once (primary window). Returns a disposer. */
export function initPetOverlayBridge(): () => void {
  const api = window.hermesDesktop?.petOverlay

  if (!api || controlUnsub) {
    return () => {}
  }

  controlUnsub = api.onControl(handleOverlayControl)

  return () => {
    controlUnsub?.()
    controlUnsub = null
  }
}
