/**
 * V3-RT (K153 / K-S1, RT-3): the Hermes runtime icloneOS runs is the one this release ships, byte for byte.
 *
 * The app bundles a runtime built from its own repository (scripts/runtime-artifact.mjs) with a manifest (path, mode,
 * size, sha256 per file) whose sha256 is compiled into the app (RUNTIME_PIN.manifestSha256). Before every gated spawn
 * the installed runtime is checked against that manifest:
 *
 * - `managed` (the app installed it from this release's bundle: its ICLONE_MANAGED.json stamp, V3-S r3 m-d, names
 *   this pin's commit and tarball sha256; no `.git`): a
 *   missing or changed file is REPAIRED from the bundled tarball (sha256-checked, unpacked beside the runtime, each file
 *   checked against the manifest, renamed over the bad one), then the whole tree is verified again.
 * - `checkout` (a `.git` runtime: a developer's or the owner's clone): verify only, never written. A difference refuses.
 * - anything else (a previous release's runtime, a runtime icloneOS did not install): refused. Since ruling 36 the app's
 *   runtime lives in its own folder (`<userData>/hermes-runtime/<sha>`): the boot path installs it there before any agent
 *   starts and never touches `~/.hermes/hermes-agent` (K-RT2).
 *
 * Files the manifest does not list (the venv, node_modules, caches, launchers) are not the runtime's source and are
 * ignored. Every refusal is an IcloneGateError (`[iclone-gate]`): the caller spawns nothing.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { extractTarball } from './bootstrap-runner'
import { IcloneGateError } from './iclone-hermes-plugins'
import { readManagedStamp, refreshStampAppVersion, RUNTIME_MANIFEST_FILE } from './iclone-managed-runtime'
import { checkRuntimeDependencies, unlistedRuntimeFiles } from './iclone-runtime-closed'

export { RUNTIME_MANIFEST_FILE }
export const RUNTIME_SOURCE_MARKER = '.iclone-source.json'
export const RUNTIME_INTEGRITY_TAG = '[iclone-runtime]'
const REPAIR_PREFIX = '.iclone-runtime-repair-'

const SHA40_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export type ManifestMode = '644' | '755' | 'link'
export type ManifestRow = [path: string, mode: ManifestMode, size: number, sha256: string]

export interface RuntimeManifest {
  bytes: number
  entries: ManifestRow[]
  files: number
  sha: string
  upstream: string
}

/** The fields of the compiled pin the integrity check needs. */
export interface IntegrityPin {
  manifestSha256: string
  sha: string
  source: string
  tarballSha256: string
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** A manifest path is relative, forward-slashed and never climbs out of the runtime. */
function safeRelPath(rel: string): boolean {
  return (
    rel.length > 0 &&
    !rel.startsWith('/') &&
    !rel.includes('\\') &&
    !rel.includes('\0') &&
    rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

export function parseRuntimeManifest(text: string): RuntimeManifest {
  const value = JSON.parse(text) as Partial<RuntimeManifest> & { schema?: unknown; source?: unknown }

  if (
    value?.schema !== 1 ||
    value.source !== 'repo' ||
    !SHA40_RE.test(String(value.sha)) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== value.files
  ) {
    throw new Error('not a runtime manifest (schema 1, source repo)')
  }

  const seen = new Set<string>()

  for (const row of value.entries as unknown[]) {
    const [rel, mode, size, digest] = Array.isArray(row) ? row : []

    if (
      typeof rel !== 'string' ||
      !safeRelPath(rel) ||
      seen.has(rel) ||
      !['644', '755', 'link'].includes(String(mode)) ||
      !Number.isInteger(size) ||
      !SHA256_RE.test(String(digest))
    ) {
      throw new Error(`bad manifest row ${JSON.stringify(row).slice(0, 120)}`)
    }

    seen.add(rel)
  }

  return value as RuntimeManifest
}

/** The bundled manifest, only when its bytes are the ones the compiled pin names. */
export function loadBundledManifest(
  bundleDir: null | string,
  pin: IntegrityPin
): { error: string } | { manifest: RuntimeManifest } {
  if (pin.source !== 'repo' || !SHA256_RE.test(pin.manifestSha256)) {
    return { error: 'this build of icloneOS pins no runtime manifest' }
  }

  if (!bundleDir) {
    return { error: 'the app bundle has no runtime folder' }
  }

  let bytes: Buffer

  try {
    bytes = fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE))
  } catch {
    return { error: `the app bundle has no ${RUNTIME_MANIFEST_FILE}; reinstall icloneOS` }
  }

  if (sha256(bytes) !== pin.manifestSha256) {
    return { error: `the app bundle's ${RUNTIME_MANIFEST_FILE} is not the one this release pins; reinstall icloneOS` }
  }

  try {
    const manifest = parseRuntimeManifest(bytes.toString('utf8'))

    return manifest.sha === pin.sha
      ? { manifest }
      : { error: `the bundled manifest names ${manifest.sha.slice(0, 12)}, not the pin` }
  } catch (error) {
    return { error: `the bundled ${RUNTIME_MANIFEST_FILE} cannot be read (${(error as Error).message})` }
  }
}

export interface TreeCheck {
  /** Present but not the manifest's bytes, mode or kind. */
  changed: string[]
  missing: string[]
  ms: number
  ok: boolean
}

/**
 * Hashes every manifest file under `root`. A file must be a regular file (a link only where the manifest has a link),
 * with the manifest's size, exec bit and sha256; no directory on its way may be a link (a linked directory could hold
 * the same bytes today and others tomorrow).
 */
export function verifyRuntimeTree(root: string, manifest: RuntimeManifest, now: () => number = Date.now): TreeCheck {
  const started = now()
  const changed: string[] = []
  const missing: string[] = []
  const dirs = new Map<string, boolean>()

  const dirOk = (rel: string): boolean => {
    if (!rel) {
      return true
    }

    const cached = dirs.get(rel)

    if (cached !== undefined) {
      return cached
    }

    let ok = dirOk(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))

    if (ok) {
      try {
        ok = fs.lstatSync(path.join(root, rel)).isDirectory()
      } catch {
        ok = false
      }
    }

    dirs.set(rel, ok)

    return ok
  }

