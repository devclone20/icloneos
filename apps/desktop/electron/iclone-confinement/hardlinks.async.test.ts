/**
 * v0.0.7 V-1 — the F7 hard-link check never holds main's thread. Measured on the owner's signed app (10 Nov): every
 * confined command walked a 123 GB project with synchronous `lstat`/`readdir`, 5 s of a busy main thread (the
 * beachball). These tests prove the walk is asynchronous and incremental while every F7 property stays as strong:
 * a cached pre-check on a 50 000-file tree blocks no turn of the loop for 5 ms; a link planted while a run is going is
 * found when it exits; whatever the incremental walk cannot vouch for is decided by the full scan; a check that does
 * not answer in time refuses the start. Real files in a temp dir: link counts come from the file system.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createSeatbeltBackend } from './backend-seatbelt'
import { checkBeforeStart, createHardlinkGuard, type HardlinkCheck, hardlinkUnansweredRefusal } from './hardlinks'
import { createLiveWorld, type LiveWorld } from './live-harness'
import { SANDBOX_EXEC } from './probe'
import { realOrSelf } from './profiles'

const LIVE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
const dirs: string[] = []
const restoreModes: string[] = []

// TRI-3: a test tree here is up to 120 000 folders (I7) or 50 000 files (V-1, CF1). Removing it with rmSync blocked
// this hook past vitest's 10 s default under full-suite load and failed tests whose assertions had passed. The removal
// is async (off the loop) with its own bound; no assertion changes.
afterEach(async () => {
  restoreModes.splice(0).forEach(dir => chmodSync(dir, 0o755))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}, 120_000)

function world(options: { now?: () => Date } = {}) {
  const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v007-v1-')))
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')

  dirs.push(root)
  mkdirSync(path.join(project, 'src', 'deep'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(project, 'README.md'), 'inside\n')
  writeFileSync(path.join(outside, 'secret'), 'outside-secret\n')

  const scans: string[] = []

  const guard = createHardlinkGuard({
    ackFile: path.join(root, 'acks.json'),
    onFullScan: dir => scans.push(dir),
    now: options.now
  })

  return { root, project, outside, guard, scans }
}

/** `dirCount` folders of `perDir` empty files, two levels deep, plus inside-only links (the project's own). */
function bigTree(project: string, dirCount: number, perDir: number): void {
  for (let d = 0; d < dirCount; d += 1) {
    const dir = path.join(project, 'pkgs', `g${d % 20}`, `d${d}`)

    mkdirSync(dir, { recursive: true })

    for (let f = 0; f < perDir; f += 1) {
      closeSync(openSync(path.join(dir, `f${f}.js`), 'w'))
    }

    linkSync(path.join(dir, 'f0.js'), path.join(dir, 'own-twin.js'))
  }
}

/**
 * The longest single turn of the event loop while `work` runs: a `setImmediate` chain fires once per turn, so the
 * gap between two of its callbacks is the time main's thread was held by everything else in that turn.
 */
async function longestTurn<T>(work: () => Promise<T>): Promise<{ result: T; maxMs: number }> {
  let last = performance.now()
  let maxMs = 0
  let running = true

  const tick = () => {
    const at = performance.now()

    maxMs = Math.max(maxMs, at - last)
    last = at

    if (running) {
      setImmediate(tick)
    }
  }

  setImmediate(tick)

  const result = await work()

  running = false

  return { result, maxMs }
}

/** Every call in [from, to) of `source` whose callee is named `*Sync`, by callee text, from the TypeScript parser. */
function syncCallsIn(source: string, from: string, to: string): string[] {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  const file = ts.createSourceFile('span.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  const calleeName = (callee: ts.Expression): string | undefined =>
    ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : undefined

  const visit = (node: ts.Node): void => {
    if (node.end <= start || node.getStart(file) >= end) {
      return
    }

    if (ts.isCallExpression(node) && node.getStart(file) >= start && /Sync$/.test(calleeName(node.expression) ?? '')) {
      found.push(node.expression.getText(file))
    }

    ts.forEachChild(node, visit)
  }

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  visit(file)

  return found
}

interface DeclaredFunction {
  exported: boolean
  async: boolean
  start: number
  end: number
}

/** The module's top-level function declarations by name, from the TypeScript parser. */
function topLevelFunctions(source: string): Map<string, DeclaredFunction> {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true)
  const declared = new Map<string, DeclaredFunction>()

  const has = (node: ts.FunctionDeclaration, kind: ts.SyntaxKind) =>
    (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind)

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declared.set(statement.name.text, {
        exported: has(statement, ts.SyntaxKind.ExportKeyword),
        async: has(statement, ts.SyntaxKind.AsyncKeyword),
        start: statement.getStart(file),
        end: statement.end
      })
    }
  }

  return declared
}

