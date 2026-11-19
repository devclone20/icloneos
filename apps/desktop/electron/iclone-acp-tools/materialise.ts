/**
 * v0.0.9 (owner decision 17 Nov, replaces ruling 26) — BUILD TIME: the pinned Virtuals ACP CLI tree, materialised for
 * the app bundle (bundle.ts) with exactly the checks the v0.0.3–v0.0.8 first-use installer ran on the owner's Mac. The
 * code moved here from installer.ts; the app itself no longer fetches anything.
 *
 * WHY NOT `npm ci`. What `npm ci --ignore-scripts --omit=dev` does with a lockfile is: fetch each row's `resolved`,
 * check its `integrity`, extract it at the row's path. This does exactly that, stricter: only https://registry.npmjs.org/
 * tarballs of the row's own name and version (acp-pin.ts refuses any other row; net-core.ts refuses any other URL and
 * every redirect), sha512 required and checked before a byte is read, only the CLI's runtime closure for the target
 * (build tooling such as esbuild is never fetched), the same per-file prune (`installsFile`).
 *
 * WHY NO INSTALL SCRIPTS. Nothing in the closure needs one, and none ever runs: bufferutil and utf-8-validate ship N-API
 * prebuilds; es5-ext's postinstall only prints; esbuild and fsevents are build tooling outside the closure. The Go signer
 * (`bin/acp-cli-signer-<os>`, published inside the npm package) gets its exec bit explicitly, under the package's sha512.
 *
 * NATIVE ADD-ONS (ruling 33): the app's own copies (build/acp-native/<target>) replace npm's before the manifest is
 * written. In a release, `scripts/sign-acp-bundle.mjs` then Developer-ID signs the Go signer, swaps in the Team-signed
 * add-ons and RESEALS the manifest (`resealBundle`): only those files may change, every other byte is re-proven.
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  ACP_CLI_NAME,
  type AcpPin,
  installsFile,
  isLegalText,
  parsePin,
  type PinRow,
  type PinTarget,
  runtimeClosure,
  signerFor,
  targetName
} from '../../src/iclone-shared/acp-pin'

import { type BundleManifest, bundleManifestText, parseBundleManifest } from './bundle'
import { AcpToolsError, logText } from './errors'
import { MANIFEST_FILE, type ManifestBody, type ManifestEntry, sha256Hex, treeDigest, verifyTree } from './manifest'
import { addonsDigest, type NativeAddons, readAddonList, swapAddons } from './native'
import { gunzipAsync, readTar, type TarFile } from './tar'

export const NOTICES_FILE = 'NOTICES.md'
export const RUNTIME_DIR = 'runtime'
const DOWNLOAD_CONCURRENCY = 8
/** Largest unpacked tarball accepted (the CLI's own, with three signer binaries, is ~40 MB). */
const MAX_UNPACKED = 256 * 1024 * 1024

const sri512 = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`

export interface LoadedPin {
  pin: AcpPin
  lockSha256: string
  rows: PinRow[]
}

/** The pin in `pinDir` (package.json + package-lock.json) and its runtime closure for `target`. Throws on a bad pin. */
export function loadPin(pinDir: string, target: PinTarget): LoadedPin {
  const lockText = readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')
  const pin = parsePin(readFileSync(path.join(pinDir, 'package.json'), 'utf8'), lockText)

  return { pin, lockSha256: sha256Hex(lockText), rows: runtimeClosure(pin, target) }
}

/** The tree path of the CLI's Go signer for `platform`. */
export function signerPath(platform: string): string {
  return `${RUNTIME_DIR}/node_modules/${ACP_CLI_NAME}/bin/${signerFor(platform)}`
}

export interface MaterialiseInput {
  pinDir: string
  /** Created here; must not exist yet (a stale tree can never survive a bump). */
  outDir: string
  target: PinTarget
  /** One registry GET (net-core.ts `createRegistryFetch`: registry.npmjs.org only, no redirect, size and time caps). */
  fetch(url: string, signal: AbortSignal): Promise<Buffer>
  native: NativeAddons
  /** acp-cli-lock/NOTICES.md: placed first in the tree's NOTICES.md, so the shipped notices start with the pin's table. */
  lockNotices?: string | null
  now?(): Date
  log(line: string): void
  signal?: AbortSignal
  onProgress?(progress: { done: number; total: number; bytes: number }): void
}

function noticeFor(row: PinRow, legal: { path: string; text: string }[]): string {
  const head = `## ${row.name} ${row.version} — ${row.license ?? 'no licence declared'}`

  if (legal.length === 0) {
    return `${head}\n\nThe package carries no licence file.\n`
  }

  return (
    [head, ...legal.map(file => `### ${file.path}\n\n\`\`\`\`text\n${file.text.trimEnd()}\n\`\`\`\``)].join('\n\n') + '\n'
  )
}

