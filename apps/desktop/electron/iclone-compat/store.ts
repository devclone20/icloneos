// The verdict store (contract decision 5): every byte the engine writes lands under `<userData>/iclone-compat/`.
// Writes are atomic (temp file + rename) so a crash never leaves a half verdict for the gate to read.
import fs from 'node:fs'
import path from 'node:path'

import { readJsonFileSync, writeJsonAtomicSync } from '../lib/fs-json'

const STORE_DIR = 'iclone-compat'

export function storeRoot(userData: string): string {
  return path.join(path.resolve(userData), STORE_DIR)
}

export function storePath(root: string, rel: string): string {
  const base = path.resolve(root)
  const file = path.resolve(base, rel)
  const back = path.relative(base, file)

  if (path.basename(base) !== STORE_DIR || !back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`iclone-compat store: refused path ${rel}`)
  }

  return file
}

export function readStoreJson<T>(root: string, rel: string): T | null {
  return readJsonFileSync<T>(storePath(root, rel))
}

export function writeStoreJson(root: string, rel: string, value: unknown): string {
  const file = storePath(root, rel)
  writeJsonAtomicSync(file, value, { space: 1 })

  return file
}

export function appendLine(root: string, rel: string, value: unknown): string {
  const file = storePath(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)

  return file
}
