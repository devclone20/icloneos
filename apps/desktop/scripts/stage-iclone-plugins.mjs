/**
 * stage-iclone-plugins.mjs — V3-S (K139): the iclone Hermes plugins for the app bundle.
 *
 * Stages every `plugins/iclone-*` directory of the repo (without `tests/`, `__pycache__/`, `*.pyc`, dot-files) into
 * `build/iclone-hermes-plugins/<name>` and writes the content manifest `ICLONE_PLUGINS.json` (sha256 per file) next to
 * them. package.json `extraResources` copies that folder into `Resources/hermes-plugins/` beside `claude-code`; main
 * installs from there (electron/iclone-hermes-plugins.ts). before-pack stages, after-pack verifies the packed copy, so
 * a pack whose plugins are missing, partial or carry tests fails the build.
 *
 *   node scripts/stage-iclone-plugins.mjs                 # stage
 *   node scripts/stage-iclone-plugins.mjs --verify <dir>  # check a packed Resources dir (exit 1 on any problem)
 */
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildManifest,
  copyVerified,
  describeDiff,
  diffTree,
  expectedTree,
  ICLONE_PLUGIN_MANIFEST_FILE,
  ICLONE_PLUGIN_PREFIX,
  iclonePluginDirs,
  installedTree,
  readManifestFile,
  treeMatches
} from '../electron/iclone-plugin-tree.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export const REPO_PLUGINS = path.resolve(here, '..', '..', '..', 'plugins')
export const STAGED_PLUGINS = path.resolve(here, '..', 'build', 'iclone-hermes-plugins')

export function stageIclonePlugins({ from = REPO_PLUGINS, to = STAGED_PLUGINS } = {}) {
  const names = iclonePluginDirs(from)

  if (names.length === 0) {
    throw new Error(`no iclone-* plugin under ${from}`)
  }

  const manifest = buildManifest(from, names)
  rmSync(to, { force: true, recursive: true })

  for (const name of names) {
    copyVerified(path.join(from, name), path.join(to, name), manifest.plugins[name].files)
  }

  writeFileSync(path.join(to, ICLONE_PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

  return { names, files: names.reduce((sum, name) => sum + Object.keys(manifest.plugins[name].files).length, 0) }
}

/**
 * The packed copy for a Resources dir, staged from the repo exactly as before-pack + extraResources produce it. For tests
 * and fixtures of anything that runs afterPack (V3-S r2, m5): a pack fixture built with it passes the packed-plugins gate.
 */
export function stagePackedIclonePlugins(resourcesDir, { from = REPO_PLUGINS } = {}) {
  return stageIclonePlugins({ from, to: path.join(resourcesDir, 'hermes-plugins') })
}

/** The lstat of `file`, or null when it does not exist. */
function lstatOrNull(file) {
  try {
    return lstatSync(file)
  } catch {
    return null
  }
}

/**
 * Problems with the packed `<resources>/hermes-plugins` (empty = the bundle carries exactly this repo's plugins).
 * The packed tree must equal its manifest (listed strictly: no extra file, cache, dot-file, directory or link), and the
 * manifest must equal the one built from `repo` now (V3-S r2, m6) — so a stale staged copy from another commit fails.
 * V3-S r3: in `hermes-plugins/` (shared with other bundled plugins, such as claude-code) every `iclone-*` entry is a
 * manifest plugin and a real directory — a symbolic link (the root, a plugin folder, the manifest) or a stray `iclone-*`
 * file or folder fails it.
 */
export function verifyPackedIclonePlugins(resourcesDir, { repo = REPO_PLUGINS } = {}) {
  const root = path.join(resourcesDir, 'hermes-plugins')
  const rootStat = lstatOrNull(root)

  if (rootStat && !rootStat.isDirectory()) {
    return [`${root} is not a directory (a symbolic link is never packed)`]
  }

  const manifestStat = lstatOrNull(path.join(root, ICLONE_PLUGIN_MANIFEST_FILE))
  const manifest = manifestStat?.isFile() ? readManifestFile(path.join(root, ICLONE_PLUGIN_MANIFEST_FILE)) : null

  if (!manifest) {
    return [`${root}/${ICLONE_PLUGIN_MANIFEST_FILE} is missing or invalid`]
  }

  const problems = []

  // Other bundled plugins live here too (claude-code); every `iclone-*` entry must be a manifest plugin.
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(ICLONE_PLUGIN_PREFIX) && !manifest.plugins[entry]) {
      problems.push(`${entry} is a stray iclone entry in hermes-plugins/ (not in the manifest)`)
    }
  }

  const fromRepo = buildManifest(repo, iclonePluginDirs(repo))

  for (const name of Object.keys(fromRepo.plugins)) {
    if (!manifest.plugins[name]) {
      problems.push(`${name} is not in the manifest`)
    }
  }

  for (const [name, entry] of Object.entries(manifest.plugins)) {
    const dir = path.join(root, name)

    if (!fromRepo.plugins[name]) {
      problems.push(`${name} is not a plugin of this repo`)
    } else {
      const stale = diffTree(fromRepo.plugins[name].files, entry.files)

      if (!treeMatches(stale)) {
        problems.push(`${name} differs from the repo (${describeDiff(stale)})`)
      }
    }

    const stat = lstatOrNull(dir)

    if (!stat) {
      problems.push(`${name} is not packed`)

      continue
    }

    if (!stat.isDirectory()) {
      problems.push(`${name} is ${stat.isSymbolicLink() ? 'a symbolic link' : 'not a directory'} in hermes-plugins/`)

      continue
    }

    if (existsSync(path.join(dir, 'tests'))) {
      problems.push(`${name} ships its tests/`)
    }

    const diff = diffTree(expectedTree(entry.files), installedTree(dir))

    if (!treeMatches(diff)) {
      problems.push(`${name} differs from its manifest (${describeDiff(diff)})`)
    }
  }

  return problems
}

/** The Resources dir of a packed app for this platform (electron-builder afterPack context). */
export function packedResourcesDir(appOutDir, platformName, productFilename) {
  return platformName === 'darwin'
    ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verifyAt = process.argv.indexOf('--verify')

  if (verifyAt !== -1) {
    const problems = verifyPackedIclonePlugins(path.resolve(process.argv[verifyAt + 1] ?? '.'))

    for (const problem of problems) {
      console.error(`[iclone-plugins] ${problem}`)
    }

    console.log(problems.length ? '[iclone-plugins] packed plugins: FAIL' : '[iclone-plugins] packed plugins: OK')
    process.exit(problems.length ? 1 : 0)
  }

  const staged = stageIclonePlugins()
  console.log(`[iclone-plugins] staged ${staged.names.join(', ')} (${staged.files} files) into ${STAGED_PLUGINS}`)
}