function noticesText(input: {
  loaded: LoadedPin
  target: PinTarget
  swapped: number
  lockNotices: string | null
  sections: string[]
}): string {
  const { loaded, target } = input
  const signer = signerFor(target.platform)

  const head = [
    `# Virtuals ACP CLI — included in iclone os`,
    '',
    `iclone os includes ${ACP_CLI_NAME} ${loaded.pin.cliVersion} and its runtime packages (${loaded.rows.length}) for`,
    `${targetName(target)}, built from https://registry.npmjs.org/ tarballs checked against the sha512 in the pinned`,
    'package-lock.json (no install script ran). Each package is redistributed under its own licence, as its publisher',
    'released it on npm. Below: the pin’s package table, then each package with the licence it declares and the licence',
    'files it ships.',
    '',
    `The Go signer \`bin/${signer}\` is a program published inside ${ACP_CLI_NAME} on npm; iclone os did not build`,
    'it and holds no source for it. It is included only because it comes inside that package, whose bytes the',
    'lockfile’s sha512 pins, and it runs as a separate program.',
    target.platform === 'darwin'
      ? 'In a release it is signed with the iclone os Developer ID and notarized with the app; its bytes are otherwise' +
        ' the npm package’s.'
      : '',
    input.swapped > 0
      ? `The ${input.swapped} native add-on file(s) of @napi-rs/keyring, bufferutil and utf-8-validate (MIT) are the copies this app builds from the same versions and signs, in place of npm's copies; their licence notices, with the Rust crates linked into the keyring binding, are in THIRD_PARTY_NOTICES.md ("ACP native add-ons") and beside them in the app (Resources/acp-native).`
      : '',
    ''
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')

  return [head, input.lockNotices ? `${input.lockNotices.trimEnd()}\n` : '', '# Licence texts\n', ...input.sections]
    .filter(part => part !== '')
    .join('\n')
}

/**
 * Fetch, check and extract the pin's runtime closure into `outDir`, swap in the app's add-ons, write NOTICES.md and the
 * bundle manifest, and prove the tree against it. Returns the manifest. Leaves nothing behind on a failure.
 */
export async function materialiseBundle(input: MaterialiseInput): Promise<BundleManifest> {
  const now = input.now ?? (() => new Date())
  const signal = input.signal ?? new AbortController().signal
  const loaded = loadPin(input.pinDir, input.target)
  const out = input.outDir

  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new AcpToolsError('internal', out, 'the output folder is not empty')
  }

  try {
    const files: Record<string, ManifestEntry> = {}
    const total = loaded.rows.length
    const signer = `bin/${signerFor(input.target.platform)}`
    let done = 0
    let bytes = 0

    const put = async (rel: string, data: Buffer, mode: number) => {
      const abs = path.join(out, ...rel.split('/'))

      await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 })
      await fsp.writeFile(abs, data, { mode })
      await fsp.chmod(abs, mode)
      files[rel] = { sha256: sha256Hex(data), size: data.length, mode }
    }

    const fetchRow = async (row: PinRow): Promise<TarFile[]> => {
      const subject = `${row.name}@${row.version}`
      const tgz = await input.fetch(row.resolved, signal)

      if (sri512(tgz) !== row.integrity) {
        throw new AcpToolsError('integrity', subject, 'the tarball does not match the lockfile’s sha512')
      }

      try {
        return readTar(await gunzipAsync(tgz, MAX_UNPACKED))
      } catch (error) {
        throw new AcpToolsError('tar-unsafe', subject, logText(error))
      }
    }

    const sections = new Map<string, string>()
    let next = 0
    let failed = false
    let failure: unknown

    const worker = async () => {
      while (next < loaded.rows.length && !failed) {
        const row = loaded.rows[next++] as PinRow
        const subject = `${row.name}@${row.version}`

        try {
          if (signal.aborted) {
            throw new Error('cancelled')
          }

          const legal: { path: string; text: string }[] = []

          for (const file of await fetchRow(row)) {
            if (!installsFile(row, file.path, input.target)) {
              continue
            }

            if (file.path.split('/').some(part => part.toLowerCase() === 'node_modules')) {
              throw new AcpToolsError('nested-modules', subject, `it carries its own node_modules (${file.path})`)
            }

            const isSigner = row.name === ACP_CLI_NAME && file.path === signer

            await put(`${RUNTIME_DIR}/${row.key}/${file.path}`, file.data, isSigner ? 0o755 : file.mode)

            if (!file.path.includes('/') && isLegalText(file.path)) {
              legal.push({ path: file.path, text: file.data.toString('utf8') })
            }

            bytes += file.data.length
          }

          // Ruling 28: a package that names a licence FILE instead of a licence ships only with that file.
          const named = /^SEE LICEN[CS]E IN (.+)$/i.exec(row.license ?? '')?.[1]?.trim()

          if (named && !legal.some(file => file.path.toLowerCase() === named.toLowerCase())) {
            throw new AcpToolsError('licence-file-missing', subject, `it names its licence file ${named} and has none`)
          }

          sections.set(row.key, noticeFor(row, legal))
          done += 1
          input.onProgress?.({ done, total, bytes })
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        }
      }
    }

    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker))

    if (failed) {
      throw failure
    }

    if (!files[signerPath(input.target.platform)]) {
      throw new AcpToolsError('signer-missing', `${ACP_CLI_NAME}@${loaded.pin.cliVersion}`)
    }

    // Ruling 33: the app's own add-ons replace npm's, before the manifest is written.
    const { swapped, digest } = await swapAddons({
      native: input.native,
      target: targetName(input.target),
      lockSha256: loaded.lockSha256,
      tmp: out,
      runtimeDir: RUNTIME_DIR,
      files,
      log: input.log
    })

    await put(
      NOTICES_FILE,
      Buffer.from(
        noticesText({
          loaded,
          target: input.target,
          swapped,
          lockNotices: input.lockNotices ?? null,
          sections: loaded.rows.map(row => sections.get(row.key) as string)
        })
      ),
      0o644
    )

    const body: ManifestBody = {
      v: 1,
      lockSha256: loaded.lockSha256,
      cliVersion: loaded.pin.cliVersion,
      target: targetName(input.target),
      createdAt: now().toISOString(),
      packages: loaded.rows.length,
      addons: digest,
      files,
      treeSha256: treeDigest(files)
    }

    const manifest = await writeAndProve(out, body)

    input.log(
      `[acp-tools] materialised ${ACP_CLI_NAME}@${manifest.cliVersion} for ${manifest.target}: ${total} packages, ` +
        `${Object.keys(files).length} files, ${(bytes / 1e6).toFixed(1)} MB, tree ${manifest.treeSha256.slice(0, 12)}`
    )

    return manifest
  } catch (error) {
    await fsp.rm(out, { recursive: true, force: true })
    throw error
  }
}