  for (const [rel, mode, size, digest] of manifest.entries) {
    const parent = path.posix.dirname(rel)

    if (!dirOk(parent === '.' ? '' : parent)) {
      missing.push(rel)

      continue
    }

    const file = path.join(root, rel)
    let st: fs.Stats

    try {
      st = fs.lstatSync(file)
    } catch {
      missing.push(rel)

      continue
    }

    try {
      if (mode === 'link') {
        if (!st.isSymbolicLink() || sha256(fs.readlinkSync(file)) !== digest) {
          changed.push(rel)
        }
      } else if (
        !st.isFile() ||
        st.size !== size ||
        ((st.mode & 0o111) !== 0) !== (mode === '755') ||
        sha256(fs.readFileSync(file)) !== digest
      ) {
        changed.push(rel)
      }
    } catch {
      changed.push(rel)
    }
  }

  return { changed, missing, ms: now() - started, ok: changed.length === 0 && missing.length === 0 }
}

export type RuntimeOwnership =
  | { kind: 'absent' }
  | { kind: 'checkout' }
  | { kind: 'foreign' }
  | { kind: 'managed'; sha: string }
  | { kind: 'previous-bundle'; sha: string; source: string }

interface SourceMarker {
  manifestSha256?: string
  sha?: string
  sha256?: string
  source?: string
}

function readMarker(root: string): null | SourceMarker {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, RUNTIME_SOURCE_MARKER), 'utf8')) as SourceMarker

    return value && typeof value.sha === 'string' && SHA40_RE.test(value.sha) ? value : null
  } catch {
    return null
  }
}

/**
 * Who owns the runtime at `root`, by what is IN it (never by where it is): a `.git` is a checkout (verify only); the
 * app's ICLONE_MANAGED.json stamp (written only when the app installs a runtime tree) says the app manages it and from
 * which pin; the source marker says which release's bundle a tree without this pin's stamp came from (0.0.2 wrote a
 * `codeload` marker and no stamp).
 */
