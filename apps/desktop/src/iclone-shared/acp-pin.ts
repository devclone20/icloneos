/**
 * REL-6 (ruling 26) — the ACP CLI pin: what the app installs at first use, read from the committed lockfile
 * (`apps/desktop/acp-cli-lock/`, ruling 24). Plain TS with no Node imports and only erasable syntax, so the electron
 * installer (electron/iclone-acp-tools/) and the build scripts (Node's own type stripping) share one reading.
 *
 * The app ships NO ACP CLI. It ships this pin (Resources/acp-pin) and, on the owner's click, fetches each package the
 * pin names from the npm registry, checks the tarball against the lockfile's sha512, and extracts it. That is
 * `npm ci --ignore-scripts --omit=dev` restricted to the CLI's runtime closure for this platform, without npm: the
 * app has no npm, and a system one would put an unknown tool of unknown version on the install path.
 *
 * What this module refuses (a pin it refuses is never installed):
 *   - a CLI version that differs between package.json, the lockfile root and the lockfile tree;
 *   - any row without an exact registry URL of ITS OWN name and version on https://registry.npmjs.org/, or without a
 *     sha512 integrity (no sha1, no other host, no git/file/link rows, no aliases, no bundled rows);
 *   - a row key that is not a plain `node_modules/<name>(/node_modules/<name>)*` path (no `..`, no absolute path);
 *   - a non-optional row that cannot run on the target platform.
 */

export const ACP_CLI_NAME = '@virtuals-protocol/acp-cli'
export const ACP_REGISTRY = 'https://registry.npmjs.org/'

/** What the CLI's package tree is installed for: `process.platform`, `process.arch`, and on Linux the C library. */
export interface PinTarget {
  platform: string
  arch: string
  libc?: 'glibc' | 'musl' | null
}

export interface PinRow {
  /** The lockfile key, e.g. `node_modules/ws` or `node_modules/a/node_modules/b`: the install path. */
  key: string
  name: string
  version: string
  resolved: string
  integrity: string
  /** The licence the lockfile records (the package's own package.json field), or null when it declares none. */
  license: string | null
  optional: boolean
  os: string[] | null
  cpu: string[] | null
  libc: string[] | null
  /** Names this package can load: dependencies, optionalDependencies and peerDependencies. */
  wants: string[]
}

export interface AcpPin {
  cliVersion: string
  rows: Map<string, PinRow>
}

export class PinError extends Error {}

const SEGMENT = '(?:@[a-z0-9][a-z0-9._~-]*\\/)?[a-z0-9][a-z0-9._~-]*'
const KEY_RE = new RegExp(`^node_modules\\/${SEGMENT}(?:\\/node_modules\\/${SEGMENT})*$`)
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA512_RE = /^sha512-[A-Za-z0-9+/]{86}==$/

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? (value as string[]) : null

const names = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : [])

/** The package name a lockfile key installs: the part after its last `node_modules/`. */
export function nameOfKey(key: string): string {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

/** The one URL a registry tarball of `name@version` has. */
export function registryUrl(name: string, version: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)

  return `${ACP_REGISTRY}${name}/-/${base}-${version}.tgz`
}

function rowOf(key: string, raw: unknown): PinRow {
  if (!KEY_RE.test(key)) {
    throw new PinError(`acp pin: ${JSON.stringify(key.slice(0, 120))} is not a plain node_modules path`)
  }

  if (!isRecord(raw)) {
    throw new PinError(`acp pin: ${key} is not an object`)
  }

  if (raw.link !== undefined || raw.inBundle !== undefined || raw.dev === true) {
    throw new PinError(`acp pin: ${key} is a link, bundled or dev row`)
  }

  const name = nameOfKey(key)
  const { version, resolved, integrity } = raw

  if (raw.name !== undefined && raw.name !== name) {
    throw new PinError(`acp pin: ${key} is an alias of ${String(raw.name)}`)
  }

  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new PinError(`acp pin: ${key} has no exact version`)
  }

  if (resolved !== registryUrl(name, version)) {
    throw new PinError(`acp pin: ${key} does not resolve to ${registryUrl(name, version)}`)
  }

  if (typeof integrity !== 'string' || !SHA512_RE.test(integrity)) {
    throw new PinError(`acp pin: ${key} has no sha512 integrity`)
  }

  return {
    key,
    name,
    version,
    resolved,
    integrity,
    license: typeof raw.license === 'string' && raw.license.trim() ? raw.license.trim() : null,
    optional: raw.optional === true,
    os: stringList(raw.os),
    cpu: stringList(raw.cpu),
    libc: stringList(raw.libc),
    wants: [
      ...new Set([...names(raw.dependencies), ...names(raw.optionalDependencies), ...names(raw.peerDependencies)])
    ]
  }
}

