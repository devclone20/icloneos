/**
 * REL-6 — the installed ACP CLI tree's manifest: every file's sha256, size and mode, the tree's own digest, and an
 * HMAC over the whole body with a key the OS seals (safeStorage → Keychain), so a process that can write userData can
 * neither change a file unseen nor re-write the manifest to match.
 *
 * NO UNSEALED TREE (critic M2, lead ruling on m7). A check needs the sealed key and a manifest MAC that verifies with
 * it. No sealer (the OS or session cannot seal) ⇒ `unsealable`; a key file that is missing, is not a plain file, or
 * does not open ⇒ `key-unopenable`. Both are refusals: deleting, replacing or locking the key file can only make the
 * tree refuse, never run unsigned. Only an install (the owner's click, audited) may write a new key.
 *
 * Two checks:
 *   - full: walk the tree; the set of files must be EXACTLY the manifest's (an extra file is a refusal: Node would load
 *     `foo.js` before `foo/index.js`), no symlink or other type anywhere, every sha256 and mode equal. Returns a stat
 *     snapshot of every file and directory.
 *   - quick (before every spawn): lstat every snapshotted path; any change of inode, size, mtime, ctime or mode (ctime
 *     cannot be set back from user space) sends the caller to a full check. A quick pass is only ever a "nothing moved
 *     since the last full pass".
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fsp, lstatSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import type { AcpToolsProblemInfo } from '../../src/iclone-shared/acp-tools'
import { writeFileAtomicSync } from '../lib/atomic-write'

export const MANIFEST_FILE = 'MANIFEST.json'
export const KEY_FILE = 'manifest-key.sealed'
const STAT_CONCURRENCY = 64

export interface ManifestEntry {
  sha256: string
  size: number
  mode: number
  /** `app`: bytes the app shipped (ruling 33's Team-signed native add-ons), swapped in over npm's copy. */
  source?: 'app'
}

export interface ManifestBody {
  v: 1
  lockSha256: string
  cliVersion: string
  target: string
  createdAt: string
  packages: number
  /** The app's add-on list this tree was built with (native.ts `addonsDigest`): `none`, or a sha256. */
  addons: string
  files: Record<string, ManifestEntry>
  treeSha256: string
}

export interface AcpManifest extends ManifestBody {
  /** HMAC-SHA256 (hex) of the canonical body with the sealed key. Always present: there is no unsealed tree. */
  mac: string
}

/** The OS sealing seam (V3-F keys.ts shape): main passes safeStorage; tests pass a double. */
export interface KeySealer {
  seal: (plain: string) => string
  unseal: (sealed: string) => string
}

export interface StatMark {
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  mode: number
}

export type Snapshot = Map<string, StatMark>

export type VerifyResult = { ok: true; snapshot: Snapshot } | ({ ok: false } & AcpToolsProblemInfo)

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** One line per file, sorted. scripts/acp-launch.cjs computes the same digest (it must stay byte-identical). */
export function treeDigest(files: Record<string, ManifestEntry>): string {
  const hash = createHash('sha256')

  for (const key of Object.keys(files).sort()) {
    const entry = files[key] as ManifestEntry

    hash.update(
      `${key}\0${entry.sha256}\0${entry.size}\0${entry.mode.toString(8)}${entry.source ? `\0${entry.source}` : ''}\n`
    )
  }

  return hash.digest('hex')
}

/** The body in a fixed key order, files sorted: what the MAC covers. */
export function canonicalBody(body: ManifestBody): string {
  const files: Record<string, ManifestEntry> = {}

  for (const key of Object.keys(body.files).sort()) {
    const entry = body.files[key] as ManifestEntry

    files[key] = {
      sha256: entry.sha256,
      size: entry.size,
      mode: entry.mode,
      ...(entry.source ? { source: entry.source } : {})
    }
  }

  return JSON.stringify({
    v: body.v,
    lockSha256: body.lockSha256,
    cliVersion: body.cliVersion,
    target: body.target,
    createdAt: body.createdAt,
    packages: body.packages,
    addons: body.addons,
    files,
    treeSha256: body.treeSha256
  })
}

export type KeyAnswer = { ok: true; key: Buffer } | { ok: false; reason: 'unsealable' | 'key-unopenable' }

/** The manifest key under `root`, for a CHECK: read and unsealed, never created. Any failure is a refusal. */
export function openManifestKey(root: string, sealer: KeySealer | null): KeyAnswer {
  if (!sealer) {
    return { ok: false, reason: 'unsealable' }
  }

  const file = path.join(root, KEY_FILE)

  try {
    if (!lstatSync(file).isFile()) {
      return { ok: false, reason: 'key-unopenable' }
    }

    const key = Buffer.from(sealer.unseal(readFileSync(file, 'utf8').trim()), 'hex')

    if (key.length === 32) {
      return { ok: true, key }
    }
  } catch {
    // missing, unreadable, or sealed by another login / a reset keychain
  }

  return { ok: false, reason: 'key-unopenable' }
}

/**
 * The manifest key for an INSTALL (the owner's click, audited): the existing one when it opens, else a new one written
 * over whatever is at its path, then read back through the OS to prove the seal round-trips. A new key makes every
 * manifest the old one signed fail its MAC, which is the honest answer for trees nobody can vouch for.
 */
