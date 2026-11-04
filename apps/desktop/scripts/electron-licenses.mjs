// Chromium's licence file ships with the app.
//
// Electron's dist carries LICENSES.chromium.html (every third-party licence of Chromium and of Electron's own
// dependencies), and THIRD_PARTY_NOTICES.md promises it in the app's Resources. electron-builder's extraResources
// takes only static paths and npm hoists `electron` wherever it likes, so the file is staged by the beforePack hook
// from the dist that pack uses (build/electron-licenses/, which package.json names) and the afterPack hook refuses a
// pack whose copy is missing or differs from that dist's: a missing extraResources source is only a warning to
// electron-builder.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { electronDistDir, INSTALL_ELECTRON_COMMAND } from './electron-dist.mjs'

export const CHROMIUM_LICENSES_FILE = 'LICENSES.chromium.html'

/** Where beforePack stages the file; package.json `extraResources` reads it from here (relative to apps/desktop). */
export const STAGED_CHROMIUM_LICENSES = join('build', 'electron-licenses', CHROMIUM_LICENSES_FILE)

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The Electron dist this pack uses: the one run-electron-builder.mjs configured, else the installed package's. A
 * relative `electronDist` is resolved against the packager's project directory, as electron-builder resolves it, never
 * against the current working directory.
 */
export function packedElectronDist(context) {
  const configured = context?.packager?.config?.electronDist

  if (typeof configured !== 'string' || !configured) {
    return electronDistDir()
  }

  const projectDir = context?.packager?.projectDir

  return typeof projectDir === 'string' && projectDir ? resolve(projectDir, configured) : resolve(configured)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Copies the dist's licence file to the staged path; throws when the dist has none. Returns the staged path. */
export function stageChromiumLicenses({ dist, to = join(DESKTOP_ROOT, STAGED_CHROMIUM_LICENSES) } = {}) {
  const source = dist ? join(dist, CHROMIUM_LICENSES_FILE) : null

  if (!source || !existsSync(source)) {
    throw new Error(
      `${CHROMIUM_LICENSES_FILE} not found in the Electron dist (${dist ?? 'electron is not installed'}); ` +
        `run "${INSTALL_ELECTRON_COMMAND}" from the repo root`
    )
  }

  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(source, to)

  return to
}

/**
 * The ways the packed Resources folder fails to carry the dist's licence file: the dist has none to compare with,
 * the pack has none, or the bytes differ. Empty when the packed copy is exactly the dist's.
 */
export function verifyPackedChromiumLicenses(resourcesDir, dist) {
  const expected = dist ? join(dist, CHROMIUM_LICENSES_FILE) : null
  const packed = join(resourcesDir, CHROMIUM_LICENSES_FILE)

  if (!expected || !existsSync(expected)) {
    return [`${CHROMIUM_LICENSES_FILE} is not in the Electron dist (${dist ?? 'electron is not installed'})`]
  }

  if (!existsSync(packed)) {
    return [`${CHROMIUM_LICENSES_FILE} is not in the packed Resources (${resourcesDir})`]
  }

  const packedSha = sha256(packed)
  const expectedSha = sha256(expected)

  return packedSha === expectedSha
    ? []
    : [`${CHROMIUM_LICENSES_FILE} in the pack (sha256 ${packedSha}) is not the Electron dist's (sha256 ${expectedSha})`]
}
