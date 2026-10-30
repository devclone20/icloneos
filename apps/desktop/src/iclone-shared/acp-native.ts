/**
 * REL-6 (ruling 33) — the ACP CLI's native add-ons under the hardened runtime. Library validation refuses an
 * ad-hoc-signed `.node` in the Team-signed app, so the release build ships its OWN copies of the three MIT add-ons the
 * closure loads (`@napi-rs/keyring-<platform>`, `bufferutil`, `utf-8-validate`), taken from the lockfile's exact
 * versions and Team-signed by `release:mac`, in `Resources/acp-native/<target>/`, with a list (ADDONS.json) of what
 * each one replaces. The installer swaps them in over npm's copies BEFORE it writes the manifest, so the manifest (and
 * its MAC) covers the signed bytes. Plain TS with no Node imports: the installer and the build scripts share it.
 */

export const ADDONS_FILE = 'ADDONS.json'

/** The packages whose `.node` files are replaced by the app's own copies. */
export function isAddonPackage(name: string): boolean {
  return name === 'bufferutil' || name === 'utf-8-validate' || /^@napi-rs\/keyring-[a-z0-9-]+$/.test(name)
}

export interface AddonEntry {
  /** Install path under the tree's `runtime/`, e.g. `node_modules/bufferutil/prebuilds/darwin-x64+arm64/bufferutil.node`. */
  file: string
  package: string
  version: string
  /** The shipped copy's file name in the add-on folder (a plain name, no `/`). */
  blob: string
  /** sha256 of npm's file (inside the tarball the lockfile's sha512 pins): the copy is built from exactly that. */
  npmSha256: string
  /** sha256 of the shipped copy: unsigned in a dev or `--dir` pack, Team-signed after `release:mac`. */
  sha256: string
  /** The licence files (names in `notices`) that cover this copy's bytes (critic r2 M3). */
  licences: string[]
}

/** A licence file shipped beside the add-ons (`licences/<name>`), pinned by sha256. */
export interface AddonNotice {
  file: string
  sha256: string
}

export interface AddonList {
  v: 1
  target: string
  lockSha256: string
  /** false in an unsigned pack (the marker a `--dir` pack test reads); true once `release:mac` Team-signed them. */
  signed: boolean
  team: string | null
  addons: AddonEntry[]
  /** Every licence file shipped beside the add-ons (acp-native-notices/, rulings 32 + 33). */
  notices: AddonNotice[]
}

const HEX64 = /^[0-9a-f]{64}$/
const BLOB = /^[A-Za-z0-9@+._-]+\.node$/
const NOTICE_FILE = /^licences\/[A-Za-z0-9@+._-]+$/

/** The package a tree path belongs to: the part after its last `node_modules/`, up to the package's own folder. */
export function packageOfFile(file: string): string | null {
  const at = file.lastIndexOf('node_modules/')

  if (at < 0) {
    return null
  }

  const parts = file.slice(at + 'node_modules/'.length).split('/')

  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : (parts[0] ?? null)
}

/** A shipped copy's name: flat (electron-builder drops nested node_modules folders from extraResources). */
export function blobName(pkg: string, version: string, file: string): string {
  return `${pkg.replace(/^@/, '').replace('/', '+')}@${version}--${file.slice(file.lastIndexOf('/') + 1)}`
}

/** Parse ADDONS.json; null when it is not a well-formed list. */
export function parseAddonList(text: string): AddonList | null {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  const list = raw as Partial<AddonList> | null

  if (
    !list ||
    list.v !== 1 ||
    typeof list.target !== 'string' ||
    typeof list.lockSha256 !== 'string' ||
    !HEX64.test(list.lockSha256) ||
    typeof list.signed !== 'boolean' ||
    (list.team !== null && typeof list.team !== 'string') ||
    !Array.isArray(list.addons) ||
    !Array.isArray(list.notices)
  ) {
    return null
  }

  const notices = new Set<string>()

  for (const notice of list.notices as Partial<AddonNotice>[]) {
    if (
      !notice ||
      typeof notice.file !== 'string' ||
      !NOTICE_FILE.test(notice.file) ||
      typeof notice.sha256 !== 'string' ||
      !HEX64.test(notice.sha256)
    ) {
      return null
    }

    notices.add(notice.file)
  }

  for (const entry of list.addons as Partial<AddonEntry>[]) {
    if (
      !entry ||
      typeof entry.file !== 'string' ||
      !entry.file.startsWith('node_modules/') ||
      !entry.file.endsWith('.node') ||
      entry.file.split('/').some(part => part === '..' || part === '') ||
      typeof entry.package !== 'string' ||
      !isAddonPackage(entry.package) ||
      packageOfFile(entry.file) !== entry.package ||
      typeof entry.version !== 'string' ||
      typeof entry.blob !== 'string' ||
      !BLOB.test(entry.blob) ||
      typeof entry.npmSha256 !== 'string' ||
      !HEX64.test(entry.npmSha256) ||
      typeof entry.sha256 !== 'string' ||
      !HEX64.test(entry.sha256) ||
      !Array.isArray(entry.licences) ||
      entry.licences.length === 0 ||
      !entry.licences.every(name => typeof name === 'string' && notices.has(`licences/${name}`))
    ) {
      return null
    }
  }

  return list as AddonList
}
