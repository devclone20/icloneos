// REL-6 round 2 — a confined tree for the launcher's tests (scripts/acp-launch.cjs): userData/acp-cli/<lock>/ with
// runtime/node_modules, a MANIFEST.json whose digest the launcher recomputes, and the env main passes. Test-only.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-launch.cjs')
const LOCK = 'a'.repeat(64)

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** manifest.ts `treeDigest` (the launcher has its own copy; a test pins all three together). */
export function treeDigest(files) {
  const hash = createHash('sha256')

  for (const key of Object.keys(files).sort()) {
    const entry = files[key]

    hash.update(
      `${key}\0${entry.sha256}\0${entry.size}\0${entry.mode.toString(8)}${entry.source ? `\0${entry.source}` : ''}\n`
    )
  }

  return hash.digest('hex')
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)

    if (statSync(abs).isDirectory()) {
      walk(abs, base, out)
    } else {
      out.push(path.relative(base, abs).split(path.sep).join('/'))
    }
  }

  return out
}

/**
 * Write `files` (paths under runtime/node_modules → text) into `<home>/userData/acp-cli/<lock>/` and its manifest.
 * Returns the paths and the env the app gives the launcher.
 */
export function confinedTree(home, files) {
  const userData = path.join(home, 'userData')
  const lockDir = path.join(userData, 'acp-cli', LOCK)
  const nodeModules = path.join(lockDir, 'runtime', 'node_modules')

  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(nodeModules, ...rel.split('/'))

    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }

  return { userData, lockDir, nodeModules, ...seal(lockDir, home) }
}

/** (Re)write the manifest of everything under `lockDir` (MANIFEST.json excluded) and return the env. */
export function seal(lockDir, home) {
  const manifestFiles = {}

  for (const rel of walk(lockDir)) {
    if (rel === 'MANIFEST.json') {
      continue
    }

    const data = readFileSync(path.join(lockDir, rel))

    manifestFiles[rel] = {
      sha256: sha256(data),
      size: data.length,
      mode: statSync(path.join(lockDir, rel)).mode & 0o777
    }
  }

  const treeSha256 = treeDigest(manifestFiles)

  writeFileSync(path.join(lockDir, 'MANIFEST.json'), JSON.stringify({ v: 1, files: manifestFiles, treeSha256 }))

  return {
    treeSha256,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ICLONE_ACP_TREE: lockDir,
      ICLONE_ACP_TREE_SHA256: treeSha256
    }
  }
}

/** The Node runtimes the launcher must hold on: this Node, and Electron's own (the app's) when it is installed. */
export function runners() {
  const list = [{ name: `node ${process.versions.node}`, exec: process.execPath, env: {} }]
  const electron = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron'
  )

  if (process.platform === 'darwin' && existsSync(electron)) {
    list.push({ name: 'electron (its Node)', exec: electron, env: { ELECTRON_RUN_AS_NODE: '1' } })
  }

  return list
}
