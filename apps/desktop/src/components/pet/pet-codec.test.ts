import { describe, expect, it } from 'vitest'

import {
  base64ToBytes,
  bytesToBase64,
  decodePetCells,
  encodePetCells,
  PET_CODEC,
  TILE_INK,
  TILE_NONE
} from './pet-codec'

const RAW = import.meta.glob<string>('../../../../../iclone/pets/*/*.json', {
  eager: true,
  import: 'default',
  query: '?raw'
})

const CATALOG = import.meta.glob<string>('../../../../../iclone/pets/CATALOG.json', {
  eager: true,
  import: 'default',
  query: '?raw'
})

interface BundledPet {
  v: number
  id: string
  name: string
  legion: string
  w: number
  h: number
  yaws: number
  front: number
  codec: string
  data: string
  paint: Record<'c' | 'm' | 'p', null | string>
}

const pets = Object.entries(RAW).map(([path, text]) => ({ path, text, pet: JSON.parse(text) as BundledPet }))

function lcg(seed: number) {
  let x = seed >>> 0

  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0

    return x / 4294967296
  }
}

describe('pet codec', () => {
  it('round-trips arbitrary tile kinds exactly (noise, runs, edges)', () => {
    const rnd = lcg(7)
    const w = 13
    const h = 9
    const n = 5
    const cells = new Uint8Array(w * h * n)

    for (let i = 0; i < cells.length; i++) {
      cells[i] = i % 17 < 6 ? Math.floor(rnd() * 6) : i % 3 === 0 ? TILE_INK : TILE_NONE
    }

    const coded = encodePetCells(cells, w, h, n)
    expect(decodePetCells(coded, w, h, n)).toEqual(cells)
    expect(decodePetCells(base64ToBytes(bytesToBase64(coded)), w, h, n)).toEqual(cells)
  })

  it('base64 matches the platform encoder for every length mod 3', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 256]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255)
      const ref = btoa(String.fromCharCode(...bytes))
      expect(bytesToBase64(bytes)).toBe(ref)
      expect(base64ToBytes(ref)).toEqual(bytes)
    }
  })

  it('rejects a tile kind outside 0–5 and a wrong cell count', () => {
    expect(() => encodePetCells(Uint8Array.of(6), 1, 1, 1)).toThrow(/out of range/)
    expect(() => encodePetCells(new Uint8Array(3), 2, 2, 1)).toThrow(/tiles for/)
  })
})

describe('the bundled pets (iclone/pets)', () => {
  it('holds the 20 approved pets, 7 play · 7 death · 6 god, each ≤ 8 KB', () => {
    expect(pets).toHaveLength(20)
    const byLegion = (legion: string) => pets.filter(p => p.pet.legion === legion).length
    expect([byLegion('play'), byLegion('death'), byLegion('god')]).toEqual([7, 7, 6])

    for (const { path, text, pet } of pets) {
      expect(new TextEncoder().encode(text).length, path).toBeLessThanOrEqual(8192)
      expect(path.endsWith(`/${pet.legion}/${pet.id}.json`)).toBe(true)
      expect(pet.name).toBe(`#${pet.id.slice(1)}`)
    }
  })

  it('decodes every pet: 24 yaws of 39 × 64, ink in every yaw, the figure inside 63 × 69', () => {
    for (const { pet } of pets) {
      expect(pet.codec).toBe(PET_CODEC)
      expect([pet.w, pet.h, pet.yaws]).toEqual([39, 64, 24])
      const cells = decodePetCells(base64ToBytes(pet.data), pet.w, pet.h, pet.yaws)
      const N = pet.w * pet.h

      for (let k = 0; k < pet.yaws; k++) {
        const cell = cells.subarray(k * N, (k + 1) * N)
        expect(
          cell.some(kind => kind === TILE_INK),
          `${pet.id} yaw ${k}`
        ).toBe(true)
        expect(cell.every(kind => kind <= 5)).toBe(true)
      }
    }
  })

  it('lists the same 20 in CATALOG.json, legion order play · death · god', () => {
    const catalog = JSON.parse(Object.values(CATALOG)[0]!) as {
      legions: string[]
      pets: { legion: string; id: string; name: string; plate: string }[]
    }

    expect(catalog.legions).toEqual(['play', 'death', 'god'])
    expect(catalog.pets.map(p => `${p.legion}/${p.id}`).sort()).toEqual(
      pets.map(p => `${p.pet.legion}/${p.pet.id}`).sort()
    )

    for (const entry of catalog.pets) {
      const pet = pets.find(p => p.pet.id === entry.id)!.pet
      expect(entry.plate).toBe(pet.paint.p)
      expect(entry.name).toBe(pet.name)
    }
  })
})