describe('V-1 — a cached pre-check does no synchronous file system work on main’s thread', () => {
  it('50 000 files in 500 folders: the cached check blocks no turn of the loop for 5 ms', async () => {
    const { guard, project, scans } = world()

    bigTree(project, 500, 100)

    const first = await longestTurn(() => guard.check(project))

    expect(first.result).toMatchObject({ ok: true, cached: false })
    expect((first.result as Extract<HardlinkCheck, { ok: true }>).files).toBeGreaterThanOrEqual(50_000)
    expect(scans).toHaveLength(1)

    // The best of three, so a scheduler hiccup of the loaded test machine is not read as the walk's own turn.
    const turns: number[] = []

    for (let round = 0; round < 3; round += 1) {
      const cached = await longestTurn(() => guard.check(project))

      expect(cached.result).toMatchObject({ ok: true, cached: true })
      turns.push(cached.maxMs)
    }

    expect(scans).toHaveLength(1)
    expect(Math.min(...turns)).toBeLessThan(5)
  }, 120_000)

  it('the walk, the store resolve and every per-check step call no synchronous function (structural, CF1 B-m1)', () => {
    const guard = readFileSync(path.join(import.meta.dirname, 'hardlinks.ts'), 'utf8')
    const walk = readFileSync(path.join(import.meta.dirname, 'hardlinks-walk.ts'), 'utf8')
    const stream = readFileSync(path.join(import.meta.dirname, 'hardlinks-fsevents.ts'), 'utf8')
    const body = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to))

    for (const [source, from, to] of [
      // CF7: the records, the fold and the tree model (the in-process holder runs them on main for a small tree):
      // everything above the paced walk, which is the worker's alone.
      [walk, 'export const errnoOf =', '// ─── 4. The paced synchronous walk'],
      [guard, 'export async function storeShaped(', 'interface CacheEntry {'],
      [guard, 'async function realParentJoin(', 'const digestOf ='],
      // measure, the stream barrier's use, the background refresh, the queue, the check itself.
      [guard, '  const ackKey = ', '    async acknowledgeGroup(projectRoot'],
      [guard, '    prewarm(projectRoot: string)', 'export type HardlinkGuard ='],
      [stream, '        async barrier() {', '    async trustedVolume(dir) {']
    ]) {
      const code = body(source, from, to)

      expect(code.length, from).toBeGreaterThan(150)
      // Read as code, not as copy: the calls the parser finds in the span, listed by callee, must be none. A
      // comment or a string that names a *Sync call is not a call; any real call, by any receiver, is listed by name.
      expect(syncCallsIn(source, from, to), from).toEqual([])
    }

    // CF4b: the one synchronous walk (the background refresh's) runs only in the worker: the guard never names it,
    // and its one call is runWalk's (the worker's entry).
    const calls = [...walk.matchAll(/\bwalkTreeSync\(/g)].map(match => match.index)
    const runWalkBody = body(walk, 'export async function runWalk(', 'export async function serveRequest(')

    expect(guard).not.toMatch(/walkTreeSync/)
    expect(walk.indexOf('export function walkTreeSync(')).toBeGreaterThan(
      walk.indexOf('// ─── 4. The paced synchronous walk')
    )
    expect(calls).toHaveLength(2)
    expect(runWalkBody).toMatch(/\bwalkTreeSync\(/)
  })

  it('CF7 (I1): the guard never takes a tree’s records: no `dump`, no TreeRecords, no fold on main (structural)', () => {
    const guard = readFileSync(path.join(import.meta.dirname, 'hardlinks.ts'), 'utf8')
    const live = guard.slice(guard.indexOf('export function createHardlinkGuard('))

    expect(live).not.toMatch(/\.dump\(/)
    expect(live).not.toMatch(/TreeRecords/)
    expect(live).not.toMatch(/\bscanOf\(|\boneVolume\(|\bfoldOf\(|\bwalkTree\(/)
    // The one in-process fold the module keeps is the test helper above the guard: read from the parsed module, an
    // exported async function declaration named scanTree that ends before the guard's declaration begins.
    const declared = topLevelFunctions(guard)
    const scanTree = declared.get('scanTree')
    const createGuard = declared.get('createHardlinkGuard')

    expect(scanTree).toMatchObject({ exported: true, async: true })
    expect(createGuard).toMatchObject({ exported: true })

    if (!scanTree || !createGuard) {
      throw new Error('scanTree and createHardlinkGuard are top-level functions')
    }

    expect(scanTree.end).toBeLessThan(createGuard.start)
  })
})

describe('V-1 — what the incremental walk cannot vouch for is decided by the full scan', () => {
  it('a deep link planted after a warm cache: only the changed folders are listed, and the full scan decides the refusal', async () => {
    const { guard, outside, project, scans } = world()

    bigTree(project, 50, 10)
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: false })
    linkSync(path.join(outside, 'secret'), path.join(project, 'pkgs', 'g7', 'd27', 'late.js'))
    expect(await guard.check(project)).toMatchObject({
      ok: false,
      cached: false,
      block: { kind: 'hard-links', paths: [path.join(project, 'pkgs', 'g7', 'd27', 'late.js')], count: 1 }
    })
    expect(scans).toHaveLength(2)
  })

  it('an ordinary edit (no link) is answered by the incremental walk alone, with no full scan', async () => {
    const { guard, project, scans } = world()

    bigTree(project, 50, 10)
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: false })
    writeFileSync(path.join(project, 'pkgs', 'g3', 'd3', 'new.js'), 'x\n')
    rmSync(path.join(project, 'pkgs', 'g4', 'd4'), { recursive: true })
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: false })
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: true })
    expect(scans).toHaveLength(1)
  })

  it('a folder swapped for another of the same name (rename) is walked whole: its link is found', async () => {
    const { guard, outside, project } = world()
    const staged = path.join(path.dirname(project), 'staged')

    mkdirSync(path.join(staged, 'inner'), { recursive: true })
    linkSync(path.join(outside, 'secret'), path.join(staged, 'inner', 'x'))
    expect((await guard.check(project)).ok).toBe(true)
    rmSync(path.join(project, 'src', 'deep'), { recursive: true })
    renameSync(staged, path.join(project, 'src', 'deep'))
    expect(await guard.check(project)).toMatchObject({
      ok: false,
      block: { paths: [path.join(project, 'src', 'deep', 'inner', 'x')] }
    })
  })

  it('a link removed by hand: the vanished inode is decided by the full scan and the root runs again', async () => {
    const { guard, outside, project, scans } = world()
    const planted = path.join(project, 'src', 'deep', 'planted')

    linkSync(path.join(outside, 'secret'), planted)
    expect((await guard.check(project)).ok).toBe(false)
    rmSync(planted)
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: false })
    expect(scans).toHaveLength(2)
  })

  it('a folder that becomes unlistable after a warm cache is cannot-scan, decided by the full scan', async () => {
    const { guard, project, scans } = world()
    const deep = path.join(project, 'src', 'deep')

    expect((await guard.check(project)).ok).toBe(true)
    chmodSync(deep, 0o311)
    restoreModes.push(deep)
    expect(await guard.check(project)).toMatchObject({ ok: false, block: { kind: 'cannot-scan', paths: [deep] } })
    expect(scans).toHaveLength(2)
  })

  it('past the age bound (names made outside move no inside folder) the next check is a full scan', async () => {
    let clock = 1_000_000
    const { guard, outside, project, scans } = world({ now: () => new Date(clock) })
    const inside = path.join(project, 'src', 'own.txt')

    writeFileSync(inside, 'own\n')
    expect((await guard.check(project)).ok).toBe(true)
    // A second name made OUTSIDE for an inside inode: no inside directory moves.
    linkSync(inside, path.join(outside, 'twin'))
    clock += 60_000
    expect(await guard.check(project)).toMatchObject({ ok: true, cached: true })
    clock += 5 * 60_000
    expect(await guard.check(project)).toMatchObject({ ok: false, cached: false, block: { paths: [inside] } })
    expect(scans).toHaveLength(2)
  })

  it('checks of one root are serialized: two at once both answer, from one walk each, never a torn cache', async () => {
    const { guard, outside, project } = world()

    bigTree(project, 30, 10)
    linkSync(path.join(outside, 'secret'), path.join(project, 'pkgs', 'g1', 'd1', 'x'))

    const [a, b] = await Promise.all([guard.check(project), guard.check(project)])

    expect(a).toMatchObject({ ok: false, cached: false, block: { count: 1 } })
    expect(b).toMatchObject({ ok: false, cached: true, block: { count: 1 } })
  })
})

