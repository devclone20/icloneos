/**
 * Stage the Virtuals ACP CLI into `build/acp-cli` so it ships inside the app's
 * resources (electron-builder `extraResources` → `acp-cli`) and runs in an
 * Electron utility process (electron/iclone-acp.ts) — no system Node.js/npm
 * on the user's machine, and no RunAsNode. Its native deps are NAPI
 * (ABI-stable across Node and Electron), so they load unchanged.
 *
 * Layout: `build/acp-cli/launch.cjs` (the module the utility process runs —
 * see scripts/acp-launch.cjs for why acp.js cannot be forked directly) beside
 * `build/acp-cli/runtime/node_modules/…`. The CLI is nested under `runtime/`
 * because electron-builder's file matcher hard-excludes a root-level
 * `node_modules` (fileMatcher.js: `if (relative === "node_modules") return
 * false`) — one level down the tree ships intact.
 *
 * Only the CLI's RUNTIME closure ships (P7 B11): `@virtuals-protocol/acp-node`
 * declares `tsup` as a dependency, which drags in typescript, esbuild (a
 * native binary), rollup and sucrase — ~45 MB of build tooling no command
 * loads. Everything not reachable from the CLI through dependencies,
 * optionalDependencies or peerDependencies (build tooling and `@types/*`
 * excluded) is removed, and so is `.bin`. Inside what stays, `pruneShipFiles` drops what no command loads on
 * this platform — source maps, type declarations, TypeScript sources, docs, test/example dirs, other platforms'
 * prebuilds and signer binaries — keeping every licence and notice, and the CLI's own data (`isCliData`: its
 * `skill` verbs read SKILL.md) (F1: 196 → ~70 MB, 37 k → ~12 k files). Before that prune, `traceReads` records every
 * file the read-only runs open on the full tree; each one must survive it.
 *
 * PINNED to scripts/acp-cli-version.mjs, and the WHOLE tree is pinned by a committed lockfile (REL-4, ruling 24):
 * `acp-cli-lock/package.json` + `package-lock.json` are copied into the staging dir and installed with `npm ci`, so
 * every transitive version (and THIRD_PARTY_NOTICES' "ACP CLI" section, byte-checked below) is the same on every
 * build; a registry release can no longer change what ships. Bump: set ACP_CLI_VERSION and the dependency in
 * acp-cli-lock/package.json, run `npm install --package-lock-only --ignore-scripts` inside acp-cli-lock/, review the
 * lockfile diff, stage, then `third-party-closure.mjs --write`. The staging dir is wiped first so a stale tree can
 * never survive a bump. Staging ends with the shared self-test
 * through the launcher, so a CLI that cannot answer a real command never
 * reaches a bundle; the packaged app proves itself with `--iclone-selftest`.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACP_CLI_VERSION } from './acp-cli-version.mjs'
import { acpLayout, LAUNCHER } from './acp-selftest.mjs'
import { checkNotices } from './third-party-closure.mjs'
import { isMain } from './utils.mjs'
import { reportAcpTree, traceReads } from './verify-packaged-acp-tree.mjs'

export const CLI_NAME = '@virtuals-protocol/acp-cli'

/** The committed project that pins the staged tree (ruling 24). */
export const LOCK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'acp-cli-lock')

/**
 * The pinned project's two files, checked against ACP_CLI_VERSION: the dependency must be that exact version and the
 * lockfile must resolve the CLI to it, so a bump that forgets the lockfile (or the pin) fails before any install.
 */
