/**
 * backend-probes.ts
 *
 * Cheap "does this candidate backend actually work" checks used by
 * resolveHermesBackend (main.ts). The resolver walks a ladder of
 * candidates -- bootstrap marker, `hermes` on PATH, system Python with
 * hermes_cli installed -- and historically returned the first candidate
 * whose binary existed on disk. That assumption breaks when a user has
 * a pre-installed Python 3.11-3.13 (so findSystemPython() returns a
 * path) but no hermes_cli in its site-packages: the resolver hands back
 * a backend the spawn step can't actually run, and the user gets a
 * dead-on-arrival "ModuleNotFoundError: No module named 'hermes_cli'"
 * instead of the first-launch installer.
 *
 * These probes give the resolver a way to verify a candidate before
 * trusting it. Failure (non-zero exit, exception, timeout) means "skip
 * this rung, try the next one"; success means "spawn this for real."
 * Falling off the bottom of the ladder lands on the bootstrap-needed
 * sentinel, which is exactly what we want when nothing pre-existing
 * actually works.
 *
 * Both probes are deliberately fast and forgiving:
 *   - default 15s timeout (5s was too short on cold Windows disks / AV;
 *     issue #61764 death-loop); fixed, no env override (ruling 42)
 *   - one automatic retry after a timeout before declaring the runtime dead
 *   - stdio ignored (we only care about exit code; stdout/stderr are
 *     not surfaced to the user, just to recentHermesLog for forensics
 *     via the caller's catch block if it chooses)
 *   - any throw -> false (never propagate -- resolver wants a boolean)
 *
 * Kept in a standalone ts module so it can be unit-tested with
 * `node --test` without dragging in the electron runtime (same pattern
 * as bootstrap-platform.ts and hardening.ts).
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { NO_BYTECODE_PREFIX, pycacheEnv } from './iclone-pycache'
import { isolatePythonEnv, PYTHON_ISOLATION_FLAGS } from './iclone-spawn-env'

/** Default probe budget. 5s false-negativeed healthy Windows cold starts (#61764). */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/**
 * The probe budget is fixed (ruling 42, from V3-RT-B r2): the HERMES_PROBE_TIMEOUT_MS knob let a sync probe block main
 * for up to 120 s with no heartbeat. A packaged app runs no probe on its boot path at all (main/updates.ts).
 */
const PROBE_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }

  const e = err as { code?: string; killed?: boolean; signal?: string }

  if (e.killed === true) {
    return true
  }

  if (e.code === 'ETIMEDOUT') {
    return true
  }

  // Node marks timed-out execFileSync with SIGTERM on some platforms.
  if (e.signal === 'SIGTERM') {
    return true
  }

  return false
}

/**
 * V3-S r5b (K-RT11): the env of a probe that runs the runtime's Python — the gated spawn's interpreter env
 * (iclone-spawn-env.ts allowlist, PYTHONPATH cut to the first entry's tree, which callers make the runtime root; none
 * when there is no PYTHONPATH) and the bytecode prefix under /dev/null with PYTHONDONTWRITEBYTECODE=1.
 */
function sealedProbeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const root = String(env.PYTHONPATH ?? '')
    .split(path.delimiter)
    .find(entry => entry && path.isAbsolute(entry))

  // No absolute first entry: no PYTHONPATH at all (a system Python finds hermes_cli in its own site-packages).
  const sealed = isolatePythonEnv({ ...env, PYTHONPATH: root ? env.PYTHONPATH : undefined }, root ?? path.sep)

  return { ...sealed, ...pycacheEnv(NO_BYTECODE_PREFIX) }
}

/**
 * Run execFileSync; on timeout only, retry once before failing.
 * Non-timeout failures (ENOENT, non-zero exit) fail immediately.
 */
function execProbeSync(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdio: 'ignore'
    timeout: number
    shell?: boolean
    windowsHide?: boolean
  }
): void {
  try {
    execFileSync(command, args, options)
  } catch (err) {
    if (!isTimeoutError(err)) {
      throw err
    }

    // One cold-cache / AV miss should not force hermes-setup --update (#61764).
    execFileSync(command, args, options)
  }
}