export function runtimeOwnership(root: string, pin: IntegrityPin): RuntimeOwnership {
  try {
    if (!fs.lstatSync(root).isDirectory()) {
      return { kind: 'foreign' }
    }
  } catch {
    return { kind: 'absent' }
  }

  if (fs.existsSync(path.join(root, '.git'))) {
    return { kind: 'checkout' }
  }

  const stamp = readManagedStamp(root)

  if (stamp && stamp.runtimeSha === pin.sha && stamp.lockHash === pin.tarballSha256) {
    return { kind: 'managed', sha: stamp.runtimeSha }
  }

  const marker = readMarker(root)

  if (stamp) {
    return { kind: 'previous-bundle', sha: stamp.runtimeSha, source: marker?.source ?? 'stamp' }
  }

  return marker?.sha && (marker.source === 'codeload' || marker.source === 'repo')
    ? { kind: 'previous-bundle', sha: marker.sha, source: marker.source }
    : { kind: 'foreign' }
}

export type Extract = (archive: string, destDir: string) => Promise<void>

/** The installer's own extraction (macOS bsdtar, `--strip-components 1`, no `-P`: absolute members and `..` refused). */
export const extractRuntimeTarball: Extract = (archive, destDir) => extractTarball(archive, destDir)

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')

  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

/** Rewrites exactly `bad` from the bundled tarball; every replacement is checked against the manifest first. */
async function repairFiles(options: {
  bad: string[]
  bundleDir: string
  extract: Extract
  manifest: RuntimeManifest
  pin: IntegrityPin
  root: string
}): Promise<void> {
  const { bad, bundleDir, extract, manifest, pin, root } = options
  const tarball = path.join(bundleDir, `hermes-agent-${pin.sha}.tar.gz`)

  if (!fs.existsSync(tarball) || (await sha256File(tarball)) !== pin.tarballSha256) {
    throw new Error('the runtime that ships inside icloneOS is missing or damaged; reinstall icloneOS')
  }

  // Beside the runtime (one rename per file, same filesystem), never inside it.
  const stage = fs.mkdtempSync(path.join(path.dirname(root), REPAIR_PREFIX))

  try {
    await extract(tarball, stage)

    const rows = new Map(manifest.entries.map(row => [row[0], row]))
    const one = { entries: [] as ManifestRow[], bytes: 0, files: 0, sha: manifest.sha, upstream: manifest.upstream }

    for (const rel of bad) {
      const row = rows.get(rel)!
      one.entries = [row]
      one.files = 1

      if (!verifyRuntimeTree(stage, one).ok) {
        throw new Error(`the bundled copy of ${rel} does not match the manifest`)
      }

      const target = path.join(root, rel)
      const parts = rel.split('/')

      // Never write through a link: a linked folder inside the runtime is refused, not followed.
      for (let i = 1; i < parts.length; i++) {
        const dir = path.join(root, ...parts.slice(0, i))

        try {
          if (fs.lstatSync(dir).isSymbolicLink()) {
            throw new Error(`${parts.slice(0, i).join('/')} is a link inside the runtime`)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }

      fs.mkdirSync(path.dirname(target), { recursive: true })

      try {
        if (fs.lstatSync(target).isDirectory()) {
          fs.rmSync(target, { force: true, recursive: true })
        }
      } catch {
        // Missing: the rename creates it.
      }

      fs.renameSync(path.join(stage, rel), target)
    }
  } finally {
    fs.rmSync(stage, { force: true, recursive: true })
  }
}

/** Stage folders of a repair that died half-way (any process). */
export function sweepRepairStages(root: string): void {
  const parent = path.dirname(root)

  try {
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(REPAIR_PREFIX)) {
        fs.rmSync(path.join(parent, name), { force: true, recursive: true })
      }
    }
  } catch {
    // Nothing to sweep.
  }
}

/**
 * After a managed tree verified (or was repaired): the release's manifest is at its root (V3-S r4b's check b) and its
 * stamp names this app version (check c) — written in place, the tree itself untouched. An app update that keeps the
 * runtime sha therefore never reinstalls it.
 */