export function readPinnedProject(lockDir = LOCK_DIR, version = ACP_CLI_VERSION) {
  const manifest = JSON.parse(readFileSync(path.join(lockDir, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(path.join(lockDir, 'package-lock.json'), 'utf8'))
  const declared = manifest.dependencies?.[CLI_NAME]
  const locked = lock.packages?.[`node_modules/${CLI_NAME}`]?.version
  const root = lock.packages?.['']?.dependencies?.[CLI_NAME]

  if (declared !== version || root !== version || locked !== version) {
    throw new Error(
      `acp-cli-lock pins ${CLI_NAME} as package.json ${declared}, lockfile root ${root}, lockfile tree ${locked}; ` +
        `ACP_CLI_VERSION is ${version}: bump all of them together`
    )
  }

  for (const [key, meta] of Object.entries(lock.packages)) {
    if (key && !meta.link && (!meta.resolved || !meta.integrity)) {
      throw new Error(`acp-cli-lock/package-lock.json: ${key} has no resolved URL or integrity`)
    }
  }

  return { manifest, lock }
}

/** Copy the pinned project into `stageDir` and install exactly its lockfile (`npm ci`), runtime dependencies only. */
export function installPinned(stageDir, { lockDir = LOCK_DIR, spawn = spawnSync } = {}) {
  readPinnedProject(lockDir)
  mkdirSync(stageDir, { recursive: true })

  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(path.join(lockDir, file), path.join(stageDir, file))
  }

  return spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel', 'error'], {
    cwd: stageDir,
    stdio: 'inherit',
    timeout: 300_000
  })
}

/** Never shipped: the build tools a dependency mis-declares, and type stubs. */
export function isBuildTooling(name) {
  return name === 'tsup' || name === 'typescript' || name.startsWith('@types/')
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Node's lookup: `<dir>/node_modules/<name>`, then every ancestor's, up to `top`. */
function resolvePackageDir(fromDir, name, top) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)

    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }

    if (dir === top || path.dirname(dir) === dir) {
      return null
    }
  }
}

/** Every package dir under a node_modules tree, nested ones included. */
export function listPackages(nodeModules) {
  const found = []

  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }

    const dirs = entry.name.startsWith('@')
      ? readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })
          .filter(inner => inner.isDirectory())
          .map(inner => path.join(nodeModules, entry.name, inner.name))
      : [path.join(nodeModules, entry.name)]

    for (const dir of dirs) {
      found.push(dir)

      if (existsSync(path.join(dir, 'node_modules'))) {
        found.push(...listPackages(path.join(dir, 'node_modules')))
      }
    }
  }

  return found
}

/** The package dirs the CLI can load at run time. */
export function runtimeClosure(nodeModules, rootName = CLI_NAME) {
  const top = path.dirname(nodeModules)
  const keep = new Set()
  const queue = [path.join(nodeModules, rootName)]

  while (queue.length > 0) {
    const dir = queue.pop()

    if (keep.has(dir)) {
      continue
    }

    keep.add(dir)

    const manifest = readManifest(dir) ?? {}

    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ])

    for (const name of names) {
      const found = isBuildTooling(name) ? null : resolvePackageDir(dir, name, top)

      if (found) {
        queue.push(found)
      }
    }
  }

  return keep
}

/** Remove every package outside the runtime closure; returns what went. */
export function pruneToRuntime(nodeModules, rootName = CLI_NAME) {
  const keep = runtimeClosure(nodeModules, rootName)
  const removed = []

  for (const dir of listPackages(nodeModules)) {
    if (!keep.has(dir) && !removed.some(gone => dir.startsWith(`${gone}${path.sep}`))) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }

  rmSync(path.join(nodeModules, '.bin'), { recursive: true, force: true })

  return removed.map(dir => path.relative(nodeModules, dir))
}

/** Kept whatever their extension: licence and notice texts travel with the code they cover. */
const LEGAL_TEXT = /^(licen[cs]e|notice|copying|authors|patents|third[-_.]?party)/i

/** Never read by a command: source maps, type declarations and TypeScript sources (Node refuses to strip types under
 *  node_modules), docs — outside the CLI's own data (`isCliData`), which `traceReads` proves on every stage. */
const NOT_RUNTIME_FILE = /\.(map|[cm]?tsx?|md|markdown|tsbuildinfo)$/i

/** VCS/packaging placeholders. electron-builder drops them from the bundle anyway, so the staged tree must not carry them
 *  either (staged == shipped is a release gate). */
const PLACEHOLDER_FILE = /^\.(gitkeep|gitignore|gitattributes|npmignore|DS_Store)$/

/** Package-root directories that hold no runtime code. */
const NOT_RUNTIME_DIRS = new Set([
  '.github',
  '__tests__',
  'bench',
  'benchmark',
  'benchmarks',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'test',
  'tests'
])

