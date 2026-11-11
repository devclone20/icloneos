/**
 * v0.0.7 CF7 (I4) — the resident tree model (hardlinks-tree.ts) against the truth, by property: after a random
 * sequence of changes to a real folder tree (files written, folders made, removed, renamed, hard links planted and
 * removed, listings locked), `applyDirty` with exactly the folders those changes touched, then `walkIncremental`,
 * each leave (when they stand) records equal to a fresh full walk and a summary equal to the full fold of those
 * records. A verdict that does not stand leaves the records as they were (I2). Many seeds, a small PRNG, no
 * randomness the test cannot replay (the seed is in the failure).
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  type Dirent,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type DirRecord,
  oneVolume,
  sameLinked,
  scanOf,
  type TreeRecords,
  TreeScanFold,
  TreeState,
  UNSTATABLE,
  walkTree
} from './hardlinks-walk'

const tops: string[] = []

afterEach(() => {
  for (const top of tops.splice(0)) {
    // Locked folders (T1 cases) may have moved since: unlock everything by walking, then remove.
    execFileSync('/bin/chmod', ['-R', 'u+rwx', top])
    rmSync(top, { recursive: true, force: true })
  }
})

/** mulberry32: a replayable PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0

    let t = a

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function world(seed: number) {
  const top = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cf7-tree-')))
  const root = path.join(top, 'project')
  const outside = path.join(top, 'outside')
  const rand = prng(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]

  tops.push(top)
  mkdirSync(outside)

  for (let index = 0; index < 6; index += 1) {
    writeFileSync(path.join(outside, `o${index}`), `o${index}`)
  }

  const dirs = [root]

  for (let index = 0; index < 24; index += 1) {
    // The first three sit under the root (the links below name them); the rest anywhere.
    const dir = path.join(index < 3 ? root : pick(dirs), `d${index}`)

    mkdirSync(dir, { recursive: true })
    dirs.push(dir)
    writeFileSync(path.join(dir, `f${index}`), 'x')
  }

  // Two inside-only links and one outside link from the start: the fold has groups to keep right.
  linkSync(path.join(root, 'd0', 'f0'), path.join(root, 'd1', 'l0'))
  linkSync(path.join(outside, 'o0'), path.join(root, 'd2', 'l1'))

  return { root, outside, rand, pick, locked: [] as string[] }
}

const liveDirs = (root: string): string[] => {
  const out: string[] = []
  const stack = [root]

  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    out.push(dir)

    let entries: Dirent[]

    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name))
      }
    }
  }

  return out
}

/** One random change to the tree; returns the folders a change like it dirties (FSEvents names the parent of a
 *  changed entry, and a changed folder itself). */
function mutate(w: ReturnType<typeof world>, step: number): { kind: number; dir: string; dirty: string[] } {
  const dirs = liveDirs(w.root)
  const dir = w.pick(dirs)
  const kind = Math.floor(w.rand() * 8)

  return { kind, dir, dirty: change(w, step, dirs, dir, kind) }
}

const under = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

function change(w: ReturnType<typeof world>, step: number, dirs: string[], dir: string, kind: number): string[] {
  try {
    switch (kind) {
      case 0: {
        writeFileSync(path.join(dir, `n${step}`), 'n')

        return [dir]
      }

      case 1: {
        const sub = path.join(dir, `s${step}`)

        mkdirSync(sub)
        writeFileSync(path.join(sub, 'inner'), 'i')

        return [dir, sub]
      }

      case 2: {
        // A locked folder inside would stop the removal half way: an untracked change this test never makes.
        if (dir === w.root || w.locked.some(locked => under(locked, dir))) {
          return []
        }

        rmSync(dir, { recursive: true, force: true })

        return [path.dirname(dir), dir]
      }

      case 3: {
        if (dir === w.root) {
          return []
        }

        const to = path.join(w.pick(dirs.filter(d => !under(d, dir))), `m${step}`)

        renameSync(dir, to)
        // Locked folders inside move with it (the removal guard above reads this list).
        w.locked.splice(
          0,
          w.locked.length,
          ...w.locked.map(locked => (under(locked, dir) ? path.join(to, path.relative(dir, locked)) : locked))
        )

        return [path.dirname(dir), dir, path.dirname(to), to]
      }

      case 4: {
        linkSync(path.join(w.outside, `o${step % 6}`), path.join(dir, `ol${step}`))

        return [dir]
      }

      case 5: {
        const files = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile())

        if (files.length === 0) {
          return []
        }

        const file = path.join(dir, w.pick(files).name)
        const target = w.pick(dirs)

        linkSync(file, path.join(target, `il${step}`))

        return [dir, target]
      }

      case 6: {
        const files = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile())

        if (files.length === 0) {
          return []
        }

        unlinkSync(path.join(dir, w.pick(files).name))

        return [dir]
      }

      default: {
        if (dir === w.root) {
          return []
        }

        // A folder whose listing fails (T1): unscannable until unlocked; the parent's ctime did not move, the
        // folder's own did.
        chmodSync(dir, 0o000)
        w.locked.push(dir)

        return [dir]
      }
    }
  } catch {
    return []
  }
}

const truth = async (root: string) => (await walkTree(root, null)).records

