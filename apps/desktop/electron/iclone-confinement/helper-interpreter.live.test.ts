/**
 * The interpreter main runs OUTSIDE every sandbox (the membership probe, the launcher), live, in the non-packaged
 * layout where PM keeps its venv, its Python and its `facts.json` under HERMES_HOME — a folder the runtime profile
 * otherwise writes. A confined runtime tries to change that interpreter: it writes into the venv and the Python home,
 * rewrites PM's record, and adds a Python of its own. Every write into PM's folders is EPERM (paired with its
 * unconfined control); the one place it can write (HERMES_HOME outside those folders) never chooses what main runs: a
 * record pointing there is no record, a helper candidate there is refused by name, and the launcher and the probe keep
 * running the trusted interpreter, proven by the process table and by a marker only the other interpreter would write.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pmCommittedVenv } from '../pm-venv'

import { attachLayer, type WorldLayer } from './launcher-live-harness'
import { createRuntimeWorld, pmInstallKey, runtimeAvailable, type RuntimeWorld } from './runtime-live-harness'

const live = runtimeAvailable()

/** The WRITER driver's answers (`WRITER-JSON{…}` on its own line): id → `ok` or an errno name. */
function writerAnswers(out: string, err: string, code: number | null): Record<string, string> {
  const line = out.split('\n').find(item => item.startsWith('WRITER-JSON'))

  if (!line) {
    throw new Error(`the writer printed no result (exit ${code}): ${err.slice(-600)}`)
  }

  return JSON.parse(line.slice('WRITER-JSON'.length)) as Record<string, string>
}

/**
 * Run inside the runtime profile: each file op answered `ok` or its errno name, from this interpreter and from an
 * interpreter child it starts (Seatbelt is inherited). It also writes `ops.record` (PM's `facts.json`) pointing at a
 * venv under `ops.decoyVenv`, whose `bin/python` writes `ops.marker` on start — so if main ever ran it, the marker
 * would appear.
 */
const WRITER = String.raw`
import errno, json, os, sys

def run(op):
    try:
        if op["k"] == "write":
            os.makedirs(os.path.dirname(op["path"]), exist_ok=True)
            with open(op["path"], "w") as f:
                f.write("x")
            return "ok"
        if op["k"] == "record":
            os.makedirs(os.path.join(op["decoyVenv"], "bin"), exist_ok=True)
            with open(os.path.join(op["decoyVenv"], "pyvenv.cfg"), "w") as f:
                f.write("home = /usr/bin\n")
            p = os.path.join(op["decoyVenv"], "bin", "python")
            with open(p, "w") as f:
                f.write("#!/bin/sh\n/bin/echo other > %s\n/bin/cat\n/bin/echo '{}'\n" % op["marker"])
            os.chmod(p, 0o755)
            os.makedirs(os.path.dirname(op["path"]), exist_ok=True)
            with open(op["path"], "w") as f:
                json.dump({"packages": {"venv": {"environment": op["decoyVenv"]}}}, f)
            return "ok"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))
    return "ok"

ops = json.loads(sys.argv[1])
print("WRITER-JSON" + json.dumps({op["id"]: run(op) for op in ops}), flush=True)
`

interface Attempt {
  id: string
  k: 'write' | 'record'
  path: string
  decoyVenv?: string
  marker?: string
}