describe('V-1 — a check that does not answer in time refuses the start (fail closed)', () => {
  let live: LiveWorld

  beforeAll(() => {
    live = createLiveWorld()
  })

  afterAll(() => {
    live?.dispose()
  })

  it('checkBeforeStart: past the deadline it answers timeout; a check that throws answers error', async () => {
    const never = { check: () => new Promise<HardlinkCheck>(() => undefined) }
    const broken = { check: () => Promise.reject(new Error('walk exploded')) }

    const timedOut = await checkBeforeStart(never, '/p', 'project', 50)
    const failed = await checkBeforeStart(broken, '/p', 'project', 50)

    expect(timedOut).toMatchObject({ ok: false, unanswered: 'timeout' })
    expect(failed).toMatchObject({ ok: false, unanswered: 'error', detail: 'walk exploded' })

    if ('unanswered' in timedOut) {
      expect(hardlinkUnansweredRefusal('/p', timedOut)).toBe(
        'confinement refused to start in /p: the hard-link check is still scanning the project (no answer within 0 s); try again in a moment'
      )
    }
  })

  it('the seatbelt backend refuses the start and launches nothing; main’s loop stays free while it waits', async () => {
    const backend = createSeatbeltBackend(
      {
        paths: live.paths,
        profiles: () => live.profiles,
        scan: live.scan,
        hardlinks: { check: () => new Promise<HardlinkCheck>(() => undefined) },
        // Never reached: a launch would answer "sandbox-exec did not start", not the refusal below.
        sandboxExec: path.join(live.root, 'no-such-sandbox-exec')
      },
      { hardlinkDeadlineMs: 200 }
    )

    const { result, maxMs } = await longestTurn(() =>
      backend.spawn({
        cls: 'project',
        argv: ['/usr/bin/true'],
        cwd: live.project,
        projectRoot: live.project,
        network: false,
        writeProject: true
      })
    )

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.error).toBe(
        `confinement refused to start in ${live.project}: the hard-link check is still scanning the project (no answer within 0 s); try again in a moment`
      )
      expect(result.hardlinks).toBeUndefined()
    }

    expect(maxMs).toBeLessThan(100)
  })
})

