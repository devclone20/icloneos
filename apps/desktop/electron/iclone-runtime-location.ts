/**
 * V3-S r4 (lead ruling 36) — WHERE the app's managed Hermes runtime lives, and what any other runtime is to the gate.
 * Pure (paths and the file system only); main wires it to userData and the bundled pin (main/managed-hermes-runtime.ts),
 * and V3-RT installs the bundled artifact at `managedRuntimeRoot()`.
 *
 * - managed — `<userData>/hermes-runtime/<artifact-sha256>/`, an APP-OWNED folder, never `~/.hermes/hermes-agent`
 *   (`HERMES_HOME` stays `~/.hermes`: state, config, profiles; only the code moves). The gate installs, verifies and
 *   purges the iclone plugins there — when it carries the release's manifest and the app's stamp (iclone-managed-runtime.ts).
 * - unmanaged-dev — a checkout the developer chose with the explicit dev-backend setting (`HERMES_DESKTOP_HERMES_ROOT`,
 *   or the repository a `npm run dev` runs from; neither exists in a packaged app). The gate never writes to it: the
 *   iclone plugins load read-only from the app's copy of the bundle, through an app-owned plugin folder
 *   (`prepareDevPluginOverlay`) that the gate's env names (HERMES_BUNDLED_PLUGINS); the pane says "unmanaged runtime".
 * - foreign — anything else: whatever sits at `~/.hermes/hermes-agent` (a 0.0.2 tarball install, the owner's own git
 *   checkout), a Hermes on PATH, a system Python. Verified only, never written, refused on any mismatch.
 */
import fs from 'node:fs'
import path from 'node:path'

import { RUNTIME_PIN } from './runtime-pin.generated'

export const MANAGED_RUNTIME_DIR = 'hermes-runtime'
/** The app-owned plugin folder of an unmanaged dev runtime: `<userData>/hermes-dev-plugins/plugins`. */
export const DEV_PLUGIN_OVERLAY_DIR = 'hermes-dev-plugins'
/** The iclone plugins: the bundle's copies win over a checkout's own. */
export const ICLONE_PLUGIN_PREFIX = 'iclone-'

const SHA256_RE = /^[0-9a-f]{64}$/

/** The resolver V3-RT installs into: `<userData>/hermes-runtime/<artifact-sha256>`. */
export function managedRuntimeRoot(userData: string, artifactSha256: string): string {
  if (!SHA256_RE.test(artifactSha256)) {
    throw new Error(`the runtime artifact id ${JSON.stringify(artifactSha256)} is not a sha256`)
  }

  return path.join(path.resolve(userData), MANAGED_RUNTIME_DIR, artifactSha256)
}

/**
 * The checkouts the explicit dev-backend setting runs — the two resolveHermesBackend honours first:
 * HERMES_DESKTOP_HERMES_ROOT, and the repository `npm run dev` runs from. A packaged app has neither (its code-path
 * variables are ignored and its repository root is the app bundle).
 */
export function devBackendRootsFor(input: {
  isSourceRoot: (root: string) => boolean
  override?: null | string
  packaged: boolean
  sourceRoot: string
}): string[] {
  if (input.packaged) {
    return []
  }

  const candidates = [input.override ? path.resolve(input.override) : null, path.resolve(input.sourceRoot)]

  return [...new Set(candidates.filter((root): root is string => Boolean(root) && input.isSourceRoot(root!)))]
}

export type RuntimeMode =
  | { kind: 'foreign'; root: null | string; why: string }
  | { kind: 'managed'; root: string }
  | { kind: 'unmanaged-dev'; root: string; why: string }

function same(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/** What the runtime at `root` is to the gate (see the module comment). */
export function classifyRuntime(input: {
  devRoots: readonly string[]
  managedRoot: string
  root: null | string
}): RuntimeMode {
  const { root } = input

  if (!root) {
    return { kind: 'foreign', root: null, why: 'a Hermes the app did not install (on PATH or a system Python)' }
  }

  if (same(root, input.managedRoot)) {
    return { kind: 'managed', root: path.resolve(root) }
  }

  if (input.devRoots.some(dev => same(dev, root))) {
    return { kind: 'unmanaged-dev', root: path.resolve(root), why: 'the dev-backend setting runs this checkout' }
  }

  let checkout = false

  try {
    fs.lstatSync(path.join(root, '.git'))
    checkout = true
  } catch {
    checkout = false
  }

  return {
    kind: 'foreign',
    root: path.resolve(root),
    why: checkout
      ? 'it is a git checkout, which icloneOS never writes to'
      : `it is not the runtime icloneOS installs (${input.managedRoot})`
  }
}

function removeEntry(file: string): void {
  const stat = fs.lstatSync(file)

  if (stat.isDirectory()) {
    fs.rmSync(file, { force: true, recursive: true })
  } else {
    fs.unlinkSync(file)
  }
}

function realDirectory(dir: string): void {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true })

  if (!fs.lstatSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a real directory`)
  }
}

/**
 * The plugin folder an unmanaged dev runtime runs with, all of it in `overlayRoot` (app-owned): one link per entry of
 * `<runtimeRoot>/plugins` that is not an iclone plugin (so the checkout's own plugins load as they would), and NO iclone
 * entry of the checkout — syncIclonePlugins then installs the bundle's iclone plugins (`icloneNames`) as real folders
 * beside the links; any other `iclone-*` entry is removed.
 * The checkout is only read (one readdir). Returns `<overlayRoot>/plugins`.
 */
export function prepareDevPluginOverlay(
  overlayRoot: string,
  runtimeRoot: string,
  icloneNames: readonly string[]
): string {
  realDirectory(overlayRoot)
  const plugins = path.join(overlayRoot, 'plugins')
  realDirectory(plugins)

  let entries: string[] = []

  try {
    entries = fs.readdirSync(path.join(runtimeRoot, 'plugins'))
  } catch {
    entries = []
  }

  const wanted = new Map(
    entries
      .filter(name => !name.startsWith(ICLONE_PLUGIN_PREFIX))
      .map(name => [name, path.join(path.resolve(runtimeRoot), 'plugins', name)] as const)
  )

  for (const name of fs.readdirSync(plugins)) {
    const file = path.join(plugins, name)
    const target = wanted.get(name)

    if (name.startsWith(ICLONE_PLUGIN_PREFIX)) {
      // The bundle's own (installed by syncIclonePlugins); anything else named like one is not loaded.
      if (!icloneNames.includes(name)) {
        removeEntry(file)
      }

      continue
    }

    const stat = fs.lstatSync(file)

    if (!target || !stat.isSymbolicLink() || fs.readlinkSync(file) !== target) {
      removeEntry(file)
    }
  }

  for (const [name, target] of wanted) {
    const file = path.join(plugins, name)

    if (!fs.existsSync(file) && !isLink(file)) {
      fs.symlinkSync(target, file)
    }
  }

  return plugins
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * V3-RT (M2): the app's own runtime root, computed without main's env module (which needs a live Electron app at import):
 * `<userData>/hermes-runtime/<pinned artifact sha256>` — the same path as main's `managedHermesRuntimeRoot()`.
 */
export function appRuntimeRoot(userData: string): string {
  return managedRuntimeRoot(userData, RUNTIME_PIN.tarballSha256)
}
