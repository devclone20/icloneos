/**
 * V3-S r3 (m-d), r4b (lead ruling 38, revised) — "the runtime icloneOS manages" is decided by WHAT the signed app pins,
 * never by a secret and never by a file anyone could write freely.
 *
 * Round 2 wrote to whatever tree sat at `<HERMES_HOME>/hermes-agent`: with a user's own git checkout there, the gate
 * replaced `plugins/iclone-*`, deleted their `tests/` and reverted an uncommitted edit. Round 3's plain stamp bound
 * nothing (any 64-hex lock hash passed). A tree is managed iff ALL of:
 * (a) its path is exactly the app's runtime folder for the runtime the signed app pins
 *     (`<userData>/hermes-runtime/<sha256>`, iclone-runtime-location.ts), and it is a real directory, never a link;
 * (b) its runtime manifest is byte-for-byte the one the signed app pins (the manifest's sha256 is compiled into the
 *     app), so a tree there is the release's tree or it is not managed;
 * (c) its ICLONE_MANAGED.json stamp is present, well-formed, and names that runtime (`lockHash`) — the app version in
 *     it is informational (r5 m-d″): an app update over the same runtime keeps the tree managed, and the gate refreshes
 *     the stamp's `appVersion` in place after a successful verify (`refreshStampAppVersion`, the stamp file only);
 * and no `.git` exists from each plugin folder up to the runtime root, nor inside a plugin folder (the search stops AT
 * the runtime root: the owner's home directory is itself a git repository).
 * A same-user writer who forges all three can only reproduce the legitimate tree, so no key is needed — and the gate
 * makes no keychain (safeStorage) call at all, so it can never raise the macOS keychain dialog. Anything else is
 * verify-only: never purged, never reinstalled, never deleted; a mismatch is refused with "runtime not managed by the
 * app (why)".
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeJsonAtomicSync } from './lib/fs-json'

export const ICLONE_MANAGED_FILE = 'ICLONE_MANAGED.json'
export const ICLONE_MANAGED_SCHEMA = 2
/** The runtime manifest a managed tree carries at its root (V3-RT copies the bundle's into the tree it installs). */
export const RUNTIME_MANIFEST_FILE = 'RUNTIME_MANIFEST.json'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SHA40_RE = /^[0-9a-f]{40}$/
const MAX_STAMP_BYTES = 4096
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

export interface ManagedStamp {
  appVersion: string
  installId: string
  installedAt: string
  /** sha256 of the pinned runtime source tarball the tree was installed from. */
  lockHash: string
  runtimeSha: string
  schema: typeof ICLONE_MANAGED_SCHEMA
}

export function managedStampFor(options: { appVersion: string; lockHash: string; runtimeSha: string }): ManagedStamp {
  return {
    appVersion: options.appVersion,
    installId: randomUUID(),
    installedAt: new Date().toISOString(),
    lockHash: options.lockHash,
    runtimeSha: options.runtimeSha,
    schema: ICLONE_MANAGED_SCHEMA
  }
}

/** Writes the stamp into `dir` (a staged or installed runtime tree), atomically. */
export function writeManagedStamp(dir: string, stamp: ManagedStamp): void {
  writeJsonAtomicSync(path.join(dir, ICLONE_MANAGED_FILE), stamp)
}

/**
 * r5 (m-d″): after a successful verify of a managed tree, the stamp names this app version again — the stamp file is
 * rewritten (atomically, same install id and install time), nothing else in the tree. Returns whether it changed.
 */
export function refreshStampAppVersion(root: string, stamp: ManagedStamp, appVersion: string): boolean {
  if (stamp.appVersion === appVersion || !appVersion || appVersion.length > 64) {
    return false
  }

  writeManagedStamp(root, { ...stamp, appVersion })

  return true
}

