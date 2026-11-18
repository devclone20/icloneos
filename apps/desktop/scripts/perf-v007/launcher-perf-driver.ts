/**
 * CF8 PERF.launcher driver: main's real confinement layer and guard, the real Python launcher started by main with
 * fd 3, a confined runtime that runs the command sequence the gate judges, and the raw measurements as one
 * `DRIVER_JSON {...}` line. tests/plugins/test_perf_launcher.py runs it and turns the raw data into the PERF.launcher
 * items; this file judges nothing.
 *
 *   node <repo>/node_modules/tsx/dist/cli.mjs scripts/perf-v007/launcher-perf-driver.ts '<config json>'
 *   config: { fixture, dirs, scratch, steady, dirty, dirtyFolders, sleepMs, staleMs, replyTimeoutS, shapes?,
 *             guardTimings? }
 * `staleMs` (FX-STALE, B1-M1): after the sleep, main's guard clocks move that long AWAKE (wall and awake time, the
 * harness's advanceGuardAwake), past the root's age bound, so the next command waits on a re-walk of the whole tree.
 * `guardTimings` (self-tests only): the guard channel's waits (deadlineMs, progressMs), to compress time on a small
 * fixture; the gate itself never passes it.
 *
 * Two worlds (`shapes`, default both), each a fresh main + launcher, one after the other on the same fixture:
 *   window  the owner's v0.0.7 case: the runtime spawns on a small project of its own; the fixture is opened in a
 *           window AFTER that (main lists it, the runtime profile does not hold it), so only the launcher can check it
 *           (launcher.py scan_root). Every fixture command is paired with one in the runtime's small project (`base`),
 *           the same pipeline with a one-folder check: the no-check baseline the end-to-end overhead is measured on.
 *   own     the fixture IS the runtime's spawn project (CF8 D1: the runtime asks main through the launcher instead of
 *           walking it). Its overhead is judged against the window world's base rows.
 * Per world, one confined runtime process runs the whole plan (no respawn inside the timed part). Steps with a `gate`
 * stop before running until this process (main's side, unconfined) has acted: written the dirty files, moved main's
 * guard clock (a Mac sleep), planted one hard link to a file outside the project. The runtime never writes the project
 * itself: its profile denies that.
 * Recorded besides main's guard-channel frames:
 *   listings         every os.scandir / os.listdir of the launcher process (launcher-shim.py, same process)
 *   runtimeListings  every os.scandir / os.listdir of the confined runtime process (an audit hook in the runtime driver)
 *   stub             every frame the stub received before its answer, with its start (a stub wrapper that runs stub.py
 *                    unchanged, its reply timeout scaled to `replyTimeoutS`, the owner's 60 s for an 80 s walk scaled to
 *                    the fixture), so a launcher that goes silent towards the stub is seen where the user sees it
 * Harness hooks absent: `HARNESS_MISSING [...]` and exit 4, so the gate fails rather than measuring something else.
 * Dirty files (perf-dirty-<n>.txt) are overwritten by the next run, never removed; the planted link is always removed.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createLauncherWorld, type LauncherWorld } from '../../electron/iclone-confinement/launcher-live-harness'
import { RUNTIME_PYTHON, RUNTIME_ROOT, runtimeAvailable } from '../../electron/iclone-confinement/runtime-live-harness'

import { dirPath } from './make-fixture.mjs'

type Shape = 'window' | 'own'
type Phase = 'first' | 'steady' | 'dirty' | 'sleep' | 'stale' | 'planted'

interface DriverConfig {
  fixture: string
  dirs: number
  scratch: string
  steady: number
  dirty: number
  dirtyFolders: number
  sleepMs: number
  staleMs: number
  replyTimeoutS: number
  shapes: Shape[]
  guardTimings?: { deadlineMs?: number; progressMs?: number }
}

interface GuardFrame {
  t: number
  dir: string
  frame: Record<string, unknown>
}

interface PlanStep {
  phase: Phase
  cwd: 'fixture' | 'base'
  gate?: number
}

type GateAction = () => void

interface RuntimeRecord {
  rows: unknown[]
  listings: unknown
  stub: unknown[]
}

const SHIM = path.join(import.meta.dirname, 'launcher-shim.py')
const COMMAND_TIMEOUT_S = 300
const GATE_POLL_MS = 5
const PLANTED_NAME = 'perf-planted.txt'

/** Runs inside the confined runtime: each step through SeatbeltEnvironment.execute (stub -> launcher), timed. */
const RUNTIME_DRIVER = String.raw`
import importlib.util, json, os, sys, threading, time, types
repo, spec_raw, own, fixture, base, plan, timeout, gates, reply_timeout = sys.argv[1:10]
seen = {"total": 0, "listings": []}
lock = threading.Lock()
def hook(event, args):
    if event not in ("os.scandir", "os.listdir"):
        return
    target = args[0] if args else "."
    if isinstance(target, int):
        target = "<fd>"
    else:
        target = os.fsdecode(os.fspath(target)) if target is not None else "."
        if not os.path.isabs(target):
            try:
                target = os.path.join(os.getcwd(), target)
            except OSError:
                target = "<rel>"
    with lock:
        seen["total"] += 1
        if len(seen["listings"]) < 200000:
            seen["listings"].append([time.time(), target])
sys.addaudithook(hook)
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
d = os.path.join(repo, "plugins", "iclone-confinement")
spec = importlib.util.spec_from_file_location("hermes_plugins.iclone_confinement", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
mod = importlib.util.module_from_spec(spec); sys.modules[spec.name] = mod; spec.loader.exec_module(mod)
from hermes_plugins.iclone_confinement import core
from hermes_plugins.iclone_confinement.seatbelt import SeatbeltEnvironment
stub_log = os.path.join(gates, "stub.jsonl")
wrapper = os.path.join(gates, "perf-stub.py")
with open(wrapper, "w") as handle:
    handle.write(
        "import importlib.util, json, os, sys, time\n"
        "spec = importlib.util.spec_from_file_location('perf_stub', %r)\n"
        "stub = importlib.util.module_from_spec(spec); spec.loader.exec_module(stub)\n"
        "stub.REPLY_TIMEOUT_S = %r\n"
        "log = open(%r, 'a', buffering=1)\n"
        "answered = []\n"
        "def note(kind):\n"
        "    log.write(json.dumps({'t': time.time(), 'pid': os.getpid(), 'kind': kind}) + '\\n')\n"
        "real = stub._recv_msg\n"
        "def recv(sock, buffered):\n"
        "    msg = real(sock, buffered)\n"
        "    if not answered:\n"
        "        progress = isinstance(msg, dict) and set(msg) == {'progress'}\n"
        "        note('progress' if progress else 'reply')\n"
        "        if not progress:\n"
        "            answered.append(1)\n"
        "    return msg\n"
        "stub._recv_msg = recv\n"
        "note('start')\n"
        "stub.main(sys.argv)\n" % (os.path.join(d, "stub.py"), float(reply_timeout), stub_log))
core.STUB = wrapper
core.grant_params = lambda session, project, window=None: {"NET": "0", "WRITE_PROJECT": "1"}
env = SeatbeltEnvironment(cwd=own, timeout=int(timeout), cls="project", index=core.parse_spec(spec_raw), task_id="perf-launcher")
cwds = {"fixture": fixture, "base": base}
rows = []
for n, step in enumerate(json.loads(plan)):
    if step.get("gate") is not None:
        open(os.path.join(gates, "ready-%d" % step["gate"]), "w").close()
        go, waited = os.path.join(gates, "go-%d" % step["gate"]), time.monotonic()
        while not os.path.exists(go):
            if time.monotonic() - waited > 600:
                raise SystemExit("perf driver: gate %d never opened" % step["gate"])
            time.sleep(0.005)
    cwd = cwds[step["cwd"]]
    t0 = time.time()
    r = env.execute("echo PERF_OK", cwd=cwd)
    t1 = time.time()
    out = r.get("output", "") or ""
    rows.append({"phase": step["phase"], "cwd": step["cwd"], "t0": t0, "t1": t1, "code": r.get("returncode"), "ok": r.get("returncode") == 0 and "PERF_OK" in out, "out": out[-400:]})
stub = []
if os.path.exists(stub_log):
    with open(stub_log) as handle:
        stub = [json.loads(line) for line in handle if line.strip()]
with lock:
    listings = {"total": seen["total"], "listings": list(seen["listings"])}
print("PERFDRV-JSON" + json.dumps({"rows": rows, "listings": listings, "stub": stub}), flush=True)
`

const shQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

function hasGuardClock(world: LauncherWorld): boolean {
  const candidate: Partial<LauncherWorld> = world

  return (
    Array.isArray(candidate.guardEvents) &&
    typeof candidate.advanceGuardClock === 'function' &&
    typeof candidate.advanceGuardAwake === 'function'
  )
}

/** The channel's events as the frames the gate judges, on the wall clock the runtime rows use (epoch ms). */
function framesOf(world: LauncherWorld): GuardFrame[] {
  return world.guardEvents.flatMap((event): GuardFrame[] => {
    const t = performance.timeOrigin + event.at

    switch (event.kind) {
      case 'request':
        return [{ t, dir: 'request', frame: { id: event.id, op: 'check', root: event.root, phase: event.phase } }]

      case 'progress':
        return [{ t, dir: 'progress', frame: { id: event.id, progress: { dirs: event.dirs } } }]

      case 'verdict':
        return [{ t, dir: 'verdict', frame: { id: event.id, ok: event.ok, code: event.code } }]

      default:
        return [{ t, dir: 'closed', frame: { why: event.why } }]
    }
  })
}

function parseConfig(raw: string | undefined): DriverConfig {
  const value: unknown = JSON.parse(raw ?? '')

  if (!value || typeof value !== 'object') {
    throw new Error('launcher-perf-driver: the config is not an object')
  }

  const config = value as Record<string, unknown>

  const text = (key: string): string => {
    const field = config[key]

    if (typeof field !== 'string' || !path.isAbsolute(field) || !field.startsWith('/private/tmp/')) {
      throw new Error(`launcher-perf-driver: ${key} must be an absolute path under /private/tmp`)
    }

    return field
  }

  const count = (key: string): number => {
    const field = config[key]

    if (typeof field !== 'number' || !Number.isInteger(field) || field < 1) {
      throw new Error(`launcher-perf-driver: ${key} must be a positive integer`)
    }

    return field
  }

  const seconds = config.replyTimeoutS

  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
    throw new Error('launcher-perf-driver: replyTimeoutS must be a number of seconds in [1, 60]')
  }

  const shapes = config.shapes ?? ['window', 'own']

  if (!Array.isArray(shapes) || shapes.length === 0 || !shapes.every(shape => shape === 'window' || shape === 'own')) {
    throw new Error('launcher-perf-driver: shapes must list "window" and/or "own"')
  }

  const timings = config.guardTimings
  let guardTimings: DriverConfig['guardTimings']

  if (timings !== undefined) {
    const fields = timings && typeof timings === 'object' ? (timings as Record<string, unknown>) : null
    const keys = fields ? Object.keys(fields) : []

    if (
      !fields ||
      !keys.every(key => key === 'deadlineMs' || key === 'progressMs') ||
      !keys.every(key => Number.isInteger(fields[key]) && (fields[key] as number) >= 1)
    ) {
      throw new Error('launcher-perf-driver: guardTimings may hold only positive integer deadlineMs / progressMs')
    }

    guardTimings = fields as DriverConfig['guardTimings']
  }

  return {
    guardTimings,
    staleMs: count('staleMs'),
    fixture: text('fixture'),
    dirs: count('dirs'),
    scratch: text('scratch'),
    steady: count('steady'),
    dirty: count('dirty'),
    dirtyFolders: count('dirtyFolders'),
    sleepMs: count('sleepMs'),
    replyTimeoutS: seconds,
    shapes: [...new Set(shapes as Shape[])]
  }
}

