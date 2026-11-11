/**
 * The runtime profile's live harness, shared by runtime-profile.live.test.ts and scripts/runtime-profile-measure.ts:
 * a throwaway world (HOME, HERMES_HOME, userData, project, members under a temp dir; the real home only for the
 * never list, so the real secrets are the baits), the generated runtime profile, and `runRuntime` / `runPlain` so
 * every probe is paired with its unconfined control. Test-only: nothing in the app imports it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEV_PLUGIN_OVERLAY_DIR, ICLONE_PLUGIN_PREFIX, prepareDevPluginOverlay } from '../iclone-runtime-location'

import { writeInstallerConfig } from './live-guards'
import { ensureMembersDir } from './members'
import { type ConfinementPaths, realOrSelf } from './profiles'
import { parseSandboxMessage } from './refusals'
import {
  generateRuntimeProfile,
  interpreterLinks,
  launcherLedgerDir,
  type RuntimeFacts,
  runtimeMarkFile,
  type RuntimeProfile,
  runtimeProfileParams,
  runtimeRunDir,
  runtimeSandboxArgv
} from './runtime-profile'

/** The Hermes source tree this checkout is, and its venv (a link to the developer's venv). */
export const RUNTIME_ROOT = path.resolve(import.meta.dirname, '../../../..')
const VENV_LINK = path.join(RUNTIME_ROOT, 'venv')
// The venv by its real path, as main names a managed runtime's: a link chain in front of it is a dev-only layout the
// profile has no reason to allow (each hop is a stat of a folder outside every parameter).
export const RUNTIME_VENV = realOrSelf(VENV_LINK)
export const RUNTIME_PYTHON = path.join(RUNTIME_VENV, 'bin', 'python')

export const runtimeAvailable = (): boolean =>
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') && existsSync(RUNTIME_PYTHON)

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  err: string
  ms: number
}

export interface RuntimeWorld {
  root: string
  paths: ConfinementPaths
  facts: RuntimeFacts
  profile: RuntimeProfile
  params: string[]
  env: Record<string, string>
  readyDir: string
  outside: string
  /** The link chain the world laid in front of the interpreter (`interpreter: 'linked'`), else null. */
  linked: LinkedInterpreter | null
  /** The packaged-layout simulation (`runtime: 'packaged'`), else null. */
  managed: PackagedRuntime | null
  /** PM's environment wherever the world laid it out (`runtime: 'packaged'` inside the runtime root, `runtime:
   *  'pm-home'` under HERMES_HOME), else null. */
  pm: PackagedRuntime | null
  /** The app-owned plugin overlay (`plugins: 'overlay'`): `<userData>/hermes-dev-plugins/plugins`, else null. */
  overlay: string | null
  /** argv of the runtime interpreter with main's isolation flags. */
  pythonArgv: (args: readonly string[]) => string[]
  run: (confined: boolean, args: readonly string[], options?: RunOptions) => Promise<RunResult>
  dispose: () => void
}

export interface RunOptions {
  env?: Record<string, string>
  timeoutMs?: number
  /** Resolves early (and the child is stopped) once this returns true. */
  until?: () => boolean
  input?: string
}

export function sitePackages(venv: string): string[] {
  const lib = path.join(venv, 'lib')

  return existsSync(lib)
    ? readdirSync(lib)
        .filter(name => name.startsWith('python'))
        .map(name => path.join(lib, name, 'site-packages'))
    : []
}