/** The stamp of `root`, or null when it is missing, a link, oversized, or anything but what the app writes. */
export function readManagedStamp(root: string): ManagedStamp | null {
  const file = path.join(root, ICLONE_MANAGED_FILE)

  try {
    const stat = fs.lstatSync(file)

    if (!stat.isFile() || stat.size > MAX_STAMP_BYTES) {
      return null
    }

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

    const ok =
      raw?.schema === ICLONE_MANAGED_SCHEMA &&
      typeof raw.installId === 'string' &&
      UUID_RE.test(raw.installId) &&
      typeof raw.lockHash === 'string' &&
      SHA256_RE.test(raw.lockHash) &&
      typeof raw.runtimeSha === 'string' &&
      SHA40_RE.test(raw.runtimeSha) &&
      typeof raw.appVersion === 'string' &&
      raw.appVersion.length > 0 &&
      raw.appVersion.length <= 64 &&
      typeof raw.installedAt === 'string'

    return ok
      ? {
          appVersion: raw.appVersion as string,
          installId: raw.installId as string,
          installedAt: raw.installedAt as string,
          lockHash: raw.lockHash as string,
          runtimeSha: raw.runtimeSha as string,
          schema: ICLONE_MANAGED_SCHEMA
        }
      : null
  } catch {
    return null
  }
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file)

    return true
  } catch {
    return false
  }
}

/** The first `.git` (directory or file) from `dir` up to `root` inclusive, or inside `dir`; null when there is none. */
export function gitWorkTreeAt(root: string, dir: string): null | string {
  const top = path.resolve(root)
  let current = path.resolve(dir)

  if (path.relative(top, current).startsWith('..')) {
    current = top
  }

  for (;;) {
    if (exists(path.join(current, '.git'))) {
      return path.join(current, '.git')
    }

    if (current === top) {
      break
    }

    current = path.dirname(current)
  }

  const walk = (at: string): null | string => {
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(at, { withFileTypes: true })
    } catch {
      return null
    }

    for (const entry of entries) {
      if (entry.name === '.git') {
        return path.join(at, entry.name)
      }

      if (entry.isDirectory()) {
        const found = walk(path.join(at, entry.name))

        if (found) {
          return found
        }
      }
    }

    return null
  }

  return walk(path.resolve(dir))
}

export type ManagedVerdict = { managed: false; reason: string } | { managed: true; stamp: ManagedStamp }

/** What the signed app pins for the runtime it manages (main/managed-hermes-runtime.ts). */
export interface ManagedPin {
  /** This app's version: informational (written into the stamp, refreshed after an update; never a refusal). */
  appVersion: string
  /** The runtime the app pins (its artifact sha256): the stamp must name it. */
  lockHash: string
  /** The runtime manifest's sha256 compiled into the app; null when this release pins none (nothing is managed). */
  manifestSha256: null | string
  /** The app's runtime folder for that runtime: the only path that can be managed. */
  root: string
}

function sha256OfFile(file: string): null | string {
  try {
    const stat = fs.lstatSync(file)

    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      return null
    }

    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** Whether the app may write into `root` for the plugin folders `targets` (see the module comment). */
export function managedRuntime(root: string, targets: readonly string[], pin: ManagedPin): ManagedVerdict {
  let stat: fs.Stats

  try {
    stat = fs.lstatSync(root)
  } catch {
    return { managed: false, reason: `${root} does not exist` }
  }

  if (stat.isSymbolicLink()) {
    return { managed: false, reason: `${root} is a symbolic link` }
  }

  if (!stat.isDirectory()) {
    return { managed: false, reason: `${root} is not a directory` }
  }

  // (a) the one folder the signed app pins.
  if (path.resolve(root) !== path.resolve(pin.root)) {
    return { managed: false, reason: `${root} is not the app's runtime folder (${pin.root})` }
  }

  // (b) the release's own manifest, byte for byte.
  if (!pin.manifestSha256) {
    return { managed: false, reason: 'this release pins no runtime manifest' }
  }

  const manifest = sha256OfFile(path.join(root, RUNTIME_MANIFEST_FILE))

  if (manifest !== pin.manifestSha256) {
    return {
      managed: false,
      reason: `${root} ${manifest ? 'has a runtime manifest other than' : 'has no runtime manifest of'} this release's (${pin.manifestSha256.slice(0, 12)})`
    }
  }

  // (c) the stamp names that runtime and this app.
  const stamp = readManagedStamp(root)

  if (!stamp) {
    return { managed: false, reason: `${root} has no valid ${ICLONE_MANAGED_FILE} (icloneOS did not install it)` }
  }

  if (stamp.lockHash !== pin.lockHash) {
    return {
      managed: false,
      reason: `${root} was installed from runtime ${stamp.lockHash.slice(0, 12)}, not this release's ${pin.lockHash.slice(0, 12)}`
    }
  }

  for (const target of targets) {
    const git = gitWorkTreeAt(root, target)

    if (git) {
      return { managed: false, reason: `${git} makes it a git work tree` }
    }
  }

  return { managed: true, stamp }
}