/** Distinct fixture folders per dirty step, spread over the whole tree, never the same folder twice in a run. */
function dirtyPlan(project: string, dirs: number, steps: number, perStep: number): string[][] {
  const plan: string[][] = []
  let cursor = 1

  for (let step = 0; step < steps; step += 1) {
    const folders: string[] = []

    for (let k = 0; k < perStep; k += 1) {
      cursor = (cursor + 7_919) % dirs
      folders.push(path.join(project, 'tree', dirPath(cursor)))
    }

    plan.push(folders)
  }

  return plan
}

function readJsonLine(out: string, tag: string): unknown {
  const line = out.split('\n').find(row => row.startsWith(tag))

  return line ? JSON.parse(line.slice(tag.length)) : null
}

/** The plan and the actions main's side takes at its gates. `base` steps exist only where the world has a base. */
function buildPlan(
  shape: Shape,
  config: DriverConfig,
  project: string,
  planted: string,
  outsideFile: string,
  advance: (ms: number) => void,
  advanceAwake: (ms: number) => void
): { steps: PlanStep[]; actions: GateAction[] } {
  const paired = shape === 'window'
  const steps: PlanStep[] = [{ phase: 'first', cwd: 'fixture' }]
  const actions: GateAction[] = []

  const gated = (step: PlanStep, action: GateAction): PlanStep => {
    actions.push(action)

    return { ...step, gate: actions.length - 1 }
  }

  for (let n = 0; n < config.steady; n += 1) {
    steps.push({ phase: 'steady', cwd: 'fixture' }, ...(paired ? [{ phase: 'steady', cwd: 'base' } as const] : []))
  }

  for (const [step, folders] of dirtyPlan(project, config.dirs, config.dirty, config.dirtyFolders).entries()) {
    steps.push(
      gated({ phase: 'dirty', cwd: 'fixture' }, () => {
        for (const folder of folders) {
          writeFileSync(path.join(folder, `perf-dirty-${step}.txt`), 'dirty\n')
        }
      }),
      ...(paired ? [{ phase: 'dirty', cwd: 'base' } as const] : [])
    )
  }

  steps.push(gated({ phase: 'sleep', cwd: 'fixture' }, () => advance(config.sleepMs)))
  steps.push(gated({ phase: 'stale', cwd: 'fixture' }, () => advanceAwake(config.staleMs)))
  steps.push(gated({ phase: 'planted', cwd: 'fixture' }, () => linkSync(outsideFile, planted)))

  return { steps, actions }
}

