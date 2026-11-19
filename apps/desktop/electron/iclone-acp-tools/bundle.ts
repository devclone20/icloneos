/**
 * v0.0.9 (owner decision 17 Nov, replaces ruling 26) — the Virtuals ACP CLI the app SHIPS.
 *
 * The build materialises the pinned tree (materialise.ts: only registry.npmjs.org, sha512 per package, no install
 * scripts, the runtime closure for this target) into `build/acp-tools/`, and electron-builder seals it into the app as
 * `Resources/acp-tools/`:
 *
 *   MANIFEST.json            every file's sha256, size and mode + the tree digest, `origin: "app-bundle"`, no MAC
 *   NOTICES.md               acp-cli-lock/NOTICES.md, then every package's own licence texts
 *   runtime/node_modules/…   the CLI and its closure (the Go signer and the native add-ons Developer-ID signed)
 *
 * TRUST. The manifest's authority is where it is read from: inside the signed app (its seal covers Resources, and
 * macOS's App Management protection keeps other apps from rewriting a signed bundle). Nothing is created on a first
 * click and nothing needs the Keychain (blocker K is gone with it).
 *
 * The CLI never runs from the bundle itself: it runs from a working copy in `userData/acp-cli/<lock sha256>/`
 * (installer.ts), placed from the bundle without network and checked against THE BUNDLE's manifest — the copy's own
 * MANIFEST.json must be byte-identical to it and every file must hash to it. A changed copy is refused (`unverified`)
 * until the owner's Repair restores it from the bundle, every byte re-checked on the way.
 */
import { promises as fsp, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { AcpToolsProblemInfo } from '../../src/iclone-shared/acp-tools'

import { AcpToolsError } from './errors'
import { canonicalBody, checkManifestBody, MANIFEST_FILE, type ManifestBody, sha256Hex } from './manifest'

/** The bundled tree's folder name, beside Resources/acp-pin (never `acp-cli`: the v0.0.8 self-test refuses that name). */
export const BUNDLE_DIR = 'acp-tools'
export const BUNDLE_ORIGIN = 'app-bundle'
const COPY_CONCURRENCY = 16

export interface BundleManifest extends ManifestBody {
  origin: typeof BUNDLE_ORIGIN
}

/**
 * Where this build's bundled tree is, from where its pin is: a packaged app's `Resources/acp-pin` → `Resources/acp-tools`;
 * a dev run's `<app>/acp-cli-lock` → `<app>/build/acp-tools` (what `npm run build` staged, when it did).
 */
export function defaultBundleDir(pinDir: string): string {
  const parent = path.dirname(pinDir)

  return path.basename(pinDir) === 'acp-pin' ? path.join(parent, BUNDLE_DIR) : path.join(parent, 'build', BUNDLE_DIR)
}

/** The bytes a bundle manifest is written as (and the bytes every working copy must carry, byte for byte). */
export function bundleManifestText(body: ManifestBody): string {
  return `${JSON.stringify({ origin: BUNDLE_ORIGIN, ...(JSON.parse(canonicalBody(body)) as ManifestBody) })}\n`
}

export type BundleRead =
  | { ok: true; manifest: BundleManifest; bytes: Buffer; sha256: string }
  | ({ ok: false; absent: boolean } & AcpToolsProblemInfo)

/** Parse a bundle manifest's bytes: its shape, its tree digest, its origin; never a v0.0.8 MAC'd install manifest. */
export function parseBundleManifest(
  bytes: Buffer
): { ok: true; manifest: BundleManifest } | ({ ok: false } & AcpToolsProblemInfo) {
  let raw: unknown

  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'manifest-malformed' }
  }

  const record = raw as Record<string, unknown> | null

  if (!record || typeof record !== 'object' || record.origin !== BUNDLE_ORIGIN || 'mac' in record) {
    return { ok: false, reason: 'manifest-malformed' }
  }

  const body = checkManifestBody(raw)

  return body.ok ? { ok: true, manifest: body.body as BundleManifest } : body
}

/** The bundled tree's manifest, read from `dir` (Resources/acp-tools). `absent`: this build includes no CLI. */
export function readBundleManifest(dir: string): BundleRead {
  const file = path.join(dir, MANIFEST_FILE)
  let bytes: Buffer

  try {
    if (!lstatSync(file).isFile()) {
      return { ok: false, absent: false, reason: 'not-plain', subject: `included copy: ${MANIFEST_FILE}` }
    }

    bytes = readFileSync(file)
  } catch {
    return { ok: false, absent: true, reason: 'manifest-missing' }
  }

  const parsed = parseBundleManifest(bytes)

  return parsed.ok
    ? { ok: true, manifest: parsed.manifest, bytes, sha256: sha256Hex(bytes) }
    : { ...parsed, absent: false }
}

/** True when a working copy's MANIFEST.json is a v0.0.3–v0.0.8 npm install's (it carries the sealed key's MAC). */
export function isLegacyInstallManifest(bytes: Buffer): boolean {
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> | null

    return Boolean(raw && typeof raw === 'object' && typeof raw.mac === 'string' && raw.origin === undefined)
  } catch {
    return false
  }
}

/** Run `run` over `items`, `limit` at a time; the first failure stops every worker (none is left writing) and is thrown. */
async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  let failure: unknown

  const worker = async () => {
    while (next < items.length && !failed) {
      try {
        await run(items[next++] as T)
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  if (failed) {
    throw failure
  }
}

/**
 * Copy the bundled tree `from` into the empty folder `to`: ONLY the files the bundle manifest lists, each read from
 * the bundle (a plain file, never through a link), checked against its manifest entry BEFORE it is written (a changed
 * included copy is never copied), written with the manifest's mode; then the manifest's own bytes. No network.
 */
export async function copyBundle(input: {
  from: string
  to: string
  manifest: BundleManifest
  manifestBytes: Buffer
  signal?: AbortSignal
}): Promise<number> {
  const { from, to, manifest } = input
  const rels = Object.keys(manifest.files).sort()

  await fsp.mkdir(to, { recursive: true, mode: 0o700 })

  await pool(rels, COPY_CONCURRENCY, async rel => {
    if (input.signal?.aborted) {
      throw new Error('cancelled')
    }

    const entry = manifest.files[rel] as BundleManifest['files'][string]
    const source = path.join(from, ...rel.split('/'))
    let data: Buffer

    try {
      const stat = await fsp.lstat(source)

      if (!stat.isFile()) {
        throw new AcpToolsError('not-plain', `included copy: ${rel}`)
      }

      data = await fsp.readFile(source)
    } catch (error) {
      if (error instanceof AcpToolsError) {
        throw error
      }

      throw new AcpToolsError('missing-file', `included copy: ${rel}`)
    }

    if (data.length !== entry.size || sha256Hex(data) !== entry.sha256) {
      throw new AcpToolsError('file-changed', `included copy: ${rel}`)
    }

    const target = path.join(to, ...rel.split('/'))

    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
    await fsp.writeFile(target, data, { mode: entry.mode, flag: 'wx' })
    await fsp.chmod(target, entry.mode)
  })

  if (input.signal?.aborted) {
    throw new Error('cancelled')
  }

  await fsp.writeFile(path.join(to, MANIFEST_FILE), input.manifestBytes, { mode: 0o644, flag: 'wx' })

  return rels.length
}
