// Where electron-builder leaves the macOS bundle, shared by the install and
// verification scripts so both agree on which app they are talking about.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_NAME = 'iclone os.app'

// Local builds (`npm run pack`, used by install:mac) are written OUTSIDE iCloud: macOS refuses to sign a bundle inside
// ~/Desktop or ~/Documents because the File Provider keeps stamping FinderInfo on it ("detritus not allowed"), and the
// Electron fuses modify the binary, so every build must be signed after packing (2026-10-07).
export const LOCAL_BUILD_DIR = join(homedir(), 'Library', 'Caches', 'iclone-os', 'build')

export function findBuiltApp(projectRoot) {
  // electron-builder names the dir by target arch, and universal builds drop
  // the suffix — take whichever exists rather than assuming the host arch.
  const dirs = [`mac-${process.arch}`, 'mac-arm64', 'mac-x64', 'mac-universal', 'mac']

  const candidates = [
    ...dirs.map(dir => join(LOCAL_BUILD_DIR, dir, APP_NAME)),
    ...dirs.map(dir => join(projectRoot, 'release', dir, APP_NAME))
  ]

  return candidates.find(path => existsSync(path)) ?? ''
}
