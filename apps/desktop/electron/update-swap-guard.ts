/**
 * update-swap-guard.ts
 *
 * Whether the running macOS .app may be handed to the updater as its
 * `--relaunch-target`.
 *
 * The desktop update script (`scripts/desktop-update/posix.sh`) treats that
 * argument as permission to REPLACE the bundle. Its `mac_swap()` looks for
 *
 *     <install root>/apps/desktop/release/mac-arm64/Hermes.app
 *
 * and, on a successful update, `ditto`s that bundle over `--relaunch-target`
 * and deletes the old one. Upstream can assume the two are the same app,
 * because upstream's running app IS the app that repo builds.
 *
 * That assumption is false here. iclone os is a white-label fork: the owner
 * runs `/Applications/iclone os.app`, while the install root at
 * `~/.hermes/hermes-agent` builds a stock `Hermes.app`. Passing the running
 * bundle unguarded means an in-app "Update now" can replace iclone os with
 * Hermes — different name, different icon, none of the owner's app — and the
 * swap deletes the `.old` copy on success, so there is nothing to put back.
 *
 * The guard is therefore product identity, not location: a bundle may be
 * replaced when it IS the bundle the updater rebuilds — either because it
 * lives inside that release tree, or because it carries the same bundle name.
 * That keeps upstream's legitimate flow (an installed `Hermes.app` kept fresh
 * by its own updater) working untouched, and refuses only the case that is
 * actually wrong: handing `Hermes.app` to something called something else.
 *
 * When the guard refuses, the updater still updates the runtime, still reports
 * honestly, and simply does not relaunch — the owner reopens the app. An app
 * that must be reopened is a far better outcome than an app that has been
 * replaced by a different product.
 */

/** The bundle `mac_swap()` looks for and would copy over the target. */
const REBUILT_BUNDLE_NAME = 'Hermes.app'

interface PathLike {
  basename: (p: string) => string
  isAbsolute: (p: string) => boolean
  join: (...parts: string[]) => string
  relative: (from: string, to: string) => string
}

/**
 * True when `runningBundle` is the bundle this updater rebuilds, and may
 * therefore safely be swapped for it.
 *
 * Both paths should already be absolute and resolved; a missing or empty value
 * answers false, because "I could not tell" must never read as "yes, replace
 * it".
 */
export function mayReplaceRunningBundle(
  runningBundle: null | string | undefined,
  installRoot: null | string | undefined,
  pathModule: PathLike
): boolean {
  if (!runningBundle || !installRoot) {
    return false
  }

  // Identity, and only identity. The location test this used to carry
  // ("anything under the release tree") would have let a fork build parked in
  // that tree — `release/mac-arm64/iclone os.app` — be dittoed over by a stock
  // Hermes.app, which is the one outcome this guard exists to prevent.
  // Installed elsewhere is fine as long as it is the same product — that is
  // upstream keeping its own installed copy fresh.
  return pathModule.basename(runningBundle) === REBUILT_BUNDLE_NAME
}

/**
 * What the window says as it closes for a runtime hand-off. It promises a
 * relaunch only when the updater was given a bundle it may relaunch; otherwise
 * nothing reopens the app, and the copy says so (contract P7 decision 18).
 */
export function handoffRestartCopy(relaunchWired: boolean): string {
  return relaunchWired
    ? 'Updating iclone os — this window will close. Don’t reopen iclone os yourself; it restarts automatically when the update finishes.'
    : 'Updating the Hermes runtime — this window will close. When the update finishes, reopen iclone os yourself: it does not restart on its own.'
}
