/**
 * REL-6 (ruling 33) — swap the app's own native add-ons (src/iclone-shared/acp-native.ts) into a tree being built,
 * before its manifest is written. Every add-on file npm installed must be listed, every listed file must be the one
 * npm installed (same sha256 as the copy was built from), and every shipped copy must hash to what the list inside
 * the signed app says. Anything else REFUSES the install: there is no silent fallback to npm's ad-hoc-signed copy,
 * which library validation would refuse to load anyway.
 */
import { promises as fsp, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  type AddonList,
  ADDONS_FILE,
  isAddonPackage,
  packageOfFile,
  parseAddonList
} from '../../src/iclone-shared/acp-native'

import { AcpToolsError } from './errors'
import { type ManifestEntry, sha256Hex } from './manifest'

/** Where this build's add-ons are, and whether this build must have them (a packaged macOS app). */
export interface NativeAddons {
  dir: string | null
  required: boolean
}

/**
 * Where a build's add-ons are (ruling 33). A packaged macOS app MUST carry Resources/acp-native/<target> (the
 * hardened runtime refuses npm's ad-hoc-signed copies); other packaged platforms carry none and keep npm's; a dev run
 * uses the staged ones when `npm run build` made them.
 */
export function nativeAddonsFor(input: {
  packaged: boolean
  platform: string
  target: string
  resourcesPath: string
  appPath: string
  exists(path: string): boolean
}): NativeAddons {
  const dir = input.packaged
    ? path.join(input.resourcesPath, 'acp-native', input.target)
    : path.join(input.appPath, 'build', 'acp-native', input.target)

  const required = input.packaged && input.platform === 'darwin'

  return { dir: required || input.exists(dir) ? dir : null, required }
}

/**
 * The app's add-on list as one digest (critic r2 m4): sha256 of its ADDONS.json bytes, `none` for a build that carries
 * none, `missing` when it should be there and is not. The manifest and the install record carry it, so a replayed
 * install made with another app build's add-ons is refused (`other-pin`).
 */
export function addonsDigest(native: NativeAddons): string {
  if (!native.dir) {
    return 'none'
  }

  try {
    return sha256Hex(readFileSync(path.join(native.dir, ADDONS_FILE)))
  } catch {
    return 'missing'
  }
}

export function readAddonList(dir: string): AddonList {
  let text: string

  try {
    text = readFileSync(path.join(dir, ADDONS_FILE), 'utf8')
  } catch {
    throw new AcpToolsError('addons-missing', undefined, `${ADDONS_FILE} is missing`)
  }

  const list = parseAddonList(text)

  if (!list) {
    throw new AcpToolsError('addons-mismatch', undefined, `${ADDONS_FILE} is malformed`)
  }

  return list
}

/**
 * Swap in place. `files` is the tree's file map (keys `runtime/<file>`), `tmp` the tree's folder. Returns how many
 * files were swapped (0 when this build carries no add-ons and does not need them).
 */
export async function swapAddons(input: {
  native: NativeAddons
  target: string
  lockSha256: string
  tmp: string
  runtimeDir: string
  files: Record<string, ManifestEntry>
  log(line: string): void
}): Promise<{ swapped: number; digest: string }> {
  const { native, files } = input

  const installed = Object.keys(files)
    .filter(rel => rel.startsWith(`${input.runtimeDir}/`) && rel.endsWith('.node'))
    .map(rel => rel.slice(input.runtimeDir.length + 1))
    .filter(file => isAddonPackage(packageOfFile(file) ?? ''))

  if (!native.dir) {
    if (native.required) {
      throw new AcpToolsError('addons-missing', undefined, 'this build carries no native add-ons')
    }

    input.log(`[iclone-acp-tools] no app add-ons in this build: ${installed.length} npm add-on(s) kept`)

    return { swapped: 0, digest: 'none' }
  }

  const list = readAddonList(native.dir)
  // The digest of the very bytes the swap follows (the list is read once).
  const digest = sha256Hex(readFileSync(path.join(native.dir, ADDONS_FILE)))

  if (list.target !== input.target || list.lockSha256 !== input.lockSha256) {
    throw new AcpToolsError('addons-mismatch', list.target, 'the add-ons were built for another pin or platform')
  }

  const listed = new Set(list.addons.map(entry => entry.file))
  const unlisted = installed.find(file => !listed.has(file))
  const notInstalled = list.addons.find(entry => !installed.includes(entry.file))

  if (unlisted || notInstalled || listed.size !== list.addons.length) {
    throw new AcpToolsError('addons-mismatch', unlisted ?? notInstalled?.file, 'the add-on list is not this tree’s')
  }

  for (const entry of list.addons) {
    const rel = `${input.runtimeDir}/${entry.file}`
    const subject = `${entry.package}@${entry.version}`

    if ((files[rel] as ManifestEntry).sha256 !== entry.npmSha256) {
      throw new AcpToolsError('addon-swap', subject, 'npm’s file is not the one the copy was built from')
    }

    let data: Buffer

    try {
      data = await fsp.readFile(path.join(native.dir, entry.blob))
    } catch {
      throw new AcpToolsError('addon-swap', subject, 'the shipped copy is missing')
    }

    if (sha256Hex(data) !== entry.sha256) {
      throw new AcpToolsError('addon-swap', subject, 'the shipped copy is not the listed one')
    }

    const abs = path.join(input.tmp, ...rel.split('/'))

    await fsp.rm(abs, { force: true })
    await fsp.writeFile(abs, data, { mode: 0o644, flag: 'wx' })
    await fsp.chmod(abs, 0o644)
    files[rel] = { sha256: entry.sha256, size: data.length, mode: 0o644, source: 'app' }
  }

  input.log(
    `[iclone-acp-tools] swapped ${list.addons.length} app add-on(s) (${list.signed ? `Team-signed ${list.team}` : 'unsigned build'})`
  )

  return { swapped: list.addons.length, digest }
}
