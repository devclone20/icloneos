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
 */
import { type ChildProcess, execFile } from 'node:child_process'
import path from 'node:path'

import { app } from 'electron'

import { confinementSpawnEnv } from '../iclone-confinement/ipc'
import { ensureIcloneHermesPlugins, type GateReport, IcloneGateError, loadPluginSource } from '../iclone-hermes-plugins'
import { permissionsSpawn } from '../iclone-permissions/ipc'
import {
  CHECKED_BYTECODE_FLAGS,
  freshPycachePrefix,
  pycacheEnv,
  releasePycachePrefix,
  shippedBytecodeEnv
} from '../iclone-pycache'
import { ensureRuntimeIntegrity } from '../iclone-runtime-integrity'
import { PYTHON_ISOLATION_FLAGS, sealHermesSpawnEnv } from '../iclone-spawn-env'
import { RUNTIME_PIN } from '../runtime-pin.generated'
import { hiddenWindowsChildOptions } from '../windows-child-options'

import { HERMES_HOME, SOURCE_REPO_ROOT } from './env'
import { rememberLog } from './log'
import {
  devBackendRoots,
  devPluginOverlayRoot,
  managedHermesRuntimeRoot,
  managedRuntimePin
} from './managed-hermes-runtime'

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
   * The child's argv: the interpreter isolation flags (`-s -P`, iclone-spawn-env.ts) before the backend's own args. The
   * probe already ran this command as a Python interpreter (`-c`), so the flags are valid for it.
   */
  argv: (args: readonly string[]) => string[]
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
 * One launch checks the runtime once: the curated-config CLI and the backend spawn that follows it a few seconds later
 * share a verdict reached within `INTEGRITY_REUSE_MS` (a later spawn — a pool backend, a respawn — checks again).
 */
const INTEGRITY_REUSE_MS = 15_000

let lastIntegrity: { at: number; report: Awaited<ReturnType<typeof ensureRuntimeIntegrity>>; root: string } | null =
  null

/** Tests: forget the reused verdict. */
export function forgetRuntimeIntegrity(): void {
  lastIntegrity = null
}

/** RT-3: the runtime at `root` against this release's manifest (repaired from the bundle when the app installed it). */
export async function checkRuntimeIntegrity(
  root: string,
  resources: string | undefined = (process as { resourcesPath?: string }).resourcesPath
): ReturnType<typeof ensureRuntimeIntegrity> {
  const resolved = path.resolve(root)

  if (lastIntegrity && lastIntegrity.root === resolved && Date.now() - lastIntegrity.at < INTEGRITY_REUSE_MS) {
    return lastIntegrity.report
  }

  const report = await verifyRuntimeIntegrity(resolved, resources)
  lastIntegrity = { at: Date.now(), report, root: resolved }

  return report
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

export async function prepareHermesSpawn(options: {
  backend: SpawnBackend
  cwd: string
  profile: null | string
  role: HermesSpawnRole
}): Promise<PreparedHermesSpawn> {
  if (options.role === 'external-terminal') {
    throw new IcloneGateError(
      'a Hermes opened in another terminal app is not started by icloneOS, so it cannot receive its permission key. Continue this chat in icloneOS.'
    )
  }

  const confinementEnv = confinementSpawnEnv()

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

  const gateEnv: Record<string, string> = {
    ...permissions.env,
    // V3-G: TERMINAL_ENV + profile dir, so the agent's shell runs confined (iclone-confinement plugin).
    ...confinementEnv,
    ...(prefix === null ? shippedBytecodeEnv() : pycacheEnv(prefix)),
    // An unmanaged dev runtime: the app-owned plugin folder the probe proved the gate armed from (ruling 36).
    ...report.env
  }

  const role = options.role

  return {
    argv: args => [...PYTHON_ISOLATION_FLAGS, ...(prefix === null ? CHECKED_BYTECODE_FLAGS : []), ...args],
    seal: composed => sealHermesSpawnEnv(composed, { gateEnv, role, runtimeRoot: report.runtimeRoot }),
    stdio: GATED_STDIO,
    attach: child => {
      child.once('exit', () => {
        if (prefix !== null) {
          releasePycachePrefix(prefix)
        }
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
