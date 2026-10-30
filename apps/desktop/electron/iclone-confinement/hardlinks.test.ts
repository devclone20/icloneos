/**
 * V3-G F7 — the pre-start scan for hard links to outside inodes, its cache, the fail-closed answer to a directory it
 * cannot list (r3 T1), the owner's one-gesture-per-directory acknowledgement (r3 T2) and the sealed key that signs
 * it (r3 T5). Real files in a temp dir: the link counts come from the file system, never from a stub.
 */
import { createHmac } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createHardlinkGuard,
  type HardlinkAuditEvent,
  hardlinkRefusal,
  pnpmStoreRoots,
  readHardlinkReportRoots,
  realStoreRoot,
  resolveInStore,
  scanTree,
  type SealedKeyStore,
  type StoreResolve,
  storeShaped
} from './hardlinks'
import { acceptableProjectRoot, realOrSelf } from './profiles'

const dirs: string[] = []
const restoreModes: string[] = []

function tree() {
  const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v3g-links-')))
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')

  dirs.push(root)

  for (const dir of [path.join(project, 'src', 'deep'), outside]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path.join(project, 'README.md'), 'inside\n')
  writeFileSync(path.join(outside, 'secret'), 'outside-secret\n')
  writeFileSync(path.join(outside, 'other'), 'outside-other\n')

  const scans: string[] = []
  const guard = createHardlinkGuard({ ackFile: path.join(root, 'acks.json'), onFullScan: dir => scans.push(dir) })

  return { root, project, outside, guard, scans }
}

/** `chmod 311`: traversable, not listable. The critic's MAJOR-1 shape. */
function hide(dir: string) {
  chmodSync(dir, 0o311)
  restoreModes.push(dir)
}

/** A pnpm-shaped store: `node_modules/.pnpm/<pkg>/index.js`, each a hard link into a store outside the project. */
function plantPnpm(project: string, outside: string, count: number, from = 0): string[] {
  const store = path.join(outside, 'store')
  const planted: string[] = []

  mkdirSync(store, { recursive: true })

  for (let i = from; i < from + count; i += 1) {
    const pkg = path.join(project, 'node_modules', '.pnpm', `pkg${i}`)
    const target = path.join(store, `blob${i}`)

    mkdirSync(pkg, { recursive: true })
    writeFileSync(target, `blob ${i}\n`)
    linkSync(target, path.join(pkg, 'index.js'))
    planted.push(path.join(pkg, 'index.js'))
  }

  return planted
}

/** A stand-in for Electron's safeStorage: one secret per store, so a blob sealed by another store does not open. */
function keyStore(secret = 'app-keychain'): SealedKeyStore & { calls: string[] } {
  const calls: string[] = []

  return {
    calls,
    seal(key) {
      calls.push('seal')

      return `${secret}:${key.toString('base64')}`
    },
    open(sealed) {
      calls.push('open')

      const [who, blob] = sealed.split(':')

      if (who !== secret) {
        throw new Error('not sealed by this keychain')
      }

      return Buffer.from(blob, 'base64')
    }
  }
}

/** A pnpm store under its own root (the fixture's `~/Library/pnpm`), and a guard that resolves into it. */
function storeWorld(storeBudgetMs?: number) {
  const world = tree()
  const storeRoot = path.join(world.root, 'Library', 'pnpm')
  const resolves: StoreResolve[] = []

  const guard = createHardlinkGuard({
    ackFile: path.join(world.root, 'acks.json'),
    storeRoots: [storeRoot],
    storeBudgetMs,
    onStoreResolve: (_root, result) => resolves.push(result)
  })

  // 300 store files; 200 of them linked into node_modules/.pnpm (each inode: store name + project name = nlink 2).
  const files = path.join(storeRoot, 'store', 'v3', 'files')

  mkdirSync(files, { recursive: true })

  for (let i = 0; i < 300; i += 1) {
    writeFileSync(path.join(files, `h${i}`), `blob ${i}\n`)
  }

  const planted: string[] = []

  for (let i = 0; i < 200; i += 1) {
    const pkg = path.join(world.project, 'node_modules', '.pnpm', `pkg${i}`)

    mkdirSync(pkg, { recursive: true })
    linkSync(path.join(files, `h${i}`), path.join(pkg, 'index.js'))
    planted.push(path.join(pkg, 'index.js'))
  }

  return { ...world, guard, storeRoot, files, planted, resolves }
}

