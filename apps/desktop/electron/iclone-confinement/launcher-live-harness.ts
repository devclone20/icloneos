import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The confined runtime's live harness, shared by launcher-ledger.live.test.ts, runtime-profile.live.test.ts and
 * hermes-plugin.live.test.ts: a throwaway world (HOME, userData, project, outside under one short temp dir), main's
 * real confinement layer with its real launcher, and `launch` / `run` for the Hermes interpreter exactly as main
 * starts it (sandbox-exec with the runtime profile and this spawn's defines) or plain, the unconfined control. Also
 * the probe script both runtime tests ask: one probe list, answered by the interpreter AND by an interpreter child it
 * starts (Seatbelt is inherited). Test-only: nothing in the app imports it.
 */
import type { LauncherPolicyBody } from './launcher-policy'
import { writeInstallerConfig } from './live-guards'
import { realOrSelf } from './profiles'
import {
  type RunOptions,
  type RunResult,
  RUNTIME_PYTHON,
  RUNTIME_ROOT,
  RUNTIME_VENV,
  type RuntimeWorld,
  sitePackages,
  spawnRun
} from './runtime-live-harness'

import { createConfinement, type RuntimeSpawnFacts } from './index'

/**
 * `python probe.py '<probes json>'`: one answer per probe id, from this interpreter (`self`) and from an interpreter
 * child it starts the way the runtime starts its own (`child`). An answer is `ok` (`ok <first bytes>` for `cat`), an
 * errno name (`EPERM`), `exitN` for an exec, or `krN` for a mach lookup.
 */
/**
 * fx13 (lens3-policy L1): no policy from main is no policy, and no confined command runs without one. The app's
 * permission authority publishes the policy at every launch and before every launcher start; a live world has no
 * authority, so it publishes the least the launcher needs — an acceptEdits standing and the world's project listed.
 */
export function publishLivePolicy(
  layer: { publishLauncherPolicy(body: LauncherPolicyBody): void; noteProject(root: string | null): void },
  project: string
): void {
  layer.publishLauncherPolicy({
    v: 1,
    standing: 'acceptEdits',
    table: { acceptEdits: { Wp: 'A', N: 'Q', X: 'A' } },
    sessions: {},
    projects: {},
    grants: [],
    fnGrants: []
  } as unknown as LauncherPolicyBody)
  layer.noteProject(project)
}

export const RUNTIME_PROBE = String.raw`
import ctypes, errno, json, os, socket, subprocess, sys

def run(p):
    k = p["k"]
    try:
        if k == "read":
            os.close(os.open(p["path"], os.O_RDONLY))
        elif k == "cat":
            fd = os.open(p["path"], os.O_RDONLY)
            try:
                return "ok " + os.read(fd, 64).decode("utf-8", "replace").strip()
            finally:
                os.close(fd)
        elif k == "stat":
            os.stat(p["path"])
        elif k == "write":
            os.close(os.open(p["path"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            os.unlink(p["path"])
        elif k == "exec":
            r = subprocess.run(p["argv"], capture_output=True, timeout=15)
            return "ok" if r.returncode == 0 else "exit%d" % r.returncode
        elif k == "mkwrite":
            os.mkdir(p["path"], 0o700)
            try:
                f = os.path.join(p["path"], "probe.tmp")
                os.close(os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
                os.unlink(f)
            finally:
                os.rmdir(p["path"])
        elif k == "reopen":
            os.close(os.open(p["path"], os.O_WRONLY))
        elif k == "create":
            os.close(os.open(p["path"] + "." + str(os.getpid()), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        elif k == "unlink":
            os.unlink(p["path"])
            os.close(os.open(p["path"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        elif k == "rename":
            os.rename(p["path"], p["path"] + ".moved")
            os.rename(p["path"] + ".moved", p["path"])
        elif k in ("procargs", "procenv"):
            # fx26a: what the kernel itself says of another process (sysctl KERN_PROCARGS2: argv, then its environment),
            # the one place a same-user process reads them from; refused under both profiles since fx35d (R31).
            libc = ctypes.CDLL(None, use_errno=True)
            mib = (ctypes.c_int * 3)(1, 49, int(p["pid"]))
            buf = ctypes.create_string_buffer(65536)
            size = ctypes.c_size_t(65536)
            if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
                return errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
            raw = buf.raw[:size.value]
            word = p["marker"].encode() if k == "procenv" else b"/bin/sleep"
            return "ok" if word in raw else "hidden"
        elif k == "psutil":
            import psutil
            try:
                psutil.Process(int(p["pid"])).ppid()
                return "ok"
            except psutil.AccessDenied:
                return "AccessDenied"
        elif k == "mach":
            lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            port = ctypes.c_uint(0)
            kr = lib.bootstrap_look_up(ctypes.c_uint.in_dll(lib, "bootstrap_port"), p["name"].encode(), ctypes.byref(port))
            return "ok" if kr == 0 else "kr%d" % kr
        elif k == "connect":
            s = socket.socket(socket.AF_UNIX)
            try:
                s.connect(p["path"])
            finally:
                s.close()
        elif k == "tcp":
            socket.create_connection((p["host"], p["port"]), timeout=5).close()
        elif k == "route":
            # Sent to an address no host owns: only the sandbox's own refusal counts. No answer or no route is not one.
            s = socket.socket(socket.AF_INET)
            s.settimeout(0.5)
            try:
                s.connect((p["host"], p["port"]))
            except OSError as e:
                if e.errno in (errno.EPERM, errno.EACCES):
                    raise
            finally:
                s.close()
        return "ok"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))

probes = json.loads(sys.argv[1])
out = {"self": {p["id"]: run(p) for p in probes}}
if sys.argv[2:] != ["child"]:
    r = subprocess.run([sys.executable, "-s", "-P", __file__, sys.argv[1], "child"], capture_output=True, text=True, env=os.environ)
    out["child"] = json.loads(r.stdout)["self"] if r.returncode == 0 else {"error": r.stderr[-400:]}
print(json.dumps(out))
`

export interface RuntimeProbe {
  id: string
  k: 'cat' | 'connect' | 'exec' | 'mach' | 'mkwrite' | 'procargs' | 'procenv' | 'psutil' | 'create' | 'read' | 'rename' | 'reopen' | 'route' | 'stat' | 'tcp' | 'unlink' | 'write'
  path?: string
  /** `tcp`: connect for real. `route`: answer ok unless the sandbox refuses the connect. */
  host?: string
  port?: number
  argv?: string[]
  name?: string
  /** `procargs`/`procenv`/`psutil`: the process the kernel is asked about (sysctl KERN_PROCARGS2, kern.proc), and the
   *  word planted in its environment. */
  pid?: number
  marker?: string
}

export interface RuntimeProbeAnswers {
  self: Record<string, string>
  child?: Record<string, string>
}

/** The probe script's answers from one run's stdout (its last line); a run that printed none throws with its stderr. */
export function probeAnswers(run: RunResult): RuntimeProbeAnswers {
  try {
    return JSON.parse(run.out.trim().split('\n').at(-1) ?? '') as RuntimeProbeAnswers
  } catch {
    throw new Error(`probe run failed (exit ${run.code}): ${run.err.slice(-600)}`)
  }
}

export interface LauncherWorld {
  root: string
  home: string
  hermesHome: string
  userDataDir: string
  project: string
  outside: string
  layer: ReturnType<typeof createConfinement>
  facts: RuntimeSpawnFacts
  /** The launcher's lifecycle lines. */
  logs: string[]
  /** The spawn env main gives a confined Hermes (start-hermes.ts + the layer's own keys). */
  env: Record<string, string>
  /** The Hermes interpreter with `args`: under the runtime profile through main's own `runtimeSpawn`, or plain. */
  launch: (args: readonly string[], confined: boolean) => { command: string; args: string[] }
  run: (args: readonly string[], options: { confined: boolean; timeoutMs?: number }) => Promise<RunResult>
  dispose: () => Promise<void>
}

/** Builds the world, starts the launcher and waits for it: rejects (with the launcher's log) when it is not up. */
export async function createLauncherWorld(): Promise<LauncherWorld> {
  // A short root: the launcher socket and the browser's session socket under it (<home>/Library/Caches/…/ab-<session>/…)
  // must fit a unix socket path.
  const root = realOrSelf(mkdtempSync('/private/tmp/ie-'))
  const home = path.join(root, 'home')
  const hermesHome = path.join(home, '.hermes')
  const userDataDir = path.join(root, 'ud')
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  const logs: string[] = []

  for (const dir of [home, userDataDir, project, outside, hermesHome]) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path.join(project, 'README.md'), 'inside\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret\n')
  writeInstallerConfig(hermesHome)
  execFileSync('/usr/bin/git', ['init', '-q', project])

  const layer = createConfinement({
    userDataDir,
    home,
    hermesHome,
    hermesRoot: RUNTIME_ROOT,
    hermesPids: () => [],
    audit: () => [],
    memberPython: RUNTIME_PYTHON,
    log: line => logs.push(line),
    probes: {
      seatbelt: async () => ({
        id: 'seatbelt' as const,
        status: 'ready' as const,
        enforcing: true,
        version: null,
        detail: 'enforcing' as const,
        evidence: '',
        ownerStep: null
      })
    }
  })

  // The roots the runtime profile lets the runtime write must exist: it cannot create them (their parents are
  // outside every parameter).
  mkdirSync(layer.paths.scratchRoot, { recursive: true, mode: 0o700 })
  publishLivePolicy(layer, project)

  const tmpDir = layer.runtimeTmpDir()

  const basePrefix = execFileSync(RUNTIME_PYTHON, ['-I', '-S', '-c', 'import sys; print(sys.base_prefix)'], {
    encoding: 'utf8'
  }).trim()

  const facts: RuntimeSpawnFacts = {
    homeDir: home,
    runtimeRoot: RUNTIME_ROOT,
    venvRoot: RUNTIME_VENV,
    python: RUNTIME_PYTHON,
    pythonHome: basePrefix,
    project,
    webDist: null,
    tmpDir,
    cacheDir: null
  }

  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    HERMES_HOME: hermesHome,
    TMPDIR: `${tmpDir}/`,
    LANG: 'en_US.UTF-8',
    PYTHONPATH: [RUNTIME_ROOT, ...sitePackages(RUNTIME_VENV)].join(':'),
    VIRTUAL_ENV: RUNTIME_VENV,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    HERMES_DESKTOP: '1',
    TERMINAL_CWD: project,
    ...layer.spawnEnv()
  }

  const release = layer.leaseLauncher()
  const state = await layer.ensureLauncher(RUNTIME_ROOT, facts)

  const dispose = async () => {
    await release()
    await layer.stopLauncher()
    // maxRetries: a world with main's real authority (the locked row) may still be flushing its audit file.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  if (state !== 'up') {
    await dispose()
    throw new Error(`the launcher is ${state}\n${logs.join('\n')}`)
  }

  const launch = (args: readonly string[], confined: boolean) => {
    if (!confined) {
      return { command: RUNTIME_PYTHON, args: [...args] }
    }

    const launched = layer.runtimeSpawn(RUNTIME_PYTHON, args, facts)

    return { command: launched.command, args: launched.args }
  }

  return {
    root,
    home,
    hermesHome,
    userDataDir,
    project,
    outside,
    layer,
    facts,
    logs,
    env,
    launch,
    run(args, { confined, timeoutMs = 60_000 }) {
      const { command, args: argv } = launch(args, confined)
      const started = performance.now()

      return new Promise(resolve => {
        const child = spawn(command, argv, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        let out = ''
        let err = ''

        const timer = setTimeout(() => {
          try {
            process.kill(-(child.pid ?? 0), 'SIGKILL')
          } catch {
            // already gone
          }
        }, timeoutMs)

        child.stdout.on('data', chunk => (out += String(chunk)))
        child.stderr.on('data', chunk => (err += String(chunk)))
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, out, err, ms: performance.now() - started })
        })
      })
    },
    dispose
  }
}