/** The CLI's own docs dir: SKILL.md links `docs/*.md` relative to the package root that `acp skill path` prints. */
const CLI_DATA_DIR = 'docs'

/** True for a file of the CLI's own data, kept whatever its extension: every file at its package root (acp.js
 *  resolvePackageRoot needs package.json AND SKILL.md; `acp skill path|print|check` read SKILL.md, FR r2) and in its
 *  `docs/`. Its `bin/` and `dist/` are code and follow the ordinary rules. */
export function isCliData(cliRoot, file) {
  const parts = path.relative(cliRoot, file).split(path.sep)

  if (parts[0] === '' || parts[0] === '..' || path.isAbsolute(parts[0])) {
    return false
  }

  return parts.length === 1 || parts[0] === CLI_DATA_DIR
}

/** `acp.js` picks `bin/acp-cli-signer-<os>` from `os.platform()` (its src/lib/acpCliSigner.ts). */
const SIGNER_PREFIX = 'acp-cli-signer-'
const SIGNER_FOR = { darwin: 'acp-cli-signer-macos', win32: 'acp-cli-signer-windows.exe' }

/** A node-gyp-build prebuild tag (`darwin-arm64`, `darwin-x64+arm64`) that loads on this platform and arch. */
function prebuildRuns(tag, platform, arch) {
  const [os, archs = ''] = tag.split('-')

  return os === platform && archs.split('+').includes(arch)
}

function walkFiles(dir, skip, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (skip.has(full)) {
      continue
    }

    if (entry.isDirectory()) {
      walkFiles(full, skip, out)
    } else {
      out.push(full)
    }
  }

  return out
}

/** What `pruneShipFiles` removes: paths (dirs and files) no command on `platform`/`arch` can load. */
export function shipPrunePlan(nodeModules, { platform = process.platform, arch = process.arch } = {}) {
  const cliRoot = path.join(nodeModules, CLI_NAME)
  const dirs = new Set()

  for (const pkg of listPackages(nodeModules)) {
    for (const entry of readdirSync(pkg, { withFileTypes: true })) {
      const cliData = pkg === cliRoot && entry.name === CLI_DATA_DIR

      if (entry.isDirectory() && NOT_RUNTIME_DIRS.has(entry.name) && !cliData) {
        dirs.add(path.join(pkg, entry.name))
      }
    }

    const prebuilds = path.join(pkg, 'prebuilds')

    if (existsSync(prebuilds)) {
      for (const tag of readdirSync(prebuilds)) {
        if (!prebuildRuns(tag, platform, arch)) {
          dirs.add(path.join(prebuilds, tag))
        }
      }
    }
  }

  const signer = SIGNER_FOR[platform] ?? 'acp-cli-signer-linux'

  const files = walkFiles(nodeModules, dirs, []).filter(file => {
    const name = path.basename(file)

    if (PLACEHOLDER_FILE.test(name)) {
      return true
    }

    if (LEGAL_TEXT.test(name) || isCliData(cliRoot, file)) {
      return false
    }

    return NOT_RUNTIME_FILE.test(name) || (name.startsWith(SIGNER_PREFIX) && name !== signer)
  })

  return [...dirs, ...files]
}

function treeBytes(target) {
  const stat = lstatSync(target)

  if (!stat.isDirectory()) {
    return stat.size
  }

  return readdirSync(target).reduce((sum, name) => sum + treeBytes(path.join(target, name)), 0)
}

/** Remove `dir` and its ancestors below `top` while they are empty (only directories the prune emptied). */
function removeEmptied(dir, top) {
  for (let current = dir; current !== top && current.startsWith(`${top}${path.sep}`); current = path.dirname(current)) {
    if (!existsSync(current) || readdirSync(current).length > 0) {
      return
    }

    rmdirSync(current)
  }
}

/** Remove everything `shipPrunePlan` lists, then the directories it emptied; returns the count and bytes removed. */
export function pruneShipFiles(nodeModules, options) {
  const plan = shipPrunePlan(nodeModules, options)
  let bytes = 0

  for (const target of plan) {
    bytes += treeBytes(target)
    rmSync(target, { recursive: true, force: true })
  }

  for (const parent of new Set(plan.map(target => path.dirname(target)))) {
    removeEmptied(parent, nodeModules)
  }

  return { removed: plan.length, bytes }
}

