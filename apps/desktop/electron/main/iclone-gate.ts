/**
 * V3-S (K139, round 2 M1): the ONE preparation every app-launched Hermes goes through before it exists.
 *
 * `prepareHermesSpawn` installs/verifies the iclone plugins, proves the gate ARMED in that runtime (the probe registers
 * the `pre_tool_call` hook under the lock, see iclone-hermes-plugins.ts), then mints the spawn's permission key and
 * returns everything the spawn must carry: the V3-F lock env, the fd-3 key pipe (stdio) and its `attach`, the V3-G
 * confinement env and the bytecode prefix no `.pyc` can be read from (no bytecode written). Any refusal is an `IcloneGateError` (`[iclone-gate]`); the
 * caller spawns nothing. A structural test (hermes-spawn-paths.test.ts) holds every Hermes launch in electron/ to it.
 *
 * Roles:
 * - `primary` — the window's backend (start-hermes). Without a running permission authority it still spawns locked and
 *   keyless (V3-F F-7: the gate then runs Manual and refuses everything but reading).
 * - `pool` — a backend for another local profile, forced-local included (managed-ssh-update `spawnPoolBackend`). It runs
 *   the cron ticker too, so it is refused outright when no key can be issued (fail closed).
 * - `external-terminal` — "Open in terminal": the TUI runs in the user's terminal app, not as a child of main, so its key
 *   cannot be delivered on an inherited pipe (and never goes in env, argv or a file). Refused until V3-F can key it.
 *
 * Runtime confinement (confinement on, macOS): before Hermes exists, main starts the confinement launcher (outside any
 * sandbox) and resolves the facts of the runtime profile; a call site that passes its command through `command()` and
 * `argv(args, command)` then spawns Hermes as `sandbox-exec -p <runtime profile> -D… <python> -s -P …`, with fd 3 and
 * the rest of stdio unchanged. A launcher that is not ready does not stop the spawn: Hermes still runs confined and its
 * commands are refused until the launcher answers. Confinement off or another platform: none of this runs, and the
 * command, argv and env are exactly what they were.
 */
import { type ChildProcess, execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

import { homeSettingsRefusal } from '../home-settings-files'
import { currentConfinement, type RuntimeSpawnFacts } from '../iclone-confinement/index'
import { confinementSpawnEnv } from '../iclone-confinement/ipc'
import { LAUNCHER_PATH } from '../iclone-confinement/launcher'
import { realOrSelf } from '../iclone-confinement/profiles'
import { ensureIcloneHermesPlugins, type GateReport, IcloneGateError, loadPluginSource } from '../iclone-hermes-plugins'
import { permissionsSpawn } from '../iclone-permissions/ipc'
import {
  CHECKED_BYTECODE_FLAGS,
  freshPycachePrefix,
  pycacheEnv,
  releasePycachePrefix,
  shippedBytecodeEnv
} from '../iclone-pycache'
import { runtimeDigests } from '../iclone-runtime-digest'
import { ensureRuntimeIntegrity, warmRuntimeDigests } from '../iclone-runtime-integrity'
import { PYTHON_ISOLATION_FLAGS, sealHermesSpawnEnv } from '../iclone-spawn-env'
import { PAY_SOCKET_NAME } from '../iclone-x402/ipc'
import { RUNTIME_PIN } from '../runtime-pin.generated'
import { registerTeardown } from '../teardown-registry'
import { profileHermesHome } from '../update-runtime-align'
import { hiddenWindowsChildOptions } from '../windows-child-options'

import { HERMES_HOME, SOURCE_REPO_ROOT } from './env'
import { rememberLog } from './log'
import {
  devBackendRoots,
  devPluginOverlayRoot,
  managedHermesRuntimeRoot,
  managedRuntimePin
} from './managed-hermes-runtime'
import { refuseWhileQuitting } from './state'

const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_BUFFER = 1024 * 1024

/** Round 3's per-process bytecode folder root, removed once (iclone-pycache.ts: the prefix now lies under /dev/null). */
export function hermesPycacheRoot(): string {
  return path.join(app.getPath('userData'), 'hermes-pycache')
}

function probe(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      hiddenWindowsChildOptions({ ...options, maxBuffer: PROBE_MAX_BUFFER, timeout: PROBE_TIMEOUT_MS }),
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || '')
            .trim()
            .split('\n')
            .slice(-3)
            .join(' | ')

          reject(new Error(tail ? `${error.message.split('\n')[0]}: ${tail}` : error.message))
        } else {
          resolve(String(stdout))
        }
      }
    )
  })
}

