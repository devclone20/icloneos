/**
 * V3-RT M1 (critic r1, lead decision): the managed runtime is a CLOSED WORLD before every spawn.
 *
 * 1. The runtime tree holds exactly the release manifest's files plus a short list of files the installer writes at
 *    its root (`ROOT_ALLOW`) and the dependency folder `.iclone-deps`. Anything else — a `sitecustomize.py`, a module
 *    named like the standard library, a `.so` beside a verified `.py`, a `.pyc` the manifest does not list — is
 *    removed before Python starts (`unlistedRuntimeFiles`).
 * 2. The dependency environment (the committed venv and the Python installation it runs on, both under `.iclone-deps`)
 *    holds exactly what the installer left: `sealRuntimeDependencies` records every file, link and executable bit right
 *    after an install (`ICLONE_DEPS_MANIFEST.json`, bound to the install stamp's id); `checkRuntimeDependencies`
 *    removes any file it does not list (a `.pth`, a `sitecustomize`, a stray module or `.pyc`) and reports any file
 *    that changed or went missing — the caller refuses the spawn (only a reinstall can restore a dependency).
 * 3. Critic r2 M1: a record is only ever written over bytes the installer has just made from nothing. Every install
 *    of the managed runtime (first launch, Repair install, a pinned update) starts with
 *    `prepareDependencyInstall`, which deletes the whole dependency folder (uv, its cache, the Python installation,
 *    PM's own runtime, every environment), the launchers and the old record, and hands back a one-use capability.
 *    `sealRuntimeDependencies` records nothing without it, and checks every installed package file against the
 *    hash its wheel's RECORD gives before it records — so the files the installer found "already in place" (an edited
 *    dependency) can never be blessed: they are gone before the installer runs, and the installer fetches what the
 *    shipped lock pins (uv checks each wheel against the lock's hashes).
 *
 * Links are recorded and compared as links, never followed.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { readManagedStamp } from './iclone-managed-runtime'
import { pmCommittedVenv } from './pm-venv'

export type ClosedMode = '644' | '755' | 'link'
export type ClosedRow = [rel: string, mode: ClosedMode, size: number, sha256: string]

/** Files the installer writes at the runtime root, outside the release manifest. */
export const ROOT_ALLOW: ReadonlySet<string> = new Set([
  '.hermes-bootstrap-complete',
  '.iclone-source.json',
  'ICLONE_DEPS_MANIFEST.json',
  'ICLONE_MANAGED.json',
  'RUNTIME_MANIFEST.json'
])

export const DEPS_DIR = '.iclone-deps'
/** The runtime's own launchers (`hermes`, `hermes-acp`), written by the installer; children of the runtime run them. */
export const LAUNCHERS_DIR = '.hermes/bin'
export const DEPS_MANIFEST_FILE = 'ICLONE_DEPS_MANIFEST.json'
const DEPS_SCHEMA = 1

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** One fresh install of the dependency folder: made by `prepareDependencyInstall`, consumed by one seal. */
export interface FreshDependencyInstall {
  readonly root: string
}

const FRESH = new WeakSet<FreshDependencyInstall>()

/**
 * Before the installer runs on the app's runtime at `root`: everything an earlier install left (the dependency folder,
 * the launchers, the record) is deleted, so nothing that predates this install can be recorded after it.
 */
export function prepareDependencyInstall(root: string): FreshDependencyInstall {
  for (const rel of [DEPS_DIR, LAUNCHERS_DIR, DEPS_MANIFEST_FILE, `${DEPS_MANIFEST_FILE}.tmp`]) {
    fs.rmSync(path.join(root, rel), { force: true, recursive: true })
  }

  const fresh: FreshDependencyInstall = Object.freeze({ root: path.resolve(root) })
  FRESH.add(fresh)

  return fresh
}

/** RECORD rows of every distribution in a site-packages folder whose installed bytes differ from the wheel's hash. */
export function distributionFilesChanged(site: string): string[] {
  const changed: string[] = []
  const base = path.resolve(site)

  for (const entry of fs.existsSync(site) ? fs.readdirSync(site) : []) {
    if (!entry.endsWith('.dist-info')) {
      continue
    }

    let record: string

    try {
      record = fs.readFileSync(path.join(site, entry, 'RECORD'), 'utf8')
    } catch {
      continue
    }

    for (const line of record.split('\n')) {
      // `path,sha256=<urlsafe base64, no padding>,size` (a path holding a comma is quoted; those rows are skipped).
      const m = /^([^,"]+),sha256=([A-Za-z0-9_-]+),\d*$/.exec(line.trim())

      if (!m) {
        continue
      }

      const file = path.resolve(base, m[1] as string)

      if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
        continue
      }

      const digest = createHash('sha256').update(fs.readFileSync(file)).digest('base64url')

      if (digest !== m[2]) {
        changed.push(`${entry.replace(/\.dist-info$/, '')}: ${m[1]}`)
      }
    }
  }

  return changed.sort()
}

/** Every site-packages folder below `dir` (a venv, the Python installation, each of PM's runtime generations). */
function sitePackagesBelow(dir: string): string[] {
  const out: string[] = []
  const stack = [dir]

  while (stack.length > 0) {
    const current = stack.pop() as string

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }

      const child = path.join(current, entry.name)

      if (entry.name === 'site-packages') {
        out.push(child)
      } else if (!entry.name.endsWith('.dist-info') && path.relative(dir, child).split(path.sep).length < 6) {
        stack.push(child)
      }
    }
  }

  return out.sort()
}