describe.skipIf(!live)('the helper interpreter is the trusted one, whatever the confined runtime writes (live)', () => {
  let world: RuntimeWorld
  let wl: WorldLayer
  let confined: Record<string, string>
  let plain: Record<string, string>
  let marker = ''
  let decoyVenv = ''
  let factsFile = ''
  let venvWriteConfined = ''

  beforeAll(async () => {
    // PM under HERMES_HOME (the non-packaged layout env.ts leaves for a CLI install): the venv, the Python and
    // facts.json the runtime must never choose.
    world = createRuntimeWorld({ runtime: 'pm-home' })

    const { facts, paths, root } = world

    wl = await attachLayer(world)

    const key = pmInstallKey(facts.runtimeRoot)

    factsFile = path.join(paths.hermesHome, 'installs', key, 'facts.json')
    // A folder the runtime CAN write (HERMES_HOME outside installs/tools): where it would point a record.
    decoyVenv = path.join(paths.hermesHome, 'cache', 'v')
    marker = path.join(root, 'marker.txt')
    venvWriteConfined = path.join(facts.venvRoot, 'bin', 'planted')

    const writer = path.join(facts.project as string, 'writer.py')

    writeFileSync(writer, WRITER)

    const attempts: Attempt[] = [
      { id: 'into the venv bin', k: 'write', path: venvWriteConfined },
      { id: 'the venv pyvenv.cfg', k: 'write', path: path.join(facts.venvRoot, 'pyvenv.cfg') },
      { id: 'into the python home bin', k: 'write', path: path.join(facts.pythonHome, 'bin', 'planted') },
      { id: 'the python home os module', k: 'write', path: path.join(facts.pythonHome, 'lib', 'os-planted.py') },
      { id: 'PM facts.json and a venv of its own', k: 'record', path: factsFile, decoyVenv, marker }
    ]

    const ask = async (confine: boolean): Promise<Record<string, string>> => {
      const run = await wl.run([writer, JSON.stringify(attempts)], { confined: confine, timeoutMs: 60_000 })

      return writerAnswers(run.out, run.err, run.code)
    }

    // The control first: unconfined, every write succeeds (so a confined EPERM is the profile's doing, not a bad path)
    // — in a throwaway copy of the world, so the real one is untouched when the confined attempt runs.
    const controlWorld = createRuntimeWorld({ runtime: 'pm-home' })
    const controlWl = await attachLayer(controlWorld)

    try {
      const controlWriter = path.join(controlWorld.facts.project as string, 'writer.py')

      writeFileSync(controlWriter, WRITER)

      const controlRun = await controlWl.run(
        [
          controlWriter,
          JSON.stringify(
            attempts.map(op => ({
              ...op,
              path: op.path.replace(world.root, controlWorld.root),
              decoyVenv: op.decoyVenv?.replace(world.root, controlWorld.root),
              marker: op.marker?.replace(world.root, controlWorld.root)
            }))
          )
        ],
        { confined: false, timeoutMs: 60_000 }
      )

      plain = writerAnswers(controlRun.out, controlRun.err, controlRun.code)
    } finally {
      await controlWl.dispose()
      controlWorld.dispose()
    }

    confined = await ask(true)
  }, 900_000)

  afterAll(async () => {
    await wl?.dispose()
    world?.dispose()
  })

  it('unconfined, every write into PM’s folders goes through (the control)', () => {
    expect(plain).toMatchObject({
      'into the venv bin': 'ok',
      'the venv pyvenv.cfg': 'ok',
      'into the python home bin': 'ok',
      'the python home os module': 'ok',
      'PM facts.json and a venv of its own': 'ok'
    })
  })

  it('under the profile, every write into the venv, the Python home and PM’s facts.json is EPERM', () => {
    expect(confined).toMatchObject({
      'into the venv bin': 'EPERM',
      'the venv pyvenv.cfg': 'EPERM',
      'into the python home bin': 'EPERM',
      'the python home os module': 'EPERM',
      'PM facts.json and a venv of its own': 'EPERM'
    })
    expect(existsSync(venvWriteConfined)).toBe(false)
  })

  it('even if a record under HERMES_HOME got through, it would not choose the interpreter: PM ignores it, the trust judge refuses it', () => {
    // Prove the one place the runtime can write cannot steer main, independent of the profile: a record naming a venv
    // outside PM's own generations folder is no record (pm-venv.ts), and a helper candidate there is refused by name.
    mkdirSync(path.join(decoyVenv, 'bin'), { recursive: true })
    writeFileSync(path.join(decoyVenv, 'pyvenv.cfg'), 'home = /usr/bin\n')
    writeFileSync(path.join(decoyVenv, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
    mkdirSync(path.dirname(factsFile), { recursive: true })
    writeFileSync(factsFile, JSON.stringify({ packages: { venv: { environment: decoyVenv } } }))

    expect(pmCommittedVenv(world.facts.runtimeRoot, world.paths.hermesHome)).toBeNull()
    expect(wl.layer.interpreterRefusal(path.join(decoyVenv, 'bin', 'python'))).toContain(
      'which the agent runtime can write'
    )
  })

  it('the launcher and the membership probe run the trusted interpreter, and the other one never ran', () => {
    rmSync(marker, { force: true })

    const helper = wl.layer.helperInterpreter()

    expect(helper).toEqual({ python: wl.memberPython, refusals: [] })
    expect(realpathSync(wl.memberPython)).toBe(realpathSync(world.pm?.python as string))

    const ready = wl.logs.find(line => /launcher ready \(pid \d+\)/.test(line))
    const pid = Number(/pid (\d+)/.exec(ready ?? '')?.[1])

    expect(pid).toBeGreaterThan(1)

    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()

    expect(command.startsWith(`${wl.memberPython} -I -S `)).toBe(true)
    // The marker only the planted interpreter writes was never written: main never ran it.
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('')
  })
})