interface SpawnBackend {
  command?: null | string
  env?: Record<string, string | undefined>
  root?: null | string
}

/**
 * Throws an IcloneGateError (message marked `[iclone-gate]`) when the gate cannot be installed, verified or armed.
 * Internal to this module: callers use `prepareHermesSpawn`, which also hands out the key and the env.
 */
function ensureIcloneGate(options: {
  backend: SpawnBackend
  confinement: boolean
  cwd: string
  profile: null | string
}): Promise<GateReport> {
  return ensureIcloneHermesPlugins({
    // V3-S r4 (ruling 36): the app's own folder; a dev-backend checkout is unmanaged (verify-only, bundle plugins).
    activeRoot: managedHermesRuntimeRoot(),
    devOverlayRoot: devPluginOverlayRoot(),
    devRoots: devBackendRoots(),
    pin: managedRuntimePin(),
    backend: options.backend,
    baseEnv: process.env,
    confinement: options.confinement,
    cwd: options.cwd,
    hermesHome: HERMES_HOME,
    log: rememberLog,
    probe,
    profile: options.profile,
    pycacheRoot: hermesPycacheRoot(),
    source: () =>
      loadPluginSource({
        // A signed bundle exists only in a packaged app (not under HERMES_DESKTOP_IS_PACKAGED emulation).
        packaged: app.isPackaged,
        repoRoot: SOURCE_REPO_ROOT,
        resourcesPath: (process as { resourcesPath?: string }).resourcesPath ?? ''
      })
  })
}

export type HermesSpawnRole = 'external-terminal' | 'pool' | 'primary'

/** stdio of a gated spawn: fd 3 is the key pipe (written once by `attach`, then closed). */
export const GATED_STDIO: ['ignore', 'pipe', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe', 'pipe']

export interface PreparedHermesSpawn {
  /**
   * The command to spawn: `/usr/bin/sandbox-exec` under runtime confinement, else `command` itself. Pair it with
   * `argv(args, command)` (the same command), which then puts the interpreter after the profile and its defines.
   */
  command: (command: string) => string
  /**
   * The child's argv: the interpreter isolation flags (`-s -P`, iclone-spawn-env.ts) before the backend's own args. The
   * probe already ran this command as a Python interpreter (`-c`), so the flags are valid for it. Under runtime
   * confinement, and only when `command` is given: `-p <runtime profile> -D… <command> -s -P …args`.
   */
  argv: (args: readonly string[], command?: string) => string[]
  /**
   * The child's env, composed from everything the call site would pass (process.env, backend.env, consentEnv(), its own
   * keys): inherited Python settings and foreign `ICLONE_*` dropped, PYTHONPATH cut to the runtime's own, then the
   * gate's env (V3-F lock, V3-G confinement, the bytecode prefix) applied LAST, so nothing overrides it. A pool backend
   * keeps no payment env.
   */
  seal: (composed: Record<string, string | undefined>) => Record<string, string>
  stdio: typeof GATED_STDIO
  /** Right after spawn: the key down fd 3 (then closed), and the child's pid registered with the authority. */
  attach: (child: Pick<ChildProcess, 'once' | 'pid' | 'stdio'>) => void
  report: GateReport
}

/**
 * L4-01: every gated spawn checks its runtime; no verdict is reused by age. What makes a repeat cheap is the per-file
 * digest cache (iclone-runtime-digest.ts): a file whose stamp is unchanged since it was hashed is lstat()ed, not read.
 * Checks run one at a time (each may repair or remove files), so a spawn that arrives during another check, or during
 * the start-up prewarm, waits for it and then runs its own. A failed check fails that spawn only (fail closed); the
 * next one checks again.
 */
let integrityQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = integrityQueue.then(work)
  integrityQueue = run.catch(() => undefined)

  return run
}

/** Tests: forget every digest the checks have trusted so far (the next check hashes every file again). */
export function forgetRuntimeIntegrity(): void {
  runtimeDigests.clear()
}

/** RT-3: the runtime at `root` against this release's manifest (repaired from the bundle when the app installed it). */
export async function checkRuntimeIntegrity(
  root: string,
  resources: string | undefined = (process as { resourcesPath?: string }).resourcesPath
): ReturnType<typeof ensureRuntimeIntegrity> {
  const resolved = path.resolve(root)

  return serialized(() => verifyRuntimeIntegrity(resolved, resources))
}

