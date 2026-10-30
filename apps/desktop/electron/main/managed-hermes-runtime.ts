/**
 * V3-S r4 — main's side of "the runtime icloneOS manages" (lead rulings 36 and 38):
 * - WHERE it lives: `managedHermesRuntimeRoot()`, the one resolver V3-RT installs the bundled artifact into
 *   (`<userData>/hermes-runtime/<artifact-sha256>`, never `~/.hermes/hermes-agent`); `hermesRuntimeMode()` says what
 *   any other runtime is (iclone-runtime-location.ts).
 * - WHAT binds it (ruling 38, revised): the pinned runtime sha, the pinned runtime manifest sha256 and this app's
 *   version (`managedRuntimePin()`), all compiled into the signed app. No secret, and no keychain: nothing here (or in
 *   the gate) calls safeStorage, so the gate can never raise the macOS keychain dialog.
 */
import path from 'node:path'

import { app } from 'electron'

import type { ManagedPin } from '../iclone-managed-runtime'
import {
  classifyRuntime,
  DEV_PLUGIN_OVERLAY_DIR,
  managedRuntimeRoot,
  type RuntimeMode
} from '../iclone-runtime-location'
import { codePathEnv } from '../packaged-env'
import { RUNTIME_PIN } from '../runtime-pin.generated'

import { IS_PACKAGED, isHermesSourceRoot, SOURCE_REPO_ROOT } from './env'

/** The runtime this release installs: the bundled artifact's sha256 (the pinned runtime tarball today). */
export function runtimeLockHash(): string {
  return RUNTIME_PIN.tarballSha256
}

/** `<userData>/hermes-runtime/<artifact-sha256>`: where the app's own runtime lives (V3-RT installs it there). */
export function managedHermesRuntimeRoot(): string {
  return managedRuntimeRoot(app.getPath('userData'), runtimeLockHash())
}

/** The checkouts the explicit dev-backend setting runs (iclone-runtime-location.ts `devBackendRootsFor`). */
export function devBackendRoots(): string[] {
  if (IS_PACKAGED) {
    return []
  }

  const override = codePathEnv('HERMES_DESKTOP_HERMES_ROOT') // iclone-seam: p7-env

  return [
    override ? path.resolve(override) : null,
    isHermesSourceRoot(SOURCE_REPO_ROOT) ? SOURCE_REPO_ROOT : null
  ].filter((root): root is string => Boolean(root))
}

/** The app-owned plugin folder an unmanaged dev runtime loads the bundle's iclone plugins from. */
export function devPluginOverlayRoot(): string {
  return path.join(app.getPath('userData'), DEV_PLUGIN_OVERLAY_DIR)
}

/** What the runtime at `root` is to the gate: managed, unmanaged-dev or foreign. */
export function hermesRuntimeMode(root: null | string): RuntimeMode {
  return classifyRuntime({ devRoots: devBackendRoots(), managedRoot: managedHermesRuntimeRoot(), root })
}

/** The runtime manifest's sha256 the signed app pins (V3-RT's repo pin carries it); null when this release has none. */
export function runtimeManifestSha256(): null | string {
  const pinned = (RUNTIME_PIN as { manifestSha256?: unknown }).manifestSha256

  return typeof pinned === 'string' && /^[0-9a-f]{64}$/.test(pinned) ? pinned : null
}

/** Everything that makes a runtime tree "managed" (iclone-managed-runtime.ts): path, manifest, stamp. */
export function managedRuntimePin(): ManagedPin {
  return {
    appVersion: app.getVersion(),
    lockHash: runtimeLockHash(),
    manifestSha256: runtimeManifestSha256(),
    root: managedHermesRuntimeRoot()
  }
}
