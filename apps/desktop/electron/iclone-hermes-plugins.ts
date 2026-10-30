/**
 * V3-S (K139) — the iclone Hermes plugins reach every Hermes the app spawns, or the app does not spawn one.
 *
 * The packaged runtime is installed from the pinned upstream tarball, so `plugins/iclone-*` (the V3-F permission gate,
 * the V3-G confinement layer) exist only where this module puts them. Before every local backend spawn:
 *
 * 1. source — the signed bundle (`Resources/hermes-plugins/<name>` + the build-time `ICLONE_PLUGINS.json`, re-checked
 *    against the bundled bytes), or the repo's `plugins/` in dev. Nothing else is ever a source.
 * 2. install/verify — into the runtime's own bundled plugin directory `<runtime>/plugins/<name>`, where Hermes
 *    auto-loads `kind: backend` plugins for EVERY profile (a user-dir copy would need `plugins.enabled` per profile and
 *    is exactly what V3-F's lock refuses to trust). A copy that differs from the manifest (missing, changed or extra
 *    file, a symlink) is replaced atomically: staged beside `plugins/` (Hermes scans every folder inside it, dot-named
 *    ones included), then renamed in. Only a runtime the app manages is ever written: `<HERMES_HOME>/hermes-agent` WITH
 *    the app's own `ICLONE_MANAGED.json` stamp and no git work tree in the way (iclone-managed-runtime.ts). Any other
 *    runtime (a user's checkout, a dev tree, a CLI on PATH) is verified only and refused on mismatch ("runtime not
 *    managed by the app"); a symbolic link is never followed.
 * 3. armed — the runtime's own plugin manager (`discover_plugins()` in a short-lived probe with the spawn's
 *    interpreter, isolation flags, env, cwd and profile, and the icloneOS arming flags but no key, socket or policy)
 *    must report the permission gate — and the confinement plugin when confinement is on — enabled, without error, from
 *    the installed path, with its `pre_tool_call` hook registered. "Armed" proves REGISTRATION, not dispatch: code that
 *    runs in the spawn after the probe could still patch dispatch. That is why the probe and the spawn share one Python
 *    isolation (iclone-spawn-env.ts: allowlisted interpreter env, PYTHONPATH cut to the runtime's own, `-s -P`) and
 *    the same bytecode prefix under a non-directory, so no `.pyc` is read (iclone-pycache.ts); core files edited in
 *    place remain K-S1 (V3-RT).
 *
 * Any refusal throws an `IcloneGateError` whose message carries `[iclone-gate]`; start-hermes latches it like any local
 * boot failure, so no backend runs and the renderer shows the gate copy (boot-failure overlay).
 */
import fs from 'node:fs'
import path from 'node:path'

import { ICLONE_GATE_MARK, ICLONE_GATE_UNMANAGED_MARK } from '../src/iclone-shared/iclone-gate'

import { type ManagedPin, managedRuntime, type ManagedVerdict, refreshStampAppVersion } from './iclone-managed-runtime'
import {
  buildManifest,
  copyVerified,
  describeDiff,
  diffTree,
  expectedTree,
  ICLONE_PLUGIN_MANIFEST_FILE,
  iclonePluginDirs,
  type IclonePluginManifest,
  installedTree,
  purgeBytecode,
  readManifestFile,
  treeFiles,
  treeMatches
} from './iclone-plugin-tree'
import { freshPycachePrefix, pycacheEnv, releasePycachePrefix } from './iclone-pycache'
import { classifyRuntime, prepareDevPluginOverlay, type RuntimeMode } from './iclone-runtime-location'
import { isolatePythonEnv, PYTHON_ISOLATION_FLAGS } from './iclone-spawn-env'
import { replaceDirAtomicSync } from './lib/atomic-write'

export const PERMISSIONS_PLUGIN = 'iclone-permissions'
export const CONFINEMENT_PLUGIN = 'iclone-confinement'
/** FX-4: Hermes' own microphone capture obeys the consent switch (plugins/iclone-consent). */
export const CONSENT_PLUGIN = 'iclone-consent'
/** Every iclone plugin the app expects Hermes to load (= every `plugins/iclone-*` in the repo; a test holds that). */
export const EXPECTED_ICLONE_PLUGINS: readonly string[] = [CONFINEMENT_PLUGIN, CONSENT_PLUGIN, PERMISSIONS_PLUGIN]
/** In every refusal message: the renderer keys the gate copy on it, the logs grep for it. */
export const GATE_MARK = ICLONE_GATE_MARK
export const PROBE_MARK = 'ICLONE-GATE-PROBE'