/** Every file and link below `dir` (relative, posix separators); directories are walked, links are not followed. */
function walk(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = []
  const stack = ['']

  while (stack.length > 0) {
    const rel = stack.pop() as string
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name

      if (skip(child)) {
        continue
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(child)
      } else {
        out.push(child)
      }
    }
  }

  return out.sort()
}

/** Everything in the runtime tree that is neither a manifest row, nor `ROOT_ALLOW`, nor below `.iclone-deps`. */
export function unlistedRuntimeFiles(root: string, listed: ReadonlySet<string>): string[] {
  return walk(root, rel => rel === DEPS_DIR || rel === LAUNCHERS_DIR || rel === '.git').filter(
    rel => !listed.has(rel) && !ROOT_ALLOW.has(rel)
  )
}

function rowOf(dir: string, rel: string): ClosedRow {
  const file = path.join(dir, rel)
  const st = fs.lstatSync(file)

  if (st.isSymbolicLink()) {
    return [rel, 'link', 0, sha256(fs.readlinkSync(file))]
  }

  return [rel, (st.mode & 0o111) !== 0 ? '755' : '644', st.size, sha256(fs.readFileSync(file))]
}

/**
 * The folders the installer wrote whose code a runtime process runs: the Python installation, the committed
 * environment, and the runtime's launchers (when the installer published them).
 */
export function dependencyFolders(root: string): string[] | { error: string } {
  const roots = dependencyRoots(root)

  if ('error' in roots) {
    return roots
  }

  const launchers = path.join(root, LAUNCHERS_DIR)
  // Critic r2 m1: PM's own runtime (its generations of the `pm` tool's environment) is Python code in the app folder
  // too; it is recorded with the rest, so a file planted in it is removed before a spawn like any other.
  const pmRuntime = path.join(path.dirname(path.dirname(path.dirname(roots.venv))), 'pm-runtime')

  return [
    roots.python,
    roots.venv,
    ...(fs.existsSync(pmRuntime) ? [pmRuntime] : []),
    ...(fs.existsSync(launchers) ? [launchers] : [])
  ]
}

/** The two folders whose code a runtime Python loads: the committed environment and the Python it was made from. */
export function dependencyRoots(root: string): { python: string; venv: string } | { error: string } {
  const deps = path.join(root, DEPS_DIR)
  const venv = pmCommittedVenv(root, path.join(deps, 'hermes'))

  if (!venv) {
    return { error: 'no committed Python environment' }
  }

  const home = /^home\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8'))?.[1]?.trim()
  const python = home ? path.dirname(path.resolve(home)) : ''
  const inside = (p: string) => path.resolve(p).startsWith(path.resolve(deps) + path.sep)

  if (!inside(venv) || !python || !inside(python)) {
    return { error: 'the Python environment is not inside the runtime folder' }
  }

  return { python, venv }
}

/** Ruling 57.2: the distributions the runtime environment must never hold (shipped with PM in the verified tree). */
export const VENV_EXCLUSIONS_FILE = 'pm/runtime-venv-exclusions.txt'

const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Every excluded distribution (ruling 57.2) installed in the committed environment — by its dist-info folder. Throws
 * when the list itself is missing (fail closed). */
