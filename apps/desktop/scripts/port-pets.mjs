#!/usr/bin/env node
// Port the owner-approved pixel pets from the owner's pet library into the bundle (V3-P §1.1).
//
//   node scripts/port-pets.mjs                 write iclone/pets/<legion>/<id>.json + iclone/pets/CATALOG.json
//   node scripts/port-pets.mjs --check         rebuild in memory and fail if the bundle differs (or a file is over 8 KB)
//   node scripts/port-pets.mjs --from <dir>    read the library's pets/ from <dir> (default: $ICLONE_PETS_FROM)
//
// Source: `<library>/pets/<legion>/sprites/<id>.json` (39 × 64, 24 yaws, the library's token cells deflated). The
// library's place on the owner's machine is private (ruling 48): it comes from ICLONE_PETS_FROM or --from, never from here.
// Each pet is reduced to the tile kind present() draws per pixel and re-coded with the app's own codec
// (src/components/pet/pet-codec.ts, imported here as TypeScript: Node strips the types), then decoded again and
// compared tile for tile against the source before anything is written. Re-runnable: the output is a pure function
// of the source, so a second run writes the same bytes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import {
  base64ToBytes,
  bytesToBase64,
  decodePetCells,
  encodePetCells,
  PET_CODEC
} from '../src/components/pet/pet-codec.ts'

const DESK = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(DESK, '..', '..', 'iclone', 'pets')
const DEFAULT_FROM = process.env.ICLONE_PETS_FROM ?? ''
const MAX_BYTES = 8 * 1024

/** The 20 pets the owner approved, legion by legion, in the library READMEs' order. */
export const PET_ROSTER = {
  play: ['n2', 'n37', 'n87', 'n162', 'n217', 'n1952', 'n1007'],
  death: ['n16', 'n56', 'n161', 'n181', 'n196', 'n151', 'n136'],
  god: ['n30', 'n445', 'n715', 'n255', 'n250', 'n1405']
}

const HEX6 = /^#[0-9a-f]{6}$/i
const CLASS_KEY = [null, 'm', 'p', 'c']

/** The library's v3 cell (2 bpp rows ‖ 2 bpp classes) → the tile kinds present() draws. */
function tileKinds(sprite) {
  const { w, h } = sprite
  const n = sprite.yaws | 0
  const bytes = inflateSync(Buffer.from(sprite.blob, 'base64'))
  const N = w * h
  const size = Math.ceil(N / 4)
  const cellBytes = 2 * size

  if (sprite.bpp === 4 || !n || bytes.length < n * cellBytes) {
    throw new Error(`${sprite.id}: not a v3 sprite of ${n} cells (${bytes.length} bytes)`)
  }

  const paint = CLASS_KEY.map(k => {
    const name = k && sprite.classes?.[k]
    const hex = name && sprite[name]

    return typeof hex === 'string' && HEX6.test(hex) ? hex.toLowerCase() : null
  })

  const kinds = new Uint8Array(N * n)

  for (let k = 0; k < n; k++) {
    const off = k * cellBytes

    for (let i = 0; i < N; i++) {
      const sh = (i & 3) * 2
      const raw = (bytes[off + (i >> 2)] >> sh) & 3
      const code = raw === 3 ? 0 : raw
      const cls = (bytes[off + size + (i >> 2)] >> sh) & 3
      let kind = 0

      if (code === 1) {
        kind = cls === 2 && paint[2] ? 2 : 1
      } else if (code === 2 && cls > 0 && paint[cls]) {
        kind = 2 + cls
      }

      kinds[k * N + i] = kind
    }
  }

  return { kinds, n, paint }
}

function portOne(from, legion, id) {
  const sprite = JSON.parse(readFileSync(join(from, legion, 'sprites', `${id}.json`), 'utf8'))

  if (sprite.id !== id || sprite.w !== 39 || sprite.h !== 64) {
    throw new Error(`${legion}/${id}: expected a 39 × 64 sprite named ${id}`)
  }

  const { kinds, n, paint } = tileKinds(sprite)
  const coded = encodePetCells(kinds, sprite.w, sprite.h, n)
  const data = bytesToBase64(coded)
  const back = decodePetCells(base64ToBytes(data), sprite.w, sprite.h, n)

  for (let i = 0; i < kinds.length; i++) {
    if (back[i] !== kinds[i]) {
      throw new Error(`${legion}/${id}: round trip differs at tile ${i}`)
    }
  }

  const pet = {
    v: 1,
    id,
    name: sprite.name,
    legion,
    w: sprite.w,
    h: sprite.h,
    yaws: n,
    front: sprite.front | 0,
    thumb: sprite.thumb | 0,
    paint: { m: paint[1], p: paint[2], c: paint[3] },
    codec: PET_CODEC,
    data
  }

  const text = `${JSON.stringify(pet)}\n`

  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw new Error(`${legion}/${id}: ${Buffer.byteLength(text)} bytes, over the ${MAX_BYTES}-byte budget`)
  }

  return { pet, text }
}

function build(from) {
  const files = new Map()
  const catalog = { v: 1, legions: Object.keys(PET_ROSTER), pets: [] }

  for (const [legion, ids] of Object.entries(PET_ROSTER)) {
    for (const id of ids) {
      const { pet, text } = portOne(from, legion, id)
      files.set(join(legion, `${id}.json`), text)
      catalog.pets.push({ legion, id, name: pet.name, plate: pet.paint.p, accent: pet.paint.m })
    }
  }

  files.set('CATALOG.json', `${JSON.stringify(catalog, null, 2)}\n`)

  return files
}

function main(argv) {
  const check = argv.includes('--check')
  const fromAt = argv.indexOf('--from')
  const from = fromAt >= 0 ? argv[fromAt + 1] : DEFAULT_FROM

  if (!from || !existsSync(from)) {
    console.error('[port-pets] the pet library is not found (set ICLONE_PETS_FROM or pass --from <dir>)')

    return 2
  }

  const files = build(from)
  let drift = 0

  for (const [rel, text] of files) {
    const path = join(OUT, rel)

    if (check) {
      const have = existsSync(path) ? readFileSync(path, 'utf8') : null

      if (have !== text) {
        console.error(`[port-pets] ${rel} differs from the library`)
        drift++
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
  }

  const sizes = [...files].filter(([rel]) => rel !== 'CATALOG.json').map(([, text]) => Buffer.byteLength(text))
  console.log(
    `[port-pets] ${sizes.length} pets, ${Math.min(...sizes)}–${Math.max(...sizes)} bytes each, ${sizes.reduce((a, b) => a + b, 0)} total${check ? (drift ? `, ${drift} drifted` : ', in sync') : ' written'}`
  )

  return drift ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
