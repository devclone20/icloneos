// Where the installed Electron lives.
//
// npm hoists `electron` to the repo root's node_modules (or nests it in the workspace when the workspace pins another
// version): `require.resolve` finds the package wherever it landed. Its binary is the one `install.js` unpacked into
// `dist/` and named in `path.txt`. Nothing here ever downloads it: since Electron 42 `require('electron')` (the
// package's index) fetches the binary on first use when `dist/` is missing, so the scripts resolve the files
// themselves and name the install command instead. ELECTRON_OVERRIDE_DIST_PATH, when set, wins exactly as it does in
// the package's index: the binary is `<override>/<path.txt>`, or `<override>/electron` when there is no path.txt.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** The command that unpacks the pinned binary into the installed package without a reinstall (from the repo root). */
export const INSTALL_ELECTRON_COMMAND = 'node node_modules/electron/install.js'

/** The install command for the package that was actually resolved; the repo-root form when none was. */
export function installElectronCommand(packageDir) {
  return packageDir ? `node "${join(packageDir, 'install.js')}"` : INSTALL_ELECTRON_COMMAND
}

/** The installed `electron` package folder, or null when it is not installed. */
export function electronPackageDir(resolvePackageJson = () => require.resolve('electron/package.json')) {
  try {
    return dirname(resolvePackageJson())
  } catch {
    return null
  }
}

/** The `dist/` folder of the installed package (the unpacked Electron), or null when the package is not installed. */
export function electronDistDir(packageDir = electronPackageDir()) {
  return packageDir ? join(packageDir, 'dist') : null
}

/**
 * The Electron executable: `<ELECTRON_OVERRIDE_DIST_PATH>/<path.txt>` when that variable is set (as the package's
 * index resolves it), else the one `install.js` unpacked (`dist/<path.txt>`). Throws, naming the resolved package's
 * install command, when the binary is not there: a script must never trigger the download itself.
 */
export function findElectronBinary(packageDir = electronPackageDir(), env = process.env) {
  const pathFile = packageDir ? join(packageDir, 'path.txt') : null
  const named = pathFile && existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : ''
  const install = installElectronCommand(packageDir)
  const override = env.ELECTRON_OVERRIDE_DIST_PATH

  if (override) {
    const binary = join(override, named || 'electron')

    if (existsSync(binary)) {
      return binary
    }

    throw new Error(
      `Electron binary not found at ${binary} (ELECTRON_OVERRIDE_DIST_PATH names its folder). ` +
        `Unpack it there, or run ${install} with that variable set; the scripts never download it.`
    )
  }

  if (named) {
    const binary = join(packageDir, 'dist', named)

    if (existsSync(binary)) {
      return binary
    }
  }

  throw new Error(
    `Electron binary not found under ${packageDir ? join(packageDir, 'dist') : 'node_modules/electron/dist'} ` +
      `(its path.txt names it). Run ${install} to install it; the scripts never download it.`
  )
}