/** Read and check the two pin files (their text, as committed or as shipped in Resources/acp-pin). */
export function parsePin(packageJsonText: string, lockText: string): AcpPin {
  let manifest: unknown
  let lock: unknown

  try {
    manifest = JSON.parse(packageJsonText)
    lock = JSON.parse(lockText)
  } catch {
    throw new PinError('acp pin: package.json or package-lock.json is not JSON')
  }

  if (!isRecord(manifest) || !isRecord(lock) || !isRecord(lock.packages)) {
    throw new PinError('acp pin: not a lockfile with a packages map')
  }

  if (lock.lockfileVersion !== 3) {
    throw new PinError('acp pin: lockfileVersion must be 3')
  }

  const declared = isRecord(manifest.dependencies) ? manifest.dependencies : {}
  const root = isRecord(lock.packages['']) ? lock.packages[''] : {}
  const rootDeps = isRecord(root.dependencies) ? root.dependencies : {}
  const cli = lock.packages[`node_modules/${ACP_CLI_NAME}`]
  const version = declared[ACP_CLI_NAME]

  if (
    typeof version !== 'string' ||
    Object.keys(declared).length !== 1 ||
    Object.keys(rootDeps).length !== 1 ||
    rootDeps[ACP_CLI_NAME] !== version ||
    !isRecord(cli) ||
    cli.version !== version
  ) {
    throw new PinError(`acp pin: package.json, the lockfile root and the lockfile tree must pin ${ACP_CLI_NAME} alike`)
  }

  const rows = new Map<string, PinRow>()

  for (const [key, raw] of Object.entries(lock.packages)) {
    if (key !== '') {
      rows.set(key, rowOf(key, raw))
    }
  }

  return { cliVersion: version, rows }
}

/** npm's os/cpu/libc rule: a `!value` entry excludes, any positive entry must include the value. */
function listAdmits(list: string[] | null, value: string | null | undefined): boolean {
  if (!list || list.length === 0) {
    return true
  }

  if (value && list.includes(`!${value}`)) {
    return false
  }

  const positive = list.filter(entry => !entry.startsWith('!'))

  return positive.length === 0 || (value != null && positive.includes(value))
}

export function rowRunsOn(row: PinRow, target: PinTarget): boolean {
  return (
    listAdmits(row.os, target.platform) &&
    listAdmits(row.cpu, target.arch) &&
    (target.platform !== 'linux' || listAdmits(row.libc, target.libc ?? null))
  )
}

/** Build tooling a dependency mis-declares, and type stubs: never loaded by a command (stage-acp-cli.mjs). */
export function isBuildTooling(name: string): boolean {
  return name === 'tsup' || name === 'typescript' || name.startsWith('@types/')
}