export interface RuntimeWorldOptions {
  /**
   * `direct`: the runtime venv's interpreter as it is. `linked`: an interpreter reached the way a checkout's venv
   * reaches a uv-managed Python — a folder link in front of the venv, `bin/python` pointing into a minor-version
   * alias folder (a link beside the real install, outside every root of the profile), and the real binary at the end.
   */
  interpreter?: 'direct' | 'linked'
  /** Give the profile main's permission and pay sockets, at the world's `<userData>/run`, as a window's backend has them. */
  mainSockets?: boolean
  /**
   * `beside`: HERMES_HOME is a folder of its own next to userData (an installed app's `~/.hermes`). `userData`: it is
   * `<userData>/hermes-home`, as a fresh-install run puts it (HERMES_DESKTOP_USER_DATA_DIR, env.ts resolveHermesHome).
   */
  hermesHome?: 'beside' | 'userData'
  /**
   * `checkout`: the runtime is this checkout, outside userData (the dev layout). `packaged`: a simulation of where a
   * packed app places its runtime (env.ts ACTIVE_HERMES_ROOT, pm-venv.ts): the shipped files of this checkout cloned to
   * `<userData>/hermes-runtime/<sha>`, PM's environment under its `.iclone-deps/hermes` (the venv at
   * `installs/<key>/environments/gen1/venv`, its `bin/python` a link into the pinned Python at `tools/python-<v>`), the
   * runtime named by one `.pth` with no PYTHONPATH (runtime.ts createActiveBackend), userData at `~/Library/Application
   * Support/iclone os` and HERMES_HOME at `~/.hermes`, outside it. Not a packed build: the same tree, placed the same way.
   * `pm-home`: the non-packaged layout a CLI install leaves (env.ts with IS_PACKAGED false): the runtime root at
   * `<HERMES_HOME>/hermes-agent` (here only the confinement plugin's folder, what the launcher needs), PM's venv at
   * `<HERMES_HOME>/installs/<key>/environments/gen1/venv` and its Python at `<HERMES_HOME>/tools/python-<v>`.
   */
  runtime?: 'checkout' | 'packaged' | 'pm-home'
  /**
   * `overlay`: the runtime is an unmanaged dev checkout and Hermes discovers its plugins in the app-owned overlay
   * `<userData>/hermes-dev-plugins/plugins` (iclone-runtime-location.ts prepareDevPluginOverlay: one link per
   * checkout plugin, the iclone plugins as real copies), named by HERMES_BUNDLED_PLUGINS as the gate names it.
   */
  plugins?: 'overlay'
}

/** Where the packaged-layout simulation put the runtime's parts. */
export interface PackagedRuntime {
  runtimeRoot: string
  venvRoot: string
  /** The venv's `bin/python`: a link into the pinned Python, as PM lays it out. */
  python: string
  pythonHome: string
}

/** The shipped set of the runtime (runtime-artifact.mjs isShippedPath), restated for a sync, test-only clone. */
const NOT_SHIPPED_TOP = new Set(['.github', 'apps', 'assets', 'bench', 'contributors', 'docs', 'evals', 'iclone', 'packages', 'packaging', 'tests', 'tests-js', 'ui-tui', 'web', 'website'])

const shipped = (rel: string) => {
  const parts = rel.split('/')

  return !NOT_SHIPPED_TOP.has(parts[0]) && !parts.slice(0, -1).some(part => ['__tests__', 'docs', 'tests'].includes(part))
}

/** Clones (APFS clonefile, no bytes copied) `from` into `to`, links kept as links. */
export function cloneTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })

  for (const name of readdirSync(from)) {
    const source = path.join(from, name)
    const target = path.join(to, name)
    const stat = lstatSync(source)

    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target)
    } else if (stat.isDirectory()) {
      cloneTree(source, target)
    } else {
      copyFileSync(source, target, constants.COPYFILE_FICLONE)
    }
  }
}