export interface WorldLayer {
  layer: ReturnType<typeof createConfinement>
  /** The spawn's facts as main resolves them: the interpreter by real path, the runtime-only temp folder. */
  facts: RuntimeSpawnFacts
  /** The interpreter main's helpers were given (what main.ts computes from the active venv). */
  memberPython: string
  logs: string[]
  /** The spawn env: the world's plus the layer's own keys (the launcher socket, the spec, the ack file). */
  env: Record<string, string>
  ackFile: string
  /** The Hermes interpreter with `args` (main's isolation flags added): under the runtime profile through the layer's
   *  own `runtimeSpawn`, or plain, the unconfined control. */
  run: (args: readonly string[], options: RunOptions & { confined: boolean }) => Promise<RunResult>
  dispose: () => Promise<void>
}

/**
 * Main's real confinement layer over a layout world (runtime-live-harness.ts createRuntimeWorld): the layer's paths
 * from the world's HOME, HERMES_HOME, userData and runtime root, the helper interpreter main.ts would name (the
 * world's venv Python unless given), its launcher started and up. Every run goes through the layer's `runtimeSpawn`,
 * so the profile is the one main would spawn with, parameters and all. `hermesPids` names the processes main treats as
 * Hermes when it folds the state (none unless given). Rejects with the launcher's log when it is not up.
 */