/** Write the manifest, read it back as a bundle manifest, and prove the tree against it. */
async function writeAndProve(dir: string, body: ManifestBody): Promise<BundleManifest> {
  const text = bundleManifestText(body)

  await fsp.writeFile(path.join(dir, MANIFEST_FILE), text, { mode: 0o644 })

  const parsed = parseBundleManifest(Buffer.from(text))

  if (!parsed.ok) {
    throw new AcpToolsError(parsed.reason, parsed.subject, 'the manifest just written does not parse')
  }

  const proof = await verifyTree(dir, parsed.manifest)

  if (!proof.ok) {
    throw new AcpToolsError('new-tree-unverified', proof.subject, proof.reason)
  }

  return parsed.manifest
}

/**
 * RELEASE (scripts/sign-acp-bundle.mjs, inside release:mac's signing window, after sign-acp-native.mjs): the Go signer
 * was just signed in place with the Developer ID; swap in the Team-signed add-ons from `native` (each must hash to its
 * list entry), then rewrite the manifest. ONLY the signer and the app's add-on files may differ from the manifest the
 * build wrote; any other changed, missing or added file refuses the reseal.
 */
export async function resealBundle(input: {
  dir: string
  native: NativeAddons
  target: PinTarget
  log(line: string): void
}): Promise<BundleManifest> {
  const parsed = parseBundleManifest(readFileSync(path.join(input.dir, MANIFEST_FILE)))

  if (!parsed.ok) {
    throw new AcpToolsError(parsed.reason, parsed.subject, 'the staged bundle manifest does not parse')
  }

  const before = parsed.manifest

  if (before.target !== targetName(input.target)) {
    throw new AcpToolsError('other-pin', before.target, `the staged bundle is not for ${targetName(input.target)}`)
  }

  const may = new Set<string>([signerPath(input.target.platform)])

  if (input.native.dir) {
    const list = readAddonList(input.native.dir)

    if (list.lockSha256 !== before.lockSha256 || list.target !== before.target) {
      throw new AcpToolsError('addons-mismatch', list.target, 'the add-ons were built for another pin or platform')
    }

    for (const entry of list.addons) {
      const rel = `${RUNTIME_DIR}/${entry.file}`

      if (before.files[rel]?.source !== 'app') {
        throw new AcpToolsError('addons-mismatch', entry.file, 'the bundle does not carry this add-on as the app’s copy')
      }

      const data = await fsp.readFile(path.join(input.native.dir, entry.blob))

      if (sha256Hex(data) !== entry.sha256) {
        throw new AcpToolsError('addon-swap', `${entry.package}@${entry.version}`, 'the copy is not the listed one')
      }

      const abs = path.join(input.dir, ...rel.split('/'))

      await fsp.rm(abs, { force: true })
      await fsp.writeFile(abs, data, { mode: 0o644, flag: 'wx' })
      await fsp.chmod(abs, 0o644)
      may.add(rel)
    }
  }

  const files: Record<string, ManifestEntry> = {}

  for (const [rel, entry] of Object.entries(before.files)) {
    const data = await fsp.readFile(path.join(input.dir, ...rel.split('/')))
    const now: ManifestEntry = { ...entry, sha256: sha256Hex(data), size: data.length }

    if ((now.sha256 !== entry.sha256 || now.size !== entry.size) && !may.has(rel)) {
      throw new AcpToolsError('file-changed', rel, 'only the signer and the app’s add-ons may change at reseal')
    }

    files[rel] = now
  }

  const changed = Object.keys(files).filter(rel => files[rel]?.sha256 !== before.files[rel]?.sha256)

  const manifest = await writeAndProve(input.dir, {
    v: 1,
    lockSha256: before.lockSha256,
    cliVersion: before.cliVersion,
    target: before.target,
    createdAt: before.createdAt,
    packages: before.packages,
    addons: addonsDigest(input.native),
    files,
    treeSha256: treeDigest(files)
  })

  input.log(
    `[acp-tools] resealed the bundle: ${changed.length} signed file(s) (${changed.join(', ') || 'none'}), tree ${manifest.treeSha256.slice(0, 12)}`
  )

  return manifest
}