async function runWorld(shape: Shape, config: DriverConfig, project: string): Promise<Record<string, unknown> | null> {
  const scratch = path.join(config.scratch, shape)

  mkdirSync(scratch, { recursive: true })

  const counts = path.join(scratch, 'launcher-listings.json')
  const wrapper = path.join(scratch, 'launcher-python')

  writeFileSync(wrapper, `#!/bin/sh\nexec ${shQuote(RUNTIME_PYTHON)} -I -S ${shQuote(SHIM)} ${shQuote(counts)} "$@"\n`)
  chmodSync(wrapper, 0o755)

  const world = await createLauncherWorld({
    launcherInterpreter: wrapper,
    ...(config.guardTimings ? { guardTimings: config.guardTimings } : {}),
    ...(shape === 'own' ? { project } : {})
  })

  const planted = path.join(project, 'tree', dirPath(Math.floor(config.dirs / 3)), PLANTED_NAME)

  rmSync(planted, { force: true })

  try {
    const missing = [
      ...(existsSync(counts) ? [] : ['launcherInterpreter (the launcher did not start through the shim)']),
      ...(hasGuardClock(world) ? [] : ['advanceGuardClock'])
    ]

    if (missing.length > 0) {
      console.log(`HARNESS_MISSING ${JSON.stringify(missing)}`)

      return null
    }

    // window: the base is the runtime's own small project and the fixture is opened in a window after the spawn (main
    // lists it; the runtime profile, fixed at spawn, does not hold it). own: the fixture is the runtime's project.
    const base = shape === 'window' ? world.project : project

    if (shape === 'window') {
      world.layer.noteProject(project)
    }

    const gates = path.join(world.facts.tmpDir ?? '', `perf-gates-${shape}`)

    if (!world.facts.tmpDir) {
      throw new Error('launcher-perf-driver: the world has no runtime tmp dir')
    }

    mkdirSync(gates, { recursive: true })

    const { steps, actions } = buildPlan(
      shape,
      config,
      project,
      planted,
      path.join(world.outside, 'secret.txt'),
      ms => world.advanceGuardClock(ms),
      ms => world.advanceGuardAwake(ms)
    )

    const spec = world.layer.spawnEnv().ICLONE_CONFINEMENT_SPEC

    const running = world.run(
      [
        '-s', '-P', '-c', RUNTIME_DRIVER, RUNTIME_ROOT, spec ?? '', world.project, project, base,
        JSON.stringify(steps), String(COMMAND_TIMEOUT_S), gates, String(config.replyTimeoutS)
      ],
      { confined: true, timeoutMs: (steps.length + 2) * COMMAND_TIMEOUT_S * 1_000 }
    )

    let finished = false

    void running.then(() => (finished = true))

    for (const [gate, action] of actions.entries()) {
      while (!existsSync(path.join(gates, `ready-${gate}`)) && !finished) {
        await new Promise(resolve => setTimeout(resolve, GATE_POLL_MS))
      }

      if (finished) {
        break
      }

      action()
      writeFileSync(path.join(gates, `go-${gate}`), '')
    }

    const output = await running
    const record = readJsonLine(output.out, 'PERFDRV-JSON') as RuntimeRecord | null

    if (!record) {
      throw new Error(`launcher-perf-driver: runtime driver (${shape}) ${output.code}: ${output.err.slice(-800)} ${output.out.slice(-300)}`)
    }

    await new Promise(resolve => setTimeout(resolve, 200))

    return {
      shape,
      project,
      base,
      dirs: config.dirs,
      replyTimeoutS: config.replyTimeoutS,
      plannedRows: steps.length,
      rows: record.rows,
      frames: framesOf(world),
      listings: existsSync(counts) ? JSON.parse(readFileSync(counts, 'utf8')) : null,
      runtimeListings: record.listings,
      stub: record.stub,
      logs: world.logs.slice(-200)
    }
  } finally {
    rmSync(planted, { force: true })
    await world.dispose()
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv[2])

  if (!runtimeAvailable()) {
    console.log('HARNESS_MISSING ["runtime venv (RUNTIME_ROOT/venv)"]')
    process.exit(4)
  }

  const project = realpathSync(config.fixture)
  const worlds: Record<string, unknown> = {}

  for (const shape of config.shapes) {
    const world = await runWorld(shape, config, project)

    if (world === null) {
      process.exitCode = 4

      return
    }

    worlds[shape] = world
  }

  console.log(`DRIVER_JSON ${JSON.stringify({ project, dirs: config.dirs, worlds })}`)
}

await main()