export async function attachLayer(
  world: RuntimeWorld,
  options: { memberPython?: string; hermesPids?: () => number[] } = {}
): Promise<WorldLayer> {
  const home = world.facts.homeDir ?? path.join(world.root, 'home')
  const logs: string[] = []
  const memberPython = options.memberPython ?? world.facts.python

  const layer = createConfinement({
    userDataDir: world.paths.userDataDir,
    home,
    hermesHome: world.paths.hermesHome,
    hermesRoot: world.facts.runtimeRoot,
    hermesPids: options.hermesPids ?? (() => []),
    audit: () => [],
    memberPython,
    log: line => logs.push(line),
    probes: {
      seatbelt: async () => ({
        id: 'seatbelt' as const,
        status: 'ready' as const,
        enforcing: true,
        version: null,
        detail: 'enforcing' as const,
        evidence: '',
        ownerStep: null
      })
    }
  })

  mkdirSync(layer.paths.scratchRoot, { recursive: true, mode: 0o700 })
  publishLivePolicy(layer, world.facts.project ?? world.root)

  const tmpDir = layer.runtimeTmpDir()
  const facts: RuntimeSpawnFacts = { ...world.facts, python: realpathSync(world.facts.python), tmpDir }
  const env: Record<string, string> = { ...world.env, TMPDIR: `${tmpDir}/`, ...layer.spawnEnv() }
  const release = layer.leaseLauncher()
  const state = await layer.ensureLauncher(world.facts.runtimeRoot, facts)

  const dispose = async () => {
    await release()
    await layer.stopLauncher()
  }

  if (state !== 'up') {
    await dispose()
    throw new Error(`the launcher is ${state}\n${logs.join('\n')}`)
  }

  return {
    layer,
    facts,
    memberPython,
    logs,
    env,
    ackFile: path.join(world.paths.userDataDir, 'confinement', 'run', 'hermes-ack.json'),
    run(args, { confined, ...rest }) {
      const argv = world.pythonArgv(args)
      const launched = confined ? layer.runtimeSpawn(argv[0], argv.slice(1), facts) : null
      const full = launched ? [launched.command, ...launched.args] : argv

      return spawnRun(full, { cwd: facts.project ?? world.root, env: { ...env, ...rest.env } }, rest)
    },
    dispose
  }
}
