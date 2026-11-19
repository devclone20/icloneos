/**
 * v0.0.9 F2 point A (PLANO_V009_INSTALLS §2, P0_HERMES_FAILURES cause A): DETECT install state for the app's own
 * runtime under HERMES_HOME — never move or write it.
 *
 * The app's runtime keeps its dependencies privately (`<runtime>/.iclone-deps`, bootstrap-runner `placeStage`) and
 * its backend boots on its own venv interpreter. The runtime, though, scopes its install state by HERMES_HOME
 * (`pm/environments.py` `install_state_dir` = `<dependency root>/installs/<sha256(realpath(runtime))[:16]>`), and the
 * backend runs with the user's HERMES_HOME. When anything ran this runtime with the real HERMES_HOME and synced
 * dependencies (Isolation off + a lazy install such as the voice extra; the runtime run by hand), a `facts.json`
 * lands there; `activate_dependencies` then selects THAT environment and takes a lease inside it
 * (`hermes_cli/runtime_state.py` `lease_directory`). With Isolation on, the Seatbelt profile never lets the runtime
 * write `<HERMES_HOME>/installs` (`HERMES_HOME_NEVER_WRITTEN`, unchanged), and the backend exits 1 with "install state
 * is not writable by this user".
 *
 * Lead decision (17 Nov): main must NOT move anything under `~/.hermes/installs` by itself (it can be the user's own
 * standalone Hermes state). The durable fix is the runtime never adopting that state (no setting of the bundled
 * runtime does it today — verified read-only: `dependency_home_root` reads only HERMES_HOME — so it needs the runtime
 * patch RESUME/release/v0.0.9-installs/runtime-patches/pm-dependency-home.patch and a new pin). Moving a stale record
 * is the repair kit's job (F3, electron/repair-kit/), on the owner's click. This module only finds the record, so the
 * boot can log it and name it as the hint behind an `install-state-not-writable` boot cause.
 *
 * Only for a runtime with private dependencies (`<root>/.iclone-deps` exists).
 */
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'

export const PRIVATE_DEPS_DIR = '.iclone-deps'

type FsLike = Pick<typeof nodeFs, 'existsSync' | 'lstatSync' | 'realpathSync' | 'statSync'>

/** A runtime whose dependencies the app installed privately (`<root>/.iclone-deps`): the packaged app's own. */
export function isAppManagedRuntime(runtimeRoot: null | string | undefined, fs: FsLike = nodeFs): boolean {
  try {
    return Boolean(runtimeRoot) && fs.existsSync(path.join(runtimeRoot!, PRIVATE_DEPS_DIR))
  } catch {
    return false
  }
}

/** `<runtime>/.iclone-deps/hermes`: PM's dependency root for the app's runtime (env.ts `runtimePrivateDependencies`). */
export function privateDependencyHome(runtimeRoot: string): string {
  return path.join(runtimeRoot, PRIVATE_DEPS_DIR, 'hermes')
}

/**
 * v0.0.9 point A: the env EVERY app-launched process of the app's own runtime carries (the backend, pool backends, the
 * curated-config CLI, the `serve --help` probe, the doctor's runs, the uninstall summary, the plugin probe):
 * - HERMES_DEPENDENCY_HOME = the runtime's private dependency root, so a process run with the user's HERMES_HOME
 *   selects (and leases) its dependencies there, never in `<HERMES_HOME>/installs/<key>`
 *   (runtime-patches/pm-dependency-home.patch; the runtime freezes it at activation, before any `.env`);
 * - HERMES_DISABLE_LAZY_INSTALLS = 1, so it never syncs dependencies on demand (pm/install.py `lazy_installs_allowed`;
 *   explicit installs, such as the voice extra, are unaffected).
 * Empty for any other runtime (a dev checkout, the user's own Hermes). Both names are on HERMES_APP_ENV, so every seal
 * keeps them; callers still spread this AFTER their seal. hermes-spawn-paths.test.ts fails when a launch of the
 * runtime does not carry it.
 */
export function managedRuntimeEnv(
  runtimeRoot: null | string | undefined,
  fs: FsLike = nodeFs
): Readonly<Record<string, string>> {
  if (!runtimeRoot || !isAppManagedRuntime(runtimeRoot, fs)) {
    return {}
  }

  return { HERMES_DEPENDENCY_HOME: privateDependencyHome(runtimeRoot), HERMES_DISABLE_LAZY_INSTALLS: '1' }
}