export function createManifestKey(root: string, sealer: KeySealer | null): KeyAnswer {
  const open = openManifestKey(root, sealer)

  if (open.ok || !sealer) {
    return open
  }

  const file = path.join(root, KEY_FILE)
  const key = randomBytes(32)

  try {
    rmSync(file, { recursive: true, force: true })
    writeFileAtomicSync(file, `${sealer.seal(key.toString('hex'))}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch {
    return { ok: false, reason: 'key-unopenable' }
  }

  const again = openManifestKey(root, sealer)

  return again.ok && again.key.equals(key) ? again : { ok: false, reason: 'unsealable' }
}

export function signManifest(body: ManifestBody, key: Buffer): AcpManifest {
  return { ...body, mac: createHmac('sha256', key).update(canonicalBody(body)).digest('hex') }
}

const isHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)

/** Parse and authenticate `MANIFEST.json`: shape, tree digest, and the MAC with the sealed key (always). */
export function readManifest(
  dir: string,
  key: Buffer
): { ok: true; manifest: AcpManifest } | ({ ok: false } & AcpToolsProblemInfo) {
  let raw: unknown

  try {
    raw = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))
  } catch {
    return { ok: false, reason: 'manifest-missing' }
  }

  const m = raw as Partial<AcpManifest>

  if (
    !m ||
    m.v !== 1 ||
    !isHex(m.lockSha256, 64) ||
    !isHex(m.treeSha256, 64) ||
    typeof m.cliVersion !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.createdAt !== 'string' ||
    typeof m.packages !== 'number' ||
    typeof m.addons !== 'string' ||
    !m.files ||
    typeof m.files !== 'object'
  ) {
    return { ok: false, reason: 'manifest-malformed' }
  }

  for (const [rel, entry] of Object.entries(m.files)) {
    if (
      rel.startsWith('/') ||
      rel.split('/').some(part => part === '..' || part === '') ||
      !entry ||
      !isHex(entry.sha256, 64) ||
      typeof entry.size !== 'number' ||
      (entry.mode !== 0o644 && entry.mode !== 0o755) ||
      (entry.source !== undefined && entry.source !== 'app')
    ) {
      return { ok: false, reason: 'manifest-malformed' }
    }
  }

  const manifest = m as AcpManifest

  if (treeDigest(manifest.files) !== manifest.treeSha256) {
    return { ok: false, reason: 'manifest-digest' }
  }

  const expected = createHmac('sha256', key).update(canonicalBody(manifest)).digest('hex')

  if (!isHex(manifest.mac, 64) || !timingSafeEqual(Buffer.from(manifest.mac), Buffer.from(expected))) {
    return { ok: false, reason: 'manifest-signature' }
  }

  return { ok: true, manifest }
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0

  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T

      await run(item)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const mark = (stat: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): StatMark => ({
  ino: stat.ino,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
  mode: Number(stat.mode)
})

/** Full check of `dir` against its manifest (MANIFEST.json itself excluded from the file set). */
export async function verifyTree(dir: string, manifest: AcpManifest): Promise<VerifyResult> {
  const snapshot: Snapshot = new Map()
  const seen = new Set<string>()
  const files: string[] = []
  let problem: AcpToolsProblemInfo | null = null

  const walk = async (abs: string, rel: string): Promise<void> => {
    const stat = await fsp.lstat(abs, { bigint: true })

    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      problem ??= { reason: 'not-plain', subject: rel || '.' }

      return
    }

    snapshot.set(stat.isDirectory() ? `${rel}/` : rel, mark(stat))

    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(abs)) {
        await walk(path.join(abs, name), rel ? `${rel}/${name}` : name)
      }
    } else if (rel !== MANIFEST_FILE) {
      seen.add(rel)
      files.push(rel)
    }
  }

  try {
    await walk(dir, '')
  } catch {
    return { ok: false, reason: 'tree-unreadable' }
  }

  if (problem) {
    return { ok: false, ...(problem as AcpToolsProblemInfo) }
  }

  const extra = files.filter(rel => !(rel in manifest.files))

  if (extra.length > 0) {
    return { ok: false, reason: 'extra-file', subject: extra[0] as string }
  }

  const missing = Object.keys(manifest.files).filter(rel => !seen.has(rel))

  if (missing.length > 0) {
    return { ok: false, reason: 'missing-file', subject: missing[0] as string }
  }

  await pool(files, STAT_CONCURRENCY, async rel => {
    if (problem) {
      return
    }

    const entry = manifest.files[rel] as ManifestEntry
    const data = await fsp.readFile(path.join(dir, rel))
    const mode = Number((snapshot.get(rel) as StatMark).mode) & 0o777

    if (data.length !== entry.size || sha256Hex(data) !== entry.sha256) {
      problem ??= { reason: 'file-changed', subject: rel }
    } else if (mode !== entry.mode) {
      problem ??= { reason: 'mode-changed', subject: rel }
    }
  })

  return problem ? { ok: false, ...(problem as AcpToolsProblemInfo) } : { ok: true, snapshot }
}

/** Nothing moved since `snapshot` was taken. False sends the caller to a full check. */
export async function quickUnchanged(dir: string, snapshot: Snapshot): Promise<boolean> {
  let same = true

  await pool([...snapshot.entries()], STAT_CONCURRENCY, async ([rel, before]) => {
    if (!same) {
      return
    }

    try {
      const now = mark(await fsp.lstat(path.join(dir, rel.endsWith('/') ? rel.slice(0, -1) : rel), { bigint: true }))

      same =
        same &&
        now.ino === before.ino &&
        now.size === before.size &&
        now.mtimeNs === before.mtimeNs &&
        now.ctimeNs === before.ctimeNs &&
        now.mode === before.mode
    } catch {
      same = false
    }
  })

  return same
}