/** Records equal, whole (the same listings, link counts included). */
const sameTree = (a: TreeRecords, b: TreeRecords, why = '') => {
  const plain = (records: TreeRecords) =>
    [...records]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([dir, record]) => [dir, record === UNSTATABLE ? record : { ...(record as DirRecord) }])

  expect(plain(a), why).toEqual(plain(b))
}

/** Records equal in STRUCTURE: the same folders, identities, subfolders, file counts and unscannable flags. A re-list
 *  of the dirty folders alone leaves the link counts of names in untouched folders as they were read (a stale count
 *  only ever sends the tree to the full scan: the V-1 rule), so the links are the fold's to judge, below. */
const sameStructure = (a: TreeRecords, b: TreeRecords, why = '') => {
  const plain = (records: TreeRecords) =>
    [...records]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([dir, record]) =>
        record === UNSTATABLE
          ? [dir, record]
          : [
              dir,
              {
                dev: record.dev,
                ino: record.ino,
                subdirs: record.subdirs,
                files: record.files,
                unscannable: record.unscannable
              }
            ]
      )

  expect(plain(a), why).toEqual(plain(b))
}

sameTree.equal = (a: TreeRecords, b: TreeRecords): boolean =>
  a.size === b.size && [...a].every(([dir, record]) => b.get(dir) === record)

/** I4: the incremental fold answers exactly as a full fold of the same records. */
const foldAgrees = (state: TreeState, why: string) => {
  const records = state.dump()

  expect(state.scan(), why).toEqual(scanOf(records))
  expect(state.oneVolume(), why).toBe(oneVolume(state.root, records))
}

describe('CF7 (I4): the incremental tree equals a full walk and the full fold, over random change sets', () => {
  const SEEDS = 40
  const STEPS = 14

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`seed ${seed}: applyDirty then walkIncremental, ${STEPS} random changes`, async () => {
      const w = world(seed)
      const state = new TreeState(w.root, await truth(w.root))

      expect(state.scan()).toEqual(scanOf(await truth(w.root)))

      for (let step = 0; step < STEPS; step += 1) {
        const { kind, dir, dirty } = mutate(w, step)
        const why = `seed ${seed} step ${step}: kind ${kind} on ${path.relative(w.root, dir) || '.'} dirty ${JSON.stringify(dirty.map(d => path.relative(w.root, d)))}`
        const before = state.dump()
        const beforeScan = state.scan()
        const verdict = await state.applyDirty(dirty)
        const now = await truth(w.root)
        const expected = scanOf(now)

        foldAgrees(state, why)

        if (verdict.placed && verdict.stands) {
          // Stood: the tree's structure is the truth's, the linked set is the one before (the standing rule), and
          // only a tree that did not move keeps an unscannable folder (the cached refusal, as walk-cached did).
          sameStructure(state.dump(), now, why)
          expect(sameLinked(state.scan().linked, beforeScan.linked), why).toBe(true)
          expect(verdict.cached || state.scan().unscannable.length === 0, why).toBe(true)
          expect(verdict).toMatchObject({ files: expected.files, dirs: expected.dirs })
          expect(verdict.cached, why).toBe(dirty.length === 0 || sameTree.equal(state.dump(), before))
        } else {
          // Did not stand (or could not place): nothing changed (I2).
          // Not standing may be conservative (a link count read with an untouched name is stale until a full
          // scan: the V-1 rule), so the truth is not asserted here; the walk below reaches it.
          sameTree(state.dump(), before, why)
          expect(state.scan(), why).toEqual(beforeScan)
        }

        // The incremental walk then: when it stands, the structure is the truth's; else a full scan decides (the
        // guard replaces the tree) and the fresh fold is the truth's own.
        const stoodBefore = verdict.placed && verdict.stands
        const walked = await state.walkIncremental()

        foldAgrees(state, why)

        if (walked.placed && walked.stands) {
          sameStructure(state.dump(), now, why)
          expect(walked.cached, why).toBe(stoodBefore)
        } else {
          const fresh = new TreeState(w.root, now)

          expect(fresh.scan(), why).toEqual(expected)
          Object.assign(state, fresh)
        }
      }
    }, 30_000)
  }

  it('the fold’s add and remove are exact inverses: any order of removals leaves the fold of what remains', () => {
    const rand = prng(7)
    const records: TreeRecords = new Map()

    for (let index = 0; index < 60; index += 1) {
      const links = Array.from({ length: Math.floor(rand() * 3) }, (_item, n) => ({
        name: `l${n}`,
        dev: 1,
        ino: 100 + Math.floor(rand() * 8),
        nlink: 2 + Math.floor(rand() * 2),
        ctimeMs: Math.floor(rand() * 1000)
      }))

      records.set(`/r/d${index}`, {
        dev: BigInt(1 + (index % 7 === 0 ? 1 : 0)),
        ino: BigInt(index),
        mtimeNs: 0n,
        ctimeNs: 0n,
        subdirs: [],
        files: Math.floor(rand() * 5),
        links,
        unscannable: index % 11 === 0
      })
    }

    records.set('/r/u', UNSTATABLE)

    const fold = new TreeScanFold()

    for (const [dir, record] of records) {
      fold.add(dir, record)
    }

    const keys = [...records.keys()].sort(() => rand() - 0.5)

    for (const key of keys.slice(0, 40)) {
      fold.remove(key, records.get(key) as DirRecord | typeof UNSTATABLE)
      records.delete(key)
      expect(fold.scan()).toEqual(scanOf(records))
    }
  })
})