function refreshManagedTree(
  root: string,
  bundleDir: null | string,
  appVersion: string | undefined,
  log: (line: string) => void
) {
  if (bundleDir) {
    const want = fs.readFileSync(path.join(bundleDir, RUNTIME_MANIFEST_FILE))
    const file = path.join(root, RUNTIME_MANIFEST_FILE)
    let have: Buffer | null = null

    try {
      have = fs.readFileSync(file)
    } catch {
      have = null
    }

    if (!have || !have.equals(want)) {
      fs.writeFileSync(`${file}.tmp`, want)
      fs.renameSync(`${file}.tmp`, file)
      log(`${RUNTIME_INTEGRITY_TAG} the runtime's manifest copy was restored from the app bundle`)
    }
  }

  const stamp = readManagedStamp(root)

  if (appVersion && stamp && refreshStampAppVersion(root, stamp, appVersion)) {
    log(
      `${RUNTIME_INTEGRITY_TAG} stamp brought to icloneOS ${appVersion} (was ${stamp.appVersion}); the runtime is unchanged`
    )
  }
}

export interface IntegrityReport {
  action: 'repaired' | 'skipped' | 'verified' | 'verified-checkout'
  files: number
  ms: number
  repaired?: string[]
}

const listSome = (paths: string[]) =>
  `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, … (${paths.length})` : ''}`

/**
 * RT-3: the runtime at `root` is this release's runtime, or it is made so (managed), or the spawn is refused. Called by
 * prepareHermesSpawn before the plugin gate; a packaged build only (a dev run's runtime is the repository itself).
 */
/** The runtime's top-level package; a folder holding it anywhere but the runtime root is an importable copy. */
const RUNTIME_PACKAGE = 'hermes_cli'

/**
 * V3-RT K-RT15b (lead decision): every importable copy of the runtime package under the app's runtime folder other
 * than the verified tree itself — a `hermes_cli/__init__.py` anywhere below `<root>/.iclone-deps` (PM's build
 * snapshots, a stray environment). Links are not followed. Paths are the copies' package folders.
 */
export function runtimeCopiesOutsideTree(root: string): string[] {
  const deps = path.join(root, '.iclone-deps')
  const found: string[] = []
  const stack = fs.existsSync(deps) ? [deps] : []

  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }

      const child = path.join(dir, entry.name)

      if (entry.name === RUNTIME_PACKAGE && fs.existsSync(path.join(child, '__init__.py'))) {
        found.push(child)
      } else {
        stack.push(child)
      }
    }
  }

  return found.sort()
}

/**
 * M1 (closed world): every file of the managed tree that is not a manifest row (and not one of the installer's own
 * root files, nor below `.iclone-deps`) is removed before Python starts — a planted `sitecustomize.py`, a module named
 * like the standard library, a `.so` beside a verified `.py`, a `.pyc` the manifest does not list.
 */
function removeUnlistedFiles(root: string, manifest: RuntimeManifest, log: (line: string) => void): void {
  const extra = unlistedRuntimeFiles(root, new Set(manifest.entries.map(row => row[0])))

  for (const rel of extra) {
    fs.rmSync(path.join(root, rel), { force: true })
  }

  if (extra.length > 0) {
    log(`${RUNTIME_INTEGRITY_TAG} removed ${extra.length} file(s) the manifest does not list: ${listSome(extra)}`)
  }
}

/** M1: the dependency environment against its install-time record (unlisted files removed; a change refuses). */
function enforceDependencies(root: string, log: (line: string) => void): void {
  const deps = checkRuntimeDependencies(root)

  if (deps.removed.length > 0) {
    log(
      `${RUNTIME_INTEGRITY_TAG} removed ${deps.removed.length} file(s) the Python environment's record does not list: ${listSome(deps.removed)}`
    )
  }

  if (deps.problem) {
    throw new IcloneGateError(
      `${deps.problem}${deps.changed.length + deps.missing.length > 0 ? ` (${listSome([...deps.changed, ...deps.missing])})` : ''}. Use Repair install to reinstall the runtime this release ships.`
    )
  }

  log(`${RUNTIME_INTEGRITY_TAG} Python environment verified against its install record (${deps.ms} ms)`)
}

/** Removes the copies runtimeCopiesOutsideTree finds (a copy is never run, whatever made it). */
function removeRuntimeCopies(root: string, log: (line: string) => void): void {
  for (const copy of runtimeCopiesOutsideTree(root)) {
    fs.rmSync(copy, { force: true, recursive: true })
    log(`${RUNTIME_INTEGRITY_TAG} removed an unverified copy of the runtime package: ${path.relative(root, copy)}`)
  }
}

