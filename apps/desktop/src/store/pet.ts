import { atom, computed } from 'nanostores'

import { isPetId, snapPetScale } from '@/components/pet/pet-ids'
import type { PetState } from '@/components/pet/pet-states'
import { persistBoolean, persistString, storedBoolean, storedString } from '@/lib/storage'
import { $busy } from '@/store/session'
import { $attentionSessionIds } from '@/store/session-states'

/**
 * The pixel pet (V3-P): which robot, how big, whether it roams — and what it is
 * doing. App-native: the collection ships in the bundle, the choice lives in
 * this device's storage (`hermes.desktop.pet.v3.*`), and the state is derived
 * from the activity signals the chat already tracks. No gateway call anywhere.
 */

// ── what the agent is doing ─────────────────────────────────────────────────

export interface PetActivity {
  busy?: boolean
  awaitingInput?: boolean
  toolRunning?: boolean
  reasoning?: boolean
  error?: boolean
  justCompleted?: boolean
  celebrate?: boolean
}

/**
 * Resolve the animation state from the activity signals. Priority (highest
 * first): error → celebrate → justCompleted → awaitingInput → toolRunning →
 * reasoning → busy → idle. `awaitingInput` (a clarify/approval blocking on the
 * user) outranks the in-flight signals: the turn is paused on you, not working.
 */
export function derivePetState(activity: PetActivity): PetState {
  if (activity.error) {
    return 'failed'
  }

  if (activity.celebrate) {
    return 'jump'
  }

  if (activity.justCompleted) {
    return 'wave'
  }

  if (activity.awaitingInput) {
    return 'waiting'
  }

  if (activity.toolRunning) {
    return 'run'
  }

  if (activity.reasoning) {
    return 'review'
  }

  if (activity.busy) {
    return 'run'
  }

  return 'idle'
}

export const $petActivity = atom<PetActivity>({})

/** Steady activity flags (toolRunning / reasoning) set and cleared by the message stream. */
export const setPetActivity = (next: Partial<PetActivity>) => $petActivity.set({ ...$petActivity.get(), ...next })

let flashTimer: ReturnType<typeof setTimeout> | undefined

/**
 * A transient beat (error / celebrate / justCompleted) that decays after `ms`. Each beat first clears its siblings
 * so a stale one cannot win the priority race (a clean finish must not render the failed pose of an earlier error).
 */
export const flashPetActivity = (next: Partial<PetActivity>, ms = 1600) => {
  // No pet chosen: no beat, no timer (the owner's rule: nothing of the pet runs until one is chosen). The steady flags
  // a beat settles (a finished turn clears run/review) still settle, so a turn run before a pet was chosen cannot leak
  // its run/review pose into the next turn.
  if (!$petEnabled.get()) {
    const steady: Partial<PetActivity> = {}

    if (next.reasoning !== undefined) {
      steady.reasoning = next.reasoning
    }

    if (next.toolRunning !== undefined) {
      steady.toolRunning = next.toolRunning
    }

    if (Object.keys(steady).length) {
      setPetActivity(steady)
    }

    return
  }

  setPetActivity({ celebrate: false, error: false, justCompleted: false, ...next })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => setPetActivity({ celebrate: false, error: false, justCompleted: false }), ms)
}

/** A fresh gateway connection has no turn in flight: drop the steady flags a dropped socket may have stranded. */
export const resetPetActivity = () => setPetActivity({ reasoning: false, toolRunning: false })

/** "A turn finished while you were away" — the unread marker on the pet; cleared when you come back. */
export const $petUnread = atom(false)

export const markPetUnread = () => {
  if ($petEnabled.get()) {
    $petUnread.set(true)
  }
}

export const clearPetUnread = () => $petUnread.set(false)

/**
 * The activity as the pet reads it: the stream's flags, `busy` from the chat when the stream has not said, and
 * `awaitingInput` whenever a session is parked on the user (a clarify / approval). Steady flags only count mid-turn,
 * so an interrupted turn cannot pin the pet on run/review.
 */
