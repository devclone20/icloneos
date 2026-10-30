/**
 * V3-S (K139) — the content manifest of the iclone Hermes plugins (`plugins/iclone-*`): one sha256 per shipped file.
 *
 * Shared, unchanged, by the build (scripts/stage-iclone-plugins.mjs writes the staged tree and its manifest into the
 * bundle; after-pack checks the packed copy) and by main (electron/iclone-hermes-plugins.ts installs from the bundle and
 * re-checks the installed copy on every launch). Plain node builtins and erasable TypeScript only, so the build scripts
 * import this file directly.
 *
 * What ships: every regular file of the plugin directory except its top-level `tests/`, `__pycache__/`, `*.pyc` and
 * dot-files (`treeFiles`, the build's view of a SOURCE tree). An INSTALLED copy is read with `installedTree`, which
 * skips nothing: any entry the manifest does not name — bytecode, a dot-file, a directory, a symlink — is an extra, so
 * that copy never verifies. A symlink anywhere is never followed.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ICLONE_PLUGIN_MANIFEST_FILE = 'ICLONE_PLUGINS.json'
export const ICLONE_PLUGIN_MANIFEST_SCHEMA = 1
/** Every directory under the repo's `plugins/` that the app ships and installs. */
export const ICLONE_PLUGIN_PREFIX = 'iclone-'

const NAME_RE = /^iclone-[a-z0-9][a-z0-9-]{0,62}$/
const SHA_RE = /^[0-9a-f]{64}$/
/** A foreign entry (symlink, socket, device) in an installed copy; never equal to a file hash. */
const FOREIGN = 'foreign'

export type PluginFiles = Record<string, string>

export interface IclonePluginManifest {
  schema: typeof ICLONE_PLUGIN_MANIFEST_SCHEMA
  plugins: Record<string, { files: PluginFiles }>
}

export interface TreeDiff {
  changed: string[]
  extra: string[]
  missing: string[]
}

export function isIclonePluginName(name: string): boolean {
  return NAME_RE.test(name)
}

/** A relative path (POSIX separators) of a file the plugin ships. */
export function isShippedPath(rel: string): boolean {
  const parts = rel.split('/')

  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === '__pycache__')) {
    return false
  }

  return parts[0] !== 'tests' && !rel.endsWith('.pyc')
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * The shipped files of one plugin directory, keyed by POSIX relative path. `lstat` throughout: a symlink is recorded
 * as `foreign` (its target is never read), so a tampered copy cannot point a shipped name at another file.
 * Ignored (not shipped) entries are skipped without being opened — `__pycache__` that Python writes next to the code.
 */
export function treeFiles(dir: string): PluginFiles {
  const out: PluginFiles = {}

  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name

      if (!isShippedPath(relPath)) {
        continue
      }

      const full = path.join(dir, relPath)
      const stat = fs.lstatSync(full)

      if (stat.isDirectory()) {
        walk(relPath)
      } else if (stat.isFile()) {
        out[relPath] = sha256File(full)
      } else {
        out[relPath] = FOREIGN
      }
    }
  }

  walk('')

  return out
}

/** Marks a directory in an installed-copy listing (`<rel>/`); never equal to a file hash. */
const DIRECTORY = 'dir'
const BYTECODE_RE = /\.py[co]$/

/**
 * Everything under an INSTALLED plugin directory, nothing skipped: every file (sha256), every directory (`<rel>/`), and
 * every other entry — a symlink, a socket — as `foreign` (never followed). Dot-files, `__pycache__`, `*.pyc` and a
 * nested `tests/` are listed like anything else, so a copy that holds one more entry than the manifest never verifies
 * (V3-S round 2, M2: a planted unchecked-hash `.pyc` is imported instead of the source it shadows).
 */
export function installedTree(dir: string): PluginFiles {
  const out: PluginFiles = {}

  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name
      const full = path.join(dir, relPath)
      const stat = fs.lstatSync(full)

      if (stat.isDirectory()) {
        out[`${relPath}/`] = DIRECTORY
        walk(relPath)
      } else if (stat.isFile()) {
        out[relPath] = sha256File(full)
      } else {
        out[relPath] = FOREIGN
      }
    }
  }

  walk('')

  return out
}

/** The manifest's files plus the directories they imply, in `installedTree`'s shape. */
export function expectedTree(files: PluginFiles): PluginFiles {
  const out: PluginFiles = { ...files }

  for (const rel of Object.keys(files)) {
    const parts = rel.split('/')

    for (let i = 1; i < parts.length; i += 1) {
      out[`${parts.slice(0, i).join('/')}/`] = DIRECTORY
    }
  }

  return out
}