afterEach(() => {
  for (const dir of restoreModes.splice(0)) {
    chmodSync(dir, 0o755)
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('F7 — the scan', () => {
  it('finds a planted link to an outside inode and names its inside path', () => {
    const { outside, project } = tree()

    linkSync(path.join(outside, 'secret'), path.join(project, 'src', 'deep', 'planted'))

    const scan = scanTree(project)

    expect(scan.linked.map(inode => inode.paths)).toEqual([[path.join(project, 'src', 'deep', 'planted')]])
    expect(scan.linked[0].nlink).toBe(2)
    expect(scan.unscannable).toEqual([])
  })

  it('an inode whose every name is inside the project is the project’s own', () => {
    const { project } = tree()

    linkSync(path.join(project, 'README.md'), path.join(project, 'src', 'README.copy'))

    expect(scanTree(project).linked).toEqual([])
  })

  it('refuses with a sentence naming at most three paths and the rest as a count', () => {
    const { guard, outside, project } = tree()

    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(path.join(outside, `s-${name}`), name)
      linkSync(path.join(outside, `s-${name}`), path.join(project, name))
    }

    const result = guard.check(project)

    expect(result.ok).toBe(false)

    if (result.ok) {
      return
    }

    expect(result.block).toMatchObject({
      root: project,
      kind: 'hard-links',
      paths: ['a', 'b', 'c'].map(name => path.join(project, name)),
      count: 4
    })
    expect(result.block.groups).toHaveLength(1)
    expect(result.block.groups[0]).toMatchObject({ dir: project, count: 4 })
    expect(hardlinkRefusal(result.block)).toBe(
      `confinement refused to start in ${project}: ${['a', 'b', 'c'].map(name => path.join(project, name)).join(', ')} and 1 more are hard links to a file outside the project; remove them or allow them in Containers`
    )
  })
})

describe('F7 r3 T1 — a directory the scan cannot list is a refusal, never "nothing to scan"', () => {
  it('chmod 311 on a folder hiding a link: refused as cannot-scan, naming the folder; readable again, the link is found', () => {
    const { guard, outside, project } = tree()
    const hidden = path.join(project, 'hidden')

    mkdirSync(hidden)
    linkSync(path.join(outside, 'secret'), path.join(hidden, 'x'))
    hide(hidden)

    // The critic's premise: the link is readable through the unlistable folder (traversal needs only x).
    expect(readFileSync(path.join(hidden, 'x'), 'utf8')).toBe('outside-secret\n')

    const result = guard.check(project)

    expect(result).toMatchObject({
      ok: false,
      block: { root: project, kind: 'cannot-scan', paths: [hidden], count: 1 }
    })

    if (!result.ok) {
      expect(result.block.groups).toEqual([])
      expect(hardlinkRefusal(result.block)).toBe(
        `confinement refused to start in ${project}: cannot scan ${hidden} (a directory it cannot list); fix its permissions`
      )
    }

    // The cached answer stays a refusal while nothing changed.
    expect(guard.check(project)).toMatchObject({ ok: false, cached: true, block: { kind: 'cannot-scan' } })

    chmodSync(hidden, 0o755)
    expect(guard.check(project)).toMatchObject({
      ok: false,
      cached: false,
      block: { kind: 'hard-links', paths: [path.join(hidden, 'x')], count: 1 }
    })
  })

  it('an unlistable folder with nothing in it is refused all the same: the scan cannot know', () => {
    const { guard, project } = tree()
    const empty = path.join(project, 'src', 'empty')

    mkdirSync(empty)
    hide(empty)
    expect(guard.check(project)).toMatchObject({ ok: false, block: { kind: 'cannot-scan', paths: [empty] } })
  })

  it('a folder that vanished between two steps is nothing to scan (not a refusal)', () => {
    const { guard, project } = tree()

    rmSync(path.join(project, 'src', 'deep'), { recursive: true })
    expect(guard.check(project).ok).toBe(true)
    expect(scanTree(path.join(project, 'never-was')).unscannable).toEqual([])
  })

  it('cannot-scan has no group to allow: the gesture answers nothing-to-allow until the folder is readable', () => {
    const { guard, outside, project } = tree()
    const hidden = path.join(project, 'hidden')

    mkdirSync(hidden)
    linkSync(path.join(outside, 'secret'), path.join(hidden, 'x'))
    hide(hidden)
    expect(guard.acknowledgeGroup(project, hidden, 'anything')).toEqual({ ok: false, reason: 'nothing-to-allow' })
    expect(guard.acknowledgeGroup(project, project, 'anything')).toEqual({ ok: false, reason: 'nothing-to-allow' })
    expect(guard.acks()).toEqual([])
  })
})

describe('F7 r4 T1′ — a folder that lists but hides its link counts is a refusal too (the critic’s chmod 400 / 600)', () => {
  it.each([0o400, 0o600])(
    'chmod %o on a folder hiding a link: cannot-scan naming the folder (and what it hides); x back, the link is found',
    mode => {
      const { guard, outside, project } = tree()
      const hidden = path.join(project, 'hidden')

      mkdirSync(path.join(hidden, 'sub'), { recursive: true })
      linkSync(path.join(outside, 'secret'), path.join(hidden, 'x'))
      chmodSync(hidden, mode)
      restoreModes.push(hidden)

      // The premise: the folder lists (r), its children do not stat (no x): the link count is invisible, and a
      // confined writer may give x back (file-write-mode is inside the project's file-write*).
      expect(readdirSync(hidden).sort()).toEqual(['sub', 'x'])
      expect(() => lstatSync(path.join(hidden, 'x'))).toThrow(/EACCES/)

      const result = guard.check(project)
      const sub = path.join(hidden, 'sub')

      expect(result).toMatchObject({
        ok: false,
        cached: false,
        block: { root: project, kind: 'cannot-scan', paths: [hidden, sub], count: 2, groups: [] }
      })
      expect(scanTree(project).unscannable).toEqual([hidden, sub])
      expect(guard.check(project)).toMatchObject({ ok: false, cached: true, block: { kind: 'cannot-scan' } })
      expect(guard.acknowledgeGroup(project, hidden, 'anything')).toEqual({ ok: false, reason: 'nothing-to-allow' })

      chmodSync(hidden, 0o755)
      expect(guard.check(project)).toMatchObject({
        ok: false,
        cached: false,
        block: { kind: 'hard-links', paths: [path.join(hidden, 'x')], count: 1 }
      })
    }
  )

  it('a 400 folder with only ordinary files in it is refused all the same: the scan cannot know', () => {
    const { guard, project } = tree()
    const plain = path.join(project, 'src', 'plain')

    mkdirSync(plain)
    writeFileSync(path.join(plain, 'a.txt'), 'a\n')
    chmodSync(plain, 0o400)
    restoreModes.push(plain)
    expect(guard.check(project)).toMatchObject({ ok: false, block: { kind: 'cannot-scan', paths: [plain], count: 1 } })
  })
})

describe('F7 — the cache', () => {
  it('a repeat start with no change is answered from the cache, without a full scan', () => {
    const { guard, project, scans } = tree()

    expect(guard.check(project)).toMatchObject({ ok: true, cached: false })
    expect(guard.check(project)).toMatchObject({ ok: true, cached: true })
    expect(scans).toHaveLength(1)
  })

  it('a link planted deep in the tree after a clean start misses the cache and is refused', () => {
    const { guard, outside, project, scans } = tree()

    expect(guard.check(project).ok).toBe(true)
    linkSync(path.join(outside, 'secret'), path.join(project, 'src', 'deep', 'late'))
    expect(guard.check(project)).toMatchObject({ ok: false, cached: false })
    expect(scans).toHaveLength(2)
  })

  it('a link swapped in over an existing file (same name, same count) misses the cache', () => {
    const { guard, outside, project } = tree()

    expect(guard.check(project).ok).toBe(true)
    linkSync(path.join(outside, 'secret'), path.join(project, '.swap'))
    renameSync(path.join(project, '.swap'), path.join(project, 'README.md'))
    expect(guard.check(project)).toMatchObject({ ok: false, cached: false })
  })

  it('a link planted with the file count kept and the directory mtime put back still misses the cache (ctime)', () => {
    const { guard, outside, project } = tree()
    const dir = path.join(project, 'src')

    writeFileSync(path.join(dir, 'decoy'), 'd')
    utimesSync(dir, new Date(1_000_000), new Date(1_000_000))
    expect(guard.check(project).ok).toBe(true)
    rmSync(path.join(dir, 'decoy'))
    linkSync(path.join(outside, 'secret'), path.join(dir, 'sneaky'))
    utimesSync(dir, new Date(1_000_000), new Date(1_000_000))
    expect(guard.check(project)).toMatchObject({ ok: false, cached: false })
  })
})

describe('F7 r3 T2 — one gesture per inside directory group, recorded per inode', () => {
  it('500 pnpm-shaped links are one group under node_modules/.pnpm, with 3 samples; one gesture allows them all', () => {
    const { guard, outside, project } = tree()
    const planted = plantPnpm(project, outside, 500)
    const pnpm = path.join(project, 'node_modules', '.pnpm')

    const refused = guard.check(project)

    expect(refused.ok).toBe(false)

    if (refused.ok) {
      return
    }

    expect(refused.block.count).toBe(500)
    expect(refused.block.paths).toHaveLength(3)
    expect(refused.block.groups).toHaveLength(1)

    const [group] = refused.block.groups

    expect(group).toMatchObject({ dir: pnpm, count: 500 })
    expect(group.paths).toHaveLength(3)
    expect(group.paths.every(file => planted.includes(file))).toBe(true)
    expect(group.digest).toMatch(/^[0-9a-f]{16}$/)

    // Exactly one gesture.
    expect(guard.acknowledgeGroup(project, pnpm, group.digest)).toMatchObject({ ok: true, dir: pnpm, count: 500 })
    expect(guard.acks()).toHaveLength(500)
    expect(guard.check(project).ok).toBe(true)
  }, 30_000)

  it('the 501st link planted after the gesture asks again, on its own', () => {
    const { guard, outside, project } = tree()
    const pnpm = path.join(project, 'node_modules', '.pnpm')

    plantPnpm(project, outside, 500)

    const first = guard.check(project)

    if (first.ok) {
      throw new Error('expected a refusal')
    }

    expect(guard.acknowledgeGroup(project, pnpm, first.block.groups[0].digest).ok).toBe(true)
    expect(guard.check(project).ok).toBe(true)

    const [late] = plantPnpm(project, outside, 1, 500)
    const again = guard.check(project)

    expect(again).toMatchObject({
      ok: false,
      block: { count: 1, paths: [late], groups: [{ dir: path.join(pnpm, 'pkg500'), count: 1 }] }
    })
  }, 30_000)

  it('the gesture is bound to the set the pane showed: a link planted in between answers changed, allows nothing', () => {
    const { guard, outside, project } = tree()
    const pnpm = path.join(project, 'node_modules', '.pnpm')

    plantPnpm(project, outside, 5)

    const shown = guard.check(project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    plantPnpm(project, outside, 1, 5)
    expect(guard.acknowledgeGroup(project, pnpm, shown.block.groups[0].digest)).toEqual({
      ok: false,
      reason: 'changed'
    })
    expect(guard.acks()).toEqual([])
    expect(guard.check(project)).toMatchObject({ ok: false, block: { count: 6 } })
  })

  it('groups: one per top-level entry, deepened to where the links fan out; files in the root are their own group', () => {
    const { guard, outside, project } = tree()

    plantPnpm(project, outside, 3)
    linkSync(path.join(outside, 'secret'), path.join(project, 'src', 'deep', 'planted'))
    linkSync(path.join(outside, 'other'), path.join(project, 'top-level'))

    const result = guard.check(project)

    if (result.ok) {
      throw new Error('expected a refusal')
    }

    expect(result.block.groups.map(group => [group.dir, group.count])).toEqual([
      [project, 1],
      [path.join(project, 'node_modules', '.pnpm'), 3],
      [path.join(project, 'src', 'deep'), 1]
    ])

    const src = result.block.groups[2]

    expect(guard.acknowledgeGroup(project, src.dir, src.digest)).toMatchObject({ ok: true, count: 1 })
    expect(guard.check(project)).toMatchObject({ ok: false, block: { count: 4 } })
  })

  it('allows exactly those inodes: a new inode at the same path asks again, another project is not covered', () => {
    const { guard, outside, project, root } = tree()
    const planted = path.join(project, 'planted')
    const second = path.join(root, 'second-project')

    mkdirSync(second)
    linkSync(path.join(outside, 'secret'), planted)
    linkSync(path.join(outside, 'secret'), path.join(second, 'planted'))

    const shown = guard.check(project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    expect(guard.acknowledgeGroup(project, project, shown.block.groups[0].digest)).toMatchObject({ ok: true })
    expect(guard.check(project).ok).toBe(true)
    expect(guard.check(second).ok).toBe(false)

    rmSync(planted)
    linkSync(path.join(outside, 'other'), planted)
    expect(guard.check(project)).toMatchObject({ ok: false, block: { paths: [planted], count: 1 } })
  })

  it('refuses a folder outside the root, a relative request, a wrong digest and a clean root', () => {
    const { guard, outside, project } = tree()

    expect(guard.acknowledgeGroup(project, outside, 'x')).toEqual({ ok: false, reason: 'not-in-project' })
    expect(guard.acknowledgeGroup(project, path.join(project, '..', 'outside'), 'x')).toEqual({
      ok: false,
      reason: 'not-in-project'
    })
    expect(guard.acknowledgeGroup('relative', 'also-relative', 'x')).toEqual({ ok: false, reason: 'invalid' })
    expect(guard.acknowledgeGroup(project, project, 'x')).toEqual({ ok: false, reason: 'nothing-to-allow' })

    linkSync(path.join(outside, 'secret'), path.join(project, 'planted'))
    expect(guard.acknowledgeGroup(project, project, 'not-the-digest')).toEqual({ ok: false, reason: 'changed' })
    expect(guard.acks()).toEqual([])
  })
})

describe('F7 r4 T2′′ — build alone passes a link whose other names all resolve into the pnpm store; every other class asks', () => {
  it('a pnpm fixture in build: 0 gestures, the run is clean, every store inode passed and nothing recorded', () => {
    const { guard, project, resolves } = storeWorld()

    expect(guard.check(project, 'build')).toMatchObject({ ok: true, cached: false, passed: 200 })
    expect(resolves).toHaveLength(1)
    expect(resolves[0]).toMatchObject({ timedOut: false, files: 300 })
    expect(resolves[0].passed.size).toBe(200)
    expect(guard.acks()).toEqual([])
    expect(guard.blocked()).toEqual([])
    // The cached tree keeps the resolved set: no second store walk.
    expect(guard.check(project, 'build')).toMatchObject({ ok: true, cached: true, passed: 200 })
    expect(resolves).toHaveLength(1)
  })

  it('the same fixture in project, offline, research, media and with no class: 1 group, 1 gesture, no store walk', () => {
    const { guard, project, resolves } = storeWorld()

    for (const cls of ['project', 'offline', 'research', 'media', undefined] as const) {
      const result = guard.check(project, cls)

      expect(result.ok, cls ?? 'none').toBe(false)

      if (!result.ok) {
        expect(result.block).toMatchObject({ kind: 'hard-links', count: 200 })
        expect(result.block.groups).toHaveLength(1)
        expect(result.block.groups[0]).toMatchObject({ dir: path.join(project, 'node_modules', '.pnpm'), count: 200 })
      }
    }

    expect(resolves).toEqual([])
    // Build still passes the same cached tree afterwards, and the gesture path is untouched by it.
    expect(guard.check(project, 'build')).toMatchObject({ ok: true, passed: 200 })
    expect(guard.check(project, 'project')).toMatchObject({ ok: false, block: { count: 200 } })
  })

  it('a link into a NON-store root is a gesture in build too, named alone next to the passed ones', () => {
    const { guard, outside, project, resolves } = storeWorld()
    const planted = path.join(project, 'node_modules', '.pnpm', 'pkg0', 'secret.js')

    linkSync(path.join(outside, 'secret'), planted)

    const result = guard.check(project, 'build')

    expect(result).toMatchObject({ ok: false, block: { kind: 'hard-links', paths: [planted], count: 1 } })
    expect(resolves[0].passed.size).toBe(200)
    expect(guard.check(project, 'project')).toMatchObject({ ok: false, block: { count: 201 } })
  })

  it('an inode with a third name outside the store (store + project + elsewhere) still asks: every name must be accounted for', () => {
    const { guard, files, outside, project } = storeWorld()

    // h0 gets a third name under outside: 1 in the project + 1 in the store = 2 of nlink 3.
    linkSync(path.join(files, 'h0'), path.join(outside, 'h0-elsewhere'))

    const result = guard.check(project, 'build')

    expect(result).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [path.join(project, 'node_modules', '.pnpm', 'pkg0', 'index.js')], count: 1 }
    })
  })

  it('the resolve past its budget passes nothing: the gesture stands', () => {
    const { guard, project, resolves } = storeWorld(0)

    expect(guard.check(project, 'build')).toMatchObject({ ok: false, block: { kind: 'hard-links', count: 200 } })
    expect(resolves).toHaveLength(1)
    expect(resolves[0]).toMatchObject({ timedOut: true })
    expect(resolves[0].passed.size).toBe(0)
  })

  it('a store root that cannot be read resolves nothing; no store roots at all means no auto-pass', () => {
    const { guard, project, storeRoot } = storeWorld()

    chmodSync(storeRoot, 0o000)
    restoreModes.push(storeRoot)
    expect(guard.check(project, 'build')).toMatchObject({ ok: false, block: { count: 200 } })

    const { guard: bare, project: bareProject } = tree()
    const bareStore = path.join(path.dirname(bareProject), 'Library', 'pnpm')

    mkdirSync(bareStore, { recursive: true })
    writeFileSync(path.join(bareStore, 'blob'), 'b\n')
    mkdirSync(path.join(bareProject, 'node_modules'))
    linkSync(path.join(bareStore, 'blob'), path.join(bareProject, 'node_modules', 'blob'))
    expect(bare.check(bareProject, 'build')).toMatchObject({ ok: false, block: { count: 1 } })
  })

  it('resolveInStore counts names per inode and never follows a symlink or an unreadable directory', () => {
    const { files, outside, planted, storeRoot } = storeWorld()
    const scan = scanTree(path.dirname(path.dirname(path.dirname(planted[0]))))

    // A symlink inside the store to the outside secret is not a name of anything.
    linkSync(path.join(outside, 'secret'), path.join(path.dirname(planted[0]), 'secret.js'))
    renameSync(path.join(files, 'h299'), path.join(storeRoot, 'moved'))

    const result = resolveInStore([storeRoot], scanTree(path.dirname(path.dirname(path.dirname(planted[0])))).linked)

    expect(scan.linked).toHaveLength(200)
    expect(result.passed.size).toBe(200)
    expect(result.timedOut).toBe(false)
    expect(resolveInStore([path.join(storeRoot, 'never')], scan.linked).passed.size).toBe(0)
  })

  it('pnpmStoreRoots: the two pnpm homes under home and an absolute $PNPM_HOME; never /, home or an ancestor', () => {
    const home = '/Users/x'

    expect(pnpmStoreRoots(undefined, home)).toEqual(['/Users/x/Library/pnpm', '/Users/x/.local/share/pnpm'])
    expect(pnpmStoreRoots('/opt/pnpm', home)).toEqual([
      '/Users/x/Library/pnpm',
      '/Users/x/.local/share/pnpm',
      '/opt/pnpm'
    ])
    expect(pnpmStoreRoots('/Users/x/Library/pnpm', home)).toHaveLength(2)
    expect(pnpmStoreRoots('relative/pnpm', home)).toHaveLength(2)

    for (const bad of ['/', '/Users', '/Users/x']) {
      expect(pnpmStoreRoots(bad, home)).toHaveLength(2)
    }
  })

  it('r5 MINOR-2: pnpmStoreRoots never names a denied directory, one inside a denied one, or one holding a denied one', () => {
    const home = '/Users/x'

    const denied = [
      '/Users/x/.ssh',
      '/Users/x/.gnupg',
      '/Users/x/Library/Keychains',
      '/Users/x/.hermes',
      '/Users/x/Library/Application Support/icloneOS'
    ]

    for (const bad of [
      '/Users/x/.ssh',
      '/Users/x/.ssh/store',
      '/Users/x/.gnupg',
      '/Users/x/.hermes',
      '/Users/x/.hermes/store/v3',
      '/Users/x/Library',
      '/Users/x/Library/Keychains',
      '/Users/x/Library/Application Support',
      '/Users/x/Library/Application Support/icloneOS'
    ]) {
      expect(pnpmStoreRoots(bad, home, denied), bad).toEqual(['/Users/x/Library/pnpm', '/Users/x/.local/share/pnpm'])
    }

    expect(pnpmStoreRoots('/opt/pnpm', home, denied)).toEqual([
      '/Users/x/Library/pnpm',
      '/Users/x/.local/share/pnpm',
      '/opt/pnpm'
    ])
    // The defaults go through the same sieve.
    expect(pnpmStoreRoots(undefined, home, ['/Users/x/.local/share/pnpm'])).toEqual(['/Users/x/Library/pnpm'])
    expect(pnpmStoreRoots(undefined, home, ['/Users/x/Library'])).toEqual(['/Users/x/.local/share/pnpm'])
  })
})

describe('F7 r5 MINOR-2 — a store root has the pnpm store shape, or it is no store', () => {
  it('storeShaped: store/v<N> as a real directory under a real store, or a root named …/store/v<N>; nothing else', () => {
    const { outside, root } = tree()
    const shaped = path.join(root, 'shaped')
    const bare = path.join(root, 'bare')
    const wrongName = path.join(root, 'wrong-name')
    const linkedStore = path.join(root, 'linked-store')
    const linkedVersion = path.join(root, 'linked-version')

    mkdirSync(path.join(shaped, 'store', 'v10'), { recursive: true })
    mkdirSync(bare, { recursive: true })
    writeFileSync(path.join(bare, 'id_ed25519'), 'not a key\n')
    mkdirSync(path.join(wrongName, 'store', 'vx'), { recursive: true })
    writeFileSync(path.join(wrongName, 'store', 'v3'), 'a file, not a directory\n')
    mkdirSync(linkedStore, { recursive: true })
    symlinkSync(path.join(shaped, 'store'), path.join(linkedStore, 'store'))
    mkdirSync(path.join(linkedVersion, 'store'), { recursive: true })
    symlinkSync(path.join(shaped, 'store', 'v10'), path.join(linkedVersion, 'store', 'v10'))

    expect(storeShaped(shaped)).toBe(true)
    expect(storeShaped(path.join(shaped, 'store', 'v10'))).toBe(true)
    expect(storeShaped('/Volumes/x/pnpm/store/v3')).toBe(true)
    expect(storeShaped(bare)).toBe(false)
    expect(storeShaped(outside)).toBe(false)
    expect(storeShaped(wrongName)).toBe(false)
    expect(storeShaped(linkedStore)).toBe(false)
    expect(storeShaped(linkedVersion)).toBe(false)
    expect(storeShaped(path.join(root, 'never'))).toBe(false)
    expect(storeShaped(path.join(shaped, 'store'))).toBe(false)
  })

  it('both ways: a $PNPM_HOME-shaped root without the store layout passes nothing in build (the gesture stands); with it, the same link passes', () => {
    const { project, root } = tree()
    const pnpmHome = path.join(root, 'pnpm-home')
    const planted = path.join(project, 'node_modules', 'blob.js')
    const resolves: StoreResolve[] = []

    const guardOn = (ackFile: string) =>
      createHardlinkGuard({
        ackFile: path.join(root, ackFile),
        storeRoots: [pnpmHome],
        onStoreResolve: (_root, result) => resolves.push(result)
      })

    mkdirSync(path.join(pnpmHome, 'files'), { recursive: true })
    writeFileSync(path.join(pnpmHome, 'files', 'blob'), 'blob\n')
    mkdirSync(path.dirname(planted), { recursive: true })
    linkSync(path.join(pnpmHome, 'files', 'blob'), planted)

    expect(realStoreRoot(pnpmHome)).toBe(true)
    expect(storeShaped(pnpmHome)).toBe(false)
    expect(guardOn('a.json').check(project, 'build')).toMatchObject({
      ok: false,
      block: { paths: [planted], count: 1 }
    })
    expect(resolves[0]).toMatchObject({ files: 0 })

    mkdirSync(path.join(pnpmHome, 'store', 'v3'), { recursive: true })
    expect(storeShaped(pnpmHome)).toBe(true)
    expect(guardOn('b.json').check(project, 'build')).toMatchObject({ ok: true, passed: 1 })
    expect(resolves[1]).toMatchObject({ files: 1 })
  })
})

describe('F7 r5 MAJOR-1″ — a store root that is a symlink, or lies under one, is not the store: build asks', () => {
  it('the critic’s form: the absent ~/.local/share/pnpm made a symlink to ~/.hermes; a project link to .env asks in build and the walk enters nothing', () => {
    const { root } = tree()
    const home = path.join(root, 'home')
    const env = path.join(home, '.hermes', '.env')
    const project = path.join(home, 'proj')
    const absent = path.join(home, '.local', 'share', 'pnpm')
    const resolves: StoreResolve[] = []

    mkdirSync(path.join(home, '.hermes'), { recursive: true })
    writeFileSync(env, 'OPENAI_API_KEY=sk-not-real\n')
    // The real store exists, untouched; the absent one is created as a symlink: the one write the attacker needs.
    mkdirSync(path.join(home, 'Library', 'pnpm', 'store', 'v3'), { recursive: true })
    mkdirSync(path.dirname(absent), { recursive: true })
    symlinkSync(path.join(home, '.hermes'), absent)
    // The store's shape is one more mkdir for the same writer: it is not the boundary, the real root is.
    mkdirSync(path.join(home, '.hermes', 'store', 'v3'), { recursive: true })
    mkdirSync(path.join(project, 'node_modules'), { recursive: true })
    linkSync(env, path.join(project, 'node_modules', 'env.js'))

    const roots = pnpmStoreRoots(undefined, home)

    const guard = createHardlinkGuard({
      ackFile: path.join(root, 'acks.json'),
      storeRoots: roots,
      onStoreResolve: (_root, result) => resolves.push(result)
    })

    // The premise: main names that root, and listing it reaches the secret.
    expect(roots).toContain(absent)
    expect(readdirSync(absent)).toContain('.env')
    expect(realStoreRoot(absent)).toBe(false)
    expect(realStoreRoot(path.join(home, 'Library', 'pnpm'))).toBe(true)
    expect(guard.check(project, 'build')).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [path.join(project, 'node_modules', 'env.js')], count: 1 }
    })
    expect(resolves).toHaveLength(1)
    expect(resolves[0]).toMatchObject({ files: 0, timedOut: false })
    expect(resolves[0].passed.size).toBe(0)
  })

  it('the same inode: under a real store root it passes; with the root replaced by a symlink to the secrets folder it asks', () => {
    const { outside, project, root, storeRoot, files } = storeWorld()
    const secret = path.join(outside, 'secret')
    const planted = path.join(project, 'node_modules', '.pnpm', 'pkg0', 'secret.js')

    const guardOn = (ackFile: string) =>
      createHardlinkGuard({ ackFile: path.join(root, ackFile), storeRoots: [storeRoot] })

    // Control: the secret moved INTO the real store is store content (store name + project name = nlink 2): passes.
    renameSync(secret, path.join(files, 'secret'))
    linkSync(path.join(files, 'secret'), planted)
    expect(guardOn('real.json').check(project, 'build')).toMatchObject({ ok: true, passed: 201 })

    // The attack: the root itself is a symlink to where the secret lives. Listing it reaches the secret.
    renameSync(path.join(files, 'secret'), secret)
    rmSync(storeRoot, { recursive: true })
    symlinkSync(outside, storeRoot)
    mkdirSync(path.join(outside, 'store', 'v3'), { recursive: true })
    expect(readdirSync(storeRoot)).toContain('secret')

    const scan = scanTree(project)

    expect(scan.linked).toHaveLength(1)
    expect(resolveInStore([storeRoot], scan.linked)).toMatchObject({ files: 0, timedOut: false })
    expect(resolveInStore([storeRoot], scan.linked).passed.size).toBe(0)
    expect(guardOn('link.json').check(project, 'build')).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [planted], count: 1 }
    })
  })

  it('a root under a symlinked ancestor: lstat sees a real directory, realpath does not; ignored', () => {
    const { project, root } = tree()
    const real = path.join(root, 'real', 'pnpm')
    const viaLink = path.join(root, 'link', 'pnpm')
    const files = path.join(real, 'store', 'v3', 'files')
    const planted = path.join(project, 'node_modules', 'blob.js')

    mkdirSync(files, { recursive: true })
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    writeFileSync(path.join(files, 'blob'), 'blob\n')
    mkdirSync(path.dirname(planted), { recursive: true })
    linkSync(path.join(files, 'blob'), planted)

    expect(lstatSync(viaLink).isDirectory()).toBe(true)
    expect(realStoreRoot(viaLink)).toBe(false)
    expect(realStoreRoot(real)).toBe(true)

    const viaLinkGuard = createHardlinkGuard({ ackFile: path.join(root, 'a.json'), storeRoots: [viaLink] })
    const realGuard = createHardlinkGuard({ ackFile: path.join(root, 'b.json'), storeRoots: [real] })

    expect(viaLinkGuard.check(project, 'build')).toMatchObject({ ok: false, block: { paths: [planted], count: 1 } })
    expect(realGuard.check(project, 'build')).toMatchObject({ ok: true, passed: 1 })
  })

  it('a symlinked directory inside a real store is not entered: a link to what it points at still asks', () => {
    const { files, guard, outside, project, resolves } = storeWorld()
    const planted = path.join(project, 'node_modules', '.pnpm', 'pkg0', 'secret.js')

    symlinkSync(outside, path.join(files, 'elsewhere'))
    linkSync(path.join(outside, 'secret'), planted)
    expect(readdirSync(path.join(files, 'elsewhere'))).toContain('secret')

    expect(guard.check(project, 'build')).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [planted], count: 1 }
    })
    expect(resolves[0]).toMatchObject({ files: 300 })
    expect(resolves[0].passed.size).toBe(200)
  })

  it('realStoreRoot: a real directory is one; a symlink, a file, a missing path and a path under a symlink are not', () => {
    const { outside, root } = tree()

    symlinkSync(outside, path.join(root, 'to-outside'))
    expect(realStoreRoot(outside)).toBe(true)
    expect(realStoreRoot(path.join(root, 'to-outside'))).toBe(false)
    expect(realStoreRoot(path.join(root, 'to-outside', 'secret'))).toBe(false)
    expect(realStoreRoot(path.join(outside, 'secret'))).toBe(false)
    expect(realStoreRoot(path.join(root, 'never'))).toBe(false)
    unlinkSync(path.join(root, 'to-outside'))
  })
})