export async function ensureRuntimeIntegrity(options: {
  /** This app's version: a managed tree's stamp is brought to it after a verify (an app update with the same runtime
   *  sha keeps its tree; the version in the stamp is information only — lead ruling). */
  appVersion?: string
  bundleDir: null | string
  extract?: Extract
  log: (line: string) => void
  now?: () => number
  packaged: boolean
  pin: IntegrityPin
  root: string
  /** Ruling 36: the app's own runtime folder; any other tree is not managed, whatever it holds. */
  managedRoot?: string
}): Promise<IntegrityReport> {
  const { bundleDir, log, pin, root } = options
  const now = options.now ?? Date.now
  const started = now()

  if (!options.packaged) {
    return { action: 'skipped', files: 0, ms: 0 }
  }

  const loaded = loadBundledManifest(bundleDir, pin)

  if ('error' in loaded) {
    throw new IcloneGateError(loaded.error)
  }

  const { manifest } = loaded
  const elsewhere = options.managedRoot !== undefined && path.resolve(root) !== path.resolve(options.managedRoot)

  const owner =
    elsewhere && runtimeOwnership(root, pin).kind === 'managed'
      ? { kind: 'foreign' as const }
      : runtimeOwnership(root, pin)

  if (owner.kind !== 'managed' && owner.kind !== 'checkout') {
    const what =
      owner.kind === 'previous-bundle'
        ? `the agent runtime at ${root} is a previous release's (${owner.sha.slice(0, 12)}), not this release's`
        : owner.kind === 'absent'
          ? `no agent runtime is installed at ${root}`
          : `the agent runtime at ${root} was not installed by icloneOS`

    throw new IcloneGateError(`${what}. Use Repair install to install the runtime this release ships.`)
  }

  const check = verifyRuntimeTree(root, manifest, now)

  if (check.ok) {
    if (owner.kind === 'managed') {
      refreshManagedTree(root, bundleDir, options.appVersion, log)
      removeRuntimeCopies(root, log)
      removeUnlistedFiles(root, manifest, log)
      enforceDependencies(root, log)
    }

    log(
      `${RUNTIME_INTEGRITY_TAG} ${owner.kind === 'checkout' ? 'checkout' : 'runtime'} ${pin.sha.slice(0, 12)} verified: ${manifest.files} files (${check.ms} ms)`
    )

    return {
      action: owner.kind === 'checkout' ? 'verified-checkout' : 'verified',
      files: manifest.files,
      ms: now() - started
    }
  }

  const bad = [...check.missing, ...check.changed]
  const detail = `${check.changed.length} changed, ${check.missing.length} missing: ${listSome(bad)}`

  if (owner.kind === 'checkout' || !bundleDir) {
    throw new IcloneGateError(
      `the agent runtime at ${root} is a git checkout that differs from the runtime this release ships (${detail}). icloneOS never writes a checkout`
    )
  }

  log(
    `${RUNTIME_INTEGRITY_TAG} runtime differs from this release's manifest (${detail}); repairing from the app bundle`
  )
  sweepRepairStages(root)

  try {
    await repairFiles({ bad, bundleDir, extract: options.extract ?? extractRuntimeTarball, manifest, pin, root })
  } catch (error) {
    throw new IcloneGateError(`the agent runtime could not be repaired (${(error as Error).message})`)
  }

  const after = verifyRuntimeTree(root, manifest, now)

  if (!after.ok) {
    throw new IcloneGateError(
      `the agent runtime still differs from this release's after a repair (${listSome([...after.missing, ...after.changed])})`
    )
  }

  refreshManagedTree(root, bundleDir, options.appVersion, log)
  removeRuntimeCopies(root, log)
  removeUnlistedFiles(root, manifest, log)
  enforceDependencies(root, log)
  log(`${RUNTIME_INTEGRITY_TAG} repaired ${bad.length} file(s) from the app bundle: ${listSome(bad)}`)

  return { action: 'repaired', files: manifest.files, ms: now() - started, repaired: bad }
}