export function excludedDistributionsIn(root: string, venv: string): string[] {
  let names: string[]

  try {
    names = fs
      .readFileSync(path.join(root, VENV_EXCLUSIONS_FILE), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(pep503)
  } catch {
    // Critic r2 m4: no list is no proof — the environment is refused, never taken as clean.
    throw new Error(`the telemetry exclusion list (${VENV_EXCLUSIONS_FILE}) is missing`)
  }

  const wanted = new Set(names)
  const found: string[] = []
  const lib = path.join(venv, 'lib')

  for (const py of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
    const site = path.join(lib, py, 'site-packages')

    for (const entry of fs.existsSync(site) ? fs.readdirSync(site) : []) {
      const m = /^(.+?)-[^-]+\.dist-info$/.exec(entry)

      if (m && wanted.has(pep503(m[1] as string))) {
        found.push(entry)
      }
    }
  }

  return found.sort()
}

interface DepsManifest {
  installId: string
  roots: { rel: string; rows: ClosedRow[] }[]
  runtimeSha: string
  schema: number
}

/**
 * Right after an install that `prepareDependencyInstall` started: records the dependency environment, bound to the
 * install stamp. Without that capability (or with one already used) nothing is recorded: the bytes would predate the
 * install. A package file that differs from its wheel's hash refuses too — never recorded, never run.
 */
export function sealRuntimeDependencies(root: string, fresh: FreshDependencyInstall | null): { files: number } {
  if (!fresh || !FRESH.has(fresh) || fresh.root !== path.resolve(root)) {
    throw new Error('the Python environment was not made by an install from nothing; it is not recorded')
  }

  FRESH.delete(fresh)

  const stamp = readManagedStamp(root)
  const roots = dependencyFolders(root)

  if (!stamp) {
    throw new Error('the runtime has no install stamp')
  }

  if ('error' in roots) {
    throw new Error(roots.error)
  }

  const telemetry = excludedDistributionsIn(root, roots[1] as string)

  if (telemetry.length > 0) {
    throw new Error(`the Python environment holds excluded telemetry distributions: ${telemetry.join(', ')}`)
  }

  const changed = roots.flatMap(dir => sitePackagesBelow(dir).flatMap(site => distributionFilesChanged(site)))

  if (changed.length > 0) {
    throw new Error(
      `${changed.length} installed package file(s) differ from the packages they were installed from: ${changed.slice(0, 3).join('; ')}`
    )
  }

  const manifest: DepsManifest = {
    installId: stamp.installId,
    roots: roots.map(dir => ({
      rel: path.relative(root, dir).split(path.sep).join('/'),
      rows: walk(dir).map(rel => rowOf(dir, rel))
    })),
    runtimeSha: stamp.runtimeSha,
    schema: DEPS_SCHEMA
  }

  const file = path.join(root, DEPS_MANIFEST_FILE)
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest)}\n`)
  fs.renameSync(`${file}.tmp`, file)

  return { files: manifest.roots.reduce((n, r) => n + r.rows.length, 0) }
}

export interface DepsCheck {
  changed: string[]
  missing: string[]
  ms: number
  problem: null | string
  removed: string[]
}

/** Before a spawn: the dependency environment against its install-time record; unlisted files are removed. */
export function checkRuntimeDependencies(root: string, now: () => number = Date.now): DepsCheck {
  const started = now()
  const result: DepsCheck = { changed: [], missing: [], ms: 0, problem: null, removed: [] }
  const done = (problem: null | string) => ({ ...result, ms: now() - started, problem })
  let manifest: DepsManifest

  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, DEPS_MANIFEST_FILE), 'utf8')) as DepsManifest
  } catch {
    return done('the Python environment was never recorded by the installer')
  }

  const stamp = readManagedStamp(root)
  const roots = dependencyFolders(root)

  if (manifest.schema !== DEPS_SCHEMA || !stamp || manifest.installId !== stamp.installId) {
    return done("the Python environment's record does not belong to this install")
  }

  if ('error' in roots) {
    return done(roots.error)
  }

  let telemetry: string[]

  try {
    telemetry = excludedDistributionsIn(root, roots[1] as string)
  } catch (error) {
    return done((error as Error).message)
  }

  if (telemetry.length > 0) {
    return done(`the Python environment holds excluded telemetry distributions (${telemetry.join(', ')})`)
  }

  const current = roots.map(dir => path.relative(root, dir).split(path.sep).join('/'))

  if (JSON.stringify(current) !== JSON.stringify(manifest.roots.map(r => r.rel))) {
    return done('the Python environment was replaced outside the app')
  }

  for (const { rel: base, rows } of manifest.roots) {
    const dir = path.join(root, base)
    const listed = new Map(rows.map(row => [row[0], row]))

    for (const [rel, mode, size, digest] of rows) {
      let row: ClosedRow

      try {
        row = rowOf(dir, rel)
      } catch {
        result.missing.push(`${base}/${rel}`)

        continue
      }

      if (row[1] !== mode || row[2] !== size || row[3] !== digest) {
        result.changed.push(`${base}/${rel}`)
      }
    }

    for (const rel of walk(dir)) {
      if (!listed.has(rel)) {
        fs.rmSync(path.join(dir, rel), { force: true })
        result.removed.push(`${base}/${rel}`)
      }
    }
  }

  const bad = result.changed.length + result.missing.length

  return done(bad > 0 ? `${bad} file(s) of the Python environment changed or are missing` : null)
}

/**
 * From V3-RT-B r2 (ruling 42): whether the app's runtime at `root` is a finished install — its stamp and the
 * environment record the installer wrote right after a successful install, bound together. File reads only: no Python
 * probe on the boot path (the import question was answered when PM checked the environment it built, and the closed
 * world before every spawn holds it to that record).
 */
export function isRecordedInstall(root: string): boolean {
  try {
    const stamp = readManagedStamp(root)
    const record = JSON.parse(fs.readFileSync(path.join(root, DEPS_MANIFEST_FILE), 'utf8')) as Partial<DepsManifest>

    return Boolean(stamp) && record.schema === DEPS_SCHEMA && record.installId === stamp?.installId
  } catch {
    return false
  }
}
