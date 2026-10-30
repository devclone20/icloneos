// Child process of the `fs.read_dir` row: the real directory reader of the project tree (electron/fs-read-dir.ts).
// Prints one JSON line. Electron is replaced by an inert stub (nothing on the timed path imports it).
import '../lib/ts-hook.mjs'

import fs from 'node:fs'
import path from 'node:path'

import { writeResult } from '../lib/child_result.mjs'

const args = JSON.parse(process.argv[2] ?? '{}')
const tree = args.tree
const SHAPE = { top: 100, sub: 10, files: 100 } // 100 x 10 x 100 = 100 000 files in 1 100 folders

if (args.generate) {
  for (let a = 0; a < SHAPE.top; a += 1) {
    for (let b = 0; b < SHAPE.sub; b += 1) {
      const dir = path.join(tree, `pkg${a}`, `mod${b}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let c = 0; c < SHAPE.files; c += 1) fs.writeFileSync(path.join(dir, `file${c}.ts`), '')
    }
  }
  writeResult(args.result, { generated: SHAPE.top * SHAPE.sub * SHAPE.files })
  process.exit(0)
}

const { readDirForIpc } = await import(new URL('../../apps/desktop/electron/fs-read-dir.ts', import.meta.url).href)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const slowFs = ms => ({
  ...fs,
  promises: { ...fs.promises, readdir: async (...a) => (await sleep(ms), fs.promises.readdir(...a)) }
})
const hr = () => performance.now()

// A full walk through the same per-folder reader the project tree calls (one IPC read per folder), 16 folders in flight.
async function walk(root, options = {}) {
  const queue = [root]
  let files = 0
  let dirs = 0
  const visit = async dir => {
    const { entries, error } = await readDirForIpc(dir, options)
    if (error) throw new Error(`readDirForIpc ${error}`)
    dirs += 1
    for (const entry of entries) entry.isDirectory ? queue.push(entry.path) : (files += 1)
  }
  // Seed with one folder so the workers have something to share.
  await visit(queue.shift())
  const worker = async () => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) await visit(dir)
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  if (files !== 100_000 || dirs !== 1_101) throw new Error(`walk saw ${files} files in ${dirs} folders`)
  return { files, dirs }
}
const timed = async (options = {}) => {
  const t = hr()
  await walk(tree, options)
  return hr() - t
}

if (args.control) {
  // Interleaved base / delayed walks in one process: each readdir sleeps `injectMs` through the reader's fs seam.
  await timed()
  const base = []
  const variant = []
  for (let i = 0; i < 3; i += 1) {
    base.push(await timed())
    variant.push(await timed({ fs: slowFs(args.injectMs) }))
  }
  writeResult(args.result, { base, variant })
  process.exit(0)
}

const cold = await timed()
const warm = []
for (let i = 0; i < Number(args.warm ?? 2); i += 1) warm.push(await timed())

// Incremental: one new file in a 100-file folder, then the one re-read the tree does for that folder.
const target = path.join(tree, 'pkg7', 'mod3')
const incremental = []
for (let i = 0; i < Number(args.n ?? 50); i += 1) {
  const file = path.join(target, `added-${process.pid}-${i}.ts`)
  fs.writeFileSync(file, '')
  const s = hr()
  const { entries } = await readDirForIpc(target)
  incremental.push(hr() - s)
  if (!entries.some(entry => entry.path.endsWith(path.basename(file)))) throw new Error('new file not seen')
  fs.rmSync(file)
}
writeResult(args.result, { cold, warm, incremental })
process.exit(0)
