/**
 * K101 — the pet facts the app needs before anyone has chosen a pet: the catalogue rows (20 short ones), whether an id
 * is a pet, and the scale snap. The message stream reaches these through `store/pet` on every start; the codec, the
 * drawing code and the sprite stay out of the boot bundle until a pet is shown.
 */
import CATALOG_JSON from '../../../../../iclone/pets/CATALOG.json'

type PetLegion = 'death' | 'god' | 'play'

export interface PetCatalogEntry {
  legion: PetLegion
  id: string
  name: string
  plate: string
  accent: null | string
}

export const PET_LEGIONS: readonly PetLegion[] = ['play', 'death', 'god']

export const PET_CATALOG: readonly PetCatalogEntry[] = (CATALOG_JSON.pets as PetCatalogEntry[]).filter(entry =>
  PET_LEGIONS.includes(entry.legion)
)

export const isPetId = (id: unknown): id is string => typeof id === 'string' && PET_CATALOG.some(p => p.id === id)

export const PET_SCALE_MIN = 1
export const PET_SCALE_MAX = 3

/** A user scale snapped to the whole numbers the pets are drawn at (1 tile = 1 CSS px × scale). */
export const snapPetScale = (scale: unknown): number =>
  typeof scale === 'number' && Number.isFinite(scale)
    ? Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(scale)))
    : PET_SCALE_MIN