describe.runIf(LIVE)(
  'V-1 T3 — a link planted during a run is still found when it exits (warm, incremental cache)',
  () => {
    let live: LiveWorld

    beforeAll(() => {
      live = createLiveWorld()
      bigTree(live.project, 40, 10)
    })

    afterAll(() => {
      live?.dispose()
    })

    it('a deep plant 0.3 s into a run, after a clean warm-up run: recorded at exit, the next run refused', async () => {
      const warm = await live.runConfined('true')

      expect(warm.code).toBe(0)
      writeFileSync(path.join(live.outside, 'secret-v1.txt'), 'outside-secret\n')

      const planted = path.join(live.project, 'pkgs', 'g9', 'd29', 'during-run.js')
      const run = live.runConfined('sleep 0.7')

      await new Promise(resolve => setTimeout(resolve, 300))
      linkSync(path.join(live.outside, 'secret-v1.txt'), planted)

      const outcome = await run

      expect(outcome.code).toBe(0)

      for (let waited = 0; live.appeared.length === 0 && waited < 2_000; waited += 25) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      expect(live.appeared).toHaveLength(1)
      expect(live.appeared[0]).toMatchObject({
        root: live.project,
        pid: outcome.pid,
        block: { kind: 'hard-links', paths: [planted], count: 1 }
      })

      const next = await live.runConfined('true')

      expect(next.code).toBeNull()
      expect(next.out).toContain(`${planted} is a hard link`)
      rmSync(planted)
      live.appeared.splice(0)
    })
  }
)