/**
 * Removes every Python bytecode cache under `dir` — each `__pycache__` entry and each `*.pyc` / `*.pyo` — without
 * following a symlink (a linked `__pycache__` loses the link, never its target; a linked `dir` is refused). Python prefers a `.pyc` over the
 * source it caches and does not compare an unchecked-hash one with that source at all, so a cache is never trusted in a
 * gate the app is about to load. Returns the relative paths removed; a missing `dir` removes nothing. Throws when an
 * entry cannot be removed (the caller then refuses: the strict listing would still show it).
 */
export function purgeBytecode(dir: string): string[] {
  const removed: string[] = []

  // V3-S r3 (m-d): `dir` itself is never followed either — a linked plugin folder would take the purge outside the tree.
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`${dir} is a symbolic link; it is never followed`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const walk = (rel: string) => {
    let names: string[]

    try {
      names = fs.readdirSync(path.join(dir, rel)).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return
      }

      throw error
    }

    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name
      const full = path.join(dir, relPath)
      const stat = fs.lstatSync(full)

      if (name === '__pycache__' || BYTECODE_RE.test(name)) {
        fs.rmSync(full, { force: true, recursive: stat.isDirectory() })
        removed.push(relPath)
      } else if (stat.isDirectory()) {
        walk(relPath)
      }
    }
  }

  walk('')

  return removed
}

export function diffTree(expected: PluginFiles, actual: PluginFiles): TreeDiff {
  const diff: TreeDiff = { changed: [], extra: [], missing: [] }

  for (const [rel, sha] of Object.entries(expected)) {
    if (!(rel in actual)) {
      diff.missing.push(rel)
    } else if (actual[rel] !== sha) {
      diff.changed.push(rel)
    }
  }

  for (const rel of Object.keys(actual)) {
    if (!(rel in expected)) {
      diff.extra.push(rel)
    }
  }

  return diff
}

export function treeMatches(diff: TreeDiff): boolean {
  return diff.changed.length === 0 && diff.extra.length === 0 && diff.missing.length === 0
}

export function describeDiff(diff: TreeDiff): string {
  const part = (label: string, list: string[]) =>
    list.length ? `${list.length} ${label} (${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''})` : ''

  return [part('missing', diff.missing), part('changed', diff.changed), part('extra', diff.extra)]
    .filter(Boolean)
    .join('; ')
}

/** The `iclone-*` plugin directories under a `plugins/` root, sorted. */
export function iclonePluginDirs(pluginsRoot: string): string[] {
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(
      entry => entry.isDirectory() && entry.name.startsWith(ICLONE_PLUGIN_PREFIX) && isIclonePluginName(entry.name)
    )
    .map(entry => entry.name)
    .sort()
}

export function buildManifest(pluginsRoot: string, names: readonly string[]): IclonePluginManifest {
  const plugins: IclonePluginManifest['plugins'] = {}

  for (const name of names) {
    plugins[name] = { files: treeFiles(path.join(pluginsRoot, name)) }
  }

  return { schema: ICLONE_PLUGIN_MANIFEST_SCHEMA, plugins }
}

/** A manifest read from disk, or null when its shape is anything but what the build writes. */
export function parseManifest(raw: unknown): IclonePluginManifest | null {
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).schema !== ICLONE_PLUGIN_MANIFEST_SCHEMA) {
    return null
  }

  const plugins = (raw as Record<string, unknown>).plugins

  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return null
  }

  const out: IclonePluginManifest['plugins'] = {}

  for (const [name, entry] of Object.entries(plugins as Record<string, unknown>)) {
    const files = (entry as Record<string, unknown> | null)?.files

    if (!isIclonePluginName(name) || !files || typeof files !== 'object' || Array.isArray(files)) {
      return null
    }

    const checked: PluginFiles = {}

    for (const [rel, sha] of Object.entries(files as Record<string, unknown>)) {
      if (!isShippedPath(rel) || typeof sha !== 'string' || !SHA_RE.test(sha)) {
        return null
      }

      checked[rel] = sha
    }

    if (Object.keys(checked).length === 0) {
      return null
    }

    out[name] = { files: checked }
  }

  return { schema: ICLONE_PLUGIN_MANIFEST_SCHEMA, plugins: out }
}

export function readManifestFile(file: string): IclonePluginManifest | null {
  try {
    return parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** Copies exactly the manifest's files from `from` to a new directory `to`, checking each file's bytes on the way. */
export function copyVerified(from: string, to: string, files: PluginFiles): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o755 })

  for (const [rel, sha] of Object.entries(files)) {
    const source = path.join(from, ...rel.split('/'))

    if (!fs.lstatSync(source).isFile()) {
      throw new Error(`${rel} is not a regular file in ${from}`)
    }

    const bytes = fs.readFileSync(source)

    if (createHash('sha256').update(bytes).digest('hex') !== sha) {
      throw new Error(`${rel} in ${from} does not match the manifest`)
    }

    const dest = path.join(to, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
    fs.writeFileSync(dest, bytes, { mode: 0o644, flag: 'wx' })
  }
}