/** Lays out the packaged-layout simulation under `userDataDir` (see RuntimeWorldOptions.runtime). */
function packagedRuntime(userDataDir: string, basePrefix: string): PackagedRuntime {
  const runtimeRoot = path.join(userDataDir, 'hermes-runtime', randomBytes(32).toString('hex'))

  for (const rel of execFileSync('git', ['-C', RUNTIME_ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')) {
    const source = path.join(RUNTIME_ROOT, rel)

    if (!rel || !shipped(rel) || !existsSync(source) || lstatSync(source).isDirectory()) {
      continue
    }

    mkdirSync(path.dirname(path.join(runtimeRoot, rel)), { recursive: true })

    if (lstatSync(source).isSymbolicLink()) {
      symlinkSync(readlinkSync(source), path.join(runtimeRoot, rel))
    } else {
      copyFileSync(source, path.join(runtimeRoot, rel), constants.COPYFILE_FICLONE)
    }
  }

  return pmEnvironment(runtimeRoot, path.join(runtimeRoot, '.iclone-deps', 'hermes'), basePrefix)
}

/** PM's install key of a runtime root (pm/environments.py install_key, pm-venv.ts). */
export const pmInstallKey = (runtimeRoot: string) =>
  createHash('sha256').update(realOrSelf(runtimeRoot), 'utf8').digest('hex').slice(0, 16)

/**
 * PM's environment for `runtimeRoot` under the data root `depsHome`, as PM lays it out (pm/environments.py): the venv
 * at `installs/<key>/environments/gen1/venv`, its `bin/python` a link into the Python at `tools/python-<v>` (a clone
 * of this interpreter's base prefix), the runtime named by one `.pth`, and the install's `facts.json` naming the venv.
 */
export function pmEnvironment(runtimeRoot: string, depsHome: string, basePrefix: string): PackagedRuntime {
  const key = pmInstallKey(runtimeRoot)
  const venvRoot = path.join(depsHome, 'installs', key, 'environments', 'gen1', 'venv')
  const version = path.basename(execFileSync(realOrSelf(RUNTIME_PYTHON), ['-I', '-S', '-c', 'import sys; print("python%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim())
  const pythonHome = path.join(depsHome, 'tools', `${version.replace('python', 'python-')}`)

  cloneTree(basePrefix, pythonHome)
  cloneTree(path.join(RUNTIME_VENV, 'lib'), path.join(venvRoot, 'lib'))
  mkdirSync(path.join(venvRoot, 'bin'), { recursive: true })
  symlinkSync(path.join(pythonHome, 'bin', version), path.join(venvRoot, 'bin', 'python'))
  writeFileSync(path.join(venvRoot, 'pyvenv.cfg'), `home = ${path.join(pythonHome, 'bin')}\ninclude-system-site-packages = false\n`)

  for (const site of sitePackages(venvRoot)) {
    writeFileSync(path.join(site, 'iclone-runtime.pth'), `${runtimeRoot}\n`)
  }

  writeFileSync(path.join(depsHome, 'installs', key, 'facts.json'), JSON.stringify({ packages: { venv: { environment: venvRoot } } }))

  return { runtimeRoot, venvRoot, python: path.join(venvRoot, 'bin', 'python'), pythonHome }
}

/**
 * The runtime root of the non-packaged layout, `<HERMES_HOME>/hermes-agent`, holding what the launcher and the plugin
 * need of a runtime: the confinement plugin's folder (a clone) and a bootstrap marker; PM's environment beside it.
 */
function pmHomeRuntime(hermesHome: string, basePrefix: string): PackagedRuntime {
  const runtimeRoot = path.join(hermesHome, 'hermes-agent')

  cloneTree(path.join(RUNTIME_ROOT, 'plugins', 'iclone-confinement'), path.join(runtimeRoot, 'plugins', 'iclone-confinement'))
  writeFileSync(path.join(runtimeRoot, 'hermes_bootstrap.py'), '# a runtime root\n')

  return pmEnvironment(runtimeRoot, hermesHome, basePrefix)
}

/**
 * The plugin overlay of an unmanaged dev runtime, as the gate prepares it (prepareDevPluginOverlay): links to the
 * checkout's own plugins, and the iclone plugins as real folders (the gate copies them from the app's bundle; here
 * from the checkout, the same files). Returns `<userData>/hermes-dev-plugins/plugins`.
 */
function devPluginOverlay(userDataDir: string, runtimeRoot: string): string {
  const names = readdirSync(path.join(runtimeRoot, 'plugins')).filter(name => name.startsWith(ICLONE_PLUGIN_PREFIX))
  const overlay = prepareDevPluginOverlay(path.join(userDataDir, DEV_PLUGIN_OVERLAY_DIR), runtimeRoot, names)

  for (const name of names) {
    cloneTree(path.join(runtimeRoot, 'plugins', name), path.join(overlay, name))
  }

  return overlay
}

/** The symlinks the profile needs for `interpreter: 'linked'`, where the world put them. */
export interface LinkedInterpreter {
  python: string
  venvRoot: string
  /** The folder link in front of the venv, the venv's `bin/python`, the alias folder: the chain the kernel follows. */
  links: string[]
}

/**
 * Lays out, under `root`, the link chain a uv-managed Python gives a venv (`<store>/cpython-3.x-<platform>` is a link
 * to `<store>/cpython-3.x.y-<platform>`; a venv's `bin/python` points through it), with the alias beside the roots
 * rather than inside one, and a folder link in front of the venv as a checkout has. `pyvenv.cfg` names the alias as
 * `home`, as uv writes it.
 */
function linkedInterpreter(root: string, realPython: string, basePrefix: string): LinkedInterpreter {
  // A venv whose interpreter is a copy (a sync may write copies) is no link into the store: the chain then starts at
  // the base installation's own interpreter, which is what uv's links point at.
  const linked = realOrSelf(realPython)
  const own = realOrSelf(path.join(basePrefix, 'bin', 'python3'))
  const binary = path.relative(basePrefix, linked).startsWith('..') ? own : linked
  const inside = path.relative(basePrefix, binary)

  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`the interpreter ${binary} does not live under its base prefix ${basePrefix}`)
  }

  const alias = path.join(root, `cpython-${path.basename(basePrefix)}-alias`)
  const venv = path.join(root, 'linked-venv')
  const front = path.join(root, 'checkout-venv')
  const python = path.join(venv, 'bin', 'python')

  mkdirSync(path.join(venv, 'bin'), { recursive: true })
  // Its packages, cloned (no bytes copied): the boot the matrix asks for imports the runtime's dependencies.
  cloneTree(path.join(RUNTIME_VENV, 'lib'), path.join(venv, 'lib'))
  symlinkSync(basePrefix, alias)
  symlinkSync(path.join(alias, inside), python)
  symlinkSync(venv, front)
  writeFileSync(
    path.join(venv, 'pyvenv.cfg'),
    `home = ${path.join(alias, path.dirname(inside))}\ninclude-system-site-packages = false\nrelocatable = true\n`
  )

  return { python: path.join(front, 'bin', 'python'), venvRoot: venv, links: [front, python, alias] }
}

export function createRuntimeWorld(options: RuntimeWorldOptions = {}): RuntimeWorld {
  // A short root: the launcher socket under it must fit a unix socket path (104 bytes on macOS).
  const root = realOrSelf(mkdtempSync(path.join('/private/tmp', 'iclone-rt-')))

  const dir = (...parts: string[]) => {
    const target = path.join(root, ...parts)

    mkdirSync(target, { recursive: true })

    return target
  }

  const home = dir('home')
  const packaged = options.runtime === 'packaged'
  // A packed app's places: userData under the home's Application Support, HERMES_HOME at `~/.hermes`.
  const userDataDir = packaged ? dir('home', 'Library', 'Application Support', 'iclone os') : dir('userData')

  const hermesHome =
    options.hermesHome === 'userData'
      ? path.join(userDataDir, 'hermes-home')
      : packaged
        ? path.join(home, '.hermes')
        : dir('hermes-home')

  mkdirSync(hermesHome, { recursive: true })

  const project = dir('project')
  const outside = dir('outside')
  const webDist = dir('web-dist')
  const tmpDir = dir('tmp')
  const cacheDir = dir('cache')
  const readyDir = path.join(userDataDir, 'backend-ready')

  mkdirSync(readyDir, { recursive: true })
  mkdirSync(path.join(userDataDir, 'confinement', 'profiles'), { recursive: true })
  mkdirSync(path.join(userDataDir, 'confinement', 'refusals'), { recursive: true })
  mkdirSync(runtimeRunDir(userDataDir), { recursive: true, mode: 0o700 })
  // The launcher's ledger: a real file there, so a denied read answers EPERM rather than ENOENT.
  mkdirSync(launcherLedgerDir(userDataDir), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(launcherLedgerDir(userDataDir), 'runs.jsonl'), '{"v":1,"ev":"end"}\n', { mode: 0o600 })
  writeFileSync(path.join(launcherLedgerDir(userDataDir), 'refused.jsonl'), '{"v":1,"ev":"refused"}\n', { mode: 0o600 })

  writeFileSync(path.join(hermesHome, '.env'), 'OPENAI_API_KEY=sk-test-not-real\n')
  writeInstallerConfig(hermesHome)
  writeFileSync(path.join(userDataDir, 'consent.json'), '{"consent":true}\n')
  // The confinement settings beside the ledger: signed by main, never the runtime's to read or rewrite.
  writeFileSync(path.join(userDataDir, 'confinement', 'settings.json'), '{"v":1}\n', { mode: 0o600 })
  writeFileSync(path.join(project, 'AGENTS.md'), '# project\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret\n')
  writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>t</title>\n')

  const basePrefix = execFileSync(RUNTIME_PYTHON, ['-I', '-S', '-c', 'import sys; print(sys.base_prefix)'], {
    encoding: 'utf8'
  }).trim()

  const linked = options.interpreter === 'linked' ? linkedInterpreter(root, RUNTIME_PYTHON, basePrefix) : null
  const managed = packaged ? packagedRuntime(userDataDir, basePrefix) : null
  const pm = managed ?? (options.runtime === 'pm-home' ? pmHomeRuntime(hermesHome, basePrefix) : null)
  const venvRoot = pm?.venvRoot ?? linked?.venvRoot ?? RUNTIME_VENV
  const python = pm?.python ?? linked?.python ?? RUNTIME_PYTHON
  const runtimeRoot = pm?.runtimeRoot ?? RUNTIME_ROOT
  const overlay = options.plugins === 'overlay' ? devPluginOverlay(userDataDir, runtimeRoot) : null

  const paths: ConfinementPaths = {
    // The real home: the never list names the real secrets, which are the baits.
    home: os.homedir(),
    hermesHome,
    userDataDir,
    hermesRoot: runtimeRoot,
    profilesDir: path.join(userDataDir, 'confinement', 'profiles'),
    scratchRoot: dir('scratch'),
    membersDir: path.join(root, 'members')
  }

  ensureMembersDir(paths.membersDir)
  writeFileSync(runtimeMarkFile(paths.membersDir), '', { mode: 0o600 })

  const facts: RuntimeFacts = {
    homeDir: home,
    runtimeRoot,
    venvRoot,
    python,
    pythonHome: pm?.pythonHome ?? basePrefix,
    pluginsDir: overlay,
    project,
    webDist,
    tmpDir,
    cacheDir,
    ...(options.mainSockets
      ? {
          permDir: path.join(userDataDir, 'run'),
          permSocket: path.join(userDataDir, 'run', 'perm.sock'),
          paySocket: path.join(userDataDir, 'run', 'pay.sock'),
          policyFile: path.join(userDataDir, 'run', 'policy.json')
        }
      : {})
  }

  if (options.mainSockets) {
    mkdirSync(path.join(userDataDir, 'run'), { recursive: true })
  }

  // As main builds it: the links on the interpreter's way are the profile's literals, every other path a parameter.
  const profile = generateRuntimeProfile(paths, { links: interpreterLinks(paths, [python], facts) })
  const params = runtimeProfileParams(paths, facts)

  // What main's spawn env carries (start-hermes.ts + buildDesktopBackendEnv), minus the gate's keys.
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    HERMES_HOME: hermesHome,
    TMPDIR: `${tmpDir}/`,
    LANG: 'en_US.UTF-8',
    // A dev run puts the runtime and its venv's packages on PYTHONPATH; a packed app sets none: its venv's `.pth`
    // names the runtime (runtime.ts createActiveBackend).
    ...(pm ? {} : { PYTHONPATH: [RUNTIME_ROOT, ...sitePackages(realOrSelf(venvRoot))].join(':') }),
    // An unmanaged dev runtime discovers its plugins in the app-owned overlay (the gate's env for it).
    ...(overlay ? { HERMES_BUNDLED_PLUGINS: overlay } : {}),
    VIRTUAL_ENV: venvRoot,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    HERMES_DESKTOP: '1',
    HERMES_DASHBOARD_SESSION_TOKEN: randomBytes(16).toString('hex'),
    HERMES_WEB_DIST: webDist,
    TERMINAL_CWD: project
  }

  const pythonArgv = (args: readonly string[]) => [python, '-s', '-P', ...args]

  return {
    root,
    paths,
    facts,
    profile,
    params,
    env,
    readyDir,
    outside,
    linked,
    managed,
    pm,
    overlay,
    pythonArgv,
    run(confined, args, options = {}) {
      const argv = pythonArgv(args)
      const full = confined ? runtimeSandboxArgv(profile, params, argv[0], argv.slice(1)) : argv

      return spawnRun(full, { cwd: project, env: { ...env, ...options.env } }, options)
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Runs `argv` in its own process group (stopped whole on timeout or when `until` holds) and collects its output. */
export function spawnRun(
  argv: readonly string[],
  where: { cwd: string; env: Record<string, string> },
  options: RunOptions = {}
): Promise<RunResult> {
  const started = performance.now()

  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: where.cwd,
      env: where.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })

    let out = ''
    let err = ''
    let done = false
    let resolveTime: number | null = null

    const stop = () => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGTERM')
      } catch {
        // already gone
      }
    }

    const timer = setTimeout(stop, options.timeoutMs ?? 60_000)

    const poll = options.until
      ? setInterval(() => {
          if (!done && options.until?.()) {
            done = true
            resolveTime = performance.now()
            stop()
          }
        }, 25)
      : null

    child.stdout.on('data', chunk => (out += String(chunk)))
    child.stderr.on('data', chunk => (err += String(chunk)))
    child.stdin.end(options.input ?? '')
    child.on('close', (code, signal) => {
      clearTimeout(timer)

      if (poll) {
        clearInterval(poll)
      }

      resolve({ code, signal, out, err, ms: (resolveTime ?? performance.now()) - started })
    })
  })
}