/** Node's lookup over lockfile keys: `<key>/node_modules/<name>`, then every ancestor's, then the top. */
export function resolveFrom(rows: ReadonlyMap<string, PinRow>, fromKey: string, name: string): string | null {
  for (let base = fromKey; ;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`

    if (rows.has(candidate)) {
      return candidate
    }

    if (!base) {
      return null
    }

    const at = base.lastIndexOf('/node_modules/')

    base = at < 0 ? '' : base.slice(0, at)
  }
}

/**
 * The rows the CLI can load at run time on `target` — the closure stage-acp-cli.mjs kept, computed from the lockfile
 * alone: from the CLI through dependencies, optionalDependencies and peerDependencies, build tooling and `@types/*`
 * excluded, other platforms' optional packages left out. Sorted by key. Without `target`, every platform's rows.
 */
export function runtimeClosure(pin: AcpPin, target: PinTarget | null): PinRow[] {
  const start = `node_modules/${ACP_CLI_NAME}`
  const keep = new Map<string, PinRow>()
  const queue = [start]

  while (queue.length > 0) {
    const key = queue.pop() as string
    const row = pin.rows.get(key)

    if (!row || keep.has(key)) {
      continue
    }

    if (target && !rowRunsOn(row, target)) {
      if (!row.optional) {
        throw new PinError(`acp pin: ${row.name}@${row.version} is required but does not run on ${targetName(target)}`)
      }

      continue
    }

    keep.set(key, row)

    for (const name of row.wants) {
      const found = isBuildTooling(name) ? null : resolveFrom(pin.rows, key, name)

      if (found) {
        queue.push(found)
      }
    }
  }

  return [...keep.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function targetName(target: PinTarget): string {
  return `${target.platform}-${target.arch}${target.platform === 'linux' && target.libc ? `-${target.libc}` : ''}`
}

// ── which files of a package tarball are installed (the same rules stage-acp-cli.mjs pruned the shipped tree by) ──

/** Kept whatever their extension: licence and notice texts travel with the code they cover. */
const LEGAL_TEXT = /^(licen[cs]e|notice|copying|authors|patents|third[-_.]?party)/i
/** Never read by a command: source maps, type declarations, TypeScript sources, docs. */
const NOT_RUNTIME_FILE = /\.(map|[cm]?tsx?|md|markdown|tsbuildinfo)$/i
const PLACEHOLDER_FILE = /^\.(gitkeep|gitignore|gitattributes|npmignore|DS_Store)$/

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

const CLI_DATA_DIR = 'docs'
const SIGNER_PREFIX = 'acp-cli-signer-'
const SIGNER_FOR: Record<string, string> = { darwin: 'acp-cli-signer-macos', win32: 'acp-cli-signer-windows.exe' }

/** The Go signer acp.js runs on this platform (its src/lib/acpCliSigner.ts picks it by `os.platform()`). */
export function signerFor(platform: string): string {
  return SIGNER_FOR[platform] ?? 'acp-cli-signer-linux'
}

export function isLegalText(file: string): boolean {
  return LEGAL_TEXT.test(file.slice(file.lastIndexOf('/') + 1))
}

/** A node-gyp-build prebuild tag (`darwin-arm64`, `darwin-x64+arm64`) that loads on this platform and arch. */
function prebuildRuns(tag: string, target: PinTarget): boolean {
  const [os, archs = ''] = tag.split('-')

  return os === target.platform && archs.split('+').includes(target.arch)
}

/**
 * Is `rel` (a path inside the package, `package/` already stripped, `/`-separated) installed? The CLI keeps its own
 * data (every root file and `docs/`: `acp skill path|print|check` read SKILL.md and the docs it links).
 */
export function installsFile(row: Pick<PinRow, 'name'>, rel: string, target: PinTarget): boolean {
  const parts = rel.split('/')
  const base = parts[parts.length - 1] ?? ''
  const isCli = row.name === ACP_CLI_NAME

  if (parts.length > 1 && NOT_RUNTIME_DIRS.has(parts[0] ?? '') && !(isCli && parts[0] === CLI_DATA_DIR)) {
    return false
  }

  if (parts[0] === 'prebuilds' && parts.length > 2 && !prebuildRuns(parts[1] ?? '', target)) {
    return false
  }

  if (PLACEHOLDER_FILE.test(base)) {
    return false
  }

  if (LEGAL_TEXT.test(base) || (isCli && (parts.length === 1 || parts[0] === CLI_DATA_DIR))) {
    return true
  }

  return !NOT_RUNTIME_FILE.test(base) && !(base.startsWith(SIGNER_PREFIX) && base !== signerFor(target.platform))
}