/**
 * The notices problems that concern the staged ACP CLI (REL-5 R5-5): the section's own ('acp-cli: …'), and every
 * problem that names a package of the staged tree by name@version, whatever its prefix: an unreviewed licence, a
 * missing LGPL/GPL text (ruling 19). Filtering on the prefix alone let a new copyleft package of a byte-matching
 * section stage silently.
 */
export function problemsForAcp({ problems, acp }) {
  const ids = [...(acp?.values() ?? [])].map(row => `${row.name}@${row.version}`)

  return problems.filter(problem => problem.startsWith('acp-cli') || ids.some(id => problem.includes(id)))
}

async function stage() {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
  const root = path.join(scriptsDir, '..', 'build', 'acp-cli')
  const stageDir = path.join(root, 'runtime')
  const pkg = `${CLI_NAME}@${ACP_CLI_VERSION}`

  console.log(`[stage-acp-cli] installing ${pkg} from acp-cli-lock/package-lock.json (npm ci) → ${stageDir}`)

  rmSync(root, { recursive: true, force: true })

  let result

  try {
    result = installPinned(stageDir)
  } catch (error) {
    console.error(`[stage-acp-cli] ${error.message}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    console.error('[stage-acp-cli] npm install failed — the ACP CLI will be missing from this bundle')
    process.exit(1)
  }

  const layout = acpLayout(root)
  const removed = pruneToRuntime(layout.nodeModules)

  console.log(`[stage-acp-cli] pruned ${removed.length} packages outside the runtime closure (build tooling, types)`)
  copyFileSync(path.join(scriptsDir, 'acp-launch.cjs'), layout.launcher)

  // What the read-only runs open on the full tree (data files a `--help` never reads) must survive the ship prune.
  const reads = await traceReads({ root })
  const shipped = pruneShipFiles(layout.nodeModules)

  console.log(
    `[stage-acp-cli] pruned ${shipped.removed} paths no command loads (maps, types, docs, other platforms): ${(shipped.bytes / 1e6).toFixed(1)} MB`
  )

  const lost = reads.filter(file => !existsSync(file))

  if (lost.length > 0) {
    console.error(`[stage-acp-cli] the prune removed ${lost.length} files the read-only runs read, e.g. ${lost[0]}`)
    rmSync(root, { recursive: true, force: true })
    process.exit(1)
  }

  console.log(`[stage-acp-cli] read trace: all ${reads.length} files the read-only runs open survived the prune`)

  // The pruned tree must still answer every verb the app runs, proven on every stage (not once by hand).
  const verdict = await reportAcpTree(root, { sourceRoot: path.join(scriptsDir, '..') })

  if (!verdict.ok) {
    console.error('[stage-acp-cli] refusing to stage a CLI the app could not run')
    rmSync(root, { recursive: true, force: true })
    process.exit(1)
  }

  // The staged tree ships in Resources/acp-cli: THIRD_PARTY_NOTICES.md must list it, byte for byte (REL-2). The tree
  // is kept on a mismatch so `third-party-closure.mjs --write` can regenerate the section from it.
  const notices = checkNotices({ acpTree: stageDir, requireAcp: true })
  const acpProblems = problemsForAcp(notices)

  if (acpProblems.length > 0) {
    for (const problem of acpProblems) {
      console.error(`[stage-acp-cli] ${problem}`)
    }

    console.error(
      '[stage-acp-cli] THIRD_PARTY_NOTICES.md does not match the staged ACP CLI tree: run node scripts/third-party-closure.mjs --write, commit it, rebuild'
    )
    process.exit(1)
  }

  console.log(
    `[stage-acp-cli] ok — ACP CLI ${verdict.version} staged with ${LAUNCHER}; chain list answered ${verdict.chains} chains; notices list its ${notices.acp.size} packages`
  )
}

if (isMain(import.meta.url)) {
  await stage()
}