/**
 * Denials the measured boot causes by design (the feature is refused, the runtime carries on), each with why. Anything
 * else is unexpected: the profile is missing an allow, or the runtime reached for something new.
 */
export function expectedDenial(denial: Denial, world: Pick<RuntimeWorld, 'root'>): string | null {
  const { operation: op, target } = denial

  if (/\/members\/\.(member|decoy|runtime)$/.test(target) && !target.startsWith(world.root)) {
    return 'another process asked the kernel about this sandbox (members.ts probe of a different world)'
  }

  if (op.startsWith('process-exec') && /^\/bin\/launchctl$/.test(target)) {
    return 'never list: launchd (gateway service status check)'
  }

  if (op.startsWith('process-exec') && target === '/usr/bin/git') {
    return 'the runtime runs the interpreter only: git (version banner, checkpoints) is refused'
  }

  if (op.startsWith('file-write') && target.startsWith(path.join(world.root, 'home'))) {
    return 'the home is never written: launcher shim in ~/.local/bin'
  }

  if (op === 'mach-lookup' && target === 'com.apple.diagnosticd') {
    return 'only while a log stream is attached (the measurement itself); logging carries on'
  }

  if (target === '/private/var/run/syslog' || target.startsWith('/Library/Preferences/Logging/')) {
    return 'only while a log stream is attached (the measurement itself); logging carries on'
  }

  if (op === 'file-read-metadata' && !target.startsWith(world.root) && !target.startsWith(RUNTIME_ROOT)) {
    return 'stat of a path outside every root: the state-holder scan comparing other processes\' open files, or a dev-only link'
  }

  return null
}

export interface Denial {
  process: string
  pid: number
  operation: string
  target: string
}

/** Streams the kernel's denials tagged by the runtime profile while `body` runs (plus a settle delay). */
export async function collectDenials<T>(body: () => Promise<T>): Promise<{ result: T; denials: Denial[] }> {
  const stream = spawn(
    '/usr/bin/log',
    ['stream', '--style', 'ndjson', '--predicate', 'sender == "Sandbox" AND eventMessage CONTAINS "iclone-runtime"'],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )

  let buffer = ''

  stream.stdout.on('data', chunk => (buffer += String(chunk)))
  await new Promise(resolve => setTimeout(resolve, 1500))

  const result = await body()

  await new Promise(resolve => setTimeout(resolve, 2500))
  stream.kill('SIGTERM')

  const denials: Denial[] = []

  for (const line of buffer.split('\n')) {
    let message: unknown

    try {
      message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage
    } catch {
      continue
    }

    const parsed = typeof message === 'string' ? parseSandboxMessage(message) : null

    if (parsed) {
      denials.push({ process: parsed.process, pid: parsed.pid, operation: parsed.operation, target: parsed.target })
    }
  }

  return { result, denials }
}