const STAGE_PREFIX = '.iclone-plugin-stage-'
const OLD_PREFIX = '.iclone-plugin-old-'

export class IcloneGateError extends Error {
  readonly isIcloneGateFailure = true

  /** `unmanaged`: the cause is a runtime the app does not manage (the renderer names it, m-g). */
  constructor(reason: string, options: { unmanaged?: boolean } = {}) {
    super(
      `${GATE_MARK} The icloneOS permission gate is not in place, so the agent was not started: ${reason}${options.unmanaged ? ` ${ICLONE_GATE_UNMANAGED_MARK}` : ''}`
    )
    this.name = 'IcloneGateError'
  }
}

export interface PluginSource {
  manifest: IclonePluginManifest
  root: string
}

/** The signed bundle's plugins (packaged) or the repo's (dev); `error` when the bundle cannot be trusted. */
export function loadPluginSource(options: {
  packaged: boolean
  repoRoot: string
  resourcesPath: string
}): { error: string } | { source: PluginSource } {
  if (!options.packaged) {
    const root = path.join(options.repoRoot, 'plugins')

    try {
      return { source: { root, manifest: buildManifest(root, iclonePluginDirs(root)) } }
    } catch (error) {
      return { error: `the plugins of this checkout cannot be read (${(error as Error).message})` }
    }
  }

  const root = path.join(options.resourcesPath, 'hermes-plugins')
  const manifest = readManifestFile(path.join(root, ICLONE_PLUGIN_MANIFEST_FILE))

  if (!manifest) {
    return { error: `the app bundle has no valid ${ICLONE_PLUGIN_MANIFEST_FILE}` }
  }

  for (const [name, entry] of Object.entries(manifest.plugins)) {
    let actual: Record<string, string>

    try {
      actual = treeFiles(path.join(root, name))
    } catch {
      return { error: `the app bundle has no ${name}` }
    }

    const diff = diffTree(entry.files, actual)

    if (!treeMatches(diff)) {
      return { error: `the app bundle's ${name} does not match its manifest (${describeDiff(diff)})` }
    }
  }

  return { source: { root, manifest } }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Stage and previous-tree folders left by an interrupted sync of any dead process (or of this one). */
export function sweepLeftovers(runtimeRoot: string, pid = process.pid): void {
  let names: string[]

  try {
    names = fs.readdirSync(runtimeRoot)
  } catch {
    return
  }

  for (const name of names) {
    // `.iclone-plugin-stage-<pid>-<random>` and `.iclone-plugin-old-<plugin>-<pid>`.
    const owner = name.startsWith(STAGE_PREFIX)
      ? Number(/^(\d+)-/.exec(name.slice(STAGE_PREFIX.length))?.[1])
      : name.startsWith(OLD_PREFIX)
        ? Number(/-(\d+)$/.exec(name)?.[1])
        : null

    if (owner === null) {
      continue
    }

    if (!owner || owner === pid || !processAlive(owner)) {
      try {
        fs.rmSync(path.join(runtimeRoot, name), { force: true, recursive: true })
      } catch {
        // The next sync retries.
      }
    }
  }
}

export interface PluginOutcome {
  action: 'installed' | 'refused' | 'verified'
  detail?: string
  name: string
}

export interface SyncReport {
  ok: boolean
  plugins: PluginOutcome[]
}

function installOne(source: PluginSource, name: string, runtimeRoot: string, pid: number): string | null {
  const files = source.manifest.plugins[name]!.files
  const target = path.join(runtimeRoot, 'plugins', name)
  // Same filesystem as the target (one rename), but OUTSIDE plugins/: Hermes would scan a staged copy as a plugin.
  const stage = fs.mkdtempSync(path.join(runtimeRoot, `${STAGE_PREFIX}${pid}-`))
  const previous = path.join(runtimeRoot, `${OLD_PREFIX}${name}-${pid}`)

  try {
    copyVerified(path.join(source.root, name), path.join(stage, name), files)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    replaceDirAtomicSync(path.join(stage, name), target, { keepPrevious: previous })
  } finally {
    fs.rmSync(stage, { force: true, recursive: true })
    fs.rmSync(previous, { force: true, recursive: true })
  }

  // The copy just written is read back with the strict listing: one more, one fewer or one changed entry is a refusal.
  const diff = diffTree(expectedTree(files), installedTree(target))

  return treeMatches(diff) ? null : describeDiff(diff)
}

/**
 * The installed copy as the verify sees it. Strict (`installedTree`: every entry counts) — except where the runtime's
 * plugin directory IS the source (dev: the repo's own `plugins/`, where the manifest was just computed from that same
 * tree and `tests/` lives beside the code), which is read with the source rules.
 */
function readInstalled(source: PluginSource, name: string, target: string): Record<string, string> {
  if (!fs.lstatSync(target).isDirectory()) {
    return { [name]: 'foreign' }
  }

  if (realpathOr(target) === realpathOr(path.join(source.root, name))) {
    return expectedTree(treeFiles(target))
  }

  return installedTree(target)
}

/** The first of `<runtimeRoot>/plugins` and `<runtimeRoot>/plugins/<name>` that is a symbolic link, else null. */
function linkOnTheWay(runtimeRoot: string, name: string): null | string {
  for (const file of [path.join(runtimeRoot, 'plugins'), path.join(runtimeRoot, 'plugins', name)]) {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        return file
      }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Makes `<runtimeRoot>/plugins/<name>` byte-identical to the source for every expected plugin. `writable` false: verify
 * only — the runtime is not one the app manages (`unmanaged` says why); nothing in it is purged, replaced or deleted.
 * Never throws; a refusal is in the report.
 */
export function syncIclonePlugins(options: {
  expected: readonly string[]
  pid?: number
  runtimeRoot: string
  source: PluginSource
  /** Why the runtime is verify-only (iclone-managed-runtime.ts); in every refusal of a verify-only runtime. */
  unmanaged?: string
  writable: boolean
}): SyncReport {
  const { expected, runtimeRoot, source, writable } = options
  const pid = options.pid ?? process.pid
  const plugins: PluginOutcome[] = []

  if (writable) {
    sweepLeftovers(runtimeRoot, pid)
  }

  for (const name of expected) {
    const entry = source.manifest.plugins[name]

    if (!entry) {
      plugins.push({ name, action: 'refused', detail: 'it is not in the app bundle' })

      continue
    }

    const target = path.join(runtimeRoot, 'plugins', name)
    // No bytecode cache survives into a load check (V3-S r2, M2): Python prefers a `.pyc` to the source it caches and
    // never compares an unchecked-hash one with it. In the runtime the app owns, every cache under the plugin is removed
    // first. A runtime it does not own is never written: there the strict listing makes any cache an extra entry, so
    // that copy is refused. (In dev the plugin directory IS the source tree, read with the source rules; the spawn's
    // PYTHONPYCACHEPREFIX keeps Python from reading a cache that lives in that tree.)
    let purged: string[] = []

    // V3-S r3 (m-d): a linked `plugins/` or plugin folder is tamper — never followed, never written through.
    const link = writable ? linkOnTheWay(runtimeRoot, name) : null

    if (link) {
      plugins.push({ name, action: 'refused', detail: `${link} is a symbolic link; icloneOS never follows it` })

      continue
    }

    if (writable) {
      try {
        purged = purgeBytecode(target)
      } catch (error) {
        plugins.push({
          name,
          action: 'refused',
          detail: `a Python bytecode cache in ${target} could not be removed (${(error as Error).message})`
        })

        continue
      }
    }

    const removed = purged.length
      ? `removed ${purged.length} cached bytecode ${purged.length === 1 ? 'entry' : 'entries'} (${purged.slice(0, 3).join(', ')}${purged.length > 3 ? ', …' : ''})`
      : ''

    let actual: Record<string, string> = {}

    try {
      actual = readInstalled(source, name, target)
    } catch {
      actual = {}
    }

    const diff = diffTree(expectedTree(entry.files), actual)

    // A copy that held bytecode is never reported verified: it is reinstalled from the bundle, whatever the cache was.
    if (treeMatches(diff) && !removed) {
      plugins.push({ name, action: 'verified' })

      continue
    }

    if (!writable) {
      plugins.push({
        name,
        action: 'refused',
        detail: `the copy in ${runtimeRoot} differs from the app's (${describeDiff(diff)}); runtime not managed by the app${options.unmanaged ? ` (${options.unmanaged})` : ''}, so icloneOS never writes to it`
      })

      continue
    }

    try {
      const left = installOne(source, name, runtimeRoot, pid)

      plugins.push(
        left
          ? { name, action: 'refused', detail: `installed copy still differs (${left})` }
          : { name, action: 'installed', detail: [removed, describeDiff(diff)].filter(Boolean).join('; ') }
      )
    } catch (error) {
      plugins.push({ name, action: 'refused', detail: `install failed (${(error as Error).message})` })
    }
  }

  return { ok: plugins.every(plugin => plugin.action !== 'refused'), plugins }
}

/**
 * The only icloneOS variables the probe carries: the arming flags. With them the plugins register exactly as in the
 * spawn (the permission gate's `pre_tool_call` hook, the confinement hook), so the check proves ARMED, not just loaded.
 * Nothing that reaches main or holds a secret is passed — no key fd, policy file, socket, token, spec, link key or ack
 * — so the probe has no key, cannot attest and writes nothing for main.
 */
export const PROBE_ARMING_ENV: Readonly<Record<string, string>> = {
  ICLONE_POLICY_LOCK: '1',
  // FX-4b: arms the microphone consent gate (its sounddevice import hook) as in the spawn; no record path is passed.
  ICLONE_CONSENT_MICROPHONE: '1'
}
export const PROBE_CONFINEMENT_ARMING_ENV: Readonly<Record<string, string>> = { ICLONE_CONFINEMENT: '1' }

/**
 * Run with the spawn's interpreter, env, cwd and profile: the runtime's own plugin manager, as the backend builds it.
 * Reports every iclone plugin's load state and the module file of every `pre_tool_call` hook, then leaves through
 * `os._exit` so no atexit handler (a plugin's stats or channel flush) runs.
 */
export const PROBE_SCRIPT = [
  'import json, os, sys',
  'profile = os.environ.pop("ICLONE_GATE_PROBE_PROFILE", "")',
  'if profile:',
  '    from hermes_cli.profiles import resolve_profile_env',
  '    os.environ["HERMES_HOME"] = str(resolve_profile_env(profile))',
  'from hermes_cli.plugins import discover_plugins, get_plugin_manager',
  'discover_plugins()',
  'pm = get_plugin_manager()',
  'rows = {}',
  'for key, lp in pm._plugins.items():',
  '    if str(key).startswith("iclone-"):',
  '        m = lp.manifest',
  '        rows[str(key)] = {"enabled": bool(lp.enabled), "error": lp.error, "path": str(m.path or ""), "source": m.source}',
  'finders = []',
  'for f in list(sys.meta_path):',
  '    mod = sys.modules.get(getattr(type(f), "__module__", None) or "")',
  '    finders.append(str(getattr(mod, "__file__", None) or ""))',
  'hooks = []',
  'for cb in list(pm._hooks.get("pre_tool_call", [])):',
  '    mod = sys.modules.get(getattr(cb, "__module__", None) or "")',
  '    hooks.append(str(getattr(mod, "__file__", None) or ""))',
  `print(${JSON.stringify(PROBE_MARK)} + json.dumps({"plugins": rows, "pre_tool_call": hooks, "meta_path": finders}), flush=True)`,
  'os._exit(0)'
].join('\n')

export interface ProbeRow {
  enabled: boolean
  error: null | string
  path: string
  source: string
}

export interface ProbeReport {
  plugins: Record<string, ProbeRow>
  /** The module file of every `pre_tool_call` hook the runtime registered. */
  preToolCall: string[]
  /** FX-4b: the module file of every import finder on `sys.meta_path` (the consent gate arms one). */
  metaPath?: string[]
}

export function parseProbe(stdout: string): null | ProbeReport {
  const line = stdout
    .split('\n')
    .reverse()
    .find(row => row.startsWith(PROBE_MARK))

  if (!line) {
    return null
  }

  try {
    const raw = JSON.parse(line.slice(PROBE_MARK.length)) as Record<string, unknown>
    const plugins = raw?.plugins as Record<string, Record<string, unknown>> | undefined
    const hooks = raw?.pre_tool_call
    const finders = Array.isArray(raw?.meta_path) ? (raw.meta_path as unknown[]) : []

    if (!plugins || typeof plugins !== 'object' || !Array.isArray(hooks)) {
      return null
    }

    const out: Record<string, ProbeRow> = {}

    for (const [name, row] of Object.entries(plugins)) {
      out[name] = {
        enabled: row?.enabled === true,
        error: typeof row?.error === 'string' ? row.error : null,
        path: typeof row?.path === 'string' ? row.path : '',
        source: typeof row?.source === 'string' ? row.source : ''
      }
    }

    return {
      plugins: out,
      preToolCall: hooks.filter((file): file is string => typeof file === 'string'),
      metaPath: finders.filter((file): file is string => typeof file === 'string')
    }
  } catch {
    return null
  }
}

function realpathOr(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The folders Hermes may report `<name>` loaded from: `<runtimeRoot>/plugins/<name>` with the runtime root as given or
 * as the system resolves it (Hermes resolves its own `__file__`; a temp root under /var is /private/var). Only the ROOT
 * is ever resolved, never the plugin path Hermes reports: a folder of links to the real plugins elsewhere (an inherited
 * HERMES_BUNDLED_PLUGINS) resolves to the installed copy but is not it (V3-S r4, m-b′).
 */
function pluginHomes(runtimeRoot: string, name: string): string[] {
  return [...new Set([path.resolve(runtimeRoot), realpathOr(runtimeRoot)])].map(root =>
    path.join(root, 'plugins', name)
  )
}

/** `file`, as written, lies inside `dir` (no link of the reported path is resolved). */
function isWithin(file: string, dir: string): boolean {
  if (!file || !path.isAbsolute(file)) {
    return false
  }

  const relative = path.relative(dir, path.normalize(file))

  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** The first of `<runtimeRoot>/plugins` and `<runtimeRoot>/plugins/<name>` that is not a real directory, else null. */
function notARealDirectory(runtimeRoot: string, name: string): null | string {
  for (const dir of [path.join(runtimeRoot, 'plugins'), path.join(runtimeRoot, 'plugins', name)]) {
    try {
      if (!fs.lstatSync(dir).isDirectory()) {
        return dir
      }
    } catch {
      return dir
    }
  }

  return null
}

/**
 * Null when every required plugin is loaded from the runtime's installed copy AND armed (a `pre_tool_call` hook whose
 * code lives in that copy); else why not. `runtimeRoot` is the folder whose `plugins/` Hermes must load the gate from.
 */
export function judgeProbe(
  report: null | ProbeReport,
  required: readonly string[],
  runtimeRoot: string
): null | string {
  if (!report) {
    return 'the Hermes runtime did not report its plugins'
  }

  for (const name of required) {
    const row = report.plugins[name]
    const homes = pluginHomes(runtimeRoot, name)

    if (!row) {
      return `Hermes did not discover ${name}`
    }

    if (!row.enabled || row.error) {
      return `Hermes did not load ${name}${row.error ? ` (${row.error})` : ''}`
    }

    if (!row.path || !homes.includes(path.normalize(row.path))) {
      return `Hermes loaded ${name} from ${row.path || 'an unknown place'}, not from ${homes[0]}`
    }

    const linked = notARealDirectory(runtimeRoot, name)

    if (linked) {
      return `${linked} is not a real directory, so Hermes did not load ${name} from the installed copy`
    }

    if (name === CONSENT_PLUGIN) {
      // FX-4b: the consent gate arms an import finder for sounddevice, not a tool hook.
      if (!(report.metaPath ?? []).some(file => homes.some(home => isWithin(file, home)))) {
        return `Hermes loaded ${name} but its microphone gate is not armed, so the microphone would not obey the switch`
      }

      continue
    }

    if (!report.preToolCall.some(file => homes.some(home => isWithin(file, home)))) {
      return `Hermes loaded ${name} but it registered no pre_tool_call hook, so no tool call would be checked`
    }
  }

  return null
}

interface GateBackend {
  command?: null | string
  env?: Record<string, string | undefined>
  root?: null | string
}

export type ProbeExec = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<string>

export interface GateDeps {
  /**
   * The managed runtime: `<userData>/hermes-runtime/<artifact-sha256>` (ruling 36, iclone-runtime-location.ts); written
   * only when it carries the release's manifest and the app's stamp for this runtime and app version (`pin`).
   */
  activeRoot: string
  /** The checkouts the explicit dev-backend setting runs (never in a packaged app): unmanaged, verify-only. */
  devRoots?: readonly string[]
  /** The app-owned plugin folder an unmanaged dev runtime loads the bundle's iclone plugins from. */
  devOverlayRoot?: string
  /** What the signed app pins (ruling 38, revised): runtime sha, manifest sha256, app version. Absent ⇒ none managed. */
  pin?: Omit<ManagedPin, 'root'>
  backend: GateBackend
  /** True when the spawn routes its terminal through the confinement plugin (ICLONE_CONFINEMENT=1). */
  confinement: boolean
  cwd: string
  /** The env the spawn starts from (main's, minus ICLONE_* which the probe never carries). */
  baseEnv: NodeJS.ProcessEnv
  hermesHome: string
  log: (line: string) => void
  now?: () => number
  probe: ProbeExec
  profile: null | string
  /**
   * Round 3's per-process bytecode folder root, removed once (iclone-pycache.ts). Every gated Python — the probe here,
   * each spawn in prepareHermesSpawn — now runs with a PYTHONPYCACHEPREFIX under a non-directory and
   * PYTHONDONTWRITEBYTECODE=1, so it reads no `.pyc` at all: not one in the runtime's tree, not one planted anywhere.
   */
  pycacheRoot: string
  source: () => { error: string } | { source: PluginSource }
}

export interface GateReport {
  /** What the spawn must carry for the gate to load as probed (an unmanaged dev runtime: its plugin folder). */
  env: Record<string, string>
  loaded: string[]
  /** managed / unmanaged-dev / foreign (iclone-runtime-location.ts); the pane labels an unmanaged runtime. */
  mode: RuntimeMode['kind']
  ms: number
  plugins: PluginOutcome[]
  runtimeRoot: string
}

/** Install/verify, then confirm Hermes loads the gate. Throws IcloneGateError instead of letting a spawn through. */
export async function ensureIcloneHermesPlugins(deps: GateDeps): Promise<GateReport> {
  const now = deps.now ?? Date.now
  const started = now()
  const root = deps.backend.root ? path.resolve(deps.backend.root) : null

  if (!root || !deps.backend.command) {
    throw new IcloneGateError(
      `the Hermes runtime${deps.backend.command ? ` ${deps.backend.command}` : ''} is not one icloneOS installed, so its plugins cannot be checked. Use Repair install.`,
      { unmanaged: true }
    )
  }

  const loaded = deps.source()

  if ('error' in loaded) {
    throw new IcloneGateError(loaded.error)
  }

  // V3-S r4 (ruling 36): the managed runtime lives in the app's own folder; a dev checkout is unmanaged; anything else
  // (the owner's checkout at ~/.hermes/hermes-agent included) is foreign. Only the managed one is ever written, and
  // only with the release's manifest, the app's stamp for this runtime and app version, and no git work tree in the way
  // (r3 m-d, ruling 38 revised).
  const mode = classifyRuntime({ devRoots: deps.devRoots ?? [], managedRoot: deps.activeRoot, root })
  const targets = EXPECTED_ICLONE_PLUGINS.map(name => path.join(root, 'plugins', name))

  const managed: ManagedVerdict =
    mode.kind === 'managed'
      ? deps.pin
        ? managedRuntime(root, targets, { ...deps.pin, root: deps.activeRoot })
        : { managed: false, reason: 'the app pins no runtime to manage' }
      : { managed: false, reason: mode.kind === 'unmanaged-dev' ? `unmanaged runtime: ${mode.why}` : mode.why }

  // Where Hermes must load the gate from: the runtime's own plugins/, or (unmanaged dev) the app-owned overlay.
  let pluginRoot = root
  const gateEnv: Record<string, string> = {}

  if (mode.kind === 'unmanaged-dev') {
    if (!deps.devOverlayRoot) {
      throw new IcloneGateError(`${root} is an unmanaged runtime and the app has no plugin folder for it`)
    }

    try {
      gateEnv.HERMES_BUNDLED_PLUGINS = prepareDevPluginOverlay(deps.devOverlayRoot, root, EXPECTED_ICLONE_PLUGINS)
    } catch (error) {
      throw new IcloneGateError(
        `the app's plugin folder for ${root} could not be prepared (${(error as Error).message})`
      )
    }

    pluginRoot = path.dirname(gateEnv.HERMES_BUNDLED_PLUGINS)
    deps.log(
      `${GATE_MARK} ${root}: unmanaged runtime (dev-backend setting) — never written; the iclone plugins load read-only from ${gateEnv.HERMES_BUNDLED_PLUGINS}`
    )
  } else if (!managed.managed) {
    deps.log(`${GATE_MARK} ${root}: verify only — ${managed.reason}`)
  }

  const sync = syncIclonePlugins({
    expected: EXPECTED_ICLONE_PLUGINS,
    runtimeRoot: pluginRoot,
    source: loaded.source,
    unmanaged: managed.managed ? undefined : managed.reason,
    writable: mode.kind === 'unmanaged-dev' || managed.managed
  })

  for (const plugin of sync.plugins) {
    deps.log(`${GATE_MARK} ${plugin.name}: ${plugin.action}${plugin.detail ? ` — ${plugin.detail}` : ''}`)
  }

  if (!sync.ok) {
    const refused = sync.plugins.filter(plugin => plugin.action === 'refused')

    // m-g: a runtime the app may not write (foreign, or managed but unstamped) is refused for THAT cause.
    throw new IcloneGateError(refused.map(plugin => `${plugin.name}: ${plugin.detail}`).join('; '), {
      unmanaged: mode.kind !== 'unmanaged-dev' && !managed.managed
    })
  }

  // r5 (m-d″): the app version in the stamp is informational — after an app update over the same runtime, a verified
  // managed tree's stamp names this app again (the stamp file only).
  if (managed.managed && deps.pin && refreshStampAppVersion(root, managed.stamp, deps.pin.appVersion)) {
    deps.log(`${GATE_MARK} ${root}: stamp refreshed (${managed.stamp.appVersion} → ${deps.pin.appVersion})`)
  }

  // FX-4b: the microphone consent gate is required like the others: a Hermes that did not arm it is refused.
  const required = deps.confinement
    ? [PERMISSIONS_PLUGIN, CONSENT_PLUGIN, CONFINEMENT_PLUGIN]
    : [PERMISSIONS_PLUGIN, CONSENT_PLUGIN]

  const composed: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries({ ...deps.baseEnv, ...deps.backend.env })) {
    if (!key.toUpperCase().startsWith('ICLONE_')) {
      composed[key] = value
    }
  }

  // V3-S r3 (m-b): the spawn's Python isolation — inherited PYTHON* dropped, PYTHONPATH cut to the runtime's own.
  const env: NodeJS.ProcessEnv = isolatePythonEnv(composed, root)

  Object.assign(env, PROBE_ARMING_ENV, deps.confinement ? PROBE_CONFINEMENT_ARMING_ENV : {}, gateEnv)

  env.HERMES_HOME = deps.hermesHome

  if (deps.profile) {
    env.ICLONE_GATE_PROBE_PROFILE = deps.profile
  }

  let prefix: string

  try {
    prefix = freshPycachePrefix(deps.pycacheRoot, 'probe')
  } catch (error) {
    throw new IcloneGateError(`the app's Python bytecode cache could not be prepared (${(error as Error).message})`)
  }

  Object.assign(env, pycacheEnv(prefix))

  let stdout = ''

  try {
    stdout = await deps.probe(deps.backend.command, [...PYTHON_ISOLATION_FLAGS, '-c', PROBE_SCRIPT], {
      cwd: deps.cwd,
      env
    })
  } catch (error) {
    throw new IcloneGateError(`the plugin load check could not run (${(error as Error).message.split('\n')[0]})`)
  } finally {
    releasePycachePrefix(prefix)
  }

  const refusal = judgeProbe(parseProbe(stdout), required, pluginRoot)

  if (refusal) {
    throw new IcloneGateError(refusal)
  }

  const report: GateReport = {
    env: gateEnv,
    loaded: required,
    mode: mode.kind,
    ms: now() - started,
    plugins: sync.plugins,
    runtimeRoot: root
  }

  deps.log(`${GATE_MARK} loaded by Hermes at ${root}: ${required.join(', ')} (${report.ms} ms)`)

  return report
}