/**
 * L4-01: at app start, the managed runtime's files are hashed into the digest cache (read-only: nothing repaired or
 * removed, nothing decided), so the first spawn's check mostly lstat()s. A packaged build only; never throws.
 */
export function prewarmRuntimeIntegrity(
  resources: string | undefined = (process as { resourcesPath?: string }).resourcesPath
): Promise<void> {
  if (!app.isPackaged) {
    return Promise.resolve()
  }

  const started = Date.now()

  return serialized(() =>
    warmRuntimeDigests({
      bundleDir: resources ? path.join(resources, 'hermes-runtime') : null,
      pin: RUNTIME_PIN,
      root: path.resolve(managedHermesRuntimeRoot())
    })
  ).then(
    hashed => {
      if (hashed > 0) {
        rememberLog(`[iclone-runtime] prewarm: ${hashed} runtime file(s) hashed in ${Date.now() - started} ms`)
      }
    },
    error => rememberLog(`[iclone-runtime] prewarm skipped: ${(error as Error).message}`)
  )
}

function verifyRuntimeIntegrity(
  root: string,
  resources: string | undefined
): ReturnType<typeof ensureRuntimeIntegrity> {
  return ensureRuntimeIntegrity({
    appVersion: app.getVersion(),
    bundleDir: resources ? path.join(resources, 'hermes-runtime') : null,
    managedRoot: managedHermesRuntimeRoot(),
    log: rememberLog,
    packaged: app.isPackaged,
    pin: RUNTIME_PIN,
    root: path.resolve(root)
  })
}

const PREFIX_PROBE = 'import os, sys; print(os.path.realpath(sys.prefix)); print(os.path.realpath(sys.base_prefix))'

/** An absolute path a profile can match (normalised, symlinks resolved), or a throw naming what was not one. */
function profilePath(label: string, value: string | undefined): string {
  const raw = (value ?? '').trim()

  if (!raw || !path.isAbsolute(raw) || /[\0\n\r]/.test(raw)) {
    throw new Error(`${label} is not an absolute path`)
  }

  return realOrSelf(path.resolve(raw))
}

/**
 * The interpreter as the confined spawn names it: its folder by real path (a link chain to the venv is not reachable
 * under the runtime profile), its own name kept, so a venv's `bin/python` link still finds its `pyvenv.cfg`.
 */
export function confinedInterpreter(command: string): string {
  const absolute = path.resolve(command)

  return path.join(realOrSelf(path.dirname(absolute)), path.basename(absolute))
}

/**
 * The facts of the runtime profile for one spawn: the interpreter's own prefixes (asked of it, `-I -S`, so nothing in
 * the env or the cwd answers for it), the runtime-only temp folder, main's permission and pay sockets, and what the
 * spawn site already resolved. The per-user cache folder is not one: the measured boot writes none of it.
 */
async function runtimeFacts(input: {
  command: string
  cwd: string
  paySocket: null | string
  permissions: Record<string, string>
  pluginsDir: null | string
  pycacheDir: null | string
  runtimeRoot: string
  tmpDir: string
  webDist?: string
}): Promise<RuntimeSpawnFacts> {
  const prefixes = await probe(input.command, ['-I', '-S', '-c', PREFIX_PROBE], {
    cwd: input.cwd,
    env: { LANG: 'C', PATH: LAUNCHER_PATH }
  })

  const [venv, base] = prefixes.trim().split('\n')
  const cwd = profilePath("Hermes' working folder", input.cwd)
  const permDir = path.join(app.getPath('userData'), 'run')

  return {
    runtimeRoot: profilePath('the runtime root', input.runtimeRoot),
    venvRoot: profilePath("the interpreter's prefix", venv),
    pythonHome: profilePath("the interpreter's base prefix", base),
    python: profilePath("the agent runtime's interpreter", input.command),
    // A cwd that fell back to the home is no project: its context files are not read.
    project: cwd === realOrSelf(os.homedir()) ? null : cwd,
    webDist: input.webDist ? profilePath('the web dist', input.webDist) : null,
    tmpDir: profilePath('the runtime temp folder', input.tmpDir),
    cacheDir: null,
    permDir: profilePath("main's socket folder", permDir),
    permSocket: input.permissions.ICLONE_PERM_SOCKET
      ? profilePath('the permission socket', input.permissions.ICLONE_PERM_SOCKET)
      : null,
    paySocket: input.paySocket,
    policyFile: input.permissions.ICLONE_POLICY_FILE
      ? profilePath("the spawn's policy file", input.permissions.ICLONE_POLICY_FILE)
      : null,
    pluginsDir: input.pluginsDir ? profilePath("the runtime's plugin folder", input.pluginsDir) : null,
    pycacheDir: input.pycacheDir
  }
}