/** The runtime's own install key: `sha256(str(Path(root).resolve()))[:16]` (pm/environments.py `install_key`). */
export function runtimeInstallKey(runtimeRoot: string, fs: FsLike = nodeFs): string {
  const canonical = fs.realpathSync(runtimeRoot)

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function realOrSelf(target: string, fs: FsLike): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * The data root the runtime scopes dependency state by, for a given HERMES_HOME (hermes_constants.py
 * `get_default_hermes_root`): inside the platform default home (`~/.hermes`, profiles included) → that default;
 * else `<root>/profiles/<name>` → `<root>`; else HERMES_HOME itself.
 */
export function dependencyHomeRoot(hermesHome: string, platformDefaultHome: string, fs: FsLike = nodeFs): string {
  const home = realOrSelf(hermesHome, fs)
  const native = realOrSelf(platformDefaultHome, fs)

  if (within(home, native)) {
    return platformDefaultHome
  }

  return path.basename(path.dirname(hermesHome)) === 'profiles' ? path.dirname(path.dirname(hermesHome)) : hermesHome
}

export interface ForeignInstallState {
  /** Each `<root>/installs/<key>` holding a dependency selection (`facts.json`) the runtime would adopt. */
  records: string[]
  /** The runtime's install key, when it could be computed. */
  key?: string
  /** Why nothing was looked at. */
  skipped?: 'unmanaged' | 'unresolvable' | 'windows'
}

/**
 * v0.0.9 Q (F3 rerun, minor): what the startup log says about a stale install record — truthfully. With the runtime
 * pinned to its private dependency home (`managedRuntimeEnv` non-empty) the record is IGNORED, not blocking; only an
 * unpinned runtime can still trip on it under Isolation.
 */
export function foreignInstallStateLogLine(records: readonly string[], pinned: boolean): string {
  const where = records.join(', ')

  return pinned
    ? `[iclone-runtime] an older install record for this app's runtime exists under ${where}; the runtime is pinned to its own private dependencies and ignores it (it does not block the start; the repair kit can move it aside). Nothing was changed.`
    : `[iclone-runtime] install state for this app's runtime exists under ${where}; with Isolation on the agent cannot start on it (the repair kit can move it aside). Nothing was changed.`
}

/**
 * Find `<root>/installs/<this runtime's key>/facts.json` for the dependency root of `hermesHome` and the platform
 * default root (`owning_home_root`'s second candidate). Read-only: lstat/stat/realpath, nothing created, moved or
 * written. Never throws.
 */
export function detectForeignInstallState(input: {
  fs?: FsLike
  hermesHome: string
  /** The user's home directory (`app.getPath('home')`). */
  home: string
  platform?: NodeJS.Platform
  runtimeRoot: null | string | undefined
}): ForeignInstallState {
  const fs = input.fs ?? nodeFs

  if ((input.platform ?? process.platform) === 'win32') {
    return { records: [], skipped: 'windows' }
  }

  if (!input.runtimeRoot || !isAppManagedRuntime(input.runtimeRoot, fs)) {
    return { records: [], skipped: 'unmanaged' }
  }

  let key: string

  try {
    key = runtimeInstallKey(input.runtimeRoot, fs)
  } catch {
    return { records: [], skipped: 'unresolvable' }
  }

  const platformDefault = path.join(input.home, '.hermes')
  const roots = [...new Set([dependencyHomeRoot(input.hermesHome, platformDefault, fs), platformDefault])]
  const privateRoot = realOrSelf(path.join(input.runtimeRoot, PRIVATE_DEPS_DIR), fs)
  const records: string[] = []

  for (const root of roots) {
    const record = path.join(root, 'installs', key)

    // The app's own private state is never "foreign".
    if (within(realOrSelf(record, fs), privateRoot)) {
      continue
    }

    try {
      if (fs.lstatSync(record).isDirectory() && fs.statSync(path.join(record, 'facts.json')).isFile()) {
        records.push(record)
      }
    } catch {
      // nothing there (the healthy case), or no selection record in it
    }
  }

  return { records, key }
}
