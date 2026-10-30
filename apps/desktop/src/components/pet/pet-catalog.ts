/**
 * The pet collection: the catalogue (bundled eagerly — 20 short rows) and the
 * sprites (one lazy chunk each, decoded once and kept). The collection is the
 * app's own (`iclone/pets`, written by `scripts/port-pets.mjs`): no backend,
 * no network.
 */

import { useEffect, useState } from 'react'

import { base64ToBytes, decodePetCells, PET_CODEC } from './pet-codec'
import { boxOf, type DecodedPet } from './pet-draw'
import { PET_CATALOG } from './pet-ids'
import { petSeed } from './pet-states'

interface PetFileJson {
  v: number
  id: string
  name: string
  legion: string
  w: number
  h: number
  yaws: number
  codec: string
  data: string
  paint: { c: null | string; m: null | string; p: null | string }
}

const LOADERS = import.meta.glob<PetFileJson>('../../../../../iclone/pets/*/*.json', { import: 'default' })

const loaderFor = (id: string) => {
  const entry = PET_CATALOG.find(p => p.id === id)

  return entry ? LOADERS[`../../../../../iclone/pets/${entry.legion}/${id}.json`] : undefined
}

const HEX6 = /^#[0-9a-f]{6}$/i

const rgb = (hex: null | string): null | readonly number[] =>
  typeof hex === 'string' && HEX6.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) : null

/** A bundled pet file → the decoded pet the renderer draws. Throws on a file the codec does not know. */
export function decodePetFile(file: PetFileJson): DecodedPet {
  if (file.v !== 1 || file.codec !== PET_CODEC) {
    throw new Error(`pet ${file.id}: unknown format ${file.v}/${file.codec}`)
  }

  const cells = decodePetCells(base64ToBytes(file.data), file.w, file.h, file.yaws)
  const N = file.w * file.h

  return {
    boxes: Array.from({ length: file.yaws }, (_, k) => boxOf(cells, k * N, file.w, file.h)),
    cells,
    h: file.h,
    id: file.id,
    legion: file.legion,
    name: file.name,
    paint: { c: rgb(file.paint.c), m: rgb(file.paint.m), p: rgb(file.paint.p) },
    seed: petSeed(file.id),
    w: file.w,
    yaws: file.yaws
  }
}

const decoded = new Map<string, DecodedPet>()
const pending = new Map<string, Promise<DecodedPet | null>>()

/** The decoded pet if it is already loaded (synchronous: the renderer's hot path). */
const loadedPet = (id: string): DecodedPet | null => decoded.get(id) ?? null

/** Load and decode a pet once; null for an id the collection does not have. */
export function loadPet(id: string): Promise<DecodedPet | null> {
  const hit = decoded.get(id)

  if (hit) {
    return Promise.resolve(hit)
  }

  const inflight = pending.get(id)

  if (inflight) {
    return inflight
  }

  const loader = loaderFor(id)

  if (!loader) {
    return Promise.resolve(null)
  }

  const job = loader()
    .then(file => {
      const pet = decodePetFile(file)
      decoded.set(id, pet)

      return pet
    })
    .catch(() => null)
    .finally(() => pending.delete(id))

  pending.set(id, job)

  return job
}

/** The decoded pet for `id`, or null while it loads (or for an unknown id). */
export function usePet(id: null | string): DecodedPet | null {
  const [pet, setPet] = useState<DecodedPet | null>(() => (id ? loadedPet(id) : null))

  useEffect(() => {
    if (!id) {
      setPet(null)

      return
    }

    const ready = loadedPet(id)

    if (ready) {
      setPet(ready)

      return
    }

    let alive = true
    setPet(null)
    void loadPet(id).then(next => {
      if (alive) {
        setPet(next)
      }
    })

    return () => {
      alive = false
    }
  }, [id])

  return pet && pet.id === id ? pet : null
}