/** r6: a fake home with the agent's secret, the pnpm store at `Library/pnpm` and the secret hard-linked into it. */
function secretInStoreWorld() {
  const { root } = tree()
  const home = path.join(root, 'home')
  const env = path.join(home, '.hermes', '.env')
  const storeRoot = path.join(home, 'Library', 'pnpm')
  const files = path.join(storeRoot, 'store', 'v3', 'files')

  mkdirSync(path.dirname(env), { recursive: true })
  mkdirSync(files, { recursive: true })
  writeFileSync(env, 'OPENAI_API_KEY=sk-not-real\n')
  writeFileSync(path.join(files, 'legit'), 'blob\n')
  linkSync(env, path.join(files, 'evil-blob'))

  return { root, home, env, storeRoot, files }
}

describe('F7 r6 MAJOR-1‴ — the names of an inode are a set (project ∪ store), never a sum: no name counts twice', () => {
  it('the critic’s D3: the project IS the store root (or its store/v3); the secret linked into the store asks in every class', () => {
    const { root, env, storeRoot, files } = secretInStoreWorld()
    const guard = createHardlinkGuard({ ackFile: path.join(root, 'acks.json'), storeRoots: [storeRoot] })

    // The premise: one name in the "project" (the store), one outside it (the secret's own) — nlink 2.
    expect(lstatSync(env).nlink).toBe(2)

    for (const project of [storeRoot, path.join(storeRoot, 'store', 'v3')]) {
      for (const cls of ['build', 'project', 'offline', 'research', 'media'] as const) {
        expect(guard.check(project, cls), `${project} ${cls}`).toMatchObject({
          ok: false,
          block: { kind: 'hard-links', paths: [path.join(files, 'evil-blob')], count: 1 }
        })
      }
    }
  })

  it('the critic’s D4: the project HOLDS the store (a fake ~/.local/share with pnpm/store/v3); build asks', () => {
    const { root, home, env, files: libraryFiles } = secretInStoreWorld()
    const share = path.join(home, '.local', 'share')
    const storeRoot = path.join(share, 'pnpm')
    const files = path.join(storeRoot, 'store', 'v3', 'files')

    // Only this store holds the secret: its own name and the store's, nlink 2 (the sum counted the store name twice).
    unlinkSync(path.join(libraryFiles, 'evil-blob'))
    mkdirSync(files, { recursive: true })
    linkSync(env, path.join(files, 'evil-blob'))
    expect(lstatSync(env).nlink).toBe(2)

    const guard = createHardlinkGuard({ ackFile: path.join(root, 'acks.json'), storeRoots: [storeRoot] })

    expect(guard.check(share, 'build')).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [path.join(files, 'evil-blob')], count: 1 }
    })
    // A store file whose names are all under the project is the project's own, in every class.
    writeFileSync(path.join(files, 'own'), 'own\n')
    linkSync(path.join(files, 'own'), path.join(share, 'own-twin'))
    expect(guard.check(share, 'project')).toMatchObject({ ok: false, block: { count: 1 } })
  })

  it('the critic’s D1b: nested roots from $PNPM_HOME=…/Library/pnpm/store/v3 and one project link to a secret in the store: build asks', () => {
    const { root, home, env, storeRoot, files } = secretInStoreWorld()
    const project = path.join(home, 'proj')
    const roots = pnpmStoreRoots(path.join(storeRoot, 'store', 'v3'), home, [path.join(home, '.hermes')])

    mkdirSync(path.join(project, 'node_modules'), { recursive: true })
    linkSync(path.join(files, 'evil-blob'), path.join(project, 'node_modules', 'evil.js'))
    linkSync(path.join(files, 'legit'), path.join(project, 'node_modules', 'legit.js'))

    // The premise: the roots nest, and the secret has three names (its own, the store's, the project's).
    expect(roots).toEqual([storeRoot, path.join(home, '.local', 'share', 'pnpm'), path.join(storeRoot, 'store', 'v3')])
    expect(lstatSync(env).nlink).toBe(3)

    const resolves: StoreResolve[] = []

    const guard = createHardlinkGuard({
      ackFile: path.join(root, 'acks.json'),
      storeRoots: roots,
      onStoreResolve: (_root, result) => resolves.push(result)
    })

    expect(guard.check(project, 'build')).toMatchObject({
      ok: false,
      block: { kind: 'hard-links', paths: [path.join(project, 'node_modules', 'evil.js')], count: 1 }
    })
    // The legit blob passed, and the nested root walked no folder twice (2 store files, each met once).
    expect(resolves[0].passed.size).toBe(1)
    expect(resolves[0].files).toBe(2)
  })

  it('the same names reached by every spelling — nested roots, a duplicate, an alias of the folder — count once', () => {
    const { storeRoot, files, root } = secretInStoreWorld()
    const project = path.join(root, 'proj')

    mkdirSync(project)
    linkSync(path.join(files, 'evil-blob'), path.join(project, 'evil.js'))
    linkSync(path.join(files, 'legit'), path.join(project, 'legit.js'))

    const { linked } = scanTree(project)
    const alias = path.join('/System/Volumes/Data', storeRoot)
    const spellings = [[storeRoot], [storeRoot, storeRoot], [storeRoot, path.join(storeRoot, 'store', 'v3'), files]]

    if (existsSync(alias)) {
      spellings.push([storeRoot, alias])
    }

    for (const roots of spellings) {
      const result = resolveInStore(roots, linked)

      expect(result.passed.size, roots.join(' ')).toBe(1)
      expect(result.files, roots.join(' ')).toBe(2)
    }
  })

  it('a project that IS a store root, or lies inside one, is no project; a sibling is', () => {
    const { home, storeRoot } = secretInStoreWorld()
    const spec = { denied: [path.join(home, '.ssh')] }
    const share = path.join(home, '.local', 'share', 'pnpm')

    mkdirSync(path.join(share, 'store', 'v3', 'pkg'), { recursive: true })
    mkdirSync(path.join(home, 'proj'))

    expect(acceptableProjectRoot(path.join(home, 'proj'), spec, home, [storeRoot, share])).toBe(true)
    expect(acceptableProjectRoot(share, spec, home, [storeRoot, share])).toBe(false)
    expect(acceptableProjectRoot(path.join(share, 'store', 'v3', 'pkg'), spec, home, [storeRoot, share])).toBe(false)
    // Without the store roots (an older caller) the store folder was accepted: the parameter is what refuses it.
    expect(acceptableProjectRoot(share, spec, home)).toBe(true)

    const alias = path.join('/System/Volumes/Data', share)

    if (existsSync(alias)) {
      expect(acceptableProjectRoot(alias, spec, home, [share])).toBe(false)
    }
  })

  it('INFO-1: $PNPM_HOME naming an alias of a denied folder (firmlink form, case variant) is dropped like the folder itself', () => {
    const { home } = secretInStoreWorld()
    const hermes = path.join(home, '.hermes')

    mkdirSync(path.join(hermes, 'store', 'v3'), { recursive: true })

    const defaults = [path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm')]
    const firmlink = path.join('/System/Volumes/Data', hermes)
    const caseVariant = path.join(home, '.HERMES')
    const aliases = [firmlink, caseVariant].filter(alias => existsSync(alias))

    for (const alias of aliases) {
      expect(pnpmStoreRoots(alias, home, [hermes]), alias).toEqual(defaults)
    }

    // The firmlink form exists on every macOS data volume (the tmp dir lives there): the test is never vacuous there.
    if (process.platform === 'darwin') {
      expect(aliases).toContain(firmlink)
    }
  })
})