export const $petLiveActivity = computed(
  [$petActivity, $busy, $attentionSessionIds],
  (activity, busy, attention): PetActivity => {
    const live = activity.busy ?? busy

    return {
      awaitingInput: Boolean(activity.awaitingInput) || attention.length > 0,
      busy: live,
      celebrate: activity.celebrate,
      error: activity.error,
      justCompleted: activity.justCompleted,
      reasoning: live && activity.reasoning,
      toolRunning: live && activity.toolRunning
    }
  }
)

// ── the roam ────────────────────────────────────────────────────────────────

/** The pose the roam loop drives: `run` while walking, `jump` while hopping or falling, null at rest. */
export const $petMotion = atom<null | PetState>(null)

/** Travel direction while roaming: −1 left, 1 right, 0 still. */
export const $petRoamDir = atom<-1 | 0 | 1>(0)

/** Whether the agent-driven state is plain idle: the roam waits on this, never on `$petState` (its own pose). */
export const $petAtRest = computed($petLiveActivity, activity => derivePetState(activity) === 'idle')

/** The live state. Activity always wins; at rest, the roam's pose shows through. */
export const $petState = computed([$petLiveActivity, $petMotion], (activity, motion): PetState => {
  const base = derivePetState(activity)

  return base === 'idle' && motion ? motion : base
})

// ── the user's choice (this device) ─────────────────────────────────────────

export const PET_STORAGE_KEYS = {
  roam: 'hermes.desktop.pet.v3.roam',
  scale: 'hermes.desktop.pet.v3.scale',
  /** The chosen pet's id. Absent = no pet: nothing of the pet is mounted anywhere (the owner's rule). */
  selected: 'hermes.desktop.pet.v3.selected'
} as const

/** The stored choice, if it still names a pet of the collection. A stale id (a pet the catalogue no longer has) is
 *  dropped: the app falls back to the no-pet state, never to a crash or a stand-in pet. */
function storedSelection(): null | string {
  const id = storedString(PET_STORAGE_KEYS.selected)

  if (id !== null && !isPetId(id)) {
    persistString(PET_STORAGE_KEYS.selected, null)

    return null
  }

  return id
}

/** The chosen pet, or null: the default. Nothing renders, runs or listens for the pet until one is chosen. */
export const $petId = atom<null | string>(storedSelection())
export const $petEnabled = computed($petId, id => id !== null)
export const $petScale = atom<number>(snapPetScale(Number(storedString(PET_STORAGE_KEYS.scale) ?? 1)))
export const $petRoam = atom<boolean>(storedBoolean(PET_STORAGE_KEYS.roam, false))

/** Choose a pet from the library: it enters the scene at once. Unknown ids are refused. */
export function choosePet(id: string): boolean {
  if (!isPetId(id)) {
    return false
  }

  if ($petId.get() !== id) {
    persistString(PET_STORAGE_KEYS.selected, id)
    $petId.set(id)
  }

  return true
}

/** Remove the pet: back to the no-pet state (the pop-out closes and everything of the pet unmounts). */
export function removePet(): void {
  // Persist on change only: with no pet there is nothing to forget (a fresh profile writes no pet key at all).
  if ($petId.get() === null) {
    return
  }

  persistString(PET_STORAGE_KEYS.selected, null)
  $petId.set(null)
}

/** Set the scale: always a whole number 1–3 (1 tile = 1 CSS px × scale). Persisted on change only. */
export function setPetScale(scale: number): number {
  const next = snapPetScale(scale)

  if (next !== $petScale.get()) {
    $petScale.set(next)
    persistString(PET_STORAGE_KEYS.scale, String(next))
  }

  return next
}

/** The zoom gesture's step: one whole scale per wheel notch, up to grow, down to shrink. */
export const nextPetScaleFromWheel = (scale: number, deltaY: number): number =>
  snapPetScale(scale + (deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0))

export function setPetRoam(on: boolean): void {
  if (on !== $petRoam.get()) {
    $petRoam.set(on)
    persistBoolean(PET_STORAGE_KEYS.roam, on)
  }
}
