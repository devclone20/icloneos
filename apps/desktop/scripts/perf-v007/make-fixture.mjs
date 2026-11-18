#!/usr/bin/env node
// v0.0.7 PERF gates: the throwaway fixtures the gates measure against (electron/perf-v007/*.perf.test.ts).
//
//   node scripts/perf-v007/make-fixture.mjs <dir> [--dirs 30000] [--files N | --per-dir 7.5]   a project tree
//   node scripts/perf-v007/make-fixture.mjs <dir> --scale 1/8                                   the owner's shape, scaled
//   node scripts/perf-v007/make-fixture.mjs <dir> --shape owner [--scale 1/16]                  the owner's measured tree shape
//   node scripts/perf-v007/make-fixture.mjs <dir> --audit 200000                                a permissions dir with a chain
//   node scripts/perf-v007/make-fixture.mjs --self-test                                         builds --shape owner at 1/16 twice, checks it
//
// `--files` is the total file count (the v0.0.7 suites pass it). Without it the count is `--dirs` x `--per-dir`, whose
// default is the owner's measured ratio (OWNER below: 3 895 210 files / 522 597 folders = 7.45). `--scale full|1/2|
// 1/4|1/8|1/16` is the owner's project scaled: 1/8 (65 325 folders, 486 901 files) is the CI proxy, full (522 597 /
// 3 895 210, ~16 GB of 4 KB blocks, ~3.5 min: 1/8 measured 24.1 s / 1.9 GB) is opt-in before a release.
//
// <dir> must resolve under /private/tmp and never under the real home (judged by getpwuid, not $HOME). It must not
// exist, or be a fixture this script made (marker file), which is then replaced.
//
// Tree: `--dirs` directories in a breadth-first tree of fanout 16 and `--files` small regular files spread over them
// round-robin, every name and byte derived from its index, so two runs give the same tree. Some files get a second
// name in another directory of the tree (an inside-only hard link: the guard's nlink path runs, and the root is still
// clean, so every check answers ok), evenly spread, in the owner's proportion: 5 152 names with nlink > 1 among
// 3 895 210 files, so one linked pair (two such names) per ~1 512 files, never fewer than one pair.
//
// `--shape owner` (default shape stays the uniform tree above) reproduces the owner's measured shape (OWNER_SHAPE, from
// gates/shape/shape.json: 522 664 folders / 3 895 447 files): the depth histogram (max 35, mode 12), the sub-folders
// per folder (p50 0, p90 2, p99 10, p99.9 41, max 1 636; 63 % leaves) and the files per folder (p50 1, p90 9, p99 100,
// p99.9 918, max 55 444; mean 7.45), each seeded, so two runs give the same tree. It is sized by --scale alone (default
// full); the depth levels keep at least one folder, so the depth range survives a scale. The hard links are the same
// proportion as above. FIXTURE_JSON adds `shape` and `measured` (depth/fan-out counted from the plan that was built).
//
// Audit: `<dir>/permissions/` exactly as the app lays it out (keys.ts master + audit/ day files + head anchor), written
// by the app's own createAuditLog and loadPermissionKeys, bundled from the TypeScript sources with esbuild. The master
// is sealed by PERF_SEALER below (a test key: reversible base64, never the Keychain); the gate opens it with the same.
import { mkdirSync, mkdtempSync, linkSync, existsSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MARKER = '.perf-v007-fixture'
const FANOUT = 16
/** The owner's project, measured 2026-11-12 (CF8_DESIGN.md "Measured"). */
const OWNER = { dirs: 522_597, files: 3_895_210, linkedNames: 5_152 }
const OWNER_PER_DIR = OWNER.files / OWNER.dirs
const SCALES = { full: 1, '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16 }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..', '..')

/** The test sealer the gates share: a fixture master is never a real secret, and must reopen in another process. */
export const PERF_SEALER = {
  seal: plain => `perfv007:${Buffer.from(plain, 'utf8').toString('base64')}`,
  unseal: sealed => {
    if (!sealed.startsWith('perfv007:')) {
      throw new Error('not sealed by the perf-v007 sealer')
    }

    return Buffer.from(sealed.slice('perfv007:'.length), 'base64').toString('utf8')
  }
}

function fail(message) {
  console.error(`make-fixture: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const [dir, ...rest] = argv
  const given = {}

  if (!dir || dir.startsWith('--')) {
    fail('usage: make-fixture.mjs <dir> [--dirs M] [--files N | --per-dir R] | <dir> --scale 1/8 | <dir> --audit N')
  }

  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].replace(/^--/, '')
    const raw = rest[i + 1] ?? ''

    if (name in given) {
      fail(`option ${rest[i]} given twice`)
    }

    if (name === 'shape') {
      if (raw !== 'owner') {
        fail(`bad option --shape ${raw}: only owner`)
      }

      given.shape = raw
    } else if (name === 'scale') {
      if (!Object.hasOwn(SCALES, raw)) {
        fail(`bad option --scale ${raw}: one of ${Object.keys(SCALES).join(', ')}`)
      }

      given.scale = SCALES[raw]
    } else if (name === 'per-dir') {
      const value = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN

      if (!(value > 0 && value <= 1_000)) {
        fail(`bad option --per-dir ${raw}`)
      }

      given.perDir = value
    } else {
      const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN

      if (!['files', 'dirs', 'audit'].includes(name) || !Number.isInteger(value) || value < 1 || value > 5_000_000) {
        fail(`bad option ${rest[i]} ${raw}`)
      }

      given[name] = value
    }
  }

  if (given.scale !== undefined && (given.dirs !== undefined || given.files !== undefined || given.perDir !== undefined)) {
    fail('--scale sets the folders and files: give it alone')
  }

  if (given.shape !== undefined) {
    if (given.dirs !== undefined || given.files !== undefined || given.perDir !== undefined || given.audit !== undefined) {
      fail('--shape owner is sized by --scale alone')
    }

    const divisor = given.scale ?? 1

    return {
      dir,
      shape: 'owner',
      dirs: Math.round(OWNER_SHAPE.dirs / divisor),
      files: Math.round(OWNER_SHAPE.files / divisor),
      audit: 0
    }
  }

  if (given.files !== undefined && given.perDir !== undefined) {
    fail('--files (a total) and --per-dir (a ratio) are exclusive')
  }

  const dirs = given.scale !== undefined ? Math.round(OWNER.dirs / given.scale) : (given.dirs ?? 30_000)
  const files =
    given.scale !== undefined
      ? Math.round(OWNER.files / given.scale)
      : (given.files ?? Math.round(dirs * (given.perDir ?? OWNER_PER_DIR)))

  if (files > 5_000_000) {
    fail(`${files} files is past the 5 000 000 cap`)
  }

  return { dir, dirs, files, audit: given.audit ?? 0 }
}

/** Linked pairs for `files` files at the owner's proportion of names with nlink > 1 (two names per pair), at least one. */
export function linkPairs(files) {
  return Math.max(1, Math.round((files * OWNER.linkedNames) / OWNER.files / 2))
}

/** Resolves <dir> through its existing parent and refuses anything outside /private/tmp or inside the real home. */
export function safeFixtureDir(dir) {
  const absolute = path.resolve(dir)
  const parent = realpathSync(path.dirname(absolute))
  const target = path.join(parent, path.basename(absolute))
  const realHome = realpathSync(os.userInfo().homedir)

  if (!target.startsWith('/private/tmp/') || target === '/private/tmp/') {
    fail(`refusing ${target}: fixtures live only under /private/tmp`)
  }

  if (target === realHome || target.startsWith(`${realHome}/`) || realHome.startsWith(`${target}/`)) {
    fail(`refusing ${target}: inside (or holding) the real home ${realHome}`)
  }

  if (existsSync(target)) {
    if (!existsSync(path.join(target, MARKER))) {
      fail(`refusing ${target}: exists and is not a perf-v007 fixture`)
    }

    rmSync(target, { recursive: true, force: true })
  }

  mkdirSync(target, { mode: 0o700 })
  writeFileSync(path.join(target, MARKER), 'perf-v007 throwaway fixture\n', { mode: 0o600 })

  return target
}

/** Directory i's path relative to the root: breadth-first, so its parent is floor((i - 1) / FANOUT). */
export function dirPath(index) {
  const parts = []

  for (let i = index; i > 0; i = Math.floor((i - 1) / FANOUT)) {
    parts.push(`d${String(i).padStart(5, '0')}`)
  }

  return parts.reverse().join('/')
}

function makeTree(root, files, dirs) {
  const started = Date.now()
  const dirNames = Array.from({ length: dirs }, (_, i) => path.join(root, 'tree', dirPath(i)))

  for (const dir of dirNames) {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
  }

  const pairs = linkPairs(files)
  const linkEvery = Math.max(1, Math.floor(files / pairs))
  let links = 0

  for (let i = 0; i < files; i += 1) {
    const dir = dirNames[i % dirs]
    const file = path.join(dir, `f${String(i).padStart(7, '0')}.txt`)

    writeFileSync(file, `perf-v007 file ${i}\n`)

    if (i % linkEvery === 0 && links < pairs) {
      linkSync(file, path.join(dirNames[(i * 7 + 3) % dirs], `l${String(i).padStart(7, '0')}.txt`))
      links += 1
    }
  }

  return { root, files, dirs, perDir: Number((files / dirs).toFixed(3)), insideLinks: links, linkedNames: links * 2, ms: Date.now() - started }
}

const SHAPE_SEED = 0x0c1f8
/** gates/shape/shape.json, measured 2026-11-12: the owner's real project. */
const OWNER_SHAPE = {
  dirs: 522_664,
  files: 3_895_447,
  depth: [1, 9, 62, 1214, 3794, 6096, 6346, 8499, 20462, 48469, 63948, 74318, 88217, 87885, 55056, 30450, 12619, 6075, 3986, 2657, 1578, 627, 188, 13, 3, 3, 3, 3, 3, 6, 11, 37, 20, 4, 1, 1],
  leafDirs: 328_497,
  maxFanOut: 1_636,
  maxFiles: 55_444
}

/** Cumulative cut-offs of the sampled fan-out (0, 1, 2, 3..10, 11..41, past 41) and files (0, 1, 2..9, 10..100, 101..918, past). */
const FAN_CUM = [0.62, 0.86, 0.945, 0.993, 0.9992]
const FAN_TAIL_ALPHA = 0.9
const FILES_CUM = [0.25, 0.55, 0.905, 0.99, 0.999]
const FILES_TAIL_ALPHA = 0.8

function seededRandom(seed) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0

    let t = state

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Inverse CDF of a Pareto cut to [lo, hi], floored to an integer. */
function truncatedPareto(lo, hi, alpha, v) {
  if (hi <= lo) {
    return lo
  }

  const a = lo ** -alpha
  const b = hi ** -alpha

  return Math.min(hi, Math.floor((a - v * (a - b)) ** (-1 / alpha)))
}

/** Folders per depth for `dirs` folders: the owner's histogram, every level at least one, the rest on the mode. */
export function depthCounts(dirs) {
  const counts = OWNER_SHAPE.depth.map(h => Math.max(1, Math.round((h * dirs) / OWNER_SHAPE.dirs)))
  const mode = OWNER_SHAPE.depth.indexOf(Math.max(...OWNER_SHAPE.depth))

  counts[0] = 1
  counts[mode] += dirs - counts.reduce((a, b) => a + b, 0)

  if (counts[mode] < 1) {
    fail(`${dirs} folders is too few for the owner's depth range`)
  }

  return counts
}

/** `nonZeroShare` is the share of folders with sub-folders at this level: the owner's, scaled by how much the level grows. */
function sampleFanOut(random, cap, nonZeroShare) {
  if (random() >= nonZeroShare) return 0

  const u = FAN_CUM[0] + random() * (1 - FAN_CUM[0])

  if (u < FAN_CUM[1]) return 1
  if (u < FAN_CUM[2]) return 2
  if (u < FAN_CUM[3]) return truncatedPareto(3, 11, 1.5, random())
  if (u < FAN_CUM[4]) return truncatedPareto(11, 42, 1.5, random())

  return truncatedPareto(42, Math.max(42, cap), FAN_TAIL_ALPHA, random())
}

function sampleFiles(random, cap) {
  const u = random()

  if (u < FILES_CUM[0]) return 0
  if (u < FILES_CUM[1]) return 1
  if (u < FILES_CUM[2]) return truncatedPareto(2, 10, 1, random())
  if (u < FILES_CUM[3]) return truncatedPareto(10, 101, 1, random())
  if (u < FILES_CUM[4]) return truncatedPareto(101, 919, 1, random())

  return truncatedPareto(919, Math.max(919, cap), FILES_TAIL_ALPHA, random())
}

/** Draws an index with probability proportional to weights (`cumulative` is their running sum). */
function pickWeighted(cumulative, random) {
  const target = random() * cumulative[cumulative.length - 1]
  let lo = 0
  let hi = cumulative.length - 1

  while (lo < hi) {
    const mid = (lo + hi) >> 1

    if (cumulative[mid] > target) hi = mid
    else lo = mid + 1
  }

  return lo
}

/** Sub-folder counts of one level's `parents` folders so they add up to `children`: sampled, then the surplus or the
 * shortfall goes to the folders that already have many (rich get richer), which keeps the small end of the shape. */
function levelFanOut(parents, children, random, cap) {
  const fan = new Uint32Array(parents)
  const nonZeroShare = Math.min(1, (1 - FAN_CUM[0]) * (children / parents))
  let sum = 0

  for (let i = 0; i < parents; i += 1) {
    fan[i] = sampleFanOut(random, cap, nonZeroShare)
    sum += fan[i]
  }

  if (sum === 0) {
    fan[Math.floor(random() * parents)] = 1
    sum = 1
  }

  const cumulative = new Float64Array(parents)

  for (let i = 0, running = 0; i < parents; i += 1) {
    running += fan[i]
    cumulative[i] = running
  }

  let nonZero = fan.reduce((n, k) => n + (k > 0 ? 1 : 0), 0)
  let attempts = 0

  while (sum !== children && attempts < 50 * Math.abs(children - sum) + 1_000) {
    attempts += 1

    const i = pickWeighted(cumulative, random)

    if (sum < children) {
      if (fan[i] < cap) {
        fan[i] += 1
        sum += 1
      }
    } else if (fan[i] > 1 || (fan[i] === 1 && nonZero > 1)) {
      fan[i] -= 1
      sum -= 1
      nonZero -= fan[i] === 0 ? 1 : 0
    }
  }

  for (let i = 0; sum !== children; i = (i + 1) % parents) {
    if (sum < children && fan[i] < cap && fan[i] > 0) {
      fan[i] += 1
      sum += 1
    } else if (sum > children && (fan[i] > 1 || (fan[i] === 1 && nonZero > 1))) {
      fan[i] -= 1
      sum -= 1
      nonZero -= fan[i] === 0 ? 1 : 0
    }
  }

  return fan
}

function fileCounts(dirs, files, random, cap) {
  const counts = new Uint32Array(dirs)
  let sum = 0
  let tail = 0

  for (let i = 0; i < dirs; i += 1) {
    counts[i] = sampleFiles(random, cap)
    sum += counts[i]
    tail += counts[i] >= 100 ? counts[i] : 0
  }

  if (tail > 0 && tail + files - sum > 0) {
    const factor = (tail + files - sum) / tail

    sum = 0

    for (let i = 0; i < dirs; i += 1) {
      if (counts[i] >= 100) {
        counts[i] = Math.min(cap, Math.max(100, Math.round(counts[i] * factor)))
      }

      sum += counts[i]
    }
  }

  while (sum !== files) {
    const i = Math.floor(random() * dirs)

    if (sum < files && counts[i] > 0 && counts[i] < 100) {
      counts[i] += 1
      sum += 1
    } else if (sum > files && counts[i] > 1 && counts[i] < 100) {
      counts[i] -= 1
      sum -= 1
    }
  }

  return counts
}

/** The owner-shaped plan: folder i is in level order (root 0), `fan[i]` sub-folders, `fileCount[i]` files, `levels[d]`
 * folders at depth d; the children of folder i are contiguous in the next level, in parent order. Seeded: same in, same out. */
export function planOwnerShape(dirs, files) {
  const random = seededRandom(SHAPE_SEED)
  const levels = depthCounts(dirs)
  const scale = OWNER_SHAPE.dirs / dirs
  const fanCap = Math.max(100, Math.round(OWNER_SHAPE.maxFanOut / Math.sqrt(scale)))
  const filesCap = Math.max(1_000, Math.round(OWNER_SHAPE.maxFiles / Math.sqrt(scale)))
  const fan = new Uint32Array(dirs)
  let start = 0

  for (let d = 0; d < levels.length - 1; d += 1) {
    fan.set(levelFanOut(levels[d], levels[d + 1], random, fanCap), start)
    start += levels[d]
  }

  return { levels, fan, fileCount: fileCounts(dirs, files, random, filesCap) }
}

function percentile(sortedValues, q) {
  return sortedValues[Math.max(0, Math.ceil(q * sortedValues.length) - 1)]
}

/** Depth mode and the percentiles the owner's shape is judged by, from per-level counts and per-folder counts. */
export function shapeStats(levels, fan, fileCount) {
  const fanSorted = Uint32Array.from(fan).sort()
  const filesSorted = Uint32Array.from(fileCount).sort()
  const dirs = fan.length
  const mean = values => Number((values.reduce((a, b) => a + b, 0) / dirs).toFixed(3))

  return {
    dirs,
    files: filesSorted.reduce((a, b) => a + b, 0),
    maxDepth: levels.length - 1,
    depthMode: levels.indexOf(Math.max(...levels)),
    leafShare: Number((fanSorted.reduce((n, k) => n + (k === 0 ? 1 : 0), 0) / dirs).toFixed(4)),
    subdirs: {
      p50: percentile(fanSorted, 0.5),
      p90: percentile(fanSorted, 0.9),
      p99: percentile(fanSorted, 0.99),
      p999: percentile(fanSorted, 0.999),
      max: fanSorted[dirs - 1]
    },
    filesPerDir: {
      p50: percentile(filesSorted, 0.5),
      p90: percentile(filesSorted, 0.9),
      p99: percentile(filesSorted, 0.99),
      p999: percentile(filesSorted, 0.999),
      max: filesSorted[dirs - 1],
      mean: mean(filesSorted)
    }
  }
}

function makeOwnerTree(root, files, dirs) {
  const started = Date.now()
  const plan = planOwnerShape(dirs, files)
  const dirPaths = new Array(dirs)
  const treeRoot = path.join(root, 'tree')
  let next = 1
  let start = 0

  dirPaths[0] = treeRoot
  mkdirSync(treeRoot, { recursive: true, mode: 0o755 })

  for (let d = 0; d < plan.levels.length - 1; d += 1) {
    for (let i = start; i < start + plan.levels[d]; i += 1) {
      for (let c = 0; c < plan.fan[i]; c += 1, next += 1) {
        dirPaths[next] = `${dirPaths[i]}/d${String(next).padStart(6, '0')}`
        mkdirSync(dirPaths[next], { mode: 0o755 })
      }
    }

    start += plan.levels[d]
  }

  const pairs = linkPairs(files)
  const linkEvery = Math.max(1, Math.floor(files / pairs))
  let links = 0
  let index = 0

  for (let dir = 0; dir < dirs; dir += 1) {
    for (let f = 0; f < plan.fileCount[dir]; f += 1, index += 1) {
      const file = `${dirPaths[dir]}/f${String(index).padStart(7, '0')}.txt`

      writeFileSync(file, `perf-v007 file ${index}\n`)

      if (index % linkEvery === 0 && links < pairs) {
        linkSync(file, `${dirPaths[(index * 7 + 3) % dirs]}/l${String(index).padStart(7, '0')}.txt`)
        links += 1
      }
    }
  }

  return {
    root,
    shape: 'owner',
    files,
    dirs,
    perDir: Number((files / dirs).toFixed(3)),
    insideLinks: links,
    linkedNames: links * 2,
    measured: shapeStats(plan.levels, plan.fan, plan.fileCount),
    ms: Date.now() - started
  }
}

/** The tree on disk, read back: per-level counts, sub-folders and files per folder, and a hash of the whole listing. */
function measureTreeOnDisk(root) {
  const levels = []
  const fan = []
  const fileCount = []
  const listing = createHash('sha256')
  let level = [path.join(root, 'tree')]

  while (level.length > 0) {
    const nextLevel = []

    levels.push(level.length)

    for (const dir of level) {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
      const subdirs = entries.filter(e => e.isDirectory())
      const regular = entries.filter(e => e.isFile())

      for (const e of regular) {
        listing.update(`${path.relative(root, path.join(dir, e.name))}\0${statSync(path.join(dir, e.name)).size}\n`)
      }

      listing.update(`${path.relative(root, dir)}/\0${subdirs.length}\n`)
      fan.push(subdirs.length)
      fileCount.push(regular.length)
      nextLevel.push(...subdirs.map(e => path.join(dir, e.name)))
    }

    level = nextLevel
  }

  return { stats: shapeStats(levels, fan, fileCount), listing: listing.digest('hex') }
}

/** Builds --shape owner at 1/16 twice and holds the result to the owner's numbers (+-10 %) and to itself. */
function selfTest() {
  const scale = 16
  const dirs = Math.round(OWNER_SHAPE.dirs / scale)
  const files = Math.round(OWNER_SHAPE.files / scale)
  const scratch = mkdtempSync('/private/tmp/perf-shape-selftest-')
  const failures = []
  const within = (name, got, want) => {
    if (!(Math.abs(got - want) <= want * 0.1)) {
      failures.push(`${name}: got ${got}, want ${want} +-10%`)
    }
  }

  try {
    const built = ['a', 'b'].map(name => {
      const root = safeFixtureDir(path.join(scratch, name))
      const result = makeOwnerTree(root, files, dirs)

      return { result, disk: measureTreeOnDisk(root) }
    })
    const { stats } = built[0].disk
    const ownerLeafShare = OWNER_SHAPE.leafDirs / OWNER_SHAPE.dirs

    within('dirs', stats.dirs, dirs)
    within('files', stats.files, files)
    within('depth mode', stats.depthMode, 12)
    within('max depth', stats.maxDepth, 35)
    within('subdirs p90', stats.subdirs.p90, 2)
    within('subdirs p99', stats.subdirs.p99, 10)
    within('leaf share', stats.leafShare, ownerLeafShare)
    within('files mean', stats.filesPerDir.mean, OWNER_SHAPE.files / OWNER_SHAPE.dirs)

    if (built[0].disk.listing !== built[1].disk.listing) {
      failures.push('two builds differ in listing')
    }

    if (built[0].result.insideLinks !== linkPairs(files)) {
      failures.push(`linked pairs ${built[0].result.insideLinks}, want ${linkPairs(files)}`)
    }

    console.log(`SELF_TEST ${JSON.stringify({ ok: failures.length === 0, failures, stats, listing: built[0].disk.listing, ms: built.map(b => b.result.ms) })}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    process.exit(1)
  }
}

async function loadAuditModules(root) {
  const { build } = await import('esbuild')
  const outfile = path.join(root, '.bundle', 'audit-modules.mjs')
  const audit = path.join(DESKTOP, 'electron', 'iclone-permissions', 'audit.ts')
  const keys = path.join(DESKTOP, 'electron', 'iclone-permissions', 'keys.ts')

  await build({
    stdin: {
      contents: `export { createAuditLog, verifyAuditChain } from ${JSON.stringify(audit)}\nexport { loadPermissionKeys } from ${JSON.stringify(keys)}\n`,
      resolveDir: DESKTOP,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'error'
  })

  return import(pathToFileURL(outfile).href)
}

const SAMPLE_KINDS = ['use', 'ask', 'answer', 'use', 'use', 'refuse', 'grant', 'use']

async function makeAudit(root, count) {
  const started = Date.now()
  const { createAuditLog, loadPermissionKeys, verifyAuditChain } = await loadAuditModules(root)
  const permissions = path.join(root, 'permissions')

  mkdirSync(permissions, { recursive: true, mode: 0o700 })

  const keys = loadPermissionKeys(permissions, PERF_SEALER)

  if (!keys.sealed) {
    fail('the permission master did not seal with the test sealer')
  }

  // One record a minute from 2026-01-01: ~139 day files for 200 000 records, the shape a long-lived install has.
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const log = createAuditLog({
    dir: path.join(permissions, 'audit'),
    key: keys.auditKey,
    kid: keys.kid,
    durable: false,
    now: () => new Date(clock)
  })

  try {
    for (let i = 0; i < count; i += 1) {
      clock += 60_000

      const kind = SAMPLE_KINDS[i % SAMPLE_KINDS.length]

      log.append({
        src: 'main',
        kind,
        class: 'X',
        mode: 'manual',
        answer: kind === 'answer' ? 'once' : null,
        action: { tool: 'terminal', target: `echo perf-v007 ${i}`, project_root: '/private/tmp/perf-v007-project' },
        reason: kind === 'refuse' ? 'perf-v007 sample refusal' : null
      })
    }
  } finally {
    log.close()
  }

  const report = verifyAuditChain(path.join(permissions, 'audit'), { key: keys.auditKey, kid: keys.kid })

  if (!report.ok || report.records !== count) {
    fail(`the written chain does not verify: ${JSON.stringify({ ok: report.ok, records: report.records })}`)
  }

  const dayFiles = readdirSync(path.join(permissions, 'audit')).filter(name => name.endsWith('.jsonl')).length

  return { root, permissions, records: report.records, dayFiles, verified: report.ok, ms: Date.now() - started }
}

async function main() {
  if (process.argv[2] === '--self-test' && process.argv.length === 3) {
    selfTest()

    return
  }

  const opts = parseArgs(process.argv.slice(2))
  const root = safeFixtureDir(opts.dir)
  const result = opts.audit > 0 ? await makeAudit(root, opts.audit) : opts.shape === 'owner'
        ? makeOwnerTree(root, opts.files, opts.dirs)
        : makeTree(root, opts.files, opts.dirs)

  console.log(`FIXTURE_JSON ${JSON.stringify(result)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
