/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Stamps the Hermes icon + identity onto the packed Windows Hermes.exe via
 * rcedit (delegated to set-exe-identity.mjs). This runs for EVERY packed build
 * — first install, `hermes desktop`, the installer's --update rebuild, and a
 * dev's manual `npm run pack` — so the branded exe can never silently revert
 * to the stock "Electron" icon/name (the bug when the stamp lived only in
 * install.ps1, which the update path doesn't use).
 *
 * Windows-only: rcedit edits PE resources, irrelevant on macOS/Linux where the
 * app identity comes from the bundle Info.plist / desktop entry. Best-effort:
 * a stamp failure must never fail an otherwise-good build (worst case is the
 * stock icon, not a broken app), so we log and resolve rather than throw.
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'Hermes')
 */

import fs from 'node:fs'
import path from 'node:path'

import { readFileSync } from 'node:fs'

import { PIN_PATH, readPin, verifyPackedRuntime } from './fetch-runtime-pin.mjs'
import { stampExeIdentity } from './set-exe-identity.mjs'
import { packedResourcesDir, verifyPackedIclonePlugins } from './stage-iclone-plugins.mjs'

/**
 * K146: Electron's prebuilt dist carries `default_app.asar` (the "drop an app here" demo app `electron` runs with no
 * app). A packaged app never loads it — main is app.asar — so it is dead weight with code in the signed bundle.
 * Removed here, before signing, on every platform. Returns the paths it removed.
 */
export function removeDefaultApp(context) {
  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const target = path.join(resources, 'default_app.asar')

  if (!fs.existsSync(target)) {
    return []
  }

  fs.rmSync(target, { force: true })
  console.log(`[after-pack] removed ${path.relative(context.appOutDir, target)} (Electron's default app, never loaded)`)

  return [target]
}

export default async function afterPack(context) {
  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  // V3-S (K139): a pack without the iclone Hermes plugins (or with a partial copy, or their tests) must not ship —
  // main would refuse every agent spawn on it.
  const problems = verifyPackedIclonePlugins(
    packedResourcesDir(context.appOutDir, context.electronPlatformName, productName)
  )

  if (problems.length > 0) {
    throw new Error(`[after-pack] iclone Hermes plugins not packed correctly: ${problems.join('; ')}`)
  }

  // V3-RT: the packed runtime folder is exactly the pinned bundle, its manifest included (the spawn gate verifies the
  // installed runtime against it; a pack without it refuses every agent on first launch).
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'linux') {
    const runtimeDir = path.join(
      packedResourcesDir(context.appOutDir, context.electronPlatformName, productName),
      'hermes-runtime'
    )
    const runtimeProblems = await verifyPackedRuntime(runtimeDir, readPin(readFileSync(PIN_PATH, 'utf8')))

    if (runtimeProblems.length > 0) {
      throw new Error(`[after-pack] the Hermes runtime is not packed correctly: ${runtimeProblems.join('; ')}`)
    }

    console.log(`[after-pack] packed Hermes runtime verified (${runtimeDir})`)
  }

  if (context.electronPlatformName !== 'win32') {
    removeDefaultApp(context)

    return
  }

  const exe = path.join(context.appOutDir, `${productName}.exe`)
  const desktopRoot = path.resolve(import.meta.dirname, '..')

  try {
    await stampExeIdentity(exe, desktopRoot)
  } catch (err) {
    // Never fail the build over a cosmetic stamp.
    console.warn(`[after-pack] exe identity stamp failed (${err.message}); Hermes.exe keeps the stock Electron icon`)
  }

  removeDefaultApp(context)
}