/**
 * Return the Python snippet used to verify Hermes can import far enough to
 * launch the CLI. Kept exported for tests so dependency regressions are
 * caught without needing a real broken venv fixture.
 *
 * @returns {string}
 */
function hermesRuntimeImportProbe() {
  // V3-RT (RT-4 live): the runtime at 1ac3f97 no longer depends on PyYAML (hermes_yaml over ruamel.yaml), so the old
  // `import yaml` failed on every fresh install and the first-run bootstrap looped. This is upstream's probe at the pin.
  return 'import hermes_bootstrap; import hermes_yaml; import dotenv; import hermes_cli.config'
}

/**
 * Return true iff the Hermes runtime import probe exits 0.
 *
 * Used to gate the "fallback to system Python with hermes_cli installed"
 * rung of resolveHermesBackend. Without this, a system Python 3.11-3.13
 * registered in PEP 514 makes findSystemPython() succeed regardless of
 * whether hermes_cli has actually been pip-installed into its
 * site-packages -- and the resolver returns a backend that immediately
 * dies on spawn.
 *
 * The probe intentionally imports hermes_cli.config, not just the top-level
 * package: a broken/empty Windows launcher venv can still see the source tree
 * through PYTHONPATH but lack PyYAML, then die on the first real CLI import.
 *
 * @param {string} pythonPath - Absolute path to a python.exe / python.
 * @param {object} [opts.env] - Additional environment for the probe.
 * @returns {boolean}
 */
function canImportHermesCli(pythonPath: string | null | undefined, opts: { env?: Record<string, string> } = {}) {
  if (!pythonPath) {
    return false
  }

  try {
    // V3-S r5b (K-RT11): the same sealed interpreter as a gated spawn — `-s -P`, the env allowlist with PYTHONPATH cut
    // to the runtime (the callers put its root first), no bytecode read or written — so this probe never writes a pyc
    // into the runtime tree, and nothing inherited runs inside it.
    execProbeSync(pythonPath, [...PYTHON_ISOLATION_FLAGS, '-c', hermesRuntimeImportProbe()], {
      env: sealedProbeEnv({ ...process.env, ...(opts.env || {}) }),
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true
    })

    return true
  } catch {
    return false
  }
}

/**
 * Return true iff `<hermesCommand> --version` exits 0.
 *
 * Used to gate the "existing `hermes` on PATH" rung. Without this, a
 * stale hermes.cmd shim left behind by an uninstalled pip install (or
 * a half-built venv whose `hermes` entry-point points at a deleted
 * Python) survives findOnPath() and gets selected as the backend.
 *
 * We intentionally avoid invoking the command with the dashboard args
 * here -- `--version` is the cheapest "is this binary alive" smoke
 * test that every hermes_cli entry-point has supported since 0.1.
 *
 * @param {string} hermesCommand - Resolved absolute path to a hermes
 *   executable (or an interpreter+script wrapper).
 * @param {boolean} [opts.shell] - Whether to run through a shell. For
 *   .cmd/.bat shims on Windows execFileSync needs shell:true to find
 *   the cmd interpreter; mirrors the same flag isCommandScript() drives
 *   in resolveHermesBackend.
 * @returns {boolean}
 */
/**
 * An explicit desktop backend command is a deployment contract, not a PATH
 * discovery candidate. In particular, the Nix desktop wrapper points this at
 * its immutable, matching Hermes package; it must never fall through to the
 * mutable install-script bootstrap path if a best-effort probe is slow.
 */
function shouldTrustHermesOverride(hermesOverride?: string) {
  return typeof hermesOverride === 'string' && hermesOverride.trim().length > 0
}

function verifyHermesCli(hermesCommand: string | null | undefined, opts?: { shell?: boolean }) {
  if (!hermesCommand) {
    return false
  }

  try {
    execProbeSync(hermesCommand, ['--version'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      shell: Boolean(opts?.shell),
      windowsHide: true
    })

    return true
  } catch {
    return false
  }
}

export {
  canImportHermesCli,
  DEFAULT_PROBE_TIMEOUT_MS,
  execProbeSync,
  hermesRuntimeImportProbe,
  PROBE_TIMEOUT_MS,
  shouldTrustHermesOverride,
  verifyHermesCli
}
