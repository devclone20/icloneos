// Test helper: every bundled pet, decoded synchronously (the app loads them lazily).
import { decodePetFile } from './pet-catalog'
import type { DecodedPet } from './pet-draw'

const FILES = import.meta.glob<Parameters<typeof decodePetFile>[0]>('../../../../../iclone/pets/*/*.json', {
  eager: true,
  import: 'default'
})

export const TEST_PETS: readonly DecodedPet[] = Object.values(FILES).map(decodePetFile)

export const testPet = (id: string): DecodedPet => {
  const pet = TEST_PETS.find(p => p.id === id)

  if (!pet) {
    throw new Error(`no bundled pet ${id}`)
  }

  return pet
}