// The launcher never outlives the app (it also exits by itself when main dies). In the one registry, not on will-quit:
// a forced exit skips will-quit.
registerTeardown('confinement launcher', () => {
  void currentConfinement()?.stopLauncher()
})

export async function prepareHermesSpawn(options: {
  backend: SpawnBackend
  cwd: string
  profile: null | string
  role: HermesSpawnRole
  /** The web dist the spawn serves (a fact of the runtime profile, when confined). */
  webDist?: string
}): Promise<PreparedHermesSpawn> {
  if (options.role === 'external-terminal') {
    throw new IcloneGateError(
      'a Hermes opened in another terminal app is not started by icloneOS, so it cannot receive its permission key. Continue this chat in icloneOS.'
    )
  }

  const confinementEnv = confinementSpawnEnv()
  const runtimeConfined = confinementEnv.ICLONE_RUNTIME_CONFINED === '1'
  const layer = runtimeConfined ? currentConfinement() : null

  // Before anything of the runtime runs on them: a settings file it could not read, by name and with the fix. Not a gate
  // failure, so not `[iclone-gate]`: Repair cannot help, and the overlay offers Retry after the owner's fix.
  const settingsRefusal = homeSettingsRefusal(profileHermesHome(HERMES_HOME, options.profile), {
    doing: 'start',
    linksOutsideRefused: runtimeConfined,
    root: HERMES_HOME
  })

  if (settingsRefusal) {
    rememberLog(`[home-settings] ${settingsRefusal}`)

    throw new Error(settingsRefusal)
  }

  // Runtime confinement: before anything runs the spawn's interpreter outside a sandbox (the plugin probe below, the
  // prefix probe later), it must be one the confined runtime cannot have chosen: a binary, and every link on its way,
  // where the runtime profile never writes. Otherwise a planted facts.json, venv or Python would run with the user's
  // rights; the spawn is refused with the folder named, never started unconfined and never with that interpreter.
  if (runtimeConfined) {
    if (!layer?.runtimeConfined()) {
      throw new IcloneGateError('confinement is on but its runtime layer is not ready, so the agent was not started')
    }

    if (!options.backend.command) {
      throw new IcloneGateError('the agent runtime has no interpreter to confine, so it was not started')
    }

    const refusal = layer.interpreterRefusal(options.backend.command)

    if (refusal) {
      throw new IcloneGateError(
        `the agent runtime's interpreter is not trusted to run outside the sandbox (${refusal}), so the agent was not started`
      )
    }
  }

  // V3-RT (RT-3): the runtime is this release's, byte for byte (repaired from the bundle when the app installed it),
  // before its plugins are checked. A packaged build only: a dev run's runtime is the repository itself.
  let integrity: Awaited<ReturnType<typeof ensureRuntimeIntegrity>> | null = null

  if (options.backend.root) {
    const resources = (process as { resourcesPath?: string }).resourcesPath

    integrity = await checkRuntimeIntegrity(options.backend.root, resources)
  }

  const report = await ensureIcloneGate({
    backend: options.backend,
    confinement: confinementEnv.ICLONE_CONFINEMENT === '1',
    cwd: options.cwd,
    profile: options.profile
  })

  // V3-F: the policy lock in env; the spawn key only on fd 3, written by attach() and closed (never env or argv).
  const permissions = permissionsSpawn(path.join(app.getPath('userData'), 'run'))

  if (options.role !== 'primary' && !permissions.keyLine) {
    throw new IcloneGateError(
      `icloneOS could not issue a permission key for the agent of profile "${options.profile ?? 'default'}", so it was not started`
    )
  }

  // Ruling 37 end state (V3-RT): the managed runtime, verified (or repaired) just now, runs on its shipped checked-hash
  // bytecode. Anything else keeps V3-S r4's interim: a prefix under a non-directory and no bytecode written, so
  // Python reads no `.pyc` at all, neither one in the runtime's tree nor one planted while it runs.
  const shippedBytecode = integrity?.action === 'verified' || integrity?.action === 'repaired'
  let prefix: null | string = null

  if (!shippedBytecode) {
    try {
      prefix = freshPycachePrefix(hermesPycacheRoot(), 'spawn')
    } catch (error) {
      throw new IcloneGateError(`the app's Python bytecode cache could not be prepared (${(error as Error).message})`)
    }
  }

  // Runtime confinement: the launcher up (or reported down) and the profile's facts resolved before Hermes exists. A
  // profile that cannot be built refuses the spawn; Hermes never runs unconfined while confinement is on.
  let wrap: ((command: string, args: readonly string[]) => { args: string[]; command: string }) | null = null
  let releaseLauncher: (() => Promise<void>) | null = null
  let runtimeTmp: null | string = null

  if (runtimeConfined && layer && options.backend.command) {
    const command = options.backend.command
    let facts: RuntimeSpawnFacts

    try {
      runtimeTmp = layer.runtimeTmpDir()
      facts = await runtimeFacts({
        command,
        cwd: options.cwd,
        // The pay env reaches the window's backend only (the seal drops it for a pool backend).
        paySocket: options.role === 'primary' ? path.join(app.getPath('userData'), 'run', PAY_SOCKET_NAME) : null,
        permissions: permissions.env,
        // An unmanaged dev runtime discovers its plugins in the app-owned overlay (HERMES_BUNDLED_PLUGINS): a read
        // hole of the profile, or the confinement plugin itself would never load.
        pluginsDir: report.env.HERMES_BUNDLED_PLUGINS ?? null,
        pycacheDir: prefix,
        runtimeRoot: report.runtimeRoot,
        tmpDir: runtimeTmp,
        webDist: options.webDist
      })
      layer.runtimeSpawn(confinedInterpreter(command), [], facts)
    } catch (error) {
      throw new IcloneGateError(
        `the agent runtime's confinement profile could not be built (${(error as Error).message}), so it was not started`
      )
    }

    // Teardown stops a launcher only once and may have run during an await above: this one would outlive the quit.
    refuseWhileQuitting('the confinement launcher')

    // Every confined Hermes (the window's backend and each pool backend) holds the launcher while it lives.
    releaseLauncher = layer.leaseLauncher()

    const launcher = await layer.ensureLauncher(report.runtimeRoot, facts)

    if (launcher !== 'up') {
      rememberLog(
        '[confinement] the launcher is not answering: Hermes starts confined and its commands are refused until it is back'
      )
    }

    wrap = (target, args) => {
      const launch = layer.runtimeSpawn(confinedInterpreter(target), args, facts)

      return { command: launch.command, args: launch.args }
    }
  }

  const gateEnv: Record<string, string> = {
    ...permissions.env,
    // V3-G: TERMINAL_ENV + profile dir, so the agent's shell runs confined (iclone-confinement plugin).
    ...confinementEnv,
    ...(prefix === null ? shippedBytecodeEnv() : pycacheEnv(prefix)),
    // An unmanaged dev runtime: the app-owned plugin folder the probe proved the gate armed from (ruling 36).
    ...report.env,
    // Under the runtime profile the per-user temp folder is not writable: the runtime-only one is its TMPDIR.
    ...(runtimeTmp === null ? {} : { TMPDIR: `${runtimeTmp}/` })
  }

  const role = options.role

  const isolated = (args: readonly string[]) => [
    ...PYTHON_ISOLATION_FLAGS,
    ...(prefix === null ? CHECKED_BYTECODE_FLAGS : []),
    ...args
  ]

  return {
    command: command => (wrap ? wrap(command, []).command : command),
    argv: (args, command) => (wrap && command !== undefined ? wrap(command, isolated(args)).args : isolated(args)),
    seal: composed => sealHermesSpawnEnv(composed, { gateEnv, role, runtimeRoot: report.runtimeRoot }),
    stdio: GATED_STDIO,
    attach: child => {
      child.once('exit', () => {
        if (prefix !== null) {
          releasePycachePrefix(prefix)
        }

        // This Hermes is gone: the launcher stops with the last confined Hermes (any other claim keeps it running).
        void releaseLauncher?.()
      })

      // The key goes down the pipe once and the pipe closes; the child reads it at its first import (iclone_policy_env).
      const keyPipe = child.stdio[3]

      if (keyPipe && 'end' in keyPipe) {
        keyPipe.on('error', () => undefined)
        keyPipe.end(permissions.keyLine ?? '')
      }

      permissions.attach(child)
    },
    report
  }
}