describe('F7 r3 T5 — the record is signed with one key sealed in safeStorage, or lives for this session only', () => {
  function forge(file: string, root: string, planted: string) {
    const body = JSON.stringify({ acks: [{ root, path: planted, dev: 1, ino: 1, at: 'forged' }] })

    writeFileSync(file, JSON.stringify({ v: 2, body, sig: createHmac('sha256', 'guess').update(body).digest('hex') }))
  }

  it('without safeStorage a forged record written while main is down is never read: 0 trusted, and overwritten', () => {
    const { outside, project, root } = tree()
    const ackFile = path.join(root, 'acks.json')
    const planted = path.join(project, 'planted')

    linkSync(path.join(outside, 'secret'), planted)
    forge(ackFile, project, planted)

    const guard = createHardlinkGuard({ ackFile })

    expect(guard.persistent()).toBe(false)
    expect(guard.acks()).toEqual([])
    expect(readFileSync(ackFile, 'utf8')).not.toContain('forged')
    expect(guard.check(project).ok).toBe(false)
  })

  it('without safeStorage an allowance ends with main: the next start asks again', () => {
    const { outside, project, root } = tree()
    const ackFile = path.join(root, 'acks.json')
    const planted = path.join(project, 'planted')

    linkSync(path.join(outside, 'secret'), planted)

    const first = createHardlinkGuard({ ackFile })
    const shown = first.check(project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    expect(first.acknowledgeGroup(project, project, shown.block.groups[0].digest).ok).toBe(true)
    expect(first.check(project).ok).toBe(true)
    // The plugin of this session verifies the record with this session's key.
    expect(readFileSync(ackFile, 'utf8')).toContain('planted')

    const second = createHardlinkGuard({ ackFile })

    expect(second.acks()).toEqual([])
    expect(second.check(project).ok).toBe(false)
    expect(second.keyHex()).not.toBe(first.keyHex())
  })

  it('with safeStorage: one key is minted and sealed once, the record verifies across restarts, and a forged one is dropped and audited', () => {
    const { outside, project, root } = tree()
    const ackFile = path.join(root, 'acks-sealed.json')
    const keyFile = path.join(root, 'key.sealed')
    const planted = path.join(project, 'planted')
    const store = keyStore()
    const audit: HardlinkAuditEvent[] = []

    linkSync(path.join(outside, 'secret'), planted)

    const first = createHardlinkGuard({ ackFile, keyFile, keyStore: store, onAudit: event => audit.push(event) })

    expect(first.persistent()).toBe(true)
    expect(existsSync(keyFile)).toBe(true)
    expect(store.calls).toEqual(['seal'])

    const shown = first.check(project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    expect(first.acknowledgeGroup(project, project, shown.block.groups[0].digest).ok).toBe(true)

    const signed = () => JSON.parse(readFileSync(ackFile, 'utf8')) as { body: string; sig: string }

    expect(createHmac('sha256', Buffer.from(first.keyHex(), 'hex')).update(signed().body).digest('hex')).toBe(
      signed().sig
    )

    // Restart: the same key is unsealed (not minted), the record verifies, the allowance holds.
    const second = createHardlinkGuard({ ackFile, keyFile, keyStore: store, onAudit: event => audit.push(event) })

    expect(store.calls).toEqual(['seal', 'open'])
    expect(second.keyHex()).toBe(first.keyHex())
    expect(second.acks()).toHaveLength(1)
    expect(second.check(project).ok).toBe(true)
    expect(audit).toEqual([])

    // Main down; a writer forges the record. Next start: 0 trusted, the drop is audited, the file is re-signed clean.
    forge(ackFile, project, planted)

    const third = createHardlinkGuard({ ackFile, keyFile, keyStore: store, onAudit: event => audit.push(event) })

    expect(third.acks()).toEqual([])
    expect(third.check(project).ok).toBe(false)
    expect(audit).toEqual([{ kind: 'acks-rejected', file: ackFile, detail: 'signature' }])
    expect(readFileSync(ackFile, 'utf8')).not.toContain('forged')
  })

  it('a sealed key another keychain cannot open, or a sealed key that is gone, mints a new one: old records drop', () => {
    const { outside, project, root } = tree()
    const ackFile = path.join(root, 'acks-sealed.json')
    const keyFile = path.join(root, 'key.sealed')
    const planted = path.join(project, 'planted')
    const audit: HardlinkAuditEvent[] = []

    linkSync(path.join(outside, 'secret'), planted)

    const first = createHardlinkGuard({ ackFile, keyFile, keyStore: keyStore('mac-a') })
    const shown = first.check(project)

    if (shown.ok) {
      throw new Error('expected a refusal')
    }

    first.acknowledgeGroup(project, project, shown.block.groups[0].digest)

    const other = createHardlinkGuard({
      ackFile,
      keyFile,
      keyStore: keyStore('mac-b'),
      onAudit: event => audit.push(event)
    })

    expect(other.acks()).toEqual([])
    expect(other.check(project).ok).toBe(false)
    expect(audit.map(event => event.kind)).toEqual(['key-rejected', 'acks-rejected'])
    expect(other.persistent()).toBe(true)

    rmSync(keyFile)

    const minted = createHardlinkGuard({ ackFile, keyFile, keyStore: keyStore('mac-b') })

    expect(minted.keyHex()).not.toBe(other.keyHex())
    expect(existsSync(keyFile)).toBe(true)
  })

  it('a keychain that cannot seal falls back to session-only, audited, never to trusting the disk', () => {
    const { outside, project, root } = tree()
    const ackFile = path.join(root, 'acks-sealed.json')
    const keyFile = path.join(root, 'key.sealed')
    const planted = path.join(project, 'planted')
    const audit: HardlinkAuditEvent[] = []

    linkSync(path.join(outside, 'secret'), planted)
    forge(ackFile, project, planted)

    const broken: SealedKeyStore = {
      seal: () => {
        throw new Error('keychain locked')
      },
      open: () => {
        throw new Error('keychain locked')
      }
    }

    const guard = createHardlinkGuard({ ackFile, keyFile, keyStore: broken, onAudit: event => audit.push(event) })

    expect(guard.persistent()).toBe(false)
    expect(guard.acks()).toEqual([])
    expect(audit.map(event => event.kind)).toEqual(['key-unsealable'])
    expect(guard.check(project).ok).toBe(false)
  })
})

describe('F7 — the plugin’s report', () => {
  it('yields the absolute roots it names and nothing else; main measures each one itself', () => {
    const { root } = tree()
    const file = path.join(root, 'report.json')

    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        blocked: { '/p': { paths: ['/p/a'], count: 9 }, relative: { paths: ['x'], count: 1 }, '/q': {} }
      })
    )
    expect(readHardlinkReportRoots(file)).toEqual(['/p', '/q'])
    writeFileSync(file, '{')
    expect(readHardlinkReportRoots(file)).toEqual([])
  })
})
