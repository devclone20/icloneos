/**
 * The ACP CLI tree's manifest: every file's sha256, size and mode, and the tree's own digest.
 *
 * v0.0.9 (owner decision 17 Nov, replaces ruling 26): the app SHIPS the CLI. The manifest is written at BUILD time
 * (materialise.ts) and travels inside the signed app with the tree it describes (Resources/acp-tools/MANIFEST.json,
 * bundle.ts). Its authority is the app's own code signature and macOS's App Management protection of a signed bundle
 * — no longer an HMAC with a key the Keychain seals on the first click (blocker K: Keychain off ⇒ no install). The
 * working copy the CLI runs from (userData/acp-cli/<lock>) is checked against the BUNDLE's manifest, never its own.
 *
 * Two checks:
 *   - full: walk the tree; the set of files must be EXACTLY the manifest's (an extra file is a refusal: Node would load
 *     `foo.js` before `foo/index.js`), no symlink or other type anywhere, every sha256 and mode equal. Returns a stat
 *     snapshot of every file and directory.
 *   - quick (before every spawn): lstat every snapshotted path; any change of inode, size, mtime, ctime or mode (ctime
 *     cannot be set back from user space) sends the caller to a full check. A quick pass is only ever a "nothing moved
 *     since the last full pass".
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import type { AcpToolsProblemInfo } from '../../src/iclone-shared/acp-tools'

export const MANIFEST_FILE = 'MANIFEST.json'
/** v0.0.3–v0.0.8: the Keychain-sealed manifest key beside the npm-installed trees. Never read or written any more; a
 *  leftover one is not a stray (the check names it so the audit does not cry wolf on every upgraded Mac). */
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

/** A v0.0.3–v0.0.8 npm install's manifest (HMAC with the sealed key). Only record.ts still names its shape. */
export interface AcpManifest extends ManifestBody {
  mac: string
}

/** The OS sealing seam (V3-F keys.ts shape): main still builds one (sealer.ts); the ACP tools no longer need it. */
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

/** The body in a fixed key order, files sorted (what a writer serialises, so equal trees give equal bytes). */
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

export const isHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)

/** A relative tree path: `/`-separated, no empty part, no `..`, not absolute. */
export function isTreePath(rel: string): boolean {
  return !rel.startsWith('/') && !rel.includes('\\') && !rel.split('/').some(part => part === '..' || part === '')
}

/**
 * The body's shape and its tree digest (no authentication: the caller decides where the manifest's authority comes
 * from — for the bundled CLI, the signed app it was read from).
 */
export function checkManifestBody(
  raw: unknown
): { ok: true; body: ManifestBody } | ({ ok: false } & AcpToolsProblemInfo) {
  const m = raw as Partial<ManifestBody> | null

  if (
    !m ||
    typeof m !== 'object' ||
    m.v !== 1 ||
    !isHex(m.lockSha256, 64) ||
    !isHex(m.treeSha256, 64) ||
    typeof m.cliVersion !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.createdAt !== 'string' ||
    typeof m.packages !== 'number' ||
    typeof m.addons !== 'string' ||
    !m.files ||
    typeof m.files !== 'object' ||
    Array.isArray(m.files)
  ) {
    return { ok: false, reason: 'manifest-malformed' }
  }

  for (const [rel, entry] of Object.entries(m.files)) {
    if (
      !isTreePath(rel) ||
      rel === MANIFEST_FILE ||
      !entry ||
      !isHex(entry.sha256, 64) ||
      typeof entry.size !== 'number' ||
      (entry.mode !== 0o644 && entry.mode !== 0o755) ||
      (entry.source !== undefined && entry.source !== 'app')
    ) {
      return { ok: false, reason: 'manifest-malformed' }
    }
  }

  const body = m as ManifestBody

  if (treeDigest(body.files) !== body.treeSha256) {
    return { ok: false, reason: 'manifest-digest' }
  }

  return { ok: true, body }
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
export async function verifyTree(dir: string, manifest: ManifestBody): Promise<VerifyResult> {
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
